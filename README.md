# niche-radar

每天自动发现注册时间短但已拿到搜索流量的新网站,助力关键词赛道机会识别。

## 架构

```
GitHub Actions (cron, 每天 UTC 01:00)
  └─ daily.yml
       ├─ npm run daily          # 采集管线,产出 data/daily/<date>.json
       ├─ git commit & push      # 数据回写仓库
       ├─ Slack 推送             # 发送发现的网站列表
       └─ 完成后触发 pages.yml    # workflow_run 机制确保数据同步

GitHub Pages
  └─ pages.yml:daily 成功后、数据/site 更新时、或手动触发时部署
```

无数据库、无服务器,状态全部在 git 里。

## 本地运行

```bash
# 运行指定日期的采集
PH_API_TOKEN=<token> TABAPI_KEY=<key> npm run once -- --date=2026-09-01

# 测试
npm test
```

## Secrets 配置

在仓库 Settings → Secrets and variables → Actions 中配置:

- `PH_API_TOKEN`: ProductHunt API token(免费,开发者应用)
- `TABAPI_KEY`: TabAPI key 用于查询网站月访问量
- `SLACK_WEBHOOK_URL`: Slack incoming webhook URL(可选,无配置时仅日志输出)

## GitHub Pages 开启

1. 在仓库 Settings → Pages
2. Source 选择: **GitHub Actions**

pages.yml 会在每次 daily.yml 成功完成后自动部署(通过 workflow_run),也可手动触发或在 `data/` / `site/` 目录更新时部署。

## 阈值调整

所有过滤规则存储在 `config.json`,支持实时调整:

- `maxDomainAgeDays`: 域名最大注册日期(天)
- `minMonthlyVisits`: 最小月访问量
- `minSearchShare`: 最小搜索流量占比
- `minDirectShare`: 最小直接访问占比
- `minVotes`: PH 拉取时低于此票数即停止翻页(全量拉取会耗尽 API 配额)
- `maxPosts`: 单日拉取产品数上限
- `platformDomains`: 排除的平台域名黑名单
- `detailUrlTemplate`: 达标站点"流量详情"外链模板

## 文档

- [设计文档](docs/superpowers/specs/2026-09-01-niche-radar-design.md)
- [实现计划](docs/superpowers/plans/2026-09-01-niche-radar.md)
