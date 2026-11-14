import { z } from 'zod';
import type { ConnectorTool } from './connector-gateway.js';
import type { LokiConnector } from './loki.connector.js';
import type { PrometheusConnector } from './prometheus.connector.js';
import type { SiteDatabaseConnector } from './site-database.connector.js';

const sqlInput = z.strictObject({ query: z.string().min(1).max(8000) });
const lokiInput = z.strictObject({
  query: z.string().min(1).max(2000),
  since: z.string().max(10).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
const promInput = z.strictObject({
  query: z.string().min(1).max(2000),
  /** Sem janela: valor atual; com janela (30m, 6h, 2d): série temporal. */
  window: z.string().max(10).optional(),
});

/** Adapta o conector SQL read-only ao contrato de ferramenta do agente. */
export function siteDatabaseTool(
  connector: SiteDatabaseConnector,
): ConnectorTool<z.infer<typeof sqlInput>> {
  return {
    name: 'sql',
    input: sqlInput,
    describe: (input) => input.query,
    async run(input) {
      const result = await connector.query(input.query);
      return { result, rowCount: result.rows.length };
    },
  };
}

/** Adapta a pesquisa Loki ao contrato de ferramenta, preservando o seletor configurado como dica. */
export function lokiTool(
  connector: LokiConnector,
  selector?: string,
): ConnectorTool<z.infer<typeof lokiInput>> {
  return {
    name: 'loki',
    input: lokiInput,
    ...(selector ? { hint: `Seletor configurado: ${selector}` } : {}),
    describe: (input) => `${input.query} [${input.since ?? '1h'}]`,
    async run(input) {
      const lines = await connector.query(input);
      return { result: { lines }, rowCount: lines.length };
    },
  };
}

/** Adapta as consultas PromQL ao contrato de ferramenta; os matchers do ambiente seguem como dica. */
export function promTool(
  connector: PrometheusConnector,
  matchers?: string,
): ConnectorTool<z.infer<typeof promInput>> {
  return {
    name: 'prom',
    input: promInput,
    ...(matchers ? { hint: `Filtro do ambiente aplicado automaticamente: ${matchers}` } : {}),
    describe: (input) => (input.window ? `${input.query} [${input.window}]` : input.query),
    async run(input) {
      const series = input.window
        ? await connector.queryRange(input.query, input.window)
        : await connector.query(input.query);
      return { result: { series }, rowCount: series.length };
    },
  };
}
