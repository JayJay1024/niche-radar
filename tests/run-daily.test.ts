import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/types.js';

vi.mock('../src/pipeline/fetch-posts.js', () => ({
  fetchPosts: vi.fn().mockResolvedValue([
    { name: 'Winner', tagline: 't', votes: 100, phUrl: 'https://ph/p/w', website: 'https://ph/r/1' },
    { name: 'OldSite', tagline: 't', votes: 50, phUrl: 'https://ph/p/o', website: 'https://ph/r/2' },
    { name: 'NoWeb', tagline: 't', votes: 10, phUrl: 'https://ph/p/n', website: null },
    { name: 'Broken', tagline: 't', votes: 5, phUrl: 'https://ph/p/b', website: 'https://ph/r/3' },
  ]),
}));
vi.mock('../src/pipeline/resolve-domain.js', async (orig) => ({
  ...(await orig()),
  resolveDomain: vi.fn(async (url: string) => {
    if (url.endsWith('/1')) return { url: 'https://winner.io/', domain: 'winner.io' };
    if (url.endsWith('/2')) return { url: 'https://oldsite.com/', domain: 'oldsite.com' };
    throw new Error('boom'); // Broken → error 状态
  }),
}));
vi.mock('../src/pipeline/domain-age.js', async (orig) => ({
  ...(await orig()),
  getRegisteredAt: vi.fn(async (domain: string) =>
    domain === 'winner.io' ? '2026-05-01T00:00:00Z' : '2019-01-01T00:00:00Z'),
}));

import { runDaily } from '../src/run-daily.js';

const cfg: Config = {
  maxDomainAgeDays: 365, minMonthlyVisits: 3000, minSearchShare: 0.2, minDirectShare: 0.2,
  minVotes: 0, maxPosts: 500, cacheTtlDays: 30, platformDomains: [], detailUrlTemplate: 'https://www.similarweb.com/website/{domain}/',
};
const provider = {
  lookup: vi.fn(async () => ({
    monthlyVisits: 8000,
    sources: { direct: 0.3, search: 0.5, referral: 0.1, social: 0.1, mail: 0 },
  })),
};

afterEach(() => vi.clearAllMocks());

describe('runDaily', () => {
  it('全链路:qualified/eliminated/error 分类正确并写盘', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nr-data-'));
    const report = await runDaily({ date: '2026-08-31', phToken: 't', provider, cfg, dataDir });

    expect(report.funnel).toEqual({ total: 4, resolved: 2, newDomains: 1, hasTraffic: 1, qualified: 1 });
    const byName = Object.fromEntries(report.products.map((p) => [p.name, p]));
    expect(byName['Winner'].status).toBe('qualified');
    expect(byName['Winner'].detailUrl).toBe('https://www.similarweb.com/website/winner.io/');
    expect(byName['OldSite'].eliminatedBy).toBe('domain-age');
    expect(byName['NoWeb'].eliminatedBy).toBe('no-website');
    expect(byName['Broken'].status).toBe('error');
    // 老站不应烧流量查询
    expect(provider.lookup).toHaveBeenCalledTimes(1);
    expect(provider.lookup).toHaveBeenCalledWith('winner.io');
    // 落盘
    expect(existsSync(join(dataDir, 'daily', '2026-08-31.json'))).toBe(true);
    const index = JSON.parse(readFileSync(join(dataDir, 'index.json'), 'utf8'));
    expect(index).toEqual([{ date: '2026-08-31', total: 4, qualified: 1 }]);
  });

  it('重跑同日期覆盖 index 而不重复追加', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nr-data-'));
    await runDaily({ date: '2026-08-31', phToken: 't', provider, cfg, dataDir });
    await runDaily({ date: '2026-08-31', phToken: 't', provider, cfg, dataDir });
    const index = JSON.parse(readFileSync(join(dataDir, 'index.json'), 'utf8'));
    expect(index).toHaveLength(1);
  });
});
