import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchPosts } from '../../src/pipeline/fetch-posts.js';
import page from '../fixtures/ph-posts-page.json';

afterEach(() => vi.unstubAllGlobals());

describe('fetchPosts', () => {
  it('拉取一天的产品并映射字段', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(page), { status: 200 }));
    vi.stubGlobal('fetch', mock);
    const posts = await fetchPosts('2026-08-31', 'tok');
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual({
      name: 'CoolApp', tagline: 'Do cool things', votes: 321,
      phUrl: 'https://www.producthunt.com/posts/coolapp',
      website: 'https://www.producthunt.com/r/ABC123',
    });
    // 请求体断言:日期区间 postedAfter 含当天 0 点,postedBefore 为次日 0 点
    const body = JSON.parse((mock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables.postedAfter).toBe('2026-08-31T00:00:00Z');
    expect(body.variables.postedBefore).toBe('2026-09-01T00:00:00Z');
    // 鉴权头
    const headers = (mock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok');
  });

  it('hasNextPage 时翻页并合并', async () => {
    const page1 = structuredClone(page);
    page1.data.posts.pageInfo = { hasNextPage: true, endCursor: 'CUR1' };
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page), { status: 200 }));
    vi.stubGlobal('fetch', mock);
    const posts = await fetchPosts('2026-08-31', 'tok');
    expect(posts).toHaveLength(4);
    const body2 = JSON.parse((mock.mock.calls[1][1] as RequestInit).body as string);
    expect(body2.variables.after).toBe('CUR1');
  });

  it('GraphQL errors 字段非空时抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: 'rate limited' }] }), { status: 200 }),
    ));
    await expect(fetchPosts('2026-08-31', 'tok')).rejects.toThrow(/rate limited/);
  });
});
