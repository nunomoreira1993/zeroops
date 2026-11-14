import type { IntegrationSetting } from '../../../../contracts/src/index.js';
import type { Database, PoolClient } from '../../database/database.js';
import type { Queryable } from '../identity/membership.js';
import type { PrivateIdentityMail } from '../identity/identity-security.js';
import type { IntegrationSettingsService } from '../integrations/integration-settings.service.js';
import {
  IdentityMailService,
  type IdentityMailConfig,
  type IdentityMailInput,
} from './identity-mail.js';

/** Adapta a configuração SMTP verificada à fila privada de mensagens de identidade. */
export class ConfiguredIdentityMail implements PrivateIdentityMail {
  constructor(
    private readonly db: Database,
    private readonly settings: IntegrationSettingsService,
    private readonly environment: IntegrationSetting['environment'],
    private readonly bootstrap: IdentityMailConfig,
  ) {}
  private async service(db: Queryable = this.db) {
    const stored = await this.settings.runtimeSmtp(this.environment, db);
    return new IdentityMailService(this.db, {
      ...this.bootstrap,
      smtp: stored ?? this.bootstrap.smtp,
    });
  }
  /** Impede operações de identidade se o SMTP/cripto privado não estiver configurado. */
  async assertConfigured() {
    (await this.service()).assertConfigured();
  }
  /** Enfileira mensagem cifrada usando a configuração SMTP verificada do ambiente. */
  async enqueue(client: PoolClient, input: IdentityMailInput) {
    return (await this.service(client)).enqueue(client, input);
  }
  /** Entrega itens pendentes; bloqueia a fila com código visível se a configuração falhar. */
  async deliverPending(limit = 10) {
    let service: IdentityMailService;
    try {
      service = await this.service();
    } catch (error) {
      await this.db.query(
        `UPDATE identity_mail SET state='blocked',error_code='smtp_configuration_unavailable',updated_at=NOW(3)
         WHERE state='pending'`,
      );
      throw error;
    }
    return service.deliverPending(limit);
  }
  /** Lista entregas de identidade para a conta indicada. */
  listForUser(userId: string) {
    return new IdentityMailService(this.db, this.bootstrap).listForUser(userId);
  }
  /** Lista entregas ligadas ao hash de convite, sem devolver o token em claro. */
  listForToken(kind: 'invite', tokenHash: string) {
    return new IdentityMailService(this.db, this.bootstrap).listForToken(kind, tokenHash);
  }
  /** Repete entrega elegível apenas para o proprietário e através do serviço de fila. */
  async retry(client: PoolClient, id: string, userId: string) {
    return (await this.service(client)).retry(client, id, userId);
  }
  /** Repete entrega elegível de convite apenas quando o hash do token corresponde. */
  async retryForToken(client: PoolClient, id: string, tokenHash: string) {
    return (await this.service(client)).retryForToken(client, id, tokenHash);
  }
}
