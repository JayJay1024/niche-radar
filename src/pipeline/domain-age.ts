import { fetchWithRetry } from '../http.js';
import { readCache, writeCache } from '../cache.js';

interface RdapEvent { eventAction: string; eventDate: string }

export async function getRegisteredAt(
  domain: string,
  cacheDir: string,
  ttlDays: number,
): Promise<string | null> {
  const cached = readCache<{ registeredAt: string | null }>(cacheDir, domain, 'rdap', ttlDays);
  if (cached !== null) return cached.registeredAt;
  let registeredAt: string | null = null;
  try {
    const res = await fetchWithRetry(`https://rdap.org/domain/${domain}`, {
      headers: { accept: 'application/rdap+json' },
    });
    const body = (await res.json()) as { events?: RdapEvent[] };
    registeredAt = body.events?.find((e) => e.eventAction === 'registration')?.eventDate ?? null;
  } catch {
    registeredAt = null;
  }
  writeCache(cacheDir, domain, 'rdap', { registeredAt });
  return registeredAt;
}

export function ageInDays(registeredAt: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(registeredAt).getTime()) / 86400_000);
}
