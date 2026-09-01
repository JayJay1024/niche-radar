# niche-radar

每天自动发现注册时间短但已拿到搜索流量的新网站,助力关键词赛道机会识别。

## 架构

```
GitHub Actions (cron, 每天 UTC 01:00)
  └─ daily.yml
       ├─ npm run daily          # 采集管线,产出 data/daily/<date>.json
       ├─ git commit & push      # 数据回写仓库
       ├─ Slack 推送             # 发送发现的网站列表
       └─ 触发 pages.yml         # 数据更新后重新发布可视化

GitHub Pages
  └─ pages.yml:构建 site/ 静态页并发布
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

Pages 会自动在每次 `data/` 或 `site/` 目录更新时重新部署。

## 阈值调整

所有过滤规则存储在 `config.json`,支持实时调整:

- `maxDomainAgeDays`: 域名最大注册日期(天)
- `minMonthlyVisits`: 最小月访问量
- `minSearchShare`: 最小搜索流量占比
- `minDirectShare`: 最小直接访问占比
- `platformDomains`: 排除的平台域名黑名单

## 文档

- [设计文档](docs/superpowers/specs/2026-09-01-niche-radar-design.md)
- [实现计划](docs/superpowers/plans/2026-09-01-niche-radar.md)
