import type { Traffic } from '../../types.js';
import type { TrafficProvider } from './provider.js';
import { readCache, writeCache } from '../../cache.js';

// TabAPI 真实契约(https://tabapi.com/docs.txt):
// GET /api/v1/domains/{domain}/traffic?months=3 — 每返回一个月计 1 credit,最少 3 个月。
// 无数据 = 200 + null overview 字段;历史不足 3 个月的新站 = 422(不计费)。
// 状态码决定缓存语义,fetchWithRetry 不透出状态码,故本模块自带超时+重试的 fetch。
const BASE = 'https://tabapi.com/api/v1/domains';
const TIMEOUT_MS = 10_000;

interface TabApiTraffic {
  overview?: { visits?: number | null } | null;
  traffic_sources?: Record<string, number | null> | null;
  top_keywords?: { name: string; volume: number }[] | null;
}

export function parseTabApiResponse(raw: unknown): Traffic | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as TabApiTraffic;
  const visits = r.overview?.visits;
  if (typeof visits !== 'number') return null;
  const s = r.traffic_sources ?? {};
  return {
    monthlyVisits: visits,
    sources: {
      direct: s.direct ?? 0,
      search: s.search ?? 0,
      referral: (s.referrals ?? 0) + (s.paid_referrals ?? 0),
      social: s.social ?? 0,
      mail: s.mail ?? 0,
    },
    topKeywords: (r.top_keywords ?? []).slice(0, 5).map((k) => ({ name: k.name, volume: k.volume })),
  };
}

export function createTabApiProvider(apiKey: string, cacheDir: string, ttlDays: number): TrafficProvider {
  return {
    async lookup(domain: string): Promise<Traffic | null> {
      const cached = readCache<{ traffic: Traffic | null }>(cacheDir, domain, 'traffic', ttlDays);
      if (cached !== null) return cached.traffic;

      const url = `${BASE}/${encodeURIComponent(domain)}/traffic?months=3`;
      let res: Response | null = null;
      for (let attempt = 0; attempt < 2 && !res; attempt++) {
        try {
          const r = await fetch(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          // 402(余额不足)与 5xx 是瞬时失败:重试一次,最终失败不缓存
          if (r.status === 402 || r.status >= 500) continue;
          res = r;
        } catch {
          // 网络错误/超时:重试一次
        }
      }
      if (!res) return null; // 瞬时失败不缓存,下次运行重试

      let traffic: Traffic | null = null;
      if (res.ok) {
        try {
          traffic = parseTabApiResponse(await res.json());
        } catch {
          return null; // 响应体损坏按瞬时失败处理,不缓存
        }
      }
      // res.ok 且无数据(null overview),或 400/422(新站历史不足 3 个月,不计费):
      // 都是确定性"无数据",缓存 null 避免每天重复请求
      writeCache(cacheDir, domain, 'traffic', { traffic });
      return traffic;
    },
  };
}
