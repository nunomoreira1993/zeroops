import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SITE_QUERIES } from './collectors/site-database.collector.js';

const script = readFileSync(
  new URL('../../../../../deploy/health-agent/zeroops-health-agent.sh', import.meta.url),
  'utf8',
);
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const fromScript = (name: string) => {
  const match = new RegExp(`^${name}="([\\s\\S]*?)"$`, 'm').exec(script);
  if (!match) throw new Error(`${name} em falta no agente`);
  const dueAt = /^DUE_AT="(.*)"$/m.exec(script)![1]!;
  return squash(
    match[1]!.replaceAll('${DUE_AT}', dueAt).replaceAll('${PAID_NOT_INTEGRATED_MINUTES}', '15'),
  );
};

describe('health agent script', () => {
  it('runs exactly the same site queries as the collector', () => {
    expect(fromScript('SQL_SHIFT4')).toBe(squash(SITE_QUERIES.shift4));
    expect(fromScript('SQL_WALLET')).toBe(squash(SITE_QUERIES.wallet));
    expect(fromScript('SQL_DIVERGENCE')).toBe(squash(SITE_QUERIES.divergence));
    expect(fromScript('SQL_PAID_NOT_INTEGRATED')).toBe(squash(SITE_QUERIES.paidNotIntegrated(15)));
  });
});
