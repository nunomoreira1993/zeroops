import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { DevelopmentStore } from '../../../../packages/backend/src/modules/development/development.store.js';
import { GitRepositoriesService } from '../../../../packages/backend/src/modules/development/git-repositories.service.js';
import type { AuthenticatedRequest } from './session.js';

/** Repositórios Git de desenvolvimento por projeto (P08). */
@Controller('api/projects/:projectId/git-repositories')
export class GitRepositoriesController {
  constructor(
    @Inject(GitRepositoriesService) private readonly repositories: GitRepositoriesService,
  ) {}

  @Get()
  list(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.repositories.list(req.identity, projectId);
  }

  @Post()
  create(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.repositories.create(req.identity, projectId, raw);
  }

  @Post(':id')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    return this.repositories.update(req.identity, projectId, id, raw);
  }

  @Post(':id/archive')
  archive(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    return this.repositories.archive(req.identity, projectId, id, raw);
  }

  @Post(':id/credential/revoke')
  revokeCredential(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    return this.repositories.revokeCredential(req.identity, projectId, id, raw);
  }

  @Post(':id/verify')
  verify(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.repositories.verify(req.identity, projectId, id);
  }
}

/** Detalhe técnico do desenvolvimento de um ticket (workspace, diff, testes, PR, review). */
@Controller('api/tickets/:ticketId/development')
export class TicketDevelopmentController {
  constructor(@Inject(DevelopmentStore) private readonly development: DevelopmentStore) {}

  @Get()
  view(@Req() req: AuthenticatedRequest, @Param('ticketId') ticketId: string) {
    return this.development.ticketDevelopment(req.identity, ticketId);
  }
}
