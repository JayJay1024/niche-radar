import type { Traffic } from '../../types.js';

export interface TrafficProvider {
  /** 返回 null 表示该域名无流量数据(常见于新站),不是错误 */
  lookup(domain: string): Promise<Traffic | null>;
}
