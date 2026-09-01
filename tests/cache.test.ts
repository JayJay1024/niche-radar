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

  it('损坏的缓存文件作为缓存未中处理', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-cache-'));
    const p = join(dir, 'corrupt.com.json');
    // 写入损坏的 JSON
    writeFileSync(p, '{corrupt');
    // readCache 应该返回 null
    expect(readCache(dir, 'corrupt.com', 'rdap', 30)).toBeNull();
    // writeCache 应该成功修复
    writeCache(dir, 'corrupt.com', 'rdap', { fixed: true });
    // 后续 readCache 应该返回新值
    const hit = readCache<{ fixed: boolean }>(dir, 'corrupt.com', 'rdap', 30);
    expect(hit?.fixed).toBe(true);
  });
});
