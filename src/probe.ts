// 用法: TABAPI_KEY=xxx npm run probe -- coolapp.io
// 打真实 TabAPI,打印原始响应,用于录制/校正 tests/fixtures/tabapi-traffic.json
const domain = process.argv[2];
if (!domain) { console.error('usage: npm run probe -- <domain>'); process.exit(1); }
const key = process.env.TABAPI_KEY;
if (!key) { console.error('TABAPI_KEY env required'); process.exit(1); }
const res = await fetch(`https://tabapi.com/api/v1/domains/${encodeURIComponent(domain)}/traffic?months=3`, {
  headers: { Authorization: `Bearer ${key}` },
});
console.log('status:', res.status);
console.log(JSON.stringify(await res.json(), null, 2));
