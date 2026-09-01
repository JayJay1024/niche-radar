# niche-radar 设计文档

日期:2026-09-01
状态:已与需求方确认的设计,待实施

## 1. 目标

每天自动完成:拉取 ProductHunt 前一天发布的产品 → 解析产品真实域名 → 用公开/第三方数据补全域名注册日期、月访问量、流量结构 → 按筛选规则过滤出"新域名但已拿到搜索流量"的站点 → 推送 Slack 并展示在 GitHub Pages 上,供人工进一步分析其非品牌搜索词,判断关键词赛道机会。

**筛选思路**(来自需求方):一个注册不到一年的新站,如果月访问量达标且搜索流量、直接访问占比都不低,说明它所在的关键词赛道对新站友好、尚有机会。

## 2. 已确认的决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 项目名 | `niche-radar` | 按产出物(发现细分赛道)命名,不绑定数据源,日后可扩展 PH 以外的榜单 |
| 仓库可见性 | 公开 | GitHub Pages 免费仅对公开仓库开放;榜单数据源自公开信息,无泄密风险;密钥走 Actions Secrets |
| 运行时 | GitHub Actions scheduled workflow | 任务形态是每天一次的批处理 ETL,无入站请求、无延迟要求;Actions 免费、无子请求限制、日志/密钥/手动重跑全内置。明确不用 Cloudflare Worker(免费版 50 子请求/次会超限,调试重跑不便) |
| 存储 | git 仓库本身(JSON 文件) | 数据量小(每天几十条);免费、带版本历史、天然可 diff、无需数据库 |
| 语言 | TypeScript(Node 22 + vitest) | 团队常用;逻辑很薄,无选型价值 |
| 域名注册日期 | RDAP 协议直查 | 免费、标准、无供应商依赖 |
| 流量数据 | `TrafficProvider` 接口,第一版接 TabAPI | 流量估算是商品化数据,可替换性比选对第一家重要;TabAPI 是 AITDK 官方 API,按 credit 计费 |
| 关键词分析 | 第一版不自动化 | 需求方本来就计划人工判断非品牌词;榜单里放 AITDK 跳转链接即可,成本为零 |

## 3. 筛选规则(全部放 `config.json`,可调,不写死)

1. 域名注册时间 ≤ 365 天(代表新站);
2. 月访问量 > 3,000(证明拿到流量);
3. 搜索流量占比 > 20% 且 直接访问占比 > 20%(有搜索量且有二次访问,证明网站解决真实需求)。

规则按数据获取成本从低到高的顺序执行(见管线),不达标即淘汰,记录淘汰原因。

## 4. 总体架构

```
GitHub Actions (cron, 每天 UTC 01:00 ≈ 北京 09:00)
  └─ daily.yml
       ├─ npm run daily          # 采集管线,产出 data/daily/<date>.json
       ├─ git commit & push      # 数据回写仓库
       ├─ Slack 推送             # incoming webhook
       └─ 触发 pages.yml         # 数据更新后重新发布可视化

GitHub Pages
  └─ pages.yml:构建 site/ 静态页并发布
```

无数据库、无服务器,状态全部在 git 里。

## 5. 采集管线(`src/pipeline/`)

各阶段是纯函数,按成本从低到高串联;任一产品在任一阶段失败或被淘汰,不影响其余产品继续:

1. **fetch-posts** — PH GraphQL API(`posts(postedAfter, postedBefore)`,前一天 UTC 全天)拉产品:名称、tagline、票数、topics、`website` 跳转链接。限流 6250 复杂度点/15 分钟,每天一次用量极低。
2. **resolve-domain** — 跟随 `producthunt.com/r/...` 重定向拿最终 URL,剥离 UTM/ref 参数,取注册域名(eTLD+1)。剔除平台域名:`*.vercel.app`、`*.github.io`、`*.netlify.app`、App Store、Google Play、Chrome 商店等,黑名单维护在 `config.json`,这些域名的注册日期无意义。
3. **domain-age** — RDAP 查询注册日期,只留 ≤ 365 天。免费,所以放在付费查询之前。
4. **traffic** — 仅对通过前面所有关卡的域名调用 `TrafficProvider.lookup(domain)`,返回月访问量、流量来源占比(direct/search/referral/social/mail)。第一版实现 `TabApiProvider`;接口设计保证换供应商只改一个文件。
5. **filter-rank** — 应用规则 2、3,按月访问量排序输出。

