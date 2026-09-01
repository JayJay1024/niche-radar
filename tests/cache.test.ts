import { describe, it, expect } from 'vitest';
import { readCache, writeCache } from '../src/cache.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('cache', () => {
  it('写入后 TTL 内可读回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-cache-'));
    writeCache(dir, 'example.com', 'rdap', { registeredAt: '2026-01-01T00:00:00Z' });
    const hit = readCache<{ registeredAt: string }>(dir, 'example.com', 'rdap', 30);
    expect(hit?.registeredAt).toBe('2026-01-01T00:00:00Z');
  });

  it('超过 TTL 返回 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-cache-'));
    writeCache(dir, 'old.com', 'traffic', { monthlyVisits: 1 });
    // 手动把 fetchedAt 改到 31 天前
    const p = join(dir, 'old.com.json');
    const data = JSON.parse(readFileSync(p, 'utf8'));
    data.traffic.fetchedAt = new Date(Date.now() - 31 * 86400_000).toISOString();
    writeFileSync(p, JSON.stringify(data));
    expect(readCache(dir, 'old.com', 'traffic', 30)).toBeNull();
  });

  it('缓存不存在返回 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-cache-'));
    expect(readCache(dir, 'nope.com', 'rdap', 30)).toBeNull();
  });
});
