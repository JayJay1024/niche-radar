import { getDomain } from 'tldts';
import { fetchWithRetry } from '../http.js';

export function cleanUrl(finalUrl: string): string {
  const u = new URL(finalUrl);
  u.search = '';
  u.hash = '';
  return u.toString();
}

export function extractDomain(url: string): string | null {
  try {
    return getDomain(new URL(url).hostname);
  } catch {
    return null;
  }
}

function isPlatform(url: string, platformDomains: string[]): boolean {
  const host = new URL(url).hostname;
  const domain = getDomain(host) ?? host;
  return platformDomains.some((p) => host === p || host.endsWith(`.${p}`) || domain === p);
}

/** TabAPI Web Reader 兜底:从其服务端抓取并返回重定向后的最终 URL(1 credit) */
async function resolveViaWebReader(url: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetchWithRetry('https://tabapi.com/api/v1/markdown', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const body = (await res.json()) as { source?: { resolved_url?: string } };
    return body.source?.resolved_url ?? null;
  } catch (err) {
    console.error(`[resolve] web reader failed for ${url}: ${String(err)}`);
    return null;
  }
}

export async function resolveDomain(
  websiteUrl: string,
  platformDomains: string[],
  tabApiKey?: string,
): Promise<{ url: string; domain: string } | { eliminatedBy: 'platform-domain' | 'resolve-failed' }> {
  // 主路径:直连跟随跳转(免费)。GitHub Actions 等数据中心 IP 会被 PH 的
  // Cloudflare 按 IP 段 403(与 UA 无关),此时降级走 Web Reader。
  let finalUrl: string | null = null;
  try {
    const res = await fetchWithRetry(websiteUrl, { redirect: 'follow' });
    finalUrl = res.url || websiteUrl;
  } catch (err) {
    console.error(`[resolve] direct fetch failed for ${websiteUrl}: ${String(err)}`);
    if (tabApiKey) finalUrl = await resolveViaWebReader(websiteUrl, tabApiKey);
  }
  if (!finalUrl) return { eliminatedBy: 'resolve-failed' };
  try {
    if (isPlatform(finalUrl, platformDomains)) return { eliminatedBy: 'platform-domain' };
    const url = cleanUrl(finalUrl);
    const domain = extractDomain(url);
    if (!domain) return { eliminatedBy: 'resolve-failed' };
    return { url, domain };
  } catch {
    return { eliminatedBy: 'resolve-failed' };
  }
}
