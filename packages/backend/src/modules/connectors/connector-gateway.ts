import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IntegrationSetting, IntegrationValues } from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { connectorTokenHash } from '../../security/connector-token.js';
import { ticketWorkPaused } from '../../database/ticket-maintenance.js';
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

/** Run autorizado a chamar conectores no momento da chamada. */
interface AuthorizedRun extends ConnectorCallContext {
  epoch: number;
  /** Ferramentas efetivas (perfil atual ∩ snapshot do run); `null` = sem restrição (runs legados). */
  allowed: Set<string> | null;
}

type Authorization = { run: AuthorizedRun } | { denied: ConnectorResponse };

const denied = (status: number, error: string, code: string): Authorization => ({
  denied: { status, body: { error, code } },
});

/**
 * Ponto único entre o agente e os conectores. Em cada chamada (mesmo direta, sem passar pelo
 * executor) verifica o token, a posse atual da tentativa (lease válido, sem cancelamento), o estado
 * do projeto (arquivo/manutenção) e a política efetiva de ferramentas (snapshot do run intersetado
 * com a versão atual do perfil, para que revogações tenham efeito imediato). O limite de chamadas
 * é reservado atomicamente e cada chamada é auditada com a época do lease.
 */
export class ConnectorGateway {
  constructor(
    private readonly db: Database,
    private readonly provider: ConnectorToolProvider,
    private readonly maxCallsPerRun = 60,
  ) {}

