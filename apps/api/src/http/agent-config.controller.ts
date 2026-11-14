import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentInstructionsService } from '../../../../packages/backend/src/modules/agents/agent-instructions.service.js';
import { ProductionRelayService } from '../../../../packages/backend/src/modules/connectors/production-relay.service.js';
import type { AuthenticatedRequest } from './session.js';

/** Configuração do agente do projeto: instruções versionadas e relay de Produção. */
@Controller('api/agent')
export class AgentConfigController {
  constructor(
    @Inject(AgentInstructionsService) private readonly instructions: AgentInstructionsService,
    @Inject(ProductionRelayService) private readonly relay: ProductionRelayService,
  ) {}

  @Get('instructions')
  getInstructions(@Req() req: AuthenticatedRequest) {
    return this.instructions.get(req.identity);
  }
  @Post('instructions')
  @HttpCode(200)
  saveInstructions(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    return this.instructions.save(req.identity, raw);
  }
  @Post('settings')
  @HttpCode(200)
  saveSettings(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    return this.instructions.saveSettings(req.identity, raw);
  }
  @Get('relay')
  relayStatus(@Req() req: AuthenticatedRequest) {
    return this.relay.status(req.identity);
  }
  @Post('relay/token')
  @HttpCode(200)
  rotateRelayToken(@Req() req: AuthenticatedRequest) {
    return this.relay.rotateToken(req.identity);
  }
}

/** Endpoints do relay instalado em Produção: sem sessão, autenticados só pelo token Bearer. */
@Controller('api/relay')
export class RelayController {
  constructor(@Inject(ProductionRelayService) private readonly relay: ProductionRelayService) {}

  @Post('poll')
  @HttpCode(200)
  poll(@Req() req: Request, @Body() raw: unknown) {
    return this.relay.poll(req.headers.authorization, raw);
  }
  @Post('requests/:id/result')
  @HttpCode(200)
  result(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
    return this.relay.complete(req.headers.authorization, id, raw);
  }
}
