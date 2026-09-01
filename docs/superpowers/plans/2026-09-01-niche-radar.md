# niche-radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每天自动拉取 ProductHunt 前一天的产品,补全域名年龄/流量数据,筛出"新域名但已拿到搜索流量"的站点,推送 Slack 并发布 GitHub Pages 榜单。

**Architecture:** 一个 TypeScript 批处理管线(纯函数阶段串联,按数据成本从低到高执行),由 GitHub Actions cron 每日驱动;结果 JSON 提交回 git 仓库,静态页面读 JSON 渲染,无数据库无服务器。

**Tech Stack:** Node 22(原生 fetch)、TypeScript、tsx(运行)、vitest(测试)、tldts(eTLD+1 提取)。生产依赖仅 tldts 一个。

**Spec:** `docs/superpowers/specs/2026-09-01-niche-radar-design.md`

## Global Constraints

- Node >= 22,`"type": "module"`,全部 ESM。
- 生产依赖只允许 `tldts`;开发依赖:`typescript`、`tsx`、`vitest`、`@types/node`。
- 所有阈值、平台黑名单、外链模板放 `config.json`,代码不写死(spec §3)。
- 所有外部 HTTP 请求:10 秒超时 + 失败重试一次(spec §9)。
- 单个产品任何阶段失败记 `status: 'error'` 继续,不中断整体(spec §9)。
- 金额敏感:TabAPI 按 credit 计费,任何查询前必须先查 `data/cache/`,缓存 TTL 30 天(spec §5)。
- 测试中不发真实网络请求,一律 `vi.stubGlobal('fetch', ...)` 或 fixture。
- 提交信息用 conventional commits(`feat:`/`test:`/`chore:`/`docs:`)。

## File Structure

```
package.json / tsconfig.json / .gitignore / README.md
config.json                     # 阈值 + 平台黑名单 + AITDK 链接模板
src/
  types.ts                      # 全部共享类型
  config.ts                     # 读取并校验 config.json
  http.ts                       # fetchWithRetry(超时+重试,全项目唯一出网口)
  cache.ts                      # data/cache/<domain>.json 读写,TTL
  pipeline/
    fetch-posts.ts              # PH GraphQL
    resolve-domain.ts           # 跳转解析 + URL 清洗 + eTLD+1 + 黑名单
    domain-age.ts               # RDAP 注册日期
    traffic/provider.ts         # TrafficProvider 接口
    traffic/tabapi.ts           # TabAPI 实现
    filter-rank.ts              # 规则过滤 + 排序 + 漏斗统计
  slack.ts                      # Block Kit 构建(纯函数)+ webhook 发送
  run-daily.ts                  # CLI 编排器,写 data/daily/ 与 data/index.json
  probe.ts                      # 手动探测单个域名,录制 fixture 用
site/
  index.html / app.js / style.css
.github/workflows/daily.yml / pages.yml
tests/                          # 与 src 镜像;tests/fixtures/ 放录制样本
data/                           # 运行时产物(daily/、cache/、index.json),提交进 git
```

---

### Task 1: 项目脚手架 + config 模块

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `config.json`, `src/config.ts`, `src/types.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(path?: string): Config`;类型 `Config`、`Traffic`、`ProductResult`、`DailyReport`(后续所有任务消费,签名见下方代码,不得改名)。

- [ ] **Step 1: 初始化项目**

```bash
npm init -y
npm i tldts
npm i -D typescript tsx vitest @types/node
```

手工改 `package.json` 关键字段:

```json
{
  "name": "niche-radar",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "daily": "tsx src/run-daily.ts",
    "once": "tsx src/run-daily.ts",
    "probe": "tsx src/probe.ts"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src", "tests"]
}
```

`.gitignore`:

```
node_modules/
.env
```

- [ ] **Step 2: 写 config.json(spec §3 §5 的全部可调项)**

```json
{
  "maxDomainAgeDays": 365,
  "minMonthlyVisits": 3000,
  "minSearchShare": 0.2,
  "minDirectShare": 0.2,
  "cacheTtlDays": 30,
  "platformDomains": [
    "vercel.app", "github.io", "netlify.app", "pages.dev", "web.app",
    "notion.site", "framer.website", "framer.app", "carrd.co", "webflow.io",
    "apps.apple.com", "play.google.com", "chromewebstore.google.com",
    "producthunt.com", "github.com", "x.com", "twitter.com"
  ],
  "aitdkUrlTemplate": "https://aitdk.com/website/{domain}"
}
```

- [ ] **Step 3: 写共享类型 `src/types.ts`**

```typescript
export interface Config {
  maxDomainAgeDays: number;
  minMonthlyVisits: number;
  minSearchShare: number;
  minDirectShare: number;
  cacheTtlDays: number;
  platformDomains: string[];
  aitdkUrlTemplate: string;
}

export interface Traffic {
  monthlyVisits: number;
  /** 各来源占比,0–1 小数 */
  sources: { direct: number; search: number; referral: number; social: number; mail: number };
}

export type EliminatedBy =
  | 'no-website' | 'platform-domain' | 'resolve-failed'
  | 'domain-age' | 'no-traffic-data'
  | 'monthly-visits' | 'search-share' | 'direct-share';

export interface ProductResult {
  name: string;
  tagline: string;
  votes: number;
  phUrl: string;
  url?: string;          // 解析后的最终 URL(已清参)
  domain?: string;       // eTLD+1
  registeredAt?: string; // ISO 8601
  traffic?: Traffic;
  status: 'qualified' | 'eliminated' | 'error';
  eliminatedBy?: EliminatedBy;
  error?: string;
  aitdkUrl?: string;     // 仅 qualified 填
}

export interface Funnel {
  total: number;      // PH 当天产品数
  resolved: number;   // 解析出有效非平台域名
  newDomains: number; // 注册 ≤ maxDomainAgeDays
  hasTraffic: number; // 拿到流量数据
  qualified: number;  // 通过全部规则
}

export interface DailyReport {
  date: string; // YYYY-MM-DD (UTC)
  funnel: Funnel;
  products: ProductResult[];
}
```

- [ ] **Step 4: 写失败测试 `tests/config.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('loadConfig', () => {
  it('加载仓库根目录的 config.json 并通过校验', () => {
    const cfg = loadConfig();
    expect(cfg.maxDomainAgeDays).toBe(365);
    expect(cfg.minSearchShare).toBeGreaterThan(0);
    expect(cfg.platformDomains).toContain('vercel.app');
  });

  it('缺字段时抛出带字段名的错误', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-'));
    const p = join(dir, 'config.json');
    writeFileSync(p, JSON.stringify({ maxDomainAgeDays: 365 }));
    expect(() => loadConfig(p)).toThrow(/minMonthlyVisits/);
  });
});
```

- [ ] **Step 5: 跑测试确认失败**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL,`Cannot find module '../src/config.js'`

- [ ] **Step 6: 实现 `src/config.ts`**

```typescript
import { readFileSync } from 'node:fs';
import type { Config } from './types.js';

const REQUIRED: (keyof Config)[] = [
  'maxDomainAgeDays', 'minMonthlyVisits', 'minSearchShare', 'minDirectShare',
  'cacheTtlDays', 'platformDomains', 'aitdkUrlTemplate',
];

export function loadConfig(path = 'config.json'): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  for (const key of REQUIRED) {
    if (raw[key] === undefined) throw new Error(`config.json missing field: ${key}`);
  }
  return raw as Config;
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS(2 个用例)

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore config.json src/ tests/
git commit -m "feat: project scaffolding, config module and shared types"
```

---

