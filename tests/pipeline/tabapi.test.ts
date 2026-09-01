import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTabApiProvider, parseTabApiResponse } from '../../src/pipeline/traffic/tabapi.js';
import fixture from '../fixtures/tabapi-traffic.json' with { type: 'json' };
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterEach(() => vi.unstubAllGlobals());
const tmp = () => mkdtempSync(join(tmpdir(), 'nr-tab-'));

describe('parseTabApiResponse', () => {
  it('映射为内部 Traffic 结构', () => {
    expect(parseTabApiResponse(fixture)).toEqual({
      monthlyVisits: 12500,
      sources: { direct: 0.35, search: 0.42, referral: 0.1, social: 0.11, mail: 0.02 },
    });
  });
  it('缺流量字段返回 null', () => {
    expect(parseTabApiResponse({ domain: 'x.com' })).toBeNull();
  });
  it('非对象输入返回 null', () => {
    expect(parseTabApiResponse(null)).toBeNull();
    expect(parseTabApiResponse('oops')).toBeNull();
  });
});

describe('createTabApiProvider', () => {
  it('带 Bearer 头请求并解析', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal('fetch', mock);
    const provider = createTabApiProvider('key123', tmp(), 30);
    const t = await provider.lookup('coolapp.io');
    expect(t?.monthlyVisits).toBe(12500);
    const headers = (mock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer key123');
  });

  it('命中缓存不发第二次请求', async () => {
    const dir = tmp();
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal('fetch', mock);
    const provider = createTabApiProvider('key123', dir, 30);
    await provider.lookup('coolapp.io');
    await provider.lookup('coolapp.io');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('请求失败返回 null 且不缓存失败结果', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('500')));
    const dir = tmp();
    const provider = createTabApiProvider('key123', dir, 30);
    expect(await provider.lookup('down.com')).toBeNull();
    // 失败不写缓存:换一个成功的 fetch 再查,应出网
    const ok = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal('fetch', ok);
    await provider.lookup('down.com');
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('成功响应但无流量数据时缓存 null 避免重复请求', async () => {
    const dir = tmp();
    const noDataResponse = { domain: 'x.com' }; // 无流量数据
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(noDataResponse), { status: 200 }));
    vi.stubGlobal('fetch', mock);
    const provider = createTabApiProvider('key123', dir, 30);
    const result1 = await provider.lookup('x.com');
    const result2 = await provider.lookup('x.com');
    expect(result1).toBeNull();
    expect(result2).toBeNull();
    expect(mock).toHaveBeenCalledTimes(1); // 第二次命中缓存,未出网
  });
});