### 缓存

`data/cache/<domain>.json` 存 RDAP 与流量查询结果,带 `fetchedAt`;30 天内命中缓存不重查。目的:重跑/补数不重复消耗 TabAPI credit。

## 6. 数据文件格式

```
data/
  cache/<domain>.json      # { domain, rdap: {...}, traffic: {...}, fetchedAt }
  daily/2026-09-01.json    # 当天全量结果
  index.json               # [{ date, total, qualified }] 供前端历史导航
```

`daily/<date>.json` 中每个产品记录:PH 信息(名称、tagline、票数、PH 链接)、解析出的域名、各阶段结果、最终状态 `qualified | eliminated | error` 及 `eliminatedBy`(哪条规则/哪个阶段淘汰)。达标站点附 AITDK 网页版跳转链接,供人工看关键词。

## 7. Slack 推送

- Incoming webhook,URL 存 Actions Secrets(`SLACK_WEBHOOK_URL`)。
- 每天一条 Block Kit 消息:达标站点列表(域名、注册日期、月访、搜索/直访占比、PH 链接、AITDK 链接)+ 当天漏斗摘要(N 个产品 → 各阶段剩多少)。
- 无达标站点也发"今日 0 个",证明系统存活。
- 管线整体失败(PH API 或 TrafficProvider 不可用)时发错误告警,而非沉默。

## 8. GitHub Pages 可视化

- 纯静态单页,原生 HTML + JS(不引框架),读 `index.json` 和 `daily/<date>.json` 渲染。
- 功能:日期切换;达标站点指标卡片;漏斗视图(当天总数 → 每阶段存活数),用于日后调阈值;淘汰产品可展开查看淘汰原因。
- 部署:`pages.yml` 在数据更新后把 `site/` + `data/` 发布到 Pages。

## 9. 错误处理

- 单个域名任何一步失败(跳转超时、RDAP 无数据、流量 API 报错)→ 该产品记为 `error`,写明原因,继续处理其余产品。
- PH API 或 TrafficProvider 整体不可用 → 任务失败,Actions 标红 + Slack 告警。
- 外部请求统一带超时(10s)与一次重试。

## 10. 测试

- vitest 单测:过滤规则、域名清洗(跳转参数剥离、eTLD+1 提取)、平台黑名单、缓存读写、漏斗统计。
- 外部 API 用录制的 fixture(PH GraphQL 响应、RDAP 响应、TabAPI 响应各一份真实样本)。
- 提供 `npm run once -- --date=YYYY-MM-DD` 本地跑任意日期,用于验证与补数。

## 11. 前置条件(需求方准备)

1. ProductHunt 开发者应用 token(免费)→ Secret `PH_API_TOKEN`;
2. TabAPI key,并确认定价可接受(若单价过高,实施前更换 TrafficProvider 供应商)→ Secret `TABAPI_KEY`;
3. Slack incoming webhook → Secret `SLACK_WEBHOOK_URL`。

## 12. 明确不做(YAGNI)

- 关键词数据自动抓取与品牌词判别(人工步骤);
- 数据库、后端服务;
- 多数据源(HackerNews 等)——架构上留了空间(fetch-posts 阶段可并列),但本期不做;
- 历史数据回填(PH API 支持按日期查,需要时用 `npm run once` 手动补)。

## 13. 已知风险

- **流量数据盲区**:Similarweb 系估算对"新站 + 月访 3000 上下"恰好最不可靠,会有漏报,当"宁缺毋滥"的过滤器使用;
- **TabAPI 为小厂服务**:稳定性与数据质量需小规模验证;`TrafficProvider` 接口即为此风险的对冲;
- **GitHub Actions cron 高峰期可能延迟几分钟到几十分钟**:对每日榜单场景可接受。