### Task 2: http 工具 + 缓存模块

**Files:**
- Create: `src/http.ts`, `src/cache.ts`
- Test: `tests/http.test.ts`, `tests/cache.test.ts`

**Interfaces:**
- Produces: `fetchWithRetry(url: string, init?: RequestInit): Promise<Response>`(10s 超时、失败重试一次、非 2xx 抛错);`readCache<T>(dir: string, domain: string, key: string, ttlDays: number): T | null`、`writeCache(dir: string, domain: string, key: string, value: unknown): void`。缓存文件为 `data/cache/<domain>.json`,形如 `{ rdap: { value, fetchedAt }, traffic: { value, fetchedAt } }`,`key` 即 `'rdap' | 'traffic'`。

- [ ] **Step 1: 写失败测试 `tests/http.test.ts`**

```typescript
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/http.test.ts`
Expected: FAIL,模块不存在

- [ ] **Step 3: 实现 `src/http.ts`**

```typescript
const TIMEOUT_MS = 10_000;

export async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
```

注意:非 2xx 也会走一次重试,可接受(与 spec"失败重试一次"一致)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/http.test.ts`
Expected: PASS(3 个用例)

- [ ] **Step 5: 写失败测试 `tests/cache.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { readCache, writeCache } from '../src/cache.js';
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
    const data = JSON.parse(require('node:fs').readFileSync(p, 'utf8'));
    data.traffic.fetchedAt = new Date(Date.now() - 31 * 86400_000).toISOString();
    require('node:fs').writeFileSync(p, JSON.stringify(data));
    expect(readCache(dir, 'old.com', 'traffic', 30)).toBeNull();
  });

  it('缓存不存在返回 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-cache-'));
    expect(readCache(dir, 'nope.com', 'rdap', 30)).toBeNull();
  });
});
```

(ESM 下 `require` 不可用,测试文件顶部加 `import { readFileSync, writeFileSync } from 'node:fs';` 并替换那两行——实现者请直接用 import 写法。)

- [ ] **Step 6: 跑测试确认失败**

Run: `npx vitest run tests/cache.test.ts`
Expected: FAIL,模块不存在

- [ ] **Step 7: 实现 `src/cache.ts`**

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Entry { value: unknown; fetchedAt: string }
type CacheFile = Record<string, Entry>;

function filePath(dir: string, domain: string): string {
  return join(dir, `${domain}.json`);
}

export function readCache<T>(dir: string, domain: string, key: string, ttlDays: number): T | null {
  const p = filePath(dir, domain);
  if (!existsSync(p)) return null;
  const file = JSON.parse(readFileSync(p, 'utf8')) as CacheFile;
  const entry = file[key];
  if (!entry) return null;
  const ageMs = Date.now() - new Date(entry.fetchedAt).getTime();
  if (ageMs > ttlDays * 86400_000) return null;
  return entry.value as T;
}

export function writeCache(dir: string, domain: string, key: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  const p = filePath(dir, domain);
  const file: CacheFile = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  file[key] = { value, fetchedAt: new Date().toISOString() };
  writeFileSync(p, JSON.stringify(file, null, 2));
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run tests/cache.test.ts`
Expected: PASS(3 个用例)

- [ ] **Step 9: Commit**

```bash
git add src/http.ts src/cache.ts tests/http.test.ts tests/cache.test.ts
git commit -m "feat: fetchWithRetry helper and domain cache with TTL"
```

---

### Task 3: resolve-domain(跳转解析 + 清洗 + 黑名单)

**Files:**
- Create: `src/pipeline/resolve-domain.ts`
- Test: `tests/pipeline/resolve-domain.test.ts`

**Interfaces:**
- Consumes: `fetchWithRetry`(Task 2)、`Config.platformDomains`(Task 1)。
- Produces: `cleanUrl(finalUrl: string): string`(剥离 query/hash)、`extractDomain(url: string): string | null`(eTLD+1)、`resolveDomain(websiteUrl: string, platformDomains: string[]): Promise<{ url: string; domain: string } | { eliminatedBy: 'platform-domain' | 'resolve-failed' }>`。

- [ ] **Step 1: 写失败测试**

`tests/pipeline/resolve-domain.test.ts`:

```typescript
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
      Object.assign(new Response('', { status: 200 }), { url: 'https://coolapp.io/?ref=producthunt' }),
    ));
    const r = await resolveDomain('https://www.producthunt.com/r/abc123', platforms);
    expect(r).toEqual({ url: 'https://coolapp.io/', domain: 'coolapp.io' });
  });

  it('平台域名被淘汰(按 eTLD+1 匹配)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      Object.assign(new Response('', { status: 200 }), { url: 'https://myapp.vercel.app/' }),
    ));
    const r = await resolveDomain('https://www.producthunt.com/r/x', platforms);
    expect(r).toEqual({ eliminatedBy: 'platform-domain' });
  });

  it('平台域名也支持 host 级匹配(apps.apple.com)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      Object.assign(new Response('', { status: 200 }), { url: 'https://apps.apple.com/us/app/x/id1' }),
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pipeline/resolve-domain.test.ts`
Expected: FAIL,模块不存在

- [ ] **Step 3: 实现 `src/pipeline/resolve-domain.ts`**

```typescript
import { getDomain } from 'tldts';
import { fetchWithRetry } from '../http.js';

export function cleanUrl(finalUrl: string): string {
  const u = new URL(finalUrl);
  u.search = '';
  u.hash = '';
  return u.toString();
}

export function extractDomain(url: string): string | null {
  try {
    return getDomain(new URL(url).hostname);
  } catch {
    return null;
  }
}

function isPlatform(url: string, platformDomains: string[]): boolean {
  const host = new URL(url).hostname;
  const domain = getDomain(host) ?? host;
  return platformDomains.some((p) => host === p || host.endsWith(`.${p}`) || domain === p);
}

export async function resolveDomain(
  websiteUrl: string,
  platformDomains: string[],
): Promise<{ url: string; domain: string } | { eliminatedBy: 'platform-domain' | 'resolve-failed' }> {
  try {
    const res = await fetchWithRetry(websiteUrl, { redirect: 'follow' });
    const finalUrl = res.url || websiteUrl;
    if (isPlatform(finalUrl, platformDomains)) return { eliminatedBy: 'platform-domain' };
    const url = cleanUrl(finalUrl);
    const domain = extractDomain(url);
    if (!domain) return { eliminatedBy: 'resolve-failed' };
    return { url, domain };
  } catch {
    return { eliminatedBy: 'resolve-failed' };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/pipeline/resolve-domain.test.ts`
Expected: PASS(6 个用例)

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/resolve-domain.ts tests/pipeline/resolve-domain.test.ts
git commit -m "feat: resolve final domain from PH redirect with platform blacklist"
```

---

### Task 4: domain-age(RDAP 注册日期)

**Files:**
- Create: `src/pipeline/domain-age.ts`
- Test: `tests/pipeline/domain-age.test.ts`, `tests/fixtures/rdap-example.json`

**Interfaces:**
- Consumes: `fetchWithRetry`(Task 2)、`readCache`/`writeCache`(Task 2)。
- Produces: `getRegisteredAt(domain: string, cacheDir: string, ttlDays: number): Promise<string | null>`(ISO 日期或 null=查不到);`ageInDays(registeredAt: string, now?: Date): number`。

- [ ] **Step 1: 造 fixture `tests/fixtures/rdap-example.json`**(RDAP 标准响应节选,真实结构)

```json
{
  "objectClassName": "domain",
  "ldhName": "example.com",
  "events": [
    { "eventAction": "registration", "eventDate": "2026-03-15T08:30:00Z" },
    { "eventAction": "expiration", "eventDate": "2027-03-15T08:30:00Z" },
    { "eventAction": "last changed", "eventDate": "2026-03-15T08:30:00Z" }
  ]
}
```

- [ ] **Step 2: 写失败测试 `tests/pipeline/domain-age.test.ts`**

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getRegisteredAt, ageInDays } from '../../src/pipeline/domain-age.js';
import rdapFixture from '../fixtures/rdap-example.json';
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

  it('RDAP 查询失败返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('404')));
    expect(await getRegisteredAt('unknown.tld', tmp(), 30)).toBeNull();
  });
});

describe('ageInDays', () => {
  it('计算注册至今天数', () => {
    expect(ageInDays('2026-08-22T00:00:00Z', new Date('2026-09-01T00:00:00Z'))).toBe(10);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/pipeline/domain-age.test.ts`
