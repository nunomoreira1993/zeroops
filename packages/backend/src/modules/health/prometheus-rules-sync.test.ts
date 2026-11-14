import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { healthSettingsSchema } from '../../../../contracts/src/index.js';
import { alertRuleCatalog } from '../../../../contracts/src/alert-rules.js';
import type { Database } from '../../database/database.js';
import type { HealthRepository } from './health.repository.js';
import { PrometheusRulesSync, renderAlertRules } from './prometheus-rules-sync.js';

describe('renderAlertRules', () => {
  it('separa discos locais das partilhas e exclui o NFS interno do alerta de capacidade', () => {
    for (const id of ['EspacoDiscoBaixo', 'EspacoDiscoCritico', 'InodesBaixos']) {
      expect(alertRuleCatalog.find((rule) => rule.id === id)?.expr).toContain(
        'fstype!~"tmpfs|overlay|squashfs|nfs|nfs4|cifs|smbfs|fuse.sshfs"',
      );
    }
    const unavailable = alertRuleCatalog.find((rule) => rule.id === 'PartilhaRedeIndisponivel');
    expect(unavailable?.expr).toContain('node_filesystem_device_error');
    expect(unavailable?.expr).not.toContain('device!~');
    const capacity = alertRuleCatalog.find((rule) => rule.id === 'PartilhaRedeQuaseCheia');
    expect(capacity?.expr.match(/device!~"172\[\.\]16\[\.\]1\[\.\]\.\*"/g)).toHaveLength(2);
    const rules = renderAlertRules('', {});
    expect(rules).toContain('alert: PartilhaRedeIndisponivel');
    expect(rules).toContain('alert: PartilhaRedeQuaseCheia');
    expect(renderAlertRules('pizzamovil', {})).not.toContain('PartilhaRede');
  });

  it('gera as regras do catálogo com limiares, duração e seletor do site', () => {
    const pizzahut = renderAlertRules('', {});
    expect(pizzahut).toContain('  - name: ibm_i');
    expect(pizzahut).toContain('      - alert: DtqClientesTaxaFalhas');
    expect(pizzahut).toContain('sum by (instance, env)');
    expect(pizzahut).toContain('expr: "probe_success{project=\\"\\"} == 0"');
    expect(pizzahut).toContain('expr: "zeroops_dtq_users_seconds > 5"');
    expect(pizzahut).toContain('for: 15m');
    expect(pizzahut).not.toContain('%T%');
    expect(pizzahut).not.toContain('%FOR%');

    const movil = renderAlertRules('pizzamovil', {});
    expect(movil).toContain('  - name: disponibilidade-pizzamovil');
    expect(movil).toContain('probe_success{project=\\"pizzamovil\\"} == 0');
    expect(movil).not.toContain('Db2Indisponivel');
  });

  it('aplica as alterações do projeto e omite as regras desativadas', () => {
    const settings = healthSettingsSchema.parse({
      alertRules: {
        DtqClientesLento: { threshold: 8, forMinutes: 20, criticality: 'critica' },
        DtqErrosNoLog: { enabled: false },
      },
    });
    const rules = renderAlertRules('', settings.alertRules);
    expect(rules).toContain('expr: "zeroops_dtq_users_seconds > 8"');
    expect(rules).toMatch(
      /alert: DtqClientesLento\n.*\n\s+for: 20m\n\s+labels: \{ severity: critical \}/,
    );
    expect(rules).not.toContain('DtqErrosNoLog');
    expect(renderAlertRules('pizzamovil', { SiteIndisponivel: { enabled: false } })).toContain(
      'alert: RespostaLenta',
    );
  });

  it('rejeita regras desconhecidas e limiares fora dos limites', () => {
    const parse = (alertRules: object) => healthSettingsSchema.safeParse({ alertRules }).success;
    expect(parse({ Inexistente: { enabled: false } })).toBe(false);
    expect(parse({ DtqClientesLento: { threshold: 999 } })).toBe(false);
    expect(parse({ Db2Indisponivel: { threshold: 1 } })).toBe(false);
    expect(parse({ DtqClientesLento: { threshold: 10 } })).toBe(true);
  });
});

describe('PrometheusRulesSync', () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const db = {
    query: async () => ({ rows: [{ id: 'p1', site_key: 'pizzahut' }], rowCount: 1 }),
  } as unknown as Database;
  const repository = (alertRules: object = {}) =>
    ({
      settings: async () => ({ settings: healthSettingsSchema.parse({ alertRules }) }),
    }) as unknown as HealthRepository;
  const prometheus = (status: number) => {
    const calls: string[] = [];
    const fetchImpl = (async (url: URL, init?: RequestInit) => {
      calls.push(`${init?.method} ${url.pathname}`);
      return new Response(status === 200 ? '' : 'erro nas regras', { status });
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  it('escreve um ficheiro por site, recarrega só quando muda e remove ficheiros antigos', async () => {
    directory = await mkdtemp(join(tmpdir(), 'zeroops-rules-'));
    await writeFile(join(directory, 'zeroops-antigo.yml'), 'groups: []\n');
    await writeFile(join(directory, 'outro.yml'), 'groups: []\n');
    const { calls, fetchImpl } = prometheus(200);
    const sync = new PrometheusRulesSync(db, repository(), directory, 'http://prom', fetchImpl);
    expect(await sync.sync()).toMatchObject({ state: 'ok', message: null });
    expect((await readdir(directory)).sort()).toEqual([
      'outro.yml',
      'zeroops-pizzahut.yml',
      'zeroops-pizzamovil.yml',
    ]);
    expect(calls).toEqual(['POST /-/reload']);
    await sync.sync();
    expect(calls).toHaveLength(1);
  });

  it('repõe os ficheiros anteriores se o Prometheus recusar as regras', async () => {
    directory = await mkdtemp(join(tmpdir(), 'zeroops-rules-'));
    await new PrometheusRulesSync(
      db,
      repository(),
      directory,
      'http://prom',
      prometheus(200).fetchImpl,
    ).sync();
    const before = await readFile(join(directory, 'zeroops-pizzahut.yml'), 'utf8');
    const failing = new PrometheusRulesSync(
      db,
      repository({ DtqErrosNoLog: { enabled: false } }),
      directory,
      'http://prom',
      prometheus(500).fetchImpl,
    );
    const status = await failing.sync();
    expect(status.state).toBe('error');
    expect(status.message).toContain('erro nas regras');
    expect(await readFile(join(directory, 'zeroops-pizzahut.yml'), 'utf8')).toBe(before);
  });

  it('fica desligada sem diretório', async () => {
    const sync = new PrometheusRulesSync(db, repository());
    expect(await sync.sync()).toMatchObject({ state: 'disabled' });
  });
});
