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