Expected: FAIL,模块不存在

- [ ] **Step 4: 实现 `src/pipeline/domain-age.ts`**

RDAP 入口用 `https://rdap.org/domain/<domain>`(公共 bootstrap,会 302 到权威服务器;fetch 默认跟随)。

```typescript
import { fetchWithRetry } from '../http.js';
import { readCache, writeCache } from '../cache.js';

interface RdapEvent { eventAction: string; eventDate: string }

export async function getRegisteredAt(
  domain: string,
  cacheDir: string,
  ttlDays: number,
): Promise<string | null> {
  const cached = readCache<{ registeredAt: string | null }>(cacheDir, domain, 'rdap', ttlDays);
  if (cached !== null) return cached.registeredAt;
  let registeredAt: string | null = null;
  try {
    const res = await fetchWithRetry(`https://rdap.org/domain/${domain}`, {
      headers: { accept: 'application/rdap+json' },
    });
    const body = (await res.json()) as { events?: RdapEvent[] };
    registeredAt = body.events?.find((e) => e.eventAction === 'registration')?.eventDate ?? null;
  } catch {
    registeredAt = null;
  }
  writeCache(cacheDir, domain, 'rdap', { registeredAt });
  return registeredAt;
}

export function ageInDays(registeredAt: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(registeredAt).getTime()) / 86400_000);
}
```

注意:查询失败(`null`)也写缓存,避免每天对同一个查不到的域名反复请求;TTL 到期后自然重试。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/pipeline/domain-age.test.ts`
Expected: PASS(4 个用例)

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/domain-age.ts tests/pipeline/domain-age.test.ts tests/fixtures/rdap-example.json
git commit -m "feat: domain registration date via RDAP with cache"
```

---

### Task 5: fetch-posts(ProductHunt GraphQL)

**Files:**
- Create: `src/pipeline/fetch-posts.ts`
- Test: `tests/pipeline/fetch-posts.test.ts`, `tests/fixtures/ph-posts-page.json`

**Interfaces:**
- Consumes: `fetchWithRetry`(Task 2)。
- Produces: `fetchPosts(date: string, token: string): Promise<PhPost[]>`,其中 `export interface PhPost { name: string; tagline: string; votes: number; phUrl: string; website: string | null }`;`date` 为 `YYYY-MM-DD`(UTC 当天)。

- [ ] **Step 1: 造 fixture `tests/fixtures/ph-posts-page.json`**(PH GraphQL 真实响应结构)

```json
{
  "data": {
    "posts": {
      "pageInfo": { "hasNextPage": false, "endCursor": "Mg==" },
      "nodes": [
        {
          "name": "CoolApp",
          "tagline": "Do cool things",
          "votesCount": 321,
          "url": "https://www.producthunt.com/posts/coolapp",
          "website": "https://www.producthunt.com/r/ABC123"
        },
        {
          "name": "NoSite",
          "tagline": "No website product",
          "votesCount": 5,
          "url": "https://www.producthunt.com/posts/nosite",
          "website": null
        }
      ]
    }
  }
}
```

- [ ] **Step 2: 写失败测试 `tests/pipeline/fetch-posts.test.ts`**

```typescript
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
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/pipeline/fetch-posts.test.ts`
Expected: FAIL,模块不存在

- [ ] **Step 4: 实现 `src/pipeline/fetch-posts.ts`**

```typescript
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

export async function fetchPosts(date: string, token: string): Promise<PhPost[]> {
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
      all.push({ name: n.name, tagline: n.tagline, votes: n.votesCount, phUrl: n.url, website: n.website });
    }
    after = posts.pageInfo.hasNextPage ? posts.pageInfo.endCursor : null;
  } while (after);
  return all;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/pipeline/fetch-posts.test.ts`
Expected: PASS(3 个用例)

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/fetch-posts.ts tests/pipeline/fetch-posts.test.ts tests/fixtures/ph-posts-page.json
git commit -m "feat: fetch daily posts from Product Hunt GraphQL API with pagination"
```

---

### Task 6: TrafficProvider 接口 + TabAPI 实现 + probe 脚本

**Files:**
- Create: `src/pipeline/traffic/provider.ts`, `src/pipeline/traffic/tabapi.ts`, `src/probe.ts`
- Test: `tests/pipeline/tabapi.test.ts`, `tests/fixtures/tabapi-traffic.json`

**Interfaces:**
- Consumes: `fetchWithRetry`、`readCache`/`writeCache`(Task 2)、`Traffic` 类型(Task 1)。
- Produces: `export interface TrafficProvider { lookup(domain: string): Promise<Traffic | null> }`(null = 无数据);`createTabApiProvider(apiKey: string, cacheDir: string, ttlDays: number): TrafficProvider`。

> ⚠️ **本任务含一个外部未知量**:TabAPI 响应的确切字段名在写计划时无法访问其文档(官网 403)。处理方式:响应解析隔离在 `parseTabApiResponse()` 单个纯函数里,先按下方假定 schema 实现;拿到 API key 后**必须**跑 `npm run probe -- <domain>` 打真实接口,把真实响应存为 fixture 覆盖 `tests/fixtures/tabapi-traffic.json`,若字段不同只改 `parseTabApiResponse` 与该 fixture,接口签名不变。此验证是本任务验收条件的一部分,没有 key 时本任务其余步骤照常完成,验证步骤留待联调(Task 11)。

- [ ] **Step 1: 造假定 fixture `tests/fixtures/tabapi-traffic.json`**

```json
{
  "domain": "coolapp.io",
  "visits": 12500,
  "sources": {
    "direct": 0.35,
    "search": 0.42,
    "referral": 0.1,
    "social": 0.11,
    "mail": 0.02
  }
}
```

- [ ] **Step 2: 写接口文件 `src/pipeline/traffic/provider.ts`**(纯类型,无测试)

```typescript
import type { Traffic } from '../../types.js';

export interface TrafficProvider {
  /** 返回 null 表示该域名无流量数据(常见于新站),不是错误 */
  lookup(domain: string): Promise<Traffic | null>;
}
```

- [ ] **Step 3: 写失败测试 `tests/pipeline/tabapi.test.ts`**

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTabApiProvider, parseTabApiResponse } from '../../src/pipeline/traffic/tabapi.js';
import fixture from '../fixtures/tabapi-traffic.json';
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
});
```

注意与 RDAP 的差异:**RDAP 免费,查不到也缓存;TabAPI 收费,请求失败(网络/5xx)不缓存以便重试,但"成功返回但无数据"要缓存**(缓存值 `{ traffic: null }`),避免对无数据新站每天烧 credit。

- [ ] **Step 4: 跑测试确认失败**

Run: `npx vitest run tests/pipeline/tabapi.test.ts`
Expected: FAIL,模块不存在

- [ ] **Step 5: 实现 `src/pipeline/traffic/tabapi.ts`**

```typescript
import type { Traffic } from '../../types.js';
import type { TrafficProvider } from './provider.js';
import { fetchWithRetry } from '../../http.js';
import { readCache, writeCache } from '../../cache.js';

