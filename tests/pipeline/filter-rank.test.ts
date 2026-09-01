import { describe, it, expect } from 'vitest';
import { applyTrafficRules, rankQualified, computeFunnel } from '../../src/pipeline/filter-rank.js';
import type { Config, ProductResult, Traffic } from '../../src/types.js';

const cfg = {
  minMonthlyVisits: 3000, minSearchShare: 0.2, minDirectShare: 0.2,
  maxDomainAgeDays: 365, minVotes: 0, maxPosts: 500, cacheTtlDays: 30, platformDomains: [], detailUrlTemplate: '',
} as Config;

const good: Traffic = { monthlyVisits: 5000, sources: { direct: 0.3, search: 0.4, referral: 0.2, social: 0.1, mail: 0 } };

describe('applyTrafficRules', () => {
  it('全部达标返回 null', () => {
    expect(applyTrafficRules(good, cfg)).toBeNull();
  });
  it('月访不足 → monthly-visits', () => {
    expect(applyTrafficRules({ ...good, monthlyVisits: 2999 }, cfg)).toBe('monthly-visits');
  });
  it('搜索占比不足 → search-share', () => {
    expect(applyTrafficRules({ ...good, sources: { ...good.sources, search: 0.19 } }, cfg)).toBe('search-share');
  });
  it('直访占比不足 → direct-share', () => {
    expect(applyTrafficRules({ ...good, sources: { ...good.sources, direct: 0.1 } }, cfg)).toBe('direct-share');
  });
  it('边界值:恰好等于阈值不通过(> 是严格大于)', () => {
    expect(applyTrafficRules({ ...good, monthlyVisits: 3000 }, cfg)).toBe('monthly-visits');
    expect(applyTrafficRules({ ...good, sources: { ...good.sources, search: 0.2 } }, cfg)).toBe('search-share');
  });
});

const p = (over: Partial<ProductResult>): ProductResult => ({
  name: 'x', tagline: '', votes: 0, phUrl: '', status: 'eliminated', ...over,
});

describe('rankQualified', () => {
  it('qualified 按月访降序在前,其余原序在后', () => {
    const list = [
      p({ name: 'a', status: 'qualified', traffic: { ...good, monthlyVisits: 4000 } }),
      p({ name: 'b', status: 'eliminated' }),
      p({ name: 'c', status: 'qualified', traffic: { ...good, monthlyVisits: 9000 } }),
      p({ name: 'd', status: 'error' }),
    ];
    expect(rankQualified(list).map((x) => x.name)).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('computeFunnel', () => {
  it('统计各阶段存活数', () => {
    const list = [
      p({ name: 'noweb', eliminatedBy: 'no-website' }),
      p({ name: 'platform', eliminatedBy: 'platform-domain' }),
      p({ name: 'old', domain: 'old.com', eliminatedBy: 'domain-age' }),
      p({ name: 'nodata', domain: 'nd.com', registeredAt: '2026-05-01T00:00:00Z', eliminatedBy: 'no-traffic-data' }),
      p({ name: 'lowtraffic', domain: 'lt.com', registeredAt: '2026-05-01T00:00:00Z', traffic: { ...good, monthlyVisits: 100 }, eliminatedBy: 'monthly-visits' }),
      p({ name: 'winner', domain: 'w.com', registeredAt: '2026-05-01T00:00:00Z', traffic: good, status: 'qualified' }),
    ];
    expect(computeFunnel(list)).toEqual({
      total: 6, resolved: 4, newDomains: 3, hasTraffic: 2, qualified: 1,
    });
  });
});
