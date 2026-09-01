import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildDailyMessage, buildFailureMessage, postToSlack } from '../src/slack.js';
import type { DailyReport } from '../src/types.js';

afterEach(() => vi.unstubAllGlobals());

const report: DailyReport = {
  date: '2026-08-31',
  funnel: { total: 40, resolved: 25, newDomains: 6, hasTraffic: 3, qualified: 1 },
  products: [{
    name: 'Winner', tagline: 'wins', votes: 100, phUrl: 'https://ph/p/w',
    url: 'https://winner.io/', domain: 'winner.io',
    registeredAt: '2026-05-01T00:00:00Z',
    traffic: { monthlyVisits: 8000, sources: { direct: 0.3, search: 0.5, referral: 0.1, social: 0.1, mail: 0 } },
    status: 'qualified', aitdkUrl: 'https://aitdk.com/website/winner.io',
  }],
};

describe('buildDailyMessage', () => {
  it('包含域名、指标与漏斗摘要', () => {
    const text = JSON.stringify(buildDailyMessage(report));
    expect(text).toContain('winner.io');
    expect(text).toContain('8,000');           // 月访格式化
    expect(text).toContain('50%');             // 搜索占比
    expect(text).toContain('40');              // 漏斗 total
    expect(text).toContain('aitdk.com/website/winner.io');
  });
  it('零达标时明确说明(系统存活证明)', () => {
    const empty = { ...report, funnel: { ...report.funnel, qualified: 0 }, products: [] };
    expect(JSON.stringify(buildDailyMessage(empty))).toContain('0');
  });
});

describe('buildFailureMessage', () => {
  it('包含日期与错误', () => {
    const text = JSON.stringify(buildFailureMessage('2026-08-31', 'PH API down'));
    expect(text).toContain('2026-08-31');
    expect(text).toContain('PH API down');
  });
});

describe('postToSlack', () => {
  it('POST JSON 到 webhook', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mock);
    await postToSlack('https://hooks.slack.com/services/X', { text: 'hi' });
    expect(mock.mock.calls[0][0]).toBe('https://hooks.slack.com/services/X');
    expect((mock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });
});
