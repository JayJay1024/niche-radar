import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Entry { value: unknown; fetchedAt: string }
type CacheFile = Record<string, Entry>;

function filePath(dir: string, domain: string): string {
  return join(dir, `${domain}.json`);
}

export function readCache<T>(dir: string, domain: string, key: string, ttlDays: number): T | null {
  const p = filePath(dir, domain);
  if (!existsSync(p)) return null;
  try {
    const file = JSON.parse(readFileSync(p, 'utf8')) as CacheFile;
    const entry = file[key];
    if (!entry) return null;
    const ageMs = Date.now() - new Date(entry.fetchedAt).getTime();
    if (ageMs > ttlDays * 86400_000) return null;
    return entry.value as T;
  } catch {
    return null;
  }
}

export function writeCache(dir: string, domain: string, key: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  const p = filePath(dir, domain);
  let file: CacheFile = {};
  if (existsSync(p)) {
    try {
      file = JSON.parse(readFileSync(p, 'utf8')) as CacheFile;
    } catch {
      file = {};
    }
  }
  file[key] = { value, fetchedAt: new Date().toISOString() };
  writeFileSync(p, JSON.stringify(file, null, 2));
}
