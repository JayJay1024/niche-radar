import { describe, it, expect, vi, afterEach } from 'vitest';
import { getRegisteredAt, ageInDays } from '../../src/pipeline/domain-age.js';
import rdapFixture from '../fixtures/rdap-example.json' with { type: 'json' };
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterEach(() => vi.unstubAllGlobals());
const tmp = () => mkdtempSync(join(tmpdir(), 'nr-rdap-'));

describe('getRegisteredAt', () => {
  it('从 RDAP events 提取 registration 日期', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(rdapFixture), { status: 200 }),
    ));
    const iso = await getRegisteredAt('example.com', tmp(), 30);
    expect(iso).toBe('2026-03-15T08:30:00Z');
  });

  it('命中缓存时不发请求', async () => {
    const dir = tmp();
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(rdapFixture), { status: 200 }));
    vi.stubGlobal('fetch', mock);
    await getRegisteredAt('example.com', dir, 30);
    await getRegisteredAt('example.com', dir, 30);
    expect(mock).toHaveBeenCalledTimes(1); // 第二次命中缓存,不出网
  });

  it('RDAP 查询失败返回 null 且不缓存失败结果', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('404')));
    const dir = tmp();
    expect(await getRegisteredAt('unknown.tld', dir, 30)).toBeNull();
    // 失败不写缓存:换一个成功的 fetch 再查,应出网
    const ok = vi.fn().mockResolvedValue(new Response(JSON.stringify(rdapFixture), { status: 200 }));
    vi.stubGlobal('fetch', ok);
    await getRegisteredAt('unknown.tld', dir, 30);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('成功响应但无 registration 事件时缓存 null 避免重复请求', async () => {
    const dir = tmp();
    const noRegEvent = { events: [{ eventAction: 'expiration', eventDate: '2027-01-01T00:00:00Z' }] };
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(noRegEvent), { status: 200 }));
    vi.stubGlobal('fetch', mock);
    const result1 = await getRegisteredAt('noreg.tld', dir, 30);
    const result2 = await getRegisteredAt('noreg.tld', dir, 30);
    expect(result1).toBeNull();
    expect(result2).toBeNull();
    expect(mock).toHaveBeenCalledTimes(1); // 第二次命中缓存,未出网
  });
});

describe('ageInDays', () => {
  it('计算注册至今天数', () => {
    expect(ageInDays('2026-08-22T00:00:00Z', new Date('2026-09-01T00:00:00Z'))).toBe(10);
  });
});
