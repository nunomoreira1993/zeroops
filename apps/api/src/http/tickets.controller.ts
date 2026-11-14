import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  commentRevisionInputSchema,
  createTicketSchema,
  ticketAssignmentsInputSchema,
  updateTicketSchema,
} from '../../../../packages/contracts/src/index.js';
import { TicketsService } from '../../../../packages/backend/src/modules/tickets/tickets.service.js';
import { TicketGovernanceService } from '../../../../packages/backend/src/modules/tickets/ticket-governance.service.js';
import { WorkflowService } from '../../../../packages/backend/src/modules/workflow/workflow.service.js';
import { unconfiguredCapabilities } from '../../../../packages/backend/src/capabilities.js';
import type { AuthenticatedRequest } from './session.js';

const idSchema = z.uuid();
const commentSchema = z.strictObject({
  body: z.string().trim().min(1).max(20000),
  visibility: z.enum(['public', 'internal']),
});

@Controller('api/tickets')
export class TicketsController {
  constructor(
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(WorkflowService) private readonly workflow: WorkflowService,
    @Inject(TicketGovernanceService) private readonly governance: TicketGovernanceService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.tickets.list(request.identity);
  }

  @Post()
  create(@Req() request: AuthenticatedRequest, @Body() raw: unknown) {
    return this.tickets.create(request.identity, createTicketSchema.parse(raw));
  }

  @Post(':id/revisions')
  revise(@Req() request: AuthenticatedRequest, @Param('id') rawId: string, @Body() raw: unknown) {
    return this.tickets.update(
      request.identity,
      idSchema.parse(rawId),
      updateTicketSchema.parse(raw),
    );
  }

  @Post(':id/assignments')
  assign(@Req() request: AuthenticatedRequest, @Param('id') rawId: string, @Body() raw: unknown) {
    return this.tickets.assign(
      request.identity,
      idSchema.parse(rawId),
      ticketAssignmentsInputSchema.parse(raw),
    );
  }

  @Get(':id')
  async detail(@Req() request: AuthenticatedRequest, @Param('id') rawId: string) {
    const id = idSchema.parse(rawId);
    const result = await this.tickets.detail(request.identity, id);
    const proposal = await this.workflow.currentProposal(request.identity, id);
    return {
      ...result,
      participants: await this.governance.participants(request.identity, id),
      resolution: await this.governance.resolution(request.identity, id),
      invalidations: await this.governance.invalidations(request.identity, id),
      proposal,
      approvalHash: await this.workflow.approvalHash(request.identity, id, result.ticket.status),
      blockers: unconfiguredCapabilities().blockers,
    };
  }

  @Get(':id/participants/candidates')
  participantCandidates(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.governance.candidates(req.identity, idSchema.parse(id));
  }

  @Post(':id/participants')
  participants(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.governance.changeParticipant(req.identity, idSchema.parse(id), raw);
  }

  @Post(':id/resolutions')
  resolution(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.governance.proposeResolution(req.identity, idSchema.parse(id), raw);
  }

  @Post(':id/resolutions/decision')
  resolutionDecision(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    return this.governance.decideResolution(req.identity, idSchema.parse(id), raw);
  }

  @Post(':id/comments')
  comment(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.tickets.comment(request.identity, idSchema.parse(id), commentSchema.parse(raw));
  }

  @Post(':id/comments/:commentId/revisions')
  reviseComment(
    @Req() request: AuthenticatedRequest,
    @Param('id') rawId: string,
    @Param('commentId') rawCommentId: string,
    @Body() raw: unknown,
  ) {
    return this.tickets.reviseComment(
      request.identity,
      idSchema.parse(rawId),
      idSchema.parse(rawCommentId),
      commentRevisionInputSchema.parse(raw),
    );
  }

  @Post(':id/transitions')
  transition(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.workflow.transition(request.identity, idSchema.parse(id), raw);
  }

  @Post(':id/proposals')
  proposal(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.workflow.publishProposal(request.identity, idSchema.parse(id), raw);
  }

  @Post(':id/decisions')
  decision(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.workflow.decide(request.identity, idSchema.parse(id), raw);
  }
}
