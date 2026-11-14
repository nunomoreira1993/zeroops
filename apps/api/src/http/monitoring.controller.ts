import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { HealthService } from '../../../../packages/backend/src/modules/health/health.service.js';
import { REMOTE_WRITE_MAX_BYTES } from '../../../../packages/backend/src/modules/health/remote-write-forwarder.js';
import { readRawBody } from './raw-body.js';
import type { AuthenticatedRequest } from './session.js';

/** Pagina Saude (alarmistica). `api/health` continua a ser a sonda de prontidao da propria API. */
@Controller('api/monitoring')
export class MonitoringController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get()
  overview(@Req() req: AuthenticatedRequest) {
    return this.health.overview(req.identity);
  }
  /** Histórico dos alarmes (cronologia e notificações): `?days=30&check=<id>`. */
  @Get('history')
  history(@Req() req: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    return this.health.history(req.identity, query);
  }
  @Post('settings')
  @HttpCode(200)
  save(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    return this.health.saveSettings(req.identity, raw);
  }
  @Post('agent-token')
  @HttpCode(200)
  agentToken(@Req() req: AuthenticatedRequest) {
    return this.health.rotateAgentToken(req.identity);
  }
  @Post('run')
  @HttpCode(200)
  run(@Req() req: AuthenticatedRequest) {
    return this.health.runNow(req.identity);
  }
  @Post('report')
  @HttpCode(200)
  report(@Req() req: AuthenticatedRequest) {
    return this.health.reportNow(req.identity);
  }
  /** Suspensão manual da Saúde por ambiente (só regista os alertas; retoma manual). */
  @Get('suspension')
  suspension(@Req() req: AuthenticatedRequest) {
    return this.health.suspension(req.identity);
  }
  @Post('suspend')
  @HttpCode(200)
  suspend(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    return this.health.suspend(req.identity, raw);
  }
  @Post('resume')
  @HttpCode(200)
  resume(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    return this.health.resume(req.identity, raw);
  }
  /** Política de intervenção dos incidentes Health (regras, serviços, parâmetros, validação). */
  @Get('incident-policy')
  incidentPolicy(@Req() req: AuthenticatedRequest) {
    return this.health.incidentPolicy(req.identity);
  }
  @Post('incident-policy')
  @HttpCode(200)
  saveIncidentPolicy(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    return this.health.saveIncidentPolicy(req.identity, raw);
  }
  /** Abre um incidente de demonstração no QA (disco, memória, MySQL ou DB2), com ações simuladas. */
  @Post('incident-demo')
  @HttpCode(201)
  startIncidentDemo(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    return this.health.startIncidentDemo(req.identity, raw);
  }
  @Post('alerts/:id/ack')
  @HttpCode(200)
  acknowledge(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.health.acknowledge(req.identity, id);
  }
  @Post('alerts/:id/assign')
  @HttpCode(200)
  assign(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.health.assign(req.identity, id, raw);
  }
  /** Ingestao do agente do servidor: sem sessao, autenticada so pelo token Bearer. */
  @Post('ingest')
  @HttpCode(202)
  ingest(@Req() req: Request, @Body() raw: unknown) {
    return this.health.ingest(req.headers.authorization, raw);
  }
  /** Configuração dos coletores dos servidores (pausas das sondas), autenticada pelo token. */
  @Post('agent-config')
  @HttpCode(200)
  agentConfig(@Req() req: Request) {
    return this.health.agentConfig(req.headers.authorization);
  }
  /** Webhook do Alertmanager (`webhook_config`): sem sessão, autenticado pelo token do agente. */
  @Post('alertmanager')
  @HttpCode(200)
  alertmanager(@Req() req: Request, @Body() raw: unknown) {
    return this.health.receiveAlerts(req.headers.authorization, raw);
  }
  /** Remote write do Prometheus de Produção (modo agente): token do agente, corpo snappy/protobuf. */
  @Post('remote-write')
  async remoteWrite(@Req() req: Request, @Res() res: Response) {
    // O corpo só é lido depois de validar o token do agente.
    const result = await this.health.receiveMetrics(req.headers.authorization, async () => ({
      body: await readRawBody(req, REMOTE_WRITE_MAX_BYTES),
      contentType: req.headers['content-type'],
      contentEncoding: req.headers['content-encoding'],
      version: req.get('x-prometheus-remote-write-version'),
    }));
    if (result.status >= 200 && result.status < 300) res.status(204).end();
    else res.status(result.status).type('text/plain').send(result.message);
  }
}
