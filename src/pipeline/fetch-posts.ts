import { fetchWithRetry } from '../http.js';

export interface PhPost {
  name: string;
  tagline: string;
  votes: number;
  phUrl: string;
  website: string | null;
}

const QUERY = `
query DailyPosts($postedAfter: DateTime!, $postedBefore: DateTime!, $after: String) {
  posts(postedAfter: $postedAfter, postedBefore: $postedBefore, after: $after, order: VOTES) {
    pageInfo { hasNextPage endCursor }
    nodes { name tagline votesCount url website }
  }
}`;

interface PhPage {
  data?: {
    posts: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: { name: string; tagline: string; votesCount: number; url: string; website: string | null }[];
    };
  };
  errors?: { message: string }[];
}

export interface FetchPostsOpts {
  /** 票数低于此值即停止翻页(order: VOTES 降序保证其后都更低)。默认 0 = 不限 */
  minVotes?: number;
  /** 最多拉取的产品数,防止配额耗尽。默认不限 */
  maxPosts?: number;
}

export async function fetchPosts(date: string, token: string, opts: FetchPostsOpts = {}): Promise<PhPost[]> {
  const { minVotes = 0, maxPosts = Infinity } = opts;
  const postedAfter = `${date}T00:00:00Z`;
  const next = new Date(new Date(`${date}T00:00:00Z`).getTime() + 86400_000);
  const postedBefore = `${next.toISOString().slice(0, 10)}T00:00:00Z`;

  const all: PhPost[] = [];
  let after: string | null = null;
  do {
    const res = await fetchWithRetry('https://api.producthunt.com/v2/api/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: QUERY, variables: { postedAfter, postedBefore, after } }),
    });
    const page = (await res.json()) as PhPage;
    if (page.errors?.length) throw new Error(`PH GraphQL: ${page.errors[0].message}`);
    const posts = page.data!.posts;
    for (const n of posts.nodes) {
      // order: VOTES 降序:一旦低于阈值,后面全部更低,直接收工
      if (n.votesCount < minVotes || all.length >= maxPosts) return all;
      all.push({ name: n.name, tagline: n.tagline, votes: n.votesCount, phUrl: n.url, website: n.website });
    }
    after = posts.pageInfo.hasNextPage ? posts.pageInfo.endCursor : null;
  } while (after);
  return all;
}
