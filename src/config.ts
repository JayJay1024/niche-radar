import { readFileSync } from 'node:fs';
import type { Config } from './types.js';

const REQUIRED: (keyof Config)[] = [
  'maxDomainAgeDays',
  'minMonthlyVisits',
  'minSearchShare',
  'minDirectShare',
  'cacheTtlDays',
  'platformDomains',
  'aitdkUrlTemplate',
];

export function loadConfig(path = 'config.json'): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  for (const key of REQUIRED) {
    if (raw[key] === undefined) throw new Error(`config.json missing field: ${key}`);
  }
  return raw as Config;
}
