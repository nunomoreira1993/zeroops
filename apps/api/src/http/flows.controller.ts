import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { FlowSimulationService } from '../../../../packages/backend/src/modules/flows/flow-simulation.service.js';
import { FlowsService } from '../../../../packages/backend/src/modules/flows/flows.service.js';
import { TicketRouter } from '../../../../packages/backend/src/modules/flows/ticket-routing.js';
import type { AuthenticatedRequest } from './session.js';

const afterSchema = z.coerce.number().int().min(0).catch(0);
const STREAM_POLL_MS = 1000;
const STREAM_HEARTBEAT_MS = 15000;
const STREAM_MAX_MS = 10 * 60 * 1000;

/** Fluxos de resolução autorizados por capacidade/operação no serviço de projeto. */
@Controller('api/project-admin/:projectId/flows')
export class FlowsAdminController {
  constructor(
    @Inject(FlowsService) private readonly flows: FlowsService,
    @Inject(FlowSimulationService) private readonly simulator: FlowSimulationService,
  ) {}

  @Get()
  list(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.flows.list(req.identity, projectId);
  }

  @Post()
  create(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.flows.create(req.identity, projectId, raw);
  }

  @Get('simulation-tickets')
  simulationTickets(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.flows.simulationTickets(req.identity, projectId);
  }

  @Get('alert-links')
  alertFlows(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.flows.alertFlows(req.identity, projectId);
  }

  @Post('alert-links/link')
  linkAlertFlow(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.flows.linkAlertFlow(req.identity, projectId, raw);
  }

  @Post('alert-links/create')
  createAlertFlow(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.flows.createAlertFlow(req.identity, projectId, raw);
  }

  /** Destinos de ensaio isolado (outbox) do projeto; geridos por quem pode ativar fluxos. */
  @Post('trial-targets')
  createTrialTarget(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.simulator.createTrialTarget(req.identity, projectId, raw);
  }

  @Post('trial-targets/:targetId/deactivate')
  deactivateTrialTarget(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('targetId') targetId: string,
  ) {
    return this.simulator.deactivateTrialTarget(req.identity, projectId, targetId);
  }

  @Get('trial-targets/:targetId/deliveries')
  trialDeliveries(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('targetId') targetId: string,
  ) {
    return this.simulator.trialDeliveries(req.identity, projectId, targetId);
  }

  @Get(':flowId')
  get(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
  ) {
    return this.flows.get(req.identity, projectId, flowId);
  }

  @Post(':flowId/draft')
  saveDraft(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Body() raw: unknown,
  ) {
    return this.flows.saveDraft(req.identity, projectId, flowId, raw);
  }

  @Post(':flowId/settings')
  saveSettings(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Body() raw: unknown,
  ) {
    return this.flows.saveSettings(req.identity, projectId, flowId, raw);
  }

  /** «Ativar esta versão» (`/publish` mantém-se por compatibilidade). */
  @Post([':flowId/activate', ':flowId/publish'])
  publish(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Body() raw: unknown,
  ) {
    return this.flows.publish(req.identity, projectId, flowId, raw);
  }

  @Get(':flowId/simulations')
  simulations(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
  ) {
    return this.simulator.list(req.identity, projectId, flowId);
  }

  @Post(':flowId/simulations/scenarios')
  createScenario(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Body() raw: unknown,
  ) {
    return this.simulator.saveScenario(req.identity, projectId, flowId, null, raw);
  }

  @Post(':flowId/simulations/scenarios/from-ticket')
  scenarioFromTicket(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Body() raw: unknown,
  ) {
    return this.simulator.scenarioFromTicket(req.identity, projectId, flowId, raw);
  }

  @Post(':flowId/simulations/scenarios/:scenarioId')
  updateScenario(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Param('scenarioId') scenarioId: string,
    @Body() raw: unknown,
  ) {
    return this.simulator.saveScenario(req.identity, projectId, flowId, scenarioId, raw);
  }

  @Post(':flowId/simulations/scenarios/:scenarioId/archive')
  archiveScenario(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Param('scenarioId') scenarioId: string,
    @Body() raw: unknown,
  ) {
    return this.simulator.archiveScenario(req.identity, projectId, flowId, scenarioId, raw);
  }

  @Post(':flowId/simulations/runs')
  runSimulation(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Body() raw: unknown,
  ) {
    return this.simulator.run(req.identity, projectId, flowId, raw);
  }

  @Get(':flowId/simulations/runs/:runId')
  simulationRun(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Param('runId') runId: string,
  ) {
    return this.simulator.getRun(req.identity, projectId, flowId, runId);
  }

  @Post(':flowId/simulations/runs/:runId/cancel')
  cancelSimulationRun(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Param('runId') runId: string,
  ) {
    return this.simulator.cancelRun(req.identity, projectId, flowId, runId);
  }

