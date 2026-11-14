import 'reflect-metadata';
import { Controller, Get, Inject, Module, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import helmet from 'helmet';
import { Database } from '../../../packages/backend/src/database/database.js';
import { IdentityService } from '../../../packages/backend/src/modules/identity/identity.service.js';
import { TicketsService } from '../../../packages/backend/src/modules/tickets/tickets.service.js';
import { TicketGovernanceService } from '../../../packages/backend/src/modules/tickets/ticket-governance.service.js';
import { MetricsService } from '../../../packages/backend/src/modules/metrics/metrics.service.js';
import { WorkflowService } from '../../../packages/backend/src/modules/workflow/workflow.service.js';
import { unconfiguredCapabilities } from '../../../packages/backend/src/capabilities.js';
import { AuthController, HTTP_CONFIG, type HttpConfig } from './http/auth.controller.js';
import { TicketsController } from './http/tickets.controller.js';
import { ApiExceptionFilter } from './http/errors.js';
import { sessionMiddleware, type AuthenticatedRequest } from './http/session.js';
import { AccountController } from './http/account.controller.js';
import { AccountService } from '../../../packages/backend/src/modules/identity/account.service.js';
import {
  IdentityCipher,
  unavailableMail,
  type PrivateIdentityMail,
} from '../../../packages/backend/src/modules/identity/identity-security.js';
import { IntegrationSettingsController } from './http/integration-settings.controller.js';
import { IntegrationSettingsService } from '../../../packages/backend/src/modules/integrations/integration-settings.service.js';
import { AuthorizedIntegrationProbe } from '../../../packages/backend/src/modules/integrations/integration-probe.js';
import { ConfiguredIdentityMail } from '../../../packages/backend/src/modules/notifications/configured-identity-mail.js';
import type { IdentityMailConfig } from '../../../packages/backend/src/modules/notifications/identity-mail.js';
import { AgentRunsController } from './http/agent-runs.controller.js';
import { AgentRunsService } from '../../../packages/backend/src/modules/agents/agent-runs.service.js';
import { FlowEngine } from '../../../packages/backend/src/modules/flows/flow-engine.js';
import { createFlowActionRegistry } from '../../../packages/backend/src/modules/incidents/incident.module.js';
import { FlowsService } from '../../../packages/backend/src/modules/flows/flows.service.js';
import { FlowsAdminController, TicketFlowController } from './http/flows.controller.js';
import { HealthIncidentLifecycle } from '../../../packages/backend/src/modules/health/health-incident-lifecycle.js';
import { AgentRunEventsService } from '../../../packages/backend/src/modules/agents/agent-run-events.service.js';
import { MonitoringController } from './http/monitoring.controller.js';
import { MonitoringChartsController } from './http/monitoring-charts.controller.js';
import { HealthChartsService } from '../../../packages/backend/src/modules/health/charts/health-charts.service.js';
import { HealthService } from '../../../packages/backend/src/modules/health/health.service.js';
import { createHealthMonitoring } from '../../../packages/backend/src/modules/health/health.module.js';
import { AgentConfigController, RelayController } from './http/agent-config.controller.js';
import { AgentInstructionsService } from '../../../packages/backend/src/modules/agents/agent-instructions.service.js';
import { ProductionRelayService } from '../../../packages/backend/src/modules/connectors/production-relay.service.js';
import { ProjectLogoController } from './http/project-logo.controller.js';
import { ProjectLogoService } from '../../../packages/backend/src/modules/identity/project-logo.service.js';
import { ProjectAdminController } from './http/project-admin.controller.js';
import { AgentModelsController } from './http/agent-models.controller.js';
import { AgentModelsService } from '../../../packages/backend/src/modules/agents/agent-models.service.js';
import { AgentProfilesService } from '../../../packages/backend/src/modules/agents/agent-profiles.service.js';
import { RepositoryResources } from '../../../packages/backend/src/modules/agents/repository-resources.js';
import { AgentProfilesController } from './http/agent-profiles.controller.js';
import { UserAvatarController } from './http/user-avatar.controller.js';
import { UserAvatarService } from '../../../packages/backend/src/modules/identity/user-avatar.service.js';

@Controller('api')
class OperationsController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  @Get('health')
  async health() {
    await this.db.query('SELECT name FROM zeroops_migrations LIMIT 1');
    return {
      status: 'ready',
      product: 'ZeroOps',
      automation: 'not-configured',
      version: process.env.ZEROOPS_VERSION || 'local',
    };
  }

  @Get('capabilities')
  capabilities() {
    return unconfiguredCapabilities();
  }

  @Get('metrics')
  summary(@Req() request: AuthenticatedRequest) {
    return this.metrics.summary(request.identity);
  }
}

