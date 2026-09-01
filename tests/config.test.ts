import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('loadConfig', () => {
  it('加载仓库根目录的 config.json 并通过校验', () => {
    const cfg = loadConfig();
    expect(cfg.maxDomainAgeDays).toBe(365);
    expect(cfg.minSearchShare).toBeGreaterThan(0);
    expect(cfg.platformDomains).toContain('vercel.app');
  });

  it('缺字段时抛出带字段名的错误', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-'));
    const p = join(dir, 'config.json');
    writeFileSync(p, JSON.stringify({ maxDomainAgeDays: 365 }));
    expect(() => loadConfig(p)).toThrow(/minMonthlyVisits/);
  });
});
