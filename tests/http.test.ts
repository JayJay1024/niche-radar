import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithRetry } from '../src/http.js';

afterEach(() => vi.unstubAllGlobals());

describe('fetchWithRetry', () => {
  it('首次网络错误后重试一次并成功', async () => {
    const mock = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mock);
    const res = await fetchWithRetry('https://example.com');
    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('两次都失败时抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(fetchWithRetry('https://example.com')).rejects.toThrow('down');
  });

  it('非 2xx 响应抛出含状态码的错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x', { status: 503 })));
    await expect(fetchWithRetry('https://example.com')).rejects.toThrow(/503/);
  });
});
