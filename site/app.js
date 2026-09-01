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
