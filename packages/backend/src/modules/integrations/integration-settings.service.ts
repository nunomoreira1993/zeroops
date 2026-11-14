import { randomUUID } from 'node:crypto';
import {
  integrationActionSchema,
  integrationSaveSchema,
  integrationValuesSchema,
  SHARED_INTEGRATION_ENVIRONMENT,
  storedIntegrationEnvironment,
  type IntegrationSetting,
  type IntegrationValues,
  type User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { IdentityCipher, lockIdentityAdministration } from '../identity/identity-security.js';
import {
  requireInstanceAdmin,
  requireMember,
  isProjectAdminContext,
  type Queryable,
} from '../identity/membership.js';
import { parseInput } from '../identity/identity.validation.js';
import type { SmtpConfig } from '../smtp/smtp-transport.js';

type SettingRow = {
  id: string;
  project_id: string | null;
  environment: IntegrationSetting['environment'];
  kind: IntegrationSetting['kind'];
  version: number;
  state: IntegrationSetting['status'];
  values_ciphertext: string | null;
  public_values: IntegrationSetting['values'];
  secret_configured: boolean;
  tested_at: Date | null;
  test_code: string | null;
};
export interface IntegrationProbe {
  assertAllowed(values: IntegrationValues): void;
  verify(values: IntegrationValues): Promise<void>;
}
const secrets = new Set(['password', 'token']);
const context = (row: Pick<SettingRow, 'id' | 'project_id' | 'environment' | 'kind' | 'version'>) =>
  JSON.stringify([
    'zeroops.integration',
    row.id,
    row.project_id,
    row.environment,
    row.kind,
    row.version,
  ]);

function summary(row: SettingRow): IntegrationSetting {
  return {
    id: row.id,
    scope: row.project_id ? 'project' : 'instance',
    environment: row.environment,
    kind: row.kind,
    version: row.version,
    status: row.state,
    values: row.public_values,
    secretConfigured: row.secret_configured,
    testCode: row.test_code,
    testedAt: row.tested_at?.toISOString() ?? null,
  };
}
/** Mapeia valores SMTP validados para a configuração do transporte. */
export function toSmtpConfig(values: Extract<IntegrationValues, { kind: 'smtp' }>): SmtpConfig {
  return {
    host: values.host,
    port: values.port,
    from: values.from,
    secure: values.secure,
    requireTLS: values.requireTLS,
    allowInsecureLoopback: values.allowInsecureLoopback,
    auth: values.username ? { user: values.username, pass: values.password ?? '' } : undefined,
  };
}

/**
 * Administra integrações cifradas, com teste explícito antes de disponibilizar valores runtime.
 * Basta a sessão autenticada (com MFA no login) de um administrador; não há reconfirmação por ação.
 */
export class IntegrationSettingsService {
  constructor(
    private readonly db: Database,
    private readonly cipher: IdentityCipher,
    private readonly probe: IntegrationProbe,
  ) {}

  private async authorize(db: Queryable, actor: User, projectId: string | null, lock = false) {
    if (isProjectAdminContext(actor)) {
      if (projectId !== actor.projectId)
        throw new DomainError('FORBIDDEN', 'A configuração pertence a outro âmbito.', 403);
      await requireMember(db, actor, lock);
      return;
    }
    if (projectId === null || actor.instanceAdmin) {
      await requireInstanceAdmin(db, actor, lock);
    } else {
      const member = await requireMember(db, actor, lock);
      if (member.role !== 'admin' || member.projectId !== projectId)
        throw new DomainError(
          'FORBIDDEN',
          'Configuração reservada à administração do projeto.',
          403,
        );
    }
    if (projectId !== null) {
      const project = await db.query('SELECT id FROM projects WHERE id=$1 AND NOT archived', [
        projectId,
      ]);
      if (!project.rowCount)
        throw new DomainError('PROJECT_UNAVAILABLE', 'Projeto indisponível.', 404);
    }
  }

  /** Lista configurações públicas da instância/projeto atual sem devolver segredos. */
  async list(actor: User): Promise<IntegrationSetting[]> {
    await this.authorize(this.db, actor, actor.projectId);
    const root = !!actor.instanceAdmin && !isProjectAdminContext(actor);
    const result = await this.db.query<SettingRow>(
      `SELECT * FROM integration_settings WHERE project_id=$1 OR ($2 AND project_id IS NULL)
       ORDER BY environment,kind,id`,
      [actor.projectId, root],
    );
    return result.rows.map(summary);
  }

  private decrypt(row: SettingRow): IntegrationValues {
    if (!row.values_ciphertext)
      throw new DomainError('INTEGRATION_REVOKED', 'A configuração foi revogada.', 503);
    return integrationValuesSchema.parse(
      JSON.parse(this.cipher.decrypt(row.values_ciphertext, context(row))),
    );
  }

  /** Guarda valores cifrados como rascunho; só um teste bem-sucedido os ativa. */
  async save(actor: User, raw: unknown) {
    const input = parseInput(integrationSaveSchema, raw);
    return this.db.transaction(async (client) => {
      await lockIdentityAdministration(client);
      const projectId = input.scope === 'instance' ? null : actor.projectId;
      await this.authorize(client, actor, projectId, true);
      const environment = storedIntegrationEnvironment(input.values.kind, input.environment);
      const existing = await client.query<SettingRow>(
        `SELECT * FROM integration_settings WHERE project_id <=> $1
         AND environment=$2 AND kind=$3 FOR UPDATE`,
        [projectId, environment, input.values.kind],
      );
      const current = existing.rows[0];
      if ((current?.version ?? 0) !== input.expectedVersion)
        throw new DomainError('STALE_VERSION', 'A configuração mudou. Recarregue a página.');
      const previous = current?.values_ciphertext ? this.decrypt(current) : null;
      const merged: Record<string, unknown> = { ...input.values };
      for (const field of secrets) {
        if (!(field in merged) && previous && field in previous)
          merged[field] = Reflect.get(previous, field);
      }
      const values = integrationValuesSchema.parse(merged);
      if (values.kind === 'smtp' && !!values.username !== !!values.password)
        throw new DomainError(
          'INVALID_INPUT',
          'Indique utilizador e palavra-passe SMTP em conjunto.',
          400,
        );
      if (values.kind === 'database' && !values.password)
        throw new DomainError('INVALID_INPUT', 'A credencial read-only é obrigatória.', 400);
      if (values.kind === 'copilot' && !values.token)
        throw new DomainError('INVALID_INPUT', 'O token do Copilot é obrigatório.', 400);
      const row = {
        id: current?.id ?? randomUUID(),
        project_id: projectId,
        environment,
        kind: values.kind,
        version: (current?.version ?? 0) + 1,
      };
      const publicValues = Object.fromEntries(
        Object.entries(values).filter(([field]) => !secrets.has(field) && field !== 'kind'),
      );
      const hasSecret = Object.keys(values).some((field) => secrets.has(field));
      const ciphertext = this.cipher.encrypt(JSON.stringify(values), context(row));
      if (current)
        await client.query(
          `UPDATE integration_settings SET version=$2,values_ciphertext=$3,public_values=$4,
             secret_configured=$5,state='draft',tested_at=NULL,test_code=NULL,updated_by=$6,
             updated_at=NOW(3)
           WHERE id=$1`,
          [row.id, row.version, ciphertext, JSON.stringify(publicValues), hasSecret, actor.id],
        );
      else
        await client.query(
          `INSERT INTO integration_settings(id,project_id,environment,kind,version,values_ciphertext,public_values,secret_configured,updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            row.id,
            projectId,
            row.environment,
            row.kind,
            row.version,
            ciphertext,
            JSON.stringify(publicValues),
            hasSecret,
            actor.id,
          ],
        );
      const stored = await client.query<SettingRow>(
        'SELECT * FROM integration_settings WHERE id=$1',
        [row.id],
      );
      await client.query(
        `INSERT INTO audit_events(id,actor_id,action,details) VALUES($1,$2,'integration.saved',$3)`,
        [
          randomUUID(),
          actor.id,
          JSON.stringify({
            settingId: row.id,
            projectId,
            environment: row.environment,
            kind: row.kind,
            version: row.version,
            secretChanged: Object.keys(input.values).some((field) => secrets.has(field)),
          }),
        ],
      );
      return summary(stored.rows[0]!);
    });
  }

  private async action(
    actor: User,
    id: string,
    raw: unknown,
    action: 'integration-test' | 'integration-revoke',
  ) {
    const input = parseInput(integrationActionSchema, raw);
    return this.db.transaction(async (client) => {
      await lockIdentityAdministration(client);
      const found = await client.query<SettingRow>(
        'SELECT * FROM integration_settings WHERE id=$1 FOR UPDATE',
        [id],
      );
      const row = found.rows[0];
      if (!row || (row.project_id !== null && row.project_id !== actor.projectId))
        throw new DomainError('INTEGRATION_NOT_FOUND', 'Configuração não encontrada.', 404);
      await this.authorize(client, actor, row.project_id, true);
      if (row.version !== input.expectedVersion)
        throw new DomainError('STALE_VERSION', 'A configuração mudou.');
      if (action === 'integration-revoke') {
        await client.query(
          `UPDATE integration_settings SET state='revoked',version=version+1,values_ciphertext=NULL,
             secret_configured=false,tested_at=NULL,test_code=NULL,updated_by=$2,updated_at=NOW(3) WHERE id=$1`,
          [id, actor.id],
        );
      }
      await client.query(
        'INSERT INTO audit_events(id,actor_id,action,details) VALUES($1,$2,$3,$4)',
        [
          randomUUID(),
          actor.id,
          action,
          JSON.stringify({ settingId: id, version: row.version, projectId: row.project_id }),
        ],
      );
      return row;
    });
  }

  /** Revoga uma configuração e impede que valores anteriores voltem a ser usados. */
  async revoke(actor: User, id: string, raw: unknown) {
    await this.action(actor, id, raw, 'integration-revoke');
    return { ok: true };
  }

  /** Testa o endpoint autorizado e ativa apenas a versão exata que foi verificada. */
  async test(actor: User, id: string, raw: unknown) {
    const row = await this.action(actor, id, raw, 'integration-test');
    let failure: DomainError | null = null;
    try {
      await this.probe.verify(this.decrypt(row));
    } catch (error) {
      failure =
        error instanceof DomainError
          ? error
          : new DomainError(
              'INTEGRATION_TEST_FAILED',
              'O teste falhou. Consulte a configuração e a autorização do destino.',
              503,
            );
    }
    const code = failure?.code ?? 'verified';
    const updated = await this.db.query(
      `UPDATE integration_settings SET state=$3,tested_at=NOW(3),test_code=$4
       WHERE id=$1 AND version=$2 AND state<>'revoked'`,
      [id, row.version, failure ? 'draft' : 'verified', code],
    );
    await this.db.query(
      `INSERT INTO audit_events(id,actor_id,action,details) VALUES($1,$2,'integration.tested',$3)`,
      [
        randomUUID(),
        actor.id,
        JSON.stringify({ settingId: id, version: row.version, code, applied: !!updated.rowCount }),
      ],
    );
    if (!updated.rowCount)
      throw new DomainError(
        'STALE_VERSION',
        'A configuração mudou durante o teste. O resultado foi descartado.',
      );
    if (failure) throw failure;
    return { status: 'verified' as const };
  }

  /**
   * Valores decifrados de uma integração de projeto, apenas se estiver verificada e o destino
   * continuar autorizado. `id:version` muda a cada gravação, rotação ou revogação.
   */
  async runtimeValues<K extends IntegrationValues['kind']>(
    projectId: string,
    environment: IntegrationSetting['environment'],
    kind: K,
  ): Promise<{
    id: string;
    version: number;
    values: Extract<IntegrationValues, { kind: K }>;
  } | null> {
    const found = await this.db.query<SettingRow>(
      `SELECT * FROM integration_settings WHERE project_id=$1 AND environment=$2 AND kind=$3
         AND state='verified'`,
      [projectId, storedIntegrationEnvironment(kind, environment), kind],
    );
    const row = found.rows[0];
    if (!row) return null;
    const values = this.decrypt(row);
    if (values.kind !== kind) return null;
    this.probe.assertAllowed(values);
    return {
      id: row.id,
      version: row.version,
      values: values as Extract<IntegrationValues, { kind: K }>,
    };
  }

  /**
   * Devolve o SMTP de instância verificado, sem expor o segredo ao chamador HTTP. O SMTP é único
   * na instalação; o ambiente pedido é mantido por compatibilidade com chamadores antigos.
   */
  async runtimeSmtp(
    _environment?: IntegrationSetting['environment'],
    db: Queryable = this.db,
  ): Promise<SmtpConfig | null> {
    const found = await db.query<SettingRow>(
      "SELECT * FROM integration_settings WHERE project_id IS NULL AND kind='smtp' AND environment=$1",
      [SHARED_INTEGRATION_ENVIRONMENT],
    );
    const row = found.rows[0];
    if (!row) return null;
    if (row.state !== 'verified')
      throw new DomainError(
        'SMTP_NOT_VERIFIED',
        'A configuração SMTP não está verificada ou foi revogada.',
        503,
      );
    const values = this.decrypt(row);
    if (values.kind !== 'smtp')
      throw new DomainError('SMTP_INVALID', 'Configuração SMTP inválida.', 503);
    this.probe.assertAllowed(values);
    return toSmtpConfig(values);
  }
}
