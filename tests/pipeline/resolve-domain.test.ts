import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanUrl, extractDomain, resolveDomain } from '../../src/pipeline/resolve-domain.js';

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cleanUrl', () => {
  it('剥离 query 与 hash', () => {
    expect(cleanUrl('https://foo.com/pricing?ref=producthunt&utm_source=x#top'))
      .toBe('https://foo.com/pricing');
  });
});

describe('extractDomain', () => {
  it('返回 eTLD+1', () => {
    expect(extractDomain('https://app.foo.co.uk/x')).toBe('foo.co.uk');
  });
  it('无效 URL 返回 null', () => {
    expect(extractDomain('not a url')).toBeNull();
  });
});

describe('resolveDomain', () => {
  const platforms = ['vercel.app', 'apps.apple.com'];

  it('跟随跳转并返回清洗后的 url 与 domain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      { ok: true, status: 200, url: 'https://coolapp.io/?ref=producthunt' } as unknown as Response,
    ));
    const r = await resolveDomain('https://www.producthunt.com/r/abc123', platforms);
    expect(r).toEqual({ url: 'https://coolapp.io/', domain: 'coolapp.io' });
  });

  it('平台域名被淘汰(按 eTLD+1 匹配)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      { ok: true, status: 200, url: 'https://myapp.vercel.app/' } as unknown as Response,
    ));
    const r = await resolveDomain('https://www.producthunt.com/r/x', platforms);
    expect(r).toEqual({ eliminatedBy: 'platform-domain' });
  });

  it('平台域名也支持 host 级匹配(apps.apple.com)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      { ok: true, status: 200, url: 'https://apps.apple.com/us/app/x/id1' } as unknown as Response,
    ));
    const r = await resolveDomain('https://www.producthunt.com/r/y', platforms);
    expect(r).toEqual({ eliminatedBy: 'platform-domain' });
  });

  it('请求失败且无 fallback key 返回 resolve-failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const r = await resolveDomain('https://www.producthunt.com/r/z', platforms);
    expect(r).toEqual({ eliminatedBy: 'resolve-failed' });
  });

  // 直连被封(如 GitHub Actions IP 段被 PH 的 Cloudflare 403)时走 TabAPI Web Reader 兜底
  it('直连失败时走 Web Reader 兜底解析(带 Bearer 头与 url body)', async () => {
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://tabapi.com/api/v1/markdown') {
        const body = JSON.parse(init?.body as string);
        expect(body).toEqual({ url: 'https://www.producthunt.com/r/blocked' });
        const headers = init?.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer sk_test');
        return new Response(JSON.stringify({
          source: { requested_url: body.url, resolved_url: 'https://kilo.ai/jetbrains', http_status: 200 },
        }), { status: 200 });
      }
      throw new Error('HTTP 403'); // 直连被封
    });
    vi.stubGlobal('fetch', mock);
    const r = await resolveDomain('https://www.producthunt.com/r/blocked', platforms, 'sk_test');
    expect(r).toEqual({ url: 'https://kilo.ai/jetbrains', domain: 'kilo.ai' });
  });

  it('Web Reader 兜底结果同样过平台黑名单', async () => {
    const mock = vi.fn(async (url: string) => {
      if (url === 'https://tabapi.com/api/v1/markdown') {
        return new Response(JSON.stringify({
          source: { resolved_url: 'https://myapp.vercel.app/home' },
        }), { status: 200 });
      }
      throw new Error('HTTP 403');
    });
    vi.stubGlobal('fetch', mock);
    const r = await resolveDomain('https://www.producthunt.com/r/p', platforms, 'sk_test');
    expect(r).toEqual({ eliminatedBy: 'platform-domain' });
  });

  it('直连与 Web Reader 都失败返回 resolve-failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const r = await resolveDomain('https://www.producthunt.com/r/q', platforms, 'sk_test');
    expect(r).toEqual({ eliminatedBy: 'resolve-failed' });
  });
});