  /** Ferramentas efetivas para o run do token, ou null se o token/posse não for válido. */
  async toolsFor(token: string | undefined) {
    const auth = token ? await this.authorize(token) : null;
    if (!auth || 'denied' in auth) return null;
    const { run } = auth;
    const tools = await this.provider.toolsFor(run.projectId);
    return tools
      .filter((tool) => !run.allowed || run.allowed.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        environment: environmentOf(tool),
        hint: tool.hint ?? null,
      }));
  }

  /** Valida, executa e audita uma chamada de ferramenta associada a uma tentativa com posse. */
  async call(
    token: string | undefined,
    toolName: string,
    payload: unknown,
    environment: ConnectorEnvironment = 'quality',
  ): Promise<ConnectorResponse> {
    const auth = token ? await this.authorize(token) : null;
    if (!auth) return { status: 401, body: { error: 'Token do run inválido ou run terminado.' } };
    if ('denied' in auth) return auth.denied;
    const { run } = auth;
    const runId = run.runId;
    const started = Date.now();
    const record = (
      name: string,
      request: string,
      outcome: 'ok' | 'rejected' | 'error',
      rowCount: number | null,
      errorCode: string | null,
    ) =>
      this.record(
        runId,
        run.epoch,
        name,
        environment,
        request,
        outcome,
        rowCount,
        started,
        errorCode,
      );
    if (run.allowed && !run.allowed.has(toolName)) {
      await record(
        toolName.slice(0, 60),
        '(ferramenta não autorizada)',
        'rejected',
        null,
        'TOOL_NOT_ALLOWED',
      );
      return {
        status: 403,
        body: {
          error: `Ferramenta não autorizada para este run: ${toolName}.`,
          code: 'TOOL_NOT_ALLOWED',
        },
      };
    }
    const tools = await this.provider.toolsFor(run.projectId);
    const tool = tools.find(
      (item) => item.name === toolName && environmentOf(item) === environment,
    ) as ConnectorTool | undefined;
    if (!tool)
      return {
        status: 404,
        body: { error: `Conector indisponível: ${toolName} (${environment}).` },
      };
    const parsed = tool.input.safeParse(payload);
    const request = parsed.success ? tool.describe(parsed.data) : JSON.stringify(payload ?? null);
    const reserved = await this.db.query(
      `UPDATE agent_runs SET tool_calls_used=tool_calls_used+1
       WHERE id=$1 AND lease_epoch=$2 AND status='running' AND cancel_requested=0
         AND lease_until>NOW(3) AND tool_calls_used<$3`,
      [runId, run.epoch, this.maxCallsPerRun],
    );
    if (!reserved.rowCount) {
      const limit = await this.db.query<{ used: number }>(
        'SELECT tool_calls_used AS used FROM agent_runs WHERE id=$1',
        [runId],
      );
      if (Number(limit.rows[0]?.used ?? 0) >= this.maxCallsPerRun) {
        await record(tool.name, request, 'rejected', null, 'CALL_LIMIT');
        return { status: 429, body: { error: 'Limite de chamadas deste run atingido.' } };
      }
      await record(tool.name, request, 'rejected', null, 'LEASE_LOST');
      return {
        status: 401,
        body: { error: 'A tentativa já não detém o run.', code: 'LEASE_LOST' },
      };
    }
    // Pedidos inválidos também consomem o limite (evita sondagens ilimitadas ao conector).
    if (!parsed.success) {
      await record(tool.name, request, 'rejected', null, 'INPUT_INVALID');
      return { status: 400, body: { error: 'Pedido inválido para o conector.' } };
    }
    try {
      const { result, rowCount } = await tool.run(parsed.data, {
        runId: run.runId,
        projectId: run.projectId,
      });
      if (!(await this.stillOwned(runId, run.epoch))) {
        await record(tool.name, request, 'rejected', rowCount, 'LEASE_LOST');
        return {
          status: 409,
          body: { error: 'A tentativa perdeu a posse durante a chamada.', code: 'LEASE_LOST' },
        };
      }
      await record(tool.name, request, 'ok', rowCount, null);
      return { status: 200, body: result };
    } catch (error) {
      const known = error instanceof DomainError;
      await record(
        tool.name,
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

  private async authorize(token: string): Promise<Authorization | null> {
    const row = (
      await this.db.query<{
        id: string;
        project_id: string;
        lease_epoch: number;
        lease_valid: number | boolean;
        cancel_requested: boolean;
        allowed_tools: string[] | null;
        agent_profile_id: string | null;
        project_archived: boolean;
        profile_archived_at: Date | null;
        definition: { allowedTools?: string[] } | null;
      }>(
        `SELECT r.id, r.project_id, r.lease_epoch, (r.lease_until>NOW(3)) AS lease_valid,
                r.cancel_requested, r.allowed_tools, r.agent_profile_id,
                p.archived AS project_archived, ap.archived_at AS profile_archived_at,
                apv.definition
         FROM agent_runs r
         JOIN projects p ON p.id=r.project_id
         LEFT JOIN zeroops_agent_profiles ap ON ap.id=r.agent_profile_id AND ap.project_id=r.project_id
         LEFT JOIN zeroops_agent_profile_versions apv
           ON apv.profile_id=ap.id AND apv.version=ap.current_version
         WHERE r.connector_token_hash=$1 AND r.status='running'`,
        [connectorTokenHash(token)],
      )
    ).rows[0];
    if (!row) return null;
    if (!Number(row.lease_valid))
      return denied(401, 'A tentativa já não detém o run (lease expirado).', 'LEASE_LOST');
    if (row.cancel_requested) return denied(409, 'O run foi cancelado.', 'RUN_CANCELLED');
    if (row.project_archived) return denied(403, 'Projeto arquivado.', 'PROJECT_ARCHIVED');
    if (await ticketWorkPaused(this.db, row.project_id))
      return denied(409, 'Tickets temporariamente em manutenção.', 'TICKET_WORK_PAUSED');
    let allowed = row.allowed_tools ? new Set(row.allowed_tools) : null;
    if (row.agent_profile_id) {
      const current =
        row.profile_archived_at || !row.definition
          ? new Set<string>()
          : new Set(row.definition.allowedTools ?? []);
      allowed = new Set([...(allowed ?? current)].filter((name) => current.has(name)));
    }
    return {
      run: { runId: row.id, projectId: row.project_id, epoch: Number(row.lease_epoch), allowed },
    };
  }

  private async stillOwned(runId: string, epoch: number) {
    const result = await this.db.query(
      "SELECT id FROM agent_runs WHERE id=$1 AND lease_epoch=$2 AND status='running' AND cancel_requested=0 AND lease_until>NOW(3)",
      [runId, epoch],
    );
    return Boolean(result.rowCount);
  }

  private async record(
    runId: string,
    epoch: number,
    tool: string,
    environment: ConnectorEnvironment,
    request: string,
    outcome: 'ok' | 'rejected' | 'error',
    rowCount: number | null,
    started: number,
    errorCode: string | null,
  ) {
    await this.db.query(
      `INSERT INTO agent_run_tool_calls(id,run_id,tool,environment,request,outcome,row_count,duration_ms,error_code,lease_epoch)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
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
        epoch,
      ],
    );
  }
}
