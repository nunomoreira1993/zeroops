import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IntegrationSetting, IntegrationValues } from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { connectorTokenHash } from '../../security/connector-token.js';
import { redactText } from './redaction.js';

export type ConnectorEnvironment = IntegrationSetting['environment'];

/** Contexto do run que fez a chamada (ex.: para associar o pedido ao relay de Produção). */
export interface ConnectorCallContext {
  runId: string;
  projectId: string;
}

/** Ferramenta de leitura disponibilizada ao agente (BD do site, logs, ...). */
export interface ConnectorTool<Input = unknown> {
  readonly name: string;
  /** Ambiente consultado pela ferramenta; por omissão QA. */
  readonly environment?: ConnectorEnvironment;
  readonly input: z.ZodType<Input>;
  /** Indicação para o agente (ex.: seletor LogQL configurado). */
  readonly hint?: string;
  /** Texto curto que fica no registo de evidências. */
  describe(input: Input): string;
  run(input: Input, context: ConnectorCallContext): Promise<{ result: unknown; rowCount: number }>;
}

const environmentOf = (tool: ConnectorTool<never>) => tool.environment ?? 'quality';

/** Ferramentas disponíveis para os runs de um projeto (normalmente vindas das integrações). */
export interface ConnectorToolProvider {
  toolsFor(projectId: string): Promise<ConnectorTool<never>[]>;
}

/** Junta as ferramentas de vários fornecedores (ex.: QA local e Produção via relay). */
export class CompositeToolProvider implements ConnectorToolProvider {
  constructor(private readonly providers: ConnectorToolProvider[]) {}

  /** Concatena as ferramentas de todos os fornecedores, pela ordem em que foram registados. */
  async toolsFor(projectId: string) {
    const lists = await Promise.all(this.providers.map((provider) => provider.toolsFor(projectId)));
    return lists.flat();
  }
}

export type ConnectorKind = 'database' | 'telemetry' | 'metrics';

export interface ConnectorIntegrationSource {
  runtimeValues<K extends ConnectorKind>(
    projectId: string,
    environment: IntegrationSetting['environment'],
    kind: K,
  ): Promise<{
    id: string;
    version: number;
    values: Extract<IntegrationValues, { kind: K }>;
  } | null>;
}

export interface ConnectorResponse {
  status: number;
  body: unknown;
}

/**
 * Ponto único entre o agente e os conectores: só aceita o token de um run em execução, oferece as
 * ferramentas configuradas para o projeto do ticket, aplica um limite de chamadas por run e regista
 * cada chamada (aceite, rejeitada ou com erro).
 */
export class ConnectorGateway {
  constructor(
    private readonly db: Database,
    private readonly provider: ConnectorToolProvider,
    private readonly maxCallsPerRun = 60,
  ) {}

  /** Ferramentas disponíveis para o run do token, ou null se o token não for válido. */
  async toolsFor(token: string | undefined) {
    const run = token ? await this.authorize(token) : null;
    if (!run) return null;
    const tools = await this.provider.toolsFor(run.projectId);
    return tools.map((tool) => ({
      name: tool.name,
      environment: environmentOf(tool),
      hint: tool.hint ?? null,
    }));
  }

  /** Valida, executa e audita uma chamada de ferramenta associada a um run ativo. */
  async call(
    token: string | undefined,
    toolName: string,
    payload: unknown,
    environment: ConnectorEnvironment = 'quality',
  ): Promise<ConnectorResponse> {
    const run = token ? await this.authorize(token) : null;
    if (!run) return { status: 401, body: { error: 'Token do run inválido ou run terminado.' } };
    const runId = run.runId;
    const tools = await this.provider.toolsFor(run.projectId);
    const tool = tools.find(
      (item) => item.name === toolName && environmentOf(item) === environment,
    ) as ConnectorTool | undefined;
    if (!tool)
      return {
        status: 404,
        body: { error: `Conector indisponível: ${toolName} (${environment}).` },
      };
    const started = Date.now();
    const record = (
      request: string,
      outcome: 'ok' | 'rejected' | 'error',
      rowCount: number | null,
      errorCode: string | null,
    ) => this.record(runId, tool.name, environment, request, outcome, rowCount, started, errorCode);
    const parsed = tool.input.safeParse(payload);
    if (!parsed.success) {
      await record(JSON.stringify(payload ?? null), 'rejected', null, 'INPUT_INVALID');
      return { status: 400, body: { error: 'Pedido inválido para o conector.' } };
    }
    const request = tool.describe(parsed.data);
    const calls = await this.db.query<{ total: number }>(
      'SELECT COUNT(*) AS total FROM agent_run_tool_calls WHERE run_id=$1',
      [runId],
    );
    if ((calls.rows[0]?.total ?? 0) >= this.maxCallsPerRun) {
      await record(request, 'rejected', null, 'CALL_LIMIT');
      return { status: 429, body: { error: 'Limite de chamadas deste run atingido.' } };
    }
    try {
      const { result, rowCount } = await tool.run(parsed.data, run);
      await record(request, 'ok', rowCount, null);
      return { status: 200, body: result };
    } catch (error) {
      const known = error instanceof DomainError;
      await record(
        request,
        known ? 'rejected' : 'error',
        null,
        known ? error.code : 'CONNECTOR_FAILED',
      );
      return {
        status: known ? error.status : 502,
        body: { error: known ? error.message : 'O conector falhou.' },
      };
    }
  }

  private async authorize(token: string) {
    const result = await this.db.query<{ id: string; project_id: string }>(
      "SELECT id,project_id FROM agent_runs WHERE connector_token_hash=$1 AND status='running'",
      [connectorTokenHash(token)],
    );
    const row = result.rows[0];
    return row ? { runId: row.id, projectId: row.project_id } : null;
  }

  private async record(
    runId: string,
    tool: string,
    environment: ConnectorEnvironment,
    request: string,
    outcome: 'ok' | 'rejected' | 'error',
    rowCount: number | null,
    started: number,
    errorCode: string | null,
  ) {
    await this.db.query(
      `INSERT INTO agent_run_tool_calls(id,run_id,tool,environment,request,outcome,row_count,duration_ms,error_code)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(),
        runId,
        tool,
        environment,
        redactText(request).slice(0, 4000),
        outcome,
        rowCount,
        Date.now() - started,
        errorCode,
      ],
    );
  }
}
