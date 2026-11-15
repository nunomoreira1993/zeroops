import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { CapabilityDevelopmentService } from '../../../../packages/backend/src/modules/capabilities/capability-development.service.js';
import type { AuthenticatedRequest } from './session.js';

/** Desenvolvimento de capacidades pedidas na autoria e recursos atribuídos ao projeto (P10). */
@Controller('api/projects/:projectId')
export class CapabilityDevelopmentController {
  constructor(
    @Inject(CapabilityDevelopmentService)
    private readonly capabilities: CapabilityDevelopmentService,
  ) {}

  @Get('capabilities/settings')
  settings(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.capabilities.settings(req.identity, projectId);
  }

  @Post('capabilities/settings')
  saveSettings(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.capabilities.saveSettings(req.identity, projectId, raw);
  }

  @Get('flows/:flowId/capability-developments')
  list(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
  ) {
    return this.capabilities.list(req.identity, projectId, flowId);
  }

  @Post('flows/:flowId/capability-developments')
  start(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Body() raw: unknown,
  ) {
    return this.capabilities.start(req.identity, projectId, flowId, raw);
  }

  @Post('flows/:flowId/capability-developments/:id/authorize-publish')
  authorizePublish(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    return this.capabilities.authorizePublish(req.identity, projectId, flowId, id, raw);
  }

  @Post('flows/:flowId/capability-developments/:id/cancel')
  cancel(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    return this.capabilities.cancel(req.identity, projectId, flowId, id, raw);
  }

  @Post('flows/:flowId/capability-developments/:id/link')
  link(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('flowId') flowId: string,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    return this.capabilities.link(req.identity, projectId, flowId, id, raw);
  }
}