  /** Simulação legada (sem cenário guardado); mantida por compatibilidade. */
  @Post(':flowId/simulate')
  simulate(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Body() raw: unknown,
  ) {
    return this.flows.simulate(req.identity, projectId, flowId, raw);
  }

  @Get(':flowId/assistant')
  assistantHistory(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
  ) {
    return this.flows.flowAssistantHistory(req.identity, projectId, flowId);
  }

  @Post(':flowId/assistant')
  assistant(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Body() raw: unknown,
  ) {
    return this.flows.requestFlowAssistant(req.identity, projectId, flowId, raw);
  }

  @Post(':flowId/assistant/:requestId/resolution')
  resolve(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Param('requestId') requestId: string,
    @Body() raw: unknown,
  ) {
    return this.flows.resolveFlowAssistant(req.identity, projectId, flowId, requestId, raw);
  }

  @Post(':flowId/assistant/:requestId/cancel')
  cancelAssistant(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.flows.cancelFlowAssistant(req.identity, projectId, flowId, requestId);
  }

  /** Estado persistente da sessão de construção (modo, operações, capacidades, cursor). */
  @Get(':flowId/authoring')
  authoring(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
  ) {
    return this.flows.authoringState(req.identity, projectId, flowId);
  }

  @Post(':flowId/authoring/mode')
  authoringMode(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Body() raw: unknown,
  ) {
    return this.flows.setAuthoringMode(req.identity, projectId, flowId, raw);
  }

  @Post(':flowId/authoring/operations/:operationId/undo')
  undoAuthoring(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Param('operationId') operationId: string,
    @Body() raw: unknown,
  ) {
    return this.flows.undoAuthoringOperation(req.identity, projectId, flowId, operationId, raw);
  }

  /** Eventos de construção posteriores a `after` (replay e alternativa ao SSE). */
  @Get(':flowId/authoring/events')
  authoringEvents(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Query('after') after: unknown,
  ) {
    return this.flows.authoringEvents(req.identity, projectId, flowId, afterSchema.parse(after));
  }

  /**
   * SSE dos eventos de construção. Retoma de `Last-Event-ID`/`after`; cada página revalida o acesso
   * (permissão revogada fecha o stream). Termina ao fim de alguns minutos; o browser volta a ligar.
   */
  @Get(':flowId/authoring/events/stream')
  async authoringStream(
    @Req() req: AuthenticatedRequest,
    @Res() response: Response,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Query('after') after: unknown,
  ) {
    let cursor = afterSchema.parse(req.headers['last-event-id'] ?? after);
    let page = await this.flows.authoringEvents(req.identity, projectId, flowId, cursor);
    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    let closed = false;
    response.on('close', () => {
      closed = true;
    });
    const started = Date.now();
    let lastWrite = Date.now();
    while (!closed) {
      for (const event of page) {
        response.write(`id: ${event.id}\nevent: authoring\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.id;
        lastWrite = Date.now();
      }
      if (Date.now() - started > STREAM_MAX_MS) break;
      if (Date.now() - lastWrite > STREAM_HEARTBEAT_MS) {
        response.write(': heartbeat\n\n');
        lastWrite = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, STREAM_POLL_MS));
      if (closed) break;
      try {
        page = await this.flows.authoringEvents(req.identity, projectId, flowId, cursor);
      } catch {
        break;
      }
    }
    response.end();
  }
}

/** Percurso de um ticket no fluxo, decisões e assistente do ticket. */
@Controller('api/tickets/:id/flow')
export class TicketFlowController {
  constructor(
    @Inject(FlowsService) private readonly flows: FlowsService,
    @Inject(TicketRouter) private readonly router: TicketRouter,
  ) {}

  @Get('routing')
  routing(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.router.view(req.identity, id).then((routing) => ({ routing }));
  }

  @Post('routing/manual')
  routeManually(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.router
      .routeManually(req.identity, id, raw)
      .then(() => this.router.view(req.identity, id))
      .then((routing) => ({ routing }));
  }

  @Get()
  view(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.flows.ticketFlow(req.identity, id).then((flow) => ({ flow }));
  }

  @Post('decisions')
  decide(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.flows.decide(req.identity, id, raw).then((flow) => ({ flow }));
  }

  @Get('assistant')
  assistantHistory(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.flows.ticketAssistantHistory(req.identity, id);
  }

  @Post('assistant')
  assistant(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.flows.requestTicketAssistant(req.identity, id, raw);
  }

  @Post('assistant/:requestId/apply')
  apply(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() raw: unknown,
  ) {
    return this.flows
      .applyTicketAssistant(req.identity, id, requestId, raw)
      .then((flow) => ({ flow }));
  }
}
