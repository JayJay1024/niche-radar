import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { getRegisteredAt, ageInDays, resetRdapBootstrap } from '../../src/pipeline/domain-age.js';
import rdapFixture from '../fixtures/rdap-example.json' with { type: 'json' };
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

beforeEach(() => resetRdapBootstrap());
afterEach(() => vi.unstubAllGlobals());
const tmp = () => mkdtempSync(join(tmpdir(), 'nr-rdap-'));

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const bootstrapBody = {
  services: [[['com', 'net'], ['https://rdap.example-registry.test/com/v1/']]],
};

/** 按 URL 路由的 fetch mock:bootstrap 固定返回,其余交给 handler */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === BOOTSTRAP_URL) return new Response(JSON.stringify(bootstrapBody), { status: 200 });
    return handler(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('getRegisteredAt', () => {
  it('经 IANA bootstrap 直连注册局并提取 registration 日期', async () => {
    const mock = stubFetch((url) => {
      expect(url).toBe('https://rdap.example-registry.test/com/v1/domain/example.com');
      return new Response(JSON.stringify(rdapFixture), { status: 200 });
    });
    const iso = await getRegisteredAt('example.com', tmp(), 30);
    expect(iso).toBe('2026-03-15T08:30:00Z');
    expect(mock).toHaveBeenCalledTimes(2); // bootstrap + 注册局
  });

  it('命中缓存时不发请求(bootstrap 也不重拉)', async () => {
    const dir = tmp();
    const mock = stubFetch(() => new Response(JSON.stringify(rdapFixture), { status: 200 }));
    await getRegisteredAt('example.com', dir, 30);
    await getRegisteredAt('example.com', dir, 30);
    expect(mock).toHaveBeenCalledTimes(2); // 第二次调用零请求
  });

  it('注册局 404(查无此域)缓存 null', async () => {
    const dir = tmp();
    const mock = stubFetch(() => new Response('not found', { status: 404 }));
    expect(await getRegisteredAt('ghost.com', dir, 30)).toBeNull();
    expect(await getRegisteredAt('ghost.com', dir, 30)).toBeNull();
    expect(mock).toHaveBeenCalledTimes(2); // 第二次命中缓存
  });

  it('注册局瞬时失败(网络错误)不缓存,下次重试', async () => {
    const dir = tmp();
    let fail = true;
    const mock = stubFetch(() => {
      if (fail) throw new Error('ECONNRESET');
      return new Response(JSON.stringify(rdapFixture), { status: 200 });
    });
    expect(await getRegisteredAt('flaky.com', dir, 30)).toBeNull();
    fail = false;
    expect(await getRegisteredAt('flaky.com', dir, 30)).toBe('2026-03-15T08:30:00Z');
    // bootstrap 1 次 + 失败重试 2 次 + 成功 1 次
    expect(mock).toHaveBeenCalledTimes(4);
  });

  it('TLD 不在 bootstrap 时走 TabAPI RDAP fallback(带 Bearer 头)', async () => {
    const dir = tmp();
    const mock = stubFetch((url, init) => {
      expect(url).toBe('https://tabapi.com/api/v1/domains/coolapp.io/rdap');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sk_test');
      return new Response(JSON.stringify(rdapFixture), { status: 200 });
    });
    expect(await getRegisteredAt('coolapp.io', dir, 30, 'sk_test')).toBe('2026-03-15T08:30:00Z');
    expect(await getRegisteredAt('coolapp.io', dir, 30, 'sk_test')).toBe('2026-03-15T08:30:00Z');
    expect(mock).toHaveBeenCalledTimes(2); // bootstrap + fallback,第二次命中缓存
  });

  it('TabAPI fallback 422(不支持的 TLD)缓存 null', async () => {
    const dir = tmp();
    stubFetch(() => new Response(JSON.stringify({ error: 'unprocessable' }), { status: 422 }));
    expect(await getRegisteredAt('weird.zz', dir, 30, 'sk_test')).toBeNull();
    const mock2 = stubFetch(() => new Response(JSON.stringify(rdapFixture), { status: 200 }));
    expect(await getRegisteredAt('weird.zz', dir, 30, 'sk_test')).toBeNull(); // 已缓存
    expect(mock2).toHaveBeenCalledTimes(0);
  });

  it('无 fallback key 且 TLD 无 RDAP:确定性 null 并缓存', async () => {
    const dir = tmp();
    const mock = stubFetch(() => {
      throw new Error('should not reach any registry');
    });
    expect(await getRegisteredAt('site.io', dir, 30)).toBeNull();
    expect(await getRegisteredAt('site.io', dir, 30)).toBeNull();
    expect(mock).toHaveBeenCalledTimes(1); // 仅 bootstrap
  });
});

describe('ageInDays', () => {
  it('计算注册至今天数', () => {
    expect(ageInDays('2026-08-22T00:00:00Z', new Date('2026-09-01T00:00:00Z'))).toBe(10);
  });
});
