import type { DailyReport, ProductResult } from './types.js';
import { fetchWithRetry } from './http.js';

const pct = (n: number) => `${Math.round(n * 100)}%`;
const num = (n: number) => n.toLocaleString('en-US');
const mrkdwnEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function productBlock(p: ProductResult): object {
  const t = p.traffic!;
  const name = mrkdwnEsc(p.name);
  const tagline = mrkdwnEsc(p.tagline);
  const domain = mrkdwnEsc(p.domain ?? '');
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `*<${p.url}|${domain}>* — ${name}: ${tagline}`,
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
