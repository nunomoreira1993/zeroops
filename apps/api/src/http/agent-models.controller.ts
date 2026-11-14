import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { z } from 'zod';
import { AgentModelsService } from '../../../../packages/backend/src/modules/agents/agent-models.service.js';
import type { AuthenticatedRequest } from './session.js';

/** Modelos Copilot disponíveis para investigar um ticket (equipa). */
@Controller('api/tickets/:id/agent-models')
export class AgentModelsController {
  constructor(@Inject(AgentModelsService) private readonly models: AgentModelsService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.models.catalog(request.identity, z.uuid().parse(id));
  }
}
