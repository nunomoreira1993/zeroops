import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { AgentProfilesService } from '../../../../packages/backend/src/modules/agents/agent-profiles.service.js';
import type { AuthenticatedRequest } from './session.js';

/** Perfis ZeroOps e referências técnicas read-only do projeto. */
@Controller('api/project-admin/:projectId/agent-profiles')
export class AgentProfilesController {
  constructor(@Inject(AgentProfilesService) private readonly profiles: AgentProfilesService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.profiles.list(req.identity, projectId);
  }

  @Get('repository-resources')
  repositoryResources(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.profiles.repositoryResources(req.identity, projectId);
  }

  @Post()
  create(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.profiles.create(req.identity, projectId, raw);
  }

  @Post('import')
  importAgent(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.profiles.importAgent(req.identity, projectId, raw);
  }

  @Post(':profileId/versions')
  addVersion(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('profileId') profileId: string,
    @Body() raw: unknown,
  ) {
    return this.profiles.addVersion(req.identity, projectId, profileId, raw);
  }

  @Post(':profileId/archive')
  archive(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('profileId') profileId: string,
  ) {
    return this.profiles.archive(req.identity, projectId, profileId);
  }
}
