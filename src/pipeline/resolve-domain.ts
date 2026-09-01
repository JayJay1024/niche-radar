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

export async function resolveDomain(
  websiteUrl: string,
  platformDomains: string[],
): Promise<{ url: string; domain: string } | { eliminatedBy: 'platform-domain' | 'resolve-failed' }> {
  try {
    const res = await fetchWithRetry(websiteUrl, { redirect: 'follow' });
    const finalUrl = res.url || websiteUrl;
    if (isPlatform(finalUrl, platformDomains)) return { eliminatedBy: 'platform-domain' };
    const url = cleanUrl(finalUrl);
    const domain = extractDomain(url);
    if (!domain) return { eliminatedBy: 'resolve-failed' };
    return { url, domain };
  } catch {
    return { eliminatedBy: 'resolve-failed' };
  }
}