const BASE = 'https://tabapi.com/api/traffic'; // probe 后按真实文档修正

export function parseTabApiResponse(raw: unknown): Traffic | null {
  const r = raw as { visits?: number; sources?: Record<string, number> };
  if (typeof r.visits !== 'number' || !r.sources) return null;
  return {
    monthlyVisits: r.visits,
    sources: {
      direct: r.sources.direct ?? 0,
      search: r.sources.search ?? 0,
      referral: r.sources.referral ?? 0,
      social: r.sources.social ?? 0,
      mail: r.sources.mail ?? 0,
    },
  };
}

export function createTabApiProvider(apiKey: string, cacheDir: string, ttlDays: number): TrafficProvider {
  return {
    async lookup(domain: string): Promise<Traffic | null> {
      const cached = readCache<{ traffic: Traffic | null }>(cacheDir, domain, 'traffic', ttlDays);
      if (cached !== null) return cached.traffic;
      let raw: unknown;
      try {
        const res = await fetchWithRetry(`${BASE}?domain=${encodeURIComponent(domain)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        raw = await res.json();
      } catch {
        return null; // 请求失败不缓存,下次重试
      }
      const traffic = parseTabApiResponse(raw);
      writeCache(cacheDir, domain, 'traffic', { traffic }); // 成功响应(含无数据)缓存
      return traffic;
    },
  };
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/pipeline/tabapi.test.ts`
Expected: PASS(5 个用例)

- [ ] **Step 7: 写 probe 脚本 `src/probe.ts`**(手动工具,无单测)

```typescript
// 用法: TABAPI_KEY=xxx npm run probe -- coolapp.io
// 打真实 TabAPI,打印原始响应,用于录制/校正 tests/fixtures/tabapi-traffic.json
const domain = process.argv[2];
if (!domain) { console.error('usage: npm run probe -- <domain>'); process.exit(1); }
const key = process.env.TABAPI_KEY;
if (!key) { console.error('TABAPI_KEY env required'); process.exit(1); }
const res = await fetch(`https://tabapi.com/api/traffic?domain=${encodeURIComponent(domain)}`, {
  headers: { Authorization: `Bearer ${key}` },
});
console.log('status:', res.status);
console.log(JSON.stringify(await res.json(), null, 2));
```

- [ ] **Step 8: Commit**

```bash
git add src/pipeline/traffic/ src/probe.ts tests/pipeline/tabapi.test.ts tests/fixtures/tabapi-traffic.json
git commit -m "feat: TrafficProvider interface with TabAPI implementation and probe script"
```

---

### Task 7: filter-rank(规则过滤 + 漏斗)

**Files:**
- Create: `src/pipeline/filter-rank.ts`
- Test: `tests/pipeline/filter-rank.test.ts`

**Interfaces:**
- Consumes: `Config`、`Traffic`、`ProductResult`、`Funnel`(Task 1)。
- Produces: `applyTrafficRules(traffic: Traffic, cfg: Config): EliminatedBy | null`(null=通过);`rankQualified(products: ProductResult[]): ProductResult[]`(qualified 按 monthlyVisits 降序排前,其余保持原序附后);`computeFunnel(products: ProductResult[]): Funnel`。

- [ ] **Step 1: 写失败测试 `tests/pipeline/filter-rank.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { applyTrafficRules, rankQualified, computeFunnel } from '../../src/pipeline/filter-rank.js';
import type { Config, ProductResult, Traffic } from '../../src/types.js';

const cfg = {
  minMonthlyVisits: 3000, minSearchShare: 0.2, minDirectShare: 0.2,
  maxDomainAgeDays: 365, cacheTtlDays: 30, platformDomains: [], aitdkUrlTemplate: '',
} as Config;

const good: Traffic = { monthlyVisits: 5000, sources: { direct: 0.3, search: 0.4, referral: 0.2, social: 0.1, mail: 0 } };

describe('applyTrafficRules', () => {
  it('全部达标返回 null', () => {
    expect(applyTrafficRules(good, cfg)).toBeNull();
  });
  it('月访不足 → monthly-visits', () => {
    expect(applyTrafficRules({ ...good, monthlyVisits: 2999 }, cfg)).toBe('monthly-visits');
  });
  it('搜索占比不足 → search-share', () => {
    expect(applyTrafficRules({ ...good, sources: { ...good.sources, search: 0.19 } }, cfg)).toBe('search-share');
  });
  it('直访占比不足 → direct-share', () => {
    expect(applyTrafficRules({ ...good, sources: { ...good.sources, direct: 0.1 } }, cfg)).toBe('direct-share');
  });
  it('边界值:恰好等于阈值不通过(> 是严格大于)', () => {
    expect(applyTrafficRules({ ...good, monthlyVisits: 3000 }, cfg)).toBe('monthly-visits');
    expect(applyTrafficRules({ ...good, sources: { ...good.sources, search: 0.2 } }, cfg)).toBe('search-share');
  });
});

const p = (over: Partial<ProductResult>): ProductResult => ({
  name: 'x', tagline: '', votes: 0, phUrl: '', status: 'eliminated', ...over,
});

describe('rankQualified', () => {
  it('qualified 按月访降序在前,其余原序在后', () => {
    const list = [
      p({ name: 'a', status: 'qualified', traffic: { ...good, monthlyVisits: 4000 } }),
      p({ name: 'b', status: 'eliminated' }),
      p({ name: 'c', status: 'qualified', traffic: { ...good, monthlyVisits: 9000 } }),
      p({ name: 'd', status: 'error' }),
    ];
    expect(rankQualified(list).map((x) => x.name)).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('computeFunnel', () => {
  it('统计各阶段存活数', () => {
    const list = [
      p({ name: 'noweb', eliminatedBy: 'no-website' }),
      p({ name: 'platform', eliminatedBy: 'platform-domain' }),
      p({ name: 'old', domain: 'old.com', eliminatedBy: 'domain-age' }),
      p({ name: 'nodata', domain: 'nd.com', registeredAt: '2026-05-01T00:00:00Z', eliminatedBy: 'no-traffic-data' }),
      p({ name: 'lowtraffic', domain: 'lt.com', registeredAt: '2026-05-01T00:00:00Z', traffic: { ...good, monthlyVisits: 100 }, eliminatedBy: 'monthly-visits' }),
      p({ name: 'winner', domain: 'w.com', registeredAt: '2026-05-01T00:00:00Z', traffic: good, status: 'qualified' }),
    ];
    expect(computeFunnel(list)).toEqual({
      total: 6, resolved: 4, newDomains: 3, hasTraffic: 2, qualified: 1,
    });
  });
});
```

漏斗口径定义(实现和前端都以此为准):`resolved` = 有 `domain` 字段的产品数;`newDomains` = 有 `registeredAt` 且未被 `domain-age` 淘汰(即 eliminatedBy ≠ 'domain-age' 且有 domain 且有 registeredAt);`hasTraffic` = 有 `traffic` 字段;`qualified` = status === 'qualified'。上例:old.com 有 domain 但被年龄淘汰,不计入 newDomains;nodata 计入 newDomains 但无 traffic。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pipeline/filter-rank.test.ts`
Expected: FAIL,模块不存在

- [ ] **Step 3: 实现 `src/pipeline/filter-rank.ts`**

```typescript
import type { Config, EliminatedBy, Funnel, ProductResult, Traffic } from '../types.js';

export function applyTrafficRules(traffic: Traffic, cfg: Config): EliminatedBy | null {
  if (!(traffic.monthlyVisits > cfg.minMonthlyVisits)) return 'monthly-visits';
  if (!(traffic.sources.search > cfg.minSearchShare)) return 'search-share';
  if (!(traffic.sources.direct > cfg.minDirectShare)) return 'direct-share';
  return null;
}

export function rankQualified(products: ProductResult[]): ProductResult[] {
  const qualified = products
    .filter((p) => p.status === 'qualified')
    .sort((a, b) => (b.traffic?.monthlyVisits ?? 0) - (a.traffic?.monthlyVisits ?? 0));
  const rest = products.filter((p) => p.status !== 'qualified');
  return [...qualified, ...rest];
}

export function computeFunnel(products: ProductResult[]): Funnel {
  return {
    total: products.length,
    resolved: products.filter((p) => p.domain).length,
    newDomains: products.filter((p) => p.domain && p.registeredAt && p.eliminatedBy !== 'domain-age').length,
    hasTraffic: products.filter((p) => p.traffic).length,
    qualified: products.filter((p) => p.status === 'qualified').length,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/pipeline/filter-rank.test.ts`
Expected: PASS(8 个用例)

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/filter-rank.ts tests/pipeline/filter-rank.test.ts
git commit -m "feat: traffic rule filtering, ranking and funnel stats"
```

---

### Task 8: run-daily 编排器

**Files:**
- Create: `src/run-daily.ts`
- Test: `tests/run-daily.test.ts`

**Interfaces:**
- Consumes: 前面全部模块。
- Produces: `runDaily(opts: { date: string; phToken: string; provider: TrafficProvider; cfg: Config; dataDir: string }): Promise<DailyReport>`(核心逻辑,可测);CLI 入口读环境变量 `PH_API_TOKEN`、`TABAPI_KEY`,解析 `--date=YYYY-MM-DD`(缺省 = UTC 昨天),写 `data/daily/<date>.json` 与 `data/index.json`,并把 report 打到 stdout 摘要一行。`data/index.json` 形如 `[{ "date": "2026-08-31", "total": 42, "qualified": 2 }]`,按日期升序,同日期覆盖。

- [ ] **Step 1: 写失败测试 `tests/run-daily.test.ts`**

外部依赖全 mock:`vi.mock` 掉 `fetch-posts.js`、`resolve-domain.js`、`domain-age.js`,provider 传假实现。

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/types.js';

vi.mock('../src/pipeline/fetch-posts.js', () => ({
  fetchPosts: vi.fn().mockResolvedValue([
    { name: 'Winner', tagline: 't', votes: 100, phUrl: 'https://ph/p/w', website: 'https://ph/r/1' },
    { name: 'OldSite', tagline: 't', votes: 50, phUrl: 'https://ph/p/o', website: 'https://ph/r/2' },
    { name: 'NoWeb', tagline: 't', votes: 10, phUrl: 'https://ph/p/n', website: null },
    { name: 'Broken', tagline: 't', votes: 5, phUrl: 'https://ph/p/b', website: 'https://ph/r/3' },
  ]),
}));
vi.mock('../src/pipeline/resolve-domain.js', async (orig) => ({
  ...(await orig()),
  resolveDomain: vi.fn(async (url: string) => {
    if (url.endsWith('/1')) return { url: 'https://winner.io/', domain: 'winner.io' };
    if (url.endsWith('/2')) return { url: 'https://oldsite.com/', domain: 'oldsite.com' };
    throw new Error('boom'); // Broken → error 状态
  }),
}));
vi.mock('../src/pipeline/domain-age.js', async (orig) => ({
  ...(await orig()),
  getRegisteredAt: vi.fn(async (domain: string) =>
    domain === 'winner.io' ? '2026-05-01T00:00:00Z' : '2019-01-01T00:00:00Z'),
}));

import { runDaily } from '../src/run-daily.js';

const cfg: Config = {
  maxDomainAgeDays: 365, minMonthlyVisits: 3000, minSearchShare: 0.2, minDirectShare: 0.2,
  cacheTtlDays: 30, platformDomains: [], aitdkUrlTemplate: 'https://aitdk.com/website/{domain}',
};
const provider = {
  lookup: vi.fn(async () => ({
    monthlyVisits: 8000,
    sources: { direct: 0.3, search: 0.5, referral: 0.1, social: 0.1, mail: 0 },
  })),
};

afterEach(() => vi.clearAllMocks());

describe('runDaily', () => {
  it('全链路:qualified/eliminated/error 分类正确并写盘', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nr-data-'));
    const report = await runDaily({ date: '2026-08-31', phToken: 't', provider, cfg, dataDir });

    expect(report.funnel).toEqual({ total: 4, resolved: 2, newDomains: 1, hasTraffic: 1, qualified: 1 });
    const byName = Object.fromEntries(report.products.map((p) => [p.name, p]));
    expect(byName['Winner'].status).toBe('qualified');
    expect(byName['Winner'].aitdkUrl).toBe('https://aitdk.com/website/winner.io');
    expect(byName['OldSite'].eliminatedBy).toBe('domain-age');
    expect(byName['NoWeb'].eliminatedBy).toBe('no-website');
    expect(byName['Broken'].status).toBe('error');
    // 老站不应烧流量查询
    expect(provider.lookup).toHaveBeenCalledTimes(1);
    expect(provider.lookup).toHaveBeenCalledWith('winner.io');
    // 落盘
    expect(existsSync(join(dataDir, 'daily', '2026-08-31.json'))).toBe(true);
    const index = JSON.parse(readFileSync(join(dataDir, 'index.json'), 'utf8'));
    expect(index).toEqual([{ date: '2026-08-31', total: 4, qualified: 1 }]);
  });

  it('重跑同日期覆盖 index 而不重复追加', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nr-data-'));
    await runDaily({ date: '2026-08-31', phToken: 't', provider, cfg, dataDir });
    await runDaily({ date: '2026-08-31', phToken: 't', provider, cfg, dataDir });
    const index = JSON.parse(readFileSync(join(dataDir, 'index.json'), 'utf8'));
    expect(index).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/run-daily.test.ts`
Expected: FAIL,模块不存在

- [ ] **Step 3: 实现 `src/run-daily.ts`**

```typescript
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, DailyReport, ProductResult } from './types.js';
import { loadConfig } from './config.js';
import { fetchPosts } from './pipeline/fetch-posts.js';
import { resolveDomain } from './pipeline/resolve-domain.js';
import { getRegisteredAt, ageInDays } from './pipeline/domain-age.js';
import { applyTrafficRules, rankQualified, computeFunnel } from './pipeline/filter-rank.js';
import type { TrafficProvider } from './pipeline/traffic/provider.js';
import { createTabApiProvider } from './pipeline/traffic/tabapi.js';

export interface RunOpts {
  date: string;
  phToken: string;
  provider: TrafficProvider;
  cfg: Config;
  dataDir: string;
}

export async function runDaily(opts: RunOpts): Promise<DailyReport> {
  const { date, phToken, provider, cfg, dataDir } = opts;
  const cacheDir = join(dataDir, 'cache');
  const posts = await fetchPosts(date, phToken);

  const products: ProductResult[] = [];
  for (const post of posts) {
    const base: ProductResult = {
      name: post.name, tagline: post.tagline, votes: post.votes,
      phUrl: post.phUrl, status: 'eliminated',
    };
    try {
      if (!post.website) { products.push({ ...base, eliminatedBy: 'no-website' }); continue; }

      const resolved = await resolveDomain(post.website, cfg.platformDomains);
      if ('eliminatedBy' in resolved) { products.push({ ...base, eliminatedBy: resolved.eliminatedBy }); continue; }
      base.url = resolved.url;
      base.domain = resolved.domain;

      const registeredAt = await getRegisteredAt(resolved.domain, cacheDir, cfg.cacheTtlDays);
      if (!registeredAt) { products.push({ ...base, eliminatedBy: 'domain-age' }); continue; }
      base.registeredAt = registeredAt;
      if (ageInDays(registeredAt) > cfg.maxDomainAgeDays) {
        products.push({ ...base, eliminatedBy: 'domain-age' }); continue;
      }

      const traffic = await provider.lookup(resolved.domain);
      if (!traffic) { products.push({ ...base, eliminatedBy: 'no-traffic-data' }); continue; }
      base.traffic = traffic;

      const failedRule = applyTrafficRules(traffic, cfg);
      if (failedRule) { products.push({ ...base, eliminatedBy: failedRule }); continue; }

      products.push({
        ...base, status: 'qualified',
        aitdkUrl: cfg.aitdkUrlTemplate.replace('{domain}', resolved.domain),
      });
    } catch (err) {
      products.push({ ...base, status: 'error', error: String(err) });
    }
  }

  const ranked = rankQualified(products);
  const report: DailyReport = { date, funnel: computeFunnel(ranked), products: ranked };

  mkdirSync(join(dataDir, 'daily'), { recursive: true });
  writeFileSync(join(dataDir, 'daily', `${date}.json`), JSON.stringify(report, null, 2));

  const indexPath = join(dataDir, 'index.json');
  type IndexRow = { date: string; total: number; qualified: number };
  const index: IndexRow[] = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : [];
  const row = { date, total: report.funnel.total, qualified: report.funnel.qualified };
  const next = [...index.filter((r) => r.date !== date), row].sort((a, b) => a.date.localeCompare(b.date));
  writeFileSync(indexPath, JSON.stringify(next, null, 2));

  return report;
}

// ---- CLI 入口 ----
const isMain = process.argv[1]?.endsWith('run-daily.ts');
if (isMain) {
  const dateArg = process.argv.find((a) => a.startsWith('--date='))?.slice(7);
  const date = dateArg ?? new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const phToken = process.env.PH_API_TOKEN;
  const tabKey = process.env.TABAPI_KEY;
  if (!phToken || !tabKey) { console.error('PH_API_TOKEN and TABAPI_KEY env required'); process.exit(1); }
  const cfg = loadConfig();
  const provider = createTabApiProvider(tabKey, join('data', 'cache'), cfg.cacheTtlDays);
  const report = await runDaily({ date, phToken, provider, cfg, dataDir: 'data' });
  console.log(`[niche-radar] ${date}: ${report.funnel.qualified}/${report.funnel.total} qualified`);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/run-daily.test.ts`
Expected: PASS(2 个用例)

- [ ] **Step 5: 全量测试回归**

Run: `npx vitest run`
Expected: 此前所有任务的用例全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/run-daily.ts tests/run-daily.test.ts
git commit -m "feat: daily pipeline orchestrator with data persistence and CLI"
```

---

### Task 9: Slack 推送

**Files:**
- Create: `src/slack.ts`
- Modify: `src/run-daily.ts`(CLI 入口末尾接推送)
- Test: `tests/slack.test.ts`

**Interfaces:**
- Consumes: `DailyReport`(Task 1)、`fetchWithRetry`(Task 2)。
- Produces: `buildDailyMessage(report: DailyReport): object`(Block Kit payload,纯函数);`buildFailureMessage(date: string, error: string): object`;`postToSlack(webhookUrl: string, payload: object): Promise<void>`。

- [ ] **Step 1: 写失败测试 `tests/slack.test.ts`**

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildDailyMessage, buildFailureMessage, postToSlack } from '../src/slack.js';
import type { DailyReport } from '../src/types.js';

afterEach(() => vi.unstubAllGlobals());

const report: DailyReport = {
  date: '2026-08-31',
  funnel: { total: 40, resolved: 25, newDomains: 6, hasTraffic: 3, qualified: 1 },
  products: [{
    name: 'Winner', tagline: 'wins', votes: 100, phUrl: 'https://ph/p/w',
    url: 'https://winner.io/', domain: 'winner.io',
    registeredAt: '2026-05-01T00:00:00Z',
    traffic: { monthlyVisits: 8000, sources: { direct: 0.3, search: 0.5, referral: 0.1, social: 0.1, mail: 0 } },
    status: 'qualified', aitdkUrl: 'https://aitdk.com/website/winner.io',
  }],
};

describe('buildDailyMessage', () => {
  it('包含域名、指标与漏斗摘要', () => {
    const text = JSON.stringify(buildDailyMessage(report));
    expect(text).toContain('winner.io');
    expect(text).toContain('8,000');           // 月访格式化
    expect(text).toContain('50%');             // 搜索占比
    expect(text).toContain('40');              // 漏斗 total
    expect(text).toContain('aitdk.com/website/winner.io');
  });
  it('零达标时明确说明(系统存活证明)', () => {
    const empty = { ...report, funnel: { ...report.funnel, qualified: 0 }, products: [] };
    expect(JSON.stringify(buildDailyMessage(empty))).toContain('0');
  });
});

describe('buildFailureMessage', () => {
  it('包含日期与错误', () => {
    const text = JSON.stringify(buildFailureMessage('2026-08-31', 'PH API down'));
    expect(text).toContain('2026-08-31');
    expect(text).toContain('PH API down');
  });
});

describe('postToSlack', () => {
  it('POST JSON 到 webhook', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mock);
    await postToSlack('https://hooks.slack.com/services/X', { text: 'hi' });
    expect(mock.mock.calls[0][0]).toBe('https://hooks.slack.com/services/X');
    expect((mock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/slack.test.ts`
Expected: FAIL,模块不存在

- [ ] **Step 3: 实现 `src/slack.ts`**

```typescript
import type { DailyReport, ProductResult } from './types.js';
import { fetchWithRetry } from './http.js';

const pct = (n: number) => `${Math.round(n * 100)}%`;
const num = (n: number) => n.toLocaleString('en-US');

function productBlock(p: ProductResult): object {
  const t = p.traffic!;
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `*<${p.url}|${p.domain}>* — ${p.name}: ${p.tagline}`,
        `注册 ${p.registeredAt?.slice(0, 10)} · 月访 ${num(t.monthlyVisits)} · 搜索 ${pct(t.sources.search)} · 直访 ${pct(t.sources.direct)}`,
        `<${p.phUrl}|PH 页面> · <${p.aitdkUrl}|AITDK 关键词>`,
      ].join('\n'),
    },
  };
}

export function buildDailyMessage(report: DailyReport): object {
  const { funnel } = report;
  const qualified = report.products.filter((p) => p.status === 'qualified');
  const header = qualified.length > 0
    ? `📡 niche-radar ${report.date}:${qualified.length} 个达标站点`
    : `📡 niche-radar ${report.date}:今日 0 个达标`;
  return {
    text: header,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: header } },
      ...qualified.map(productBlock),
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `漏斗:${funnel.total} 产品 → ${funnel.resolved} 有效域名 → ${funnel.newDomains} 新站 → ${funnel.hasTraffic} 有流量 → ${funnel.qualified} 达标`,
        }],
      },
    ],
  };
}

export function buildFailureMessage(date: string, error: string): object {
  return { text: `🚨 niche-radar ${date} 运行失败:${error}` };
}

export async function postToSlack(webhookUrl: string, payload: object): Promise<void> {
  await fetchWithRetry(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
```

- [ ] **Step 4: 修改 `src/run-daily.ts` CLI 入口**,把最后的 `console.log` 段替换为:

```typescript
  const webhook = process.env.SLACK_WEBHOOK_URL;
  try {
    const report = await runDaily({ date, phToken, provider, cfg, dataDir: 'data' });
    console.log(`[niche-radar] ${date}: ${report.funnel.qualified}/${report.funnel.total} qualified`);
    if (webhook) await postToSlack(webhook, buildDailyMessage(report));
  } catch (err) {
    if (webhook) await postToSlack(webhook, buildFailureMessage(date, String(err)));
    throw err;
  }
```

顶部加 `import { buildDailyMessage, buildFailureMessage, postToSlack } from './slack.js';`。webhook 未配置时只打日志不推送(本地跑不需要 Slack)。

- [ ] **Step 5: 跑测试确认通过 + 回归**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/slack.ts src/run-daily.ts tests/slack.test.ts
git commit -m "feat: Slack daily digest and failure alert via incoming webhook"
```

---

### Task 10: GitHub Pages 可视化

**Files:**
- Create: `site/index.html`, `site/app.js`, `site/style.css`

**Interfaces:**
- Consumes: `data/index.json` 与 `data/daily/<date>.json`(Task 8 的落盘格式);部署后数据挂在站点根的 `./data/` 路径下(Task 11 的 workflow 负责拼装)。

前端无构建、无框架、无单测,验收方式是本地起静态服务人工核对(数据渲染逻辑简单,漏斗数字与 JSON 比对即可)。

- [ ] **Step 1: 造本地验收样本**

把 Task 8 测试产出的结构手工存一份:`data/daily/2026-08-31.json`(可跑 `npm run once -- --date=2026-08-31` 用假 env 生成失败也行,直接手写下面这份):

```json
{
  "date": "2026-08-31",
  "funnel": { "total": 40, "resolved": 25, "newDomains": 6, "hasTraffic": 3, "qualified": 1 },
  "products": [
    {
      "name": "Winner", "tagline": "wins at things", "votes": 100,
      "phUrl": "https://www.producthunt.com/posts/winner",
      "url": "https://winner.io/", "domain": "winner.io",
      "registeredAt": "2026-05-01T00:00:00Z",
      "traffic": { "monthlyVisits": 8000, "sources": { "direct": 0.3, "search": 0.5, "referral": 0.1, "social": 0.1, "mail": 0 } },
      "status": "qualified", "aitdkUrl": "https://aitdk.com/website/winner.io"
    },
    {
      "name": "OldSite", "tagline": "been around", "votes": 50,
      "phUrl": "https://www.producthunt.com/posts/oldsite",
      "url": "https://oldsite.com/", "domain": "oldsite.com",
      "registeredAt": "2019-01-01T00:00:00Z",
      "status": "eliminated", "eliminatedBy": "domain-age"
    }
  ]
}
```

以及 `data/index.json`:

```json
[{ "date": "2026-08-31", "total": 40, "qualified": 1 }]
```

- [ ] **Step 2: 写 `site/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>niche-radar</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <h1>📡 niche-radar</h1>
    <select id="date-picker"></select>
  </header>
  <section id="funnel"></section>
  <section id="qualified"><h2>达标站点</h2><div id="qualified-list"></div></section>
  <details id="eliminated"><summary>被淘汰的产品</summary><div id="eliminated-list"></div></details>
  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 3: 写 `site/app.js`**

```javascript
const ELIMINATED_LABEL = {
  'no-website': '无官网链接', 'platform-domain': '平台域名', 'resolve-failed': '域名解析失败',
  'domain-age': '域名超过一年', 'no-traffic-data': '无流量数据',
  'monthly-visits': '月访问量不足', 'search-share': '搜索占比不足', 'direct-share': '直访占比不足',
};
const pct = (n) => `${Math.round(n * 100)}%`;
const num = (n) => n.toLocaleString('en-US');

async function loadIndex() {
  return (await fetch('./data/index.json')).json();
}
async function loadDay(date) {
  return (await fetch(`./data/daily/${date}.json`)).json();
}

function renderFunnel(f) {
  const steps = [
    ['产品', f.total], ['有效域名', f.resolved], ['新站(≤1年)', f.newDomains],
    ['有流量数据', f.hasTraffic], ['达标', f.qualified],
  ];
  document.getElementById('funnel').innerHTML = steps
    .map(([label, n]) => `<div class="funnel-step"><b>${n}</b><span>${label}</span></div>`)
    .join('<div class="funnel-arrow">→</div>');
}

function renderQualified(products) {
  const list = products.filter((p) => p.status === 'qualified');
  document.getElementById('qualified-list').innerHTML = list.length === 0
    ? '<p class="empty">今日无达标站点</p>'
    : list.map((p) => `
      <article class="card">
        <h3><a href="${p.url}" target="_blank" rel="noopener">${p.domain}</a></h3>
        <p>${p.name} — ${p.tagline}</p>
        <dl>
          <div><dt>注册</dt><dd>${p.registeredAt.slice(0, 10)}</dd></div>
          <div><dt>月访</dt><dd>${num(p.traffic.monthlyVisits)}</dd></div>
          <div><dt>搜索</dt><dd>${pct(p.traffic.sources.search)}</dd></div>
          <div><dt>直访</dt><dd>${pct(p.traffic.sources.direct)}</dd></div>
        </dl>
        <p class="links">
          <a href="${p.phUrl}" target="_blank" rel="noopener">PH 页面</a>
          <a href="${p.aitdkUrl}" target="_blank" rel="noopener">AITDK 关键词</a>
        </p>
      </article>`).join('');
}

function renderEliminated(products) {
  const rest = products.filter((p) => p.status !== 'qualified');
  document.getElementById('eliminated-list').innerHTML = `
    <table><thead><tr><th>产品</th><th>域名</th><th>原因</th></tr></thead><tbody>
    ${rest.map((p) => `<tr>
      <td><a href="${p.phUrl}" target="_blank" rel="noopener">${p.name}</a></td>
      <td>${p.domain ?? '—'}</td>
      <td>${p.status === 'error' ? `错误:${p.error ?? ''}` : ELIMINATED_LABEL[p.eliminatedBy] ?? p.eliminatedBy}</td>
    </tr>`).join('')}
    </tbody></table>`;
}

async function show(date) {
  const day = await loadDay(date);
  renderFunnel(day.funnel);
  renderQualified(day.products);
  renderEliminated(day.products);
}

const index = await loadIndex();
const picker = document.getElementById('date-picker');
picker.innerHTML = [...index].reverse()
  .map((r) => `<option value="${r.date}">${r.date}(${r.qualified} 达标)</option>`)
  .join('');
picker.addEventListener('change', () => show(picker.value));
if (index.length > 0) await show(index[index.length - 1].date);
```

- [ ] **Step 4: 写 `site/style.css`**(简洁、系统字体、亮暗自适应)

```css
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0 auto; max-width: 860px; padding: 1rem; }
header { display: flex; justify-content: space-between; align-items: center; }
#funnel { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin: 1rem 0; }
.funnel-step { text-align: center; padding: .5rem .9rem; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: .5rem; }
.funnel-step b { display: block; font-size: 1.3rem; }
.funnel-step span { font-size: .75rem; opacity: .7; }
.funnel-arrow { opacity: .5; }
.card { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: .6rem; padding: 1rem; margin-bottom: .8rem; }
.card h3 { margin: 0 0 .3rem; }
.card dl { display: flex; gap: 1.2rem; margin: .5rem 0; }
.card dt { font-size: .7rem; opacity: .7; }
.card dd { margin: 0; font-weight: 600; }
.links a { margin-right: 1rem; }
.empty { opacity: .6; }
table { width: 100%; border-collapse: collapse; font-size: .85rem; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
details { margin-top: 1.5rem; }
```

- [ ] **Step 5: 本地验收**

```bash
mkdir -p /tmp/nr-site && cp -r site/* /tmp/nr-site/ && cp -r data /tmp/nr-site/data
npx serve /tmp/nr-site -l 5173
```

浏览器开 `http://localhost:5173`,核对:日期下拉有 2026-08-31;漏斗显示 40→25→6→3→1;达标卡片显示 winner.io、月访 8,000、搜索 50%;淘汰表里 OldSite 原因为"域名超过一年"。

- [ ] **Step 6: Commit**

```bash
git add site/ data/
git commit -m "feat: static GitHub Pages dashboard with funnel and daily list"
```

---

### Task 11: GitHub Actions workflows + README

**Files:**
- Create: `.github/workflows/daily.yml`, `.github/workflows/pages.yml`, `README.md`

**Interfaces:**
- Consumes: `npm run daily`(Task 8/9);`site/` + `data/`(Task 10 的路径约定:数据拼到站点的 `./data/`)。
- 需要仓库 Secrets:`PH_API_TOKEN`、`TABAPI_KEY`、`SLACK_WEBHOOK_URL`;Pages 设置选 "GitHub Actions" 作为 source。

- [ ] **Step 1: 写 `.github/workflows/daily.yml`**

```yaml
name: daily
on:
  schedule:
    - cron: '0 1 * * *'   # UTC 01:00 ≈ 北京 09:00
  workflow_dispatch:
    inputs:
      date:
        description: 'YYYY-MM-DD(缺省为 UTC 昨天)'
        required: false

permissions:
  contents: write

concurrency: daily

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: Run pipeline
        env:
          PH_API_TOKEN: ${{ secrets.PH_API_TOKEN }}
          TABAPI_KEY: ${{ secrets.TABAPI_KEY }}
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
        run: |
          if [ -n "${{ inputs.date }}" ]; then
            npm run once -- --date=${{ inputs.date }}
          else
            npm run daily
          fi
      - name: Commit data
        run: |
          git config user.name 'github-actions[bot]'
          git config user.email 'github-actions[bot]@users.noreply.github.com'
          git add data/
          git diff --cached --quiet || git commit -m "data: $(date -u +%F) run"
          git push
```

失败告警不需要额外 step:管线 catch 里已推 Slack 失败消息后 rethrow,job 自然标红。

- [ ] **Step 2: 写 `.github/workflows/pages.yml`**

```yaml
name: pages
on:
  push:
    branches: [main]
    paths: ['data/**', 'site/**']
  workflow_dispatch:

permissions:
  pages: write
  id-token: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - name: Assemble site
        run: |
          mkdir -p _site
          cp -r site/* _site/
          cp -r data _site/data
      - uses: actions/upload-pages-artifact@v3
        with: { path: _site }
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 3: 写 `README.md`**

内容(简洁,约 40 行):项目一句话简介;架构图(spec §4 的文字版);本地运行方法(`cp .env.example` 不用——直接 `PH_API_TOKEN=x TABAPI_KEY=y npm run once -- --date=...`);三个 Secrets 的配置说明;Pages 开启步骤(Settings → Pages → Source: GitHub Actions);阈值调整指向 `config.json`;spec 与 plan 文档链接。

- [ ] **Step 4: 本地校验 workflow 语法**

Run: `npx --yes yaml-lint .github/workflows/daily.yml .github/workflows/pages.yml`(或 `python3 -c "import yaml,sys;[yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/*.yml`)
Expected: 无语法错误

- [ ] **Step 5: Commit**

```bash
git add .github/ README.md
git commit -m "chore: daily cron and pages deploy workflows, README"
```

---

### Task 12: 联调验收(需要真实密钥,人工参与)

**Files:**
- Modify(如有需要): `src/pipeline/traffic/tabapi.ts`, `tests/fixtures/tabapi-traffic.json`, `config.json`(aitdkUrlTemplate)

前置:用户提供 `PH_API_TOKEN`、`TABAPI_KEY`、`SLACK_WEBHOOK_URL`(spec §11)。

- [ ] **Step 1: 校正 TabAPI 对接**

```bash
TABAPI_KEY=<真实key> npm run probe -- producthunt.com
```

对照输出:若字段名与 `tests/fixtures/tabapi-traffic.json` 不一致,用真实响应(可脱敏)覆盖 fixture、修改 `parseTabApiResponse` 与 `BASE` URL,重跑 `npx vitest run tests/pipeline/tabapi.test.ts` 至 PASS,commit `fix: align TabAPI parsing with real response`。

- [ ] **Step 2: 校验 AITDK 链接模板**

浏览器打开 `https://aitdk.com/website/producthunt.com` 确认路径有效;无效则找到正确路径改 `config.json` 的 `aitdkUrlTemplate`,commit。

- [ ] **Step 3: 真实日期端到端**

```bash
PH_API_TOKEN=<真实> TABAPI_KEY=<真实> SLACK_WEBHOOK_URL=<真实> npm run once -- --date=<前天日期>
```

核对:stdout 摘要;`data/daily/<date>.json` 中各状态分布合理;Slack 收到消息;`data/cache/` 有缓存文件。**重跑同一命令**确认第二次几乎瞬间完成(缓存命中,TabAPI 零消耗)。

- [ ] **Step 4: 推 GitHub + 开 Pages + 配 Secrets**

```bash
gh repo create <owner>/niche-radar --public --source=. --push
```

仓库 Settings:三个 Secrets;Pages Source 选 GitHub Actions。手动 `workflow_dispatch` 触发 daily(填一个日期),确认:Actions 绿、data 提交、Slack 推送、Pages 页面可访问且数据正确。

- [ ] **Step 5: 收尾 Commit & 汇报**

验收记录(哪天的数据、几个达标、credit 消耗量)汇报给用户,由用户决定阈值是否需要调。

---

## Self-Review 记录

- **Spec 覆盖**:§3 规则→Task 7;§4 架构→Task 8/11;§5 管线五阶段→Task 3/4/5/6/7,缓存→Task 2/4/6;§6 数据格式→Task 1(类型)/8(落盘);§7 Slack(含 0 达标与失败告警)→Task 9;§8 Pages(日期切换/卡片/漏斗/淘汰原因)→Task 10/11;§9 错误处理→Task 2(超时重试)/8(单品隔离);§10 测试(fixture、`npm run once`)→各任务 TDD + Task 8;§11 前置密钥→Task 11/12;§12 YAGNI 未引入超纲内容;§13 风险中 TabAPI 未知 schema 已用 probe + 隔离解析函数对冲。无遗漏。
- **占位符扫描**:无 TBD/TODO;Task 6 的 TabAPI 真实 schema 是显式声明的外部未知量,附了具体校正流程,非占位符。
- **类型一致性**:`EliminatedBy` 枚举值在 Task 1 定义、Task 3/7/8 使用、Task 10 前端 label 表逐一对应;`Traffic.sources` 五键在 Task 1/6/7/9/10 一致;`runDaily` 签名与 Task 12 调用一致。