/**
 * Compõe a aplicação HTTP e liga controllers aos serviços do backend.
 *
 * A configuração privada é injetada pelo bootstrap; URLs não-loopback exigem HTTPS.
 */
export async function createApplication(
  db: Database,
  config: HttpConfig,
  privateConfig: {
    encryptionKey?: string;
    mail?: PrivateIdentityMail;
    mailConfig?: IdentityMailConfig;
    environment?: 'quality' | 'production';
    smtpEndpoints?: ReadonlySet<string>;
    connectorEndpoints?: ReadonlySet<string>;
    prometheusWriteUrl?: string;
    alertSpoolDir?: string;
    alertmanagerUrl?: string;
    prometheusRulesDir?: string;
    prometheusUrl?: string;
    agentSitesRoot?: string;
  } = {},
) {
  const url = new URL(config.publicUrl);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
  )
    throw new Error('HTTPS obrigatorio fora de loopback.');
  const cipher = new IdentityCipher(privateConfig.encryptionKey);
  const settings = new IntegrationSettingsService(
    db,
    cipher,
    new AuthorizedIntegrationProbe(privateConfig.smtpEndpoints ?? new Set(), {
      connectorEndpoints: privateConfig.connectorEndpoints ?? new Set(),
    }),
  );
  const mail =
    privateConfig.mail ??
    (privateConfig.mailConfig
      ? new ConfiguredIdentityMail(
          db,
          settings,
          privateConfig.environment ?? 'quality',
          privateConfig.mailConfig,
        )
      : unavailableMail);
  const identity = new IdentityService(db, cipher, mail);
  // Cada ticket segue o fluxo do projeto (modelos por omissão reproduzem o percurso anterior).
  const agentProfiles = new AgentProfilesService(
    db,
    new RepositoryResources(privateConfig.agentSitesRoot ?? process.env.ZEROOPS_AGENT_SITES_ROOT),
  );
  const flowEngine = new FlowEngine(
    db,
    createFlowActionRegistry(db, { settings, publicUrl: config.publicUrl }),
    undefined,
    agentProfiles,
  );
  const health = createHealthMonitoring(
    db,
    settings,
    config.publicUrl,
    privateConfig.prometheusWriteUrl,
    privateConfig.alertSpoolDir,
    privateConfig.alertmanagerUrl,
    { directory: privateConfig.prometheusRulesDir, url: privateConfig.prometheusUrl },
    { ticketCreated: [flowEngine.onTicketCreated], incidentDelegate: flowEngine.incidentDelegate },
  );
  @Module({
    controllers: [
      AuthController,
      AccountController,
      TicketsController,
      OperationsController,
      IntegrationSettingsController,
      AgentRunsController,
      MonitoringChartsController,
      MonitoringController,
      AgentConfigController,
      RelayController,
      ProjectLogoController,
      ProjectAdminController,
      AgentModelsController,
      UserAvatarController,
      FlowsAdminController,
      TicketFlowController,
      AgentProfilesController,
    ],
    providers: [
      { provide: Database, useValue: db },
      { provide: AgentModelsService, useValue: new AgentModelsService(db) },
      { provide: AgentProfilesService, useValue: agentProfiles },
      { provide: UserAvatarService, useValue: new UserAvatarService(db) },
      { provide: ProjectLogoService, useValue: new ProjectLogoService(db) },
      { provide: AgentInstructionsService, useValue: new AgentInstructionsService(db) },
      { provide: ProductionRelayService, useValue: new ProductionRelayService(db) },
      { provide: HealthService, useValue: health.service },
      { provide: HealthChartsService, useValue: health.charts.service },
      {
        provide: AgentRunsService,
        useValue: new AgentRunsService(db, [
          new HealthIncidentLifecycle(db, flowEngine.incidentDelegate).onRunFinished,
          flowEngine.onRunFinished,
        ]),
      },
      { provide: AgentRunEventsService, useValue: new AgentRunEventsService(db) },
      { provide: IdentityService, useValue: identity },
      { provide: AccountService, useValue: new AccountService(db, cipher, mail) },
      { provide: IntegrationSettingsService, useValue: settings },
      // O fluxo do projeto decide o que acontece a cada ticket novo e a cada resposta do autor.
      {
        provide: TicketsService,
        useValue: new TicketsService(
          db,
          [flowEngine.onPublicComment],
          [flowEngine.onTicketCreated],
        ),
      },
      { provide: FlowsService, useValue: new FlowsService(db, flowEngine, agentProfiles) },
      { provide: TicketGovernanceService, useValue: new TicketGovernanceService(db) },
      { provide: MetricsService, useValue: new MetricsService(db) },
      { provide: WorkflowService, useValue: new WorkflowService(db, unconfiguredCapabilities()) },
      { provide: HTTP_CONFIG, useValue: config },
    ],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: ['error', 'warn'] });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: url.protocol === 'https:' ? [] : null,
        },
      },
    }),
  );
  app.use(sessionMiddleware(identity, config.publicUrl, db, config.trustLoopbackProxy));
  // Resultados SQL/logs do relay de Produção excedem o limite geral (são limitados no serviço).
  app.use('/api/relay', express.json({ limit: '2mb' }));
  // Logotipo do projeto em base64 (máx. 256 KB binário, validado no serviço).
  app.use(
    /^\/api\/(?:instance\/projects(?:\/[^/]+\/logo)?|project-admin\/[^/]+\/logo)$/i,
    express.json({ limit: '400kb' }),
  );
  // Fotografia de perfil em base64 (máx. 512 KB binário, validado no serviço).
  app.use('/api/account/avatar', express.json({ limit: '720kb' }));
  // Definições de fluxo com disposição e instruções por etapa.
  app.use(/^\/api\/project-admin\/[^/]+\/flows(?:\/.*)?$/i, express.json({ limit: '512kb' }));
  app.use(express.json({ limit: '64kb' }));
  const staticDirectory = config.staticDirectory;
  if (staticDirectory) {
    app.use(express.static(staticDirectory, { index: 'index.html', dotfiles: 'deny' }));
    app.use((request: express.Request, response: express.Response, next: express.NextFunction) => {
      if (
        request.method === 'GET' &&
        ['/activate', '/reset-password', '/verify-email', '/mfa-reset'].includes(
          request.path.toLowerCase(),
        )
      ) {
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.sendFile(resolve(staticDirectory, 'index.html'));
      } else next();
    });
  }
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.init();
  if (privateConfig.alertSpoolDir || privateConfig.alertmanagerUrl) {
    // Repõe os alertas guardados em disco durante uma falha da BD, mesmo sem novos webhooks,
    // e fecha os que deixaram de estar ativos no Alertmanager sem chegar o «resolved».
    const timer = setInterval(() => void health.service.maintainAlerts().catch(() => null), 30000);
    timer.unref();
    (app.getHttpServer() as Server).once('close', () => clearInterval(timer));
  }
  return app;
}
