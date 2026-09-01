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
import { buildDailyMessage, buildFailureMessage, postToSlack } from './slack.js';

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
  const webhook = process.env.SLACK_WEBHOOK_URL;
  try {
    const report = await runDaily({ date, phToken, provider, cfg, dataDir: 'data' });
    console.log(`[niche-radar] ${date}: ${report.funnel.qualified}/${report.funnel.total} qualified`);
    if (webhook) await postToSlack(webhook, buildDailyMessage(report));
  } catch (err) {
    if (webhook) {
      try {
        await postToSlack(webhook, buildFailureMessage(date, String(err)));
      } catch (slackErr) {
        console.error(`[niche-radar] Slack alert failed: ${String(slackErr)}`);
      }
    }
    throw err;
  }
}
