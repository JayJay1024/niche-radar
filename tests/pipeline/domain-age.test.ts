import { describe, it, expect, vi, afterEach } from 'vitest';
import { getRegisteredAt, ageInDays } from '../../src/pipeline/domain-age.js';
import rdapFixture from '../fixtures/rdap-example.json';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterEach(() => vi.unstubAllGlobals());
const tmp = () => mkdtempSync(join(tmpdir(), 'nr-rdap-'));

describe('getRegisteredAt', () => {
  it('从 RDAP events 提取 registration 日期', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(rdapFixture), { status: 200 }),
    ));
    const iso = await getRegisteredAt('example.com', tmp(), 30);
    expect(iso).toBe('2026-03-15T08:30:00Z');
  });

  it('命中缓存时不发请求', async () => {
    const dir = tmp();
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(rdapFixture), { status: 200 }));
    vi.stubGlobal('fetch', mock);
    await getRegisteredAt('example.com', dir, 30);
    await getRegisteredAt('example.com', dir, 30);
    expect(mock).toHaveBeenCalledTimes(1); // 第二次命中缓存,不出网
  });

  it('RDAP 查询失败返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('404')));
    expect(await getRegisteredAt('unknown.tld', tmp(), 30)).toBeNull();
  });
});

describe('ageInDays', () => {
  it('计算注册至今天数', () => {
    expect(ageInDays('2026-08-22T00:00:00Z', new Date('2026-09-01T00:00:00Z'))).toBe(10);
  });
});
