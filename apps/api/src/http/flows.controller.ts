import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { FlowsService } from '../../../../packages/backend/src/modules/flows/flows.service.js';
import type { AuthenticatedRequest } from './session.js';

/** Configuração dos fluxos de resolução do projeto (administradores do projeto). */
@Controller('api/project-admin/:projectId/flows')
export class FlowsAdminController {
  constructor(@Inject(FlowsService) private readonly flows: FlowsService) {}

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

  @Post(':flowId/publish')
  publish(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Body() raw: unknown,
  ) {
    return this.flows.publish(req.identity, projectId, flowId, raw);
  }

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
}

/** Percurso de um ticket no fluxo, decisões e assistente do ticket. */
@Controller('api/tickets/:id/flow')
export class TicketFlowController {
  constructor(@Inject(FlowsService) private readonly flows: FlowsService) {}

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
