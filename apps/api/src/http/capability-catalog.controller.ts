import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { SkillsService } from '../../../../packages/backend/src/modules/agents/skills.service.js';
import type { AuthenticatedRequest } from './session.js';

/** Catálogo de skills do projeto, bindings de ferramentas e partilhas explícitas (P04). */
@Controller('api/project-admin/:projectId')
export class CapabilityCatalogController {
  constructor(@Inject(SkillsService) private readonly skills: SkillsService) {}

  @Get('skills')
  catalog(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.skills.catalog(req.identity, projectId);
  }

  @Post('skills/import')
  importSkill(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.skills.importSkill(req.identity, projectId, raw);
  }

  @Post('skills/:skillId/versions')
  addVersion(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('skillId') skillId: string,
    @Body() raw: unknown,
  ) {
    return this.skills.addVersion(req.identity, projectId, skillId, raw);
  }

  @Post('skills/:skillId/archive')
  archive(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('skillId') skillId: string,
  ) {
    return this.skills.archive(req.identity, projectId, skillId);
  }

  @Post('skills/:skillId/bindings')
  setBindings(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('skillId') skillId: string,
    @Body() raw: unknown,
  ) {
    return this.skills.setBindings(req.identity, projectId, skillId, raw);
  }

  @Post('capability-shares')
  share(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.skills.share(req.identity, projectId, raw);
  }

  @Post('capability-shares/:shareId/revoke')
  revokeShare(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('shareId') shareId: string,
  ) {
    return this.skills.revokeShare(req.identity, projectId, shareId);
  }

  @Post('capability-shares/:shareId/adopt')
  adopt(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('shareId') shareId: string,
  ) {
    return this.skills.adopt(req.identity, projectId, shareId);
  }
}
