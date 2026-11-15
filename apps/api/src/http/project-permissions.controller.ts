import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { ProjectPermissionsService } from '../../../../packages/backend/src/modules/identity/project-permissions.service.js';
import type { AuthenticatedRequest } from './session.js';

/** Contexto seguro e gestão de capacidades explícitas de cada projeto. */
@Controller('api/projects/:projectId')
export class ProjectPermissionsController {
  constructor(
    @Inject(ProjectPermissionsService) private readonly permissions: ProjectPermissionsService,
  ) {}

  @Get('access')
  access(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.permissions.access(req.identity, projectId);
  }

  @Get('permissions')
  list(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.permissions.list(req.identity, projectId);
  }

  @Post('permissions')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.permissions.update(req.identity, projectId, raw);
  }
}
