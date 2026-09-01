import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanUrl, extractDomain, resolveDomain } from '../../src/pipeline/resolve-domain.js';

afterEach(() => vi.unstubAllGlobals());

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

  it('请求失败返回 resolve-failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const r = await resolveDomain('https://www.producthunt.com/r/z', platforms);
    expect(r).toEqual({ eliminatedBy: 'resolve-failed' });
  });
});
