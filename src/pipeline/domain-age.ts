import { readCache, writeCache } from '../cache.js';

// RDAP 策略:IANA bootstrap(https://data.iana.org/rdap/dns.json,静态文件)
// 查 TLD → 官方注册局 RDAP 服务器,直连查询(免费、面向程序、无 WAF 拦截)。
// 不在 bootstrap 里的 TLD(.io/.co/.sh 等 ccTLD 不发布标准 RDAP)走 TabAPI
// 的 RDAP 端点兜底(1 credit,port-43 WHOIS 转 RDAP 结构)。
// 注:rdap.org 中转站会按 User-Agent 拦截 Node 的请求(403/挂起),不可用。
// 缓存语义:确定性结果(拿到日期 / 注册局查无此域 / 不支持的 TLD)缓存;
// 瞬时失败(网络/5xx/402/429)不缓存,下次运行重试。
const TIMEOUT_MS = 10_000;
const IANA_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';

interface RdapEvent { eventAction: string; eventDate: string }

let bootstrapPromise: Promise<Map<string, string> | null> | null = null;

/** 仅测试用:清掉进程内的 bootstrap 缓存 */
export function resetRdapBootstrap(): void {
  bootstrapPromise = null;
}

/** 带超时+一次重试的 JSON GET;返回 null = 瞬时失败 */
async function fetchJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 402 || res.status === 429 || res.status >= 500) continue; // 瞬时,重试一次
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // 非 JSON 响应体(如 404 错误页),status 仍然有效
      }
      return { status: res.status, body };
    } catch {
      // 网络错误/超时,重试一次
    }
  }
  return null;
}

async function loadBootstrap(): Promise<Map<string, string> | null> {
  const r = await fetchJson(IANA_BOOTSTRAP);
  if (!r || r.status !== 200) return null;
  const services = (r.body as { services?: [string[], string[]][] } | null)?.services ?? [];
  const map = new Map<string, string>();
  for (const [tlds, urls] of services) {
    const url = urls.find((u) => u.startsWith('https://')) ?? urls[0];
    if (!url) continue;
    for (const tld of tlds) map.set(tld.toLowerCase(), url.replace(/\/+$/, ''));
  }
  return map;
}

function extractRegistration(body: unknown): string | null {
  const events = (body as { events?: RdapEvent[] } | null)?.events;
  return events?.find((e) => e.eventAction === 'registration')?.eventDate ?? null;
}

export async function getRegisteredAt(
  domain: string,
  cacheDir: string,
  ttlDays: number,
  tabApiKey?: string,
): Promise<string | null> {
  const cached = readCache<{ registeredAt: string | null }>(cacheDir, domain, 'rdap', ttlDays);
  if (cached !== null) return cached.registeredAt;

  const cacheAndReturn = (v: string | null): string | null => {
    writeCache(cacheDir, domain, 'rdap', { registeredAt: v });
    return v;
  };

  bootstrapPromise ??= loadBootstrap();
  const bootstrap = await bootstrapPromise;
  if (bootstrap === null) {
    bootstrapPromise = null; // 拉取失败不记忆,下次重试
    return null;
  }

  const tld = domain.split('.').pop()?.toLowerCase() ?? '';
  const base = bootstrap.get(tld);
  if (base) {
    const r = await fetchJson(`${base}/domain/${domain}`, { accept: 'application/rdap+json' });
    if (r === null) return null; // 注册局瞬时失败:不缓存、不烧 fallback credit,下次免费重试
    if (r.status === 200) return cacheAndReturn(extractRegistration(r.body));
    if (r.status === 404) return cacheAndReturn(null); // 注册局查无此域名
    // 其他状态(403 等异常):落到 TabAPI fallback
  }

  if (tabApiKey) {
    const r = await fetchJson(`https://tabapi.com/api/v1/domains/${encodeURIComponent(domain)}/rdap`, {
      Authorization: `Bearer ${tabApiKey}`,
    });
    if (r === null) return null; // 瞬时失败不缓存
    if (r.status === 200) return cacheAndReturn(extractRegistration(r.body));
    if (r.status === 400 || r.status === 404 || r.status === 422) return cacheAndReturn(null); // 未注册/不支持
    return null;
  }

  return cacheAndReturn(null); // 无 RDAP 也无 fallback key:确定性无数据
}

export function ageInDays(registeredAt: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(registeredAt).getTime()) / 86400_000);
}
