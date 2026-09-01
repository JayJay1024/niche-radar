export interface Config {
  maxDomainAgeDays: number;
  minMonthlyVisits: number;
  minSearchShare: number;
  minDirectShare: number;
  /** PH 拉取:票数低于此值停止翻页(0=不限);全量拉取会耗尽 API 复杂度配额 */
  minVotes: number;
  /** PH 拉取:单日产品数上限 */
  maxPosts: number;
  cacheTtlDays: number;
  platformDomains: string[];
  /** 达标站点"流量详情"外链模板,{domain} 占位 */
  detailUrlTemplate: string;
}

export interface Traffic {
  monthlyVisits: number;
  /** 各来源占比,0–1 小数 */
  sources: { direct: number; search: number; referral: number; social: number; mail: number };
  /** TabAPI 同一响应附带的头部自然搜索词(免费),供人工判断非品牌词 */
  topKeywords?: { name: string; volume: number }[];
}

export type EliminatedBy =
  | 'no-website'
  | 'platform-domain'
  | 'resolve-failed'
  | 'domain-age'
  | 'no-traffic-data'
  | 'monthly-visits'
  | 'search-share'
  | 'direct-share';

export interface ProductResult {
  name: string;
  tagline: string;
  votes: number;
  phUrl: string;
  url?: string; // 解析后的最终 URL(已清参)
  domain?: string; // eTLD+1
  registeredAt?: string; // ISO 8601
  traffic?: Traffic;
  status: 'qualified' | 'eliminated' | 'error';
  eliminatedBy?: EliminatedBy;
  error?: string;
  detailUrl?: string; // 流量详情外链,仅 qualified 填
}

export interface Funnel {
  total: number; // PH 当天产品数
  resolved: number; // 解析出有效非平台域名
  newDomains: number; // 注册 ≤ maxDomainAgeDays
  hasTraffic: number; // 拿到流量数据
  qualified: number; // 通过全部规则
}

export interface DailyReport {
  date: string; // YYYY-MM-DD (UTC)
  funnel: Funnel;
  products: ProductResult[];
}
