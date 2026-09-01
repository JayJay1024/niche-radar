import type { Traffic } from '../../types.js';
import type { TrafficProvider } from './provider.js';
import { fetchWithRetry } from '../../http.js';
import { readCache, writeCache } from '../../cache.js';

const BASE = 'https://tabapi.com/api/traffic'; // probe 后按真实文档修正

export function parseTabApiResponse(raw: unknown): Traffic | null {
  const r = raw as { visits?: number; sources?: Record<string, number> };
  if (typeof r.visits !== 'number' || !r.sources) return null;
  return {
    monthlyVisits: r.visits,
    sources: {
      direct: r.sources.direct ?? 0,
      search: r.sources.search ?? 0,
      referral: r.sources.referral ?? 0,
      social: r.sources.social ?? 0,
      mail: r.sources.mail ?? 0,
    },
  };
}

export function createTabApiProvider(apiKey: string, cacheDir: string, ttlDays: number): TrafficProvider {
  return {
    async lookup(domain: string): Promise<Traffic | null> {
      const cached = readCache<{ traffic: Traffic | null }>(cacheDir, domain, 'traffic', ttlDays);
      if (cached !== null) return cached.traffic;
      let raw: unknown;
      try {
        const res = await fetchWithRetry(`${BASE}?domain=${encodeURIComponent(domain)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        raw = await res.json();
      } catch {
        return null; // 请求失败不缓存,下次重试
      }
      const traffic = parseTabApiResponse(raw);
      writeCache(cacheDir, domain, 'traffic', { traffic }); // 成功响应(含无数据)缓存
      return traffic;
    },
  };
}
