import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '../../../../packages/backend/src/database/database.js';
import { DomainError } from '../../../../packages/backend/src/errors.js';
import { AccountService } from '../../../../packages/backend/src/modules/identity/account.service.js';
import { IdentityService } from '../../../../packages/backend/src/modules/identity/identity.service.js';
import { ProjectLogoService } from '../../../../packages/backend/src/modules/identity/project-logo.service.js';
import { requireProjectAdmin } from '../../../../packages/backend/src/modules/identity/membership.js';
import { IntegrationSettingsService } from '../../../../packages/backend/src/modules/integrations/integration-settings.service.js';
import { AgentInstructionsService } from '../../../../packages/backend/src/modules/agents/agent-instructions.service.js';
import { ProductionRelayService } from '../../../../packages/backend/src/modules/connectors/production-relay.service.js';
import { HealthService } from '../../../../packages/backend/src/modules/health/health.service.js';
import { sessionToken, type AuthenticatedRequest } from './session.js';

/** Explicit administration never changes the authenticated session's active project. */
@Controller('api/project-admin/:projectId')
export class ProjectAdminController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AccountService) private readonly accounts: AccountService,
    @Inject(ProjectLogoService) private readonly logos: ProjectLogoService,
    @Inject(IntegrationSettingsService) private readonly integrations: IntegrationSettingsService,
    @Inject(AgentInstructionsService) private readonly instructions: AgentInstructionsService,
    @Inject(ProductionRelayService) private readonly relay: ProductionRelayService,
    @Inject(HealthService) private readonly health: HealthService,
  ) {}

  private scope(req: AuthenticatedRequest, projectId: string) {
    return requireProjectAdmin(this.db, req.identity, projectId);
  }

  @Get()
  general(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.identity.administeredProject(req.identity, projectId);
  }

  @Post()
  saveGeneral(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.identity.updateProject(req.identity, projectId, raw, true);
  }

  @Post('account/reauth')
  reauth(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.accounts.reauthenticate(req.identity, sessionToken(req), raw, projectId);
  }

  @Post('logo')
  async logo(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.logos.update(await this.scope(req, projectId), projectId, raw);
  }

  @Post('logo/remove')
  async removeLogo(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.logos.remove(await this.scope(req, projectId), projectId);
  }

  @Get('users')
  async users(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.accounts.users(await this.scope(req, projectId));
  }

  @Get('users/:userId')
  async user(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
  ) {
    const id = z.uuid().parse(userId);
    const user = (await this.accounts.users(await this.scope(req, projectId))).find(
      (item) => item.id === id,
    );
    if (!user) throw new DomainError('NOT_FOUND', 'Conta indisponível.', 404);
    return user;
  }

  @Post('users/:userId')
  async updateUser(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() raw: unknown,
  ) {
    return this.accounts.update(await this.scope(req, projectId), z.uuid().parse(userId), raw);
  }

  @Post('users/:userId/action')
  async userAction(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() raw: unknown,
  ) {
    return this.accounts.action(await this.scope(req, projectId), z.uuid().parse(userId), raw);
  }

  @Post(['auth/invite', 'users', 'invitations'])
  async invite(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.accounts.invite(await this.scope(req, projectId), raw);
  }

  @Get('invitations')
  async invitations(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.accounts.invitations(await this.scope(req, projectId));
  }

  @Post('invitations/:id/action')
  async invitationAction(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    return this.accounts.invitationAction(
      await this.scope(req, projectId),
      z.uuid().parse(id),
      raw,
    );
  }

  @Get('integration-settings')
  async integrationSettings(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
  ) {
    return this.integrations.list(await this.scope(req, projectId));
  }

  @Post('integration-settings')
  async saveIntegration(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.integrations.save(await this.scope(req, projectId), raw);
  }

  @Post('integration-settings/:id/test')
  async testIntegration(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    return this.integrations.test(await this.scope(req, projectId), z.uuid().parse(id), raw);
  }

  @Post('integration-settings/:id/revoke')
  async revokeIntegration(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    return this.integrations.revoke(await this.scope(req, projectId), z.uuid().parse(id), raw);
  }

  @Get('agent/instructions')
  async agentInstructions(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.instructions.get(await this.scope(req, projectId));
  }

  @Post('agent/instructions')
  async saveInstructions(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.instructions.save(await this.scope(req, projectId), raw);
  }

  @Post('agent/settings')
  async agentSettings(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.instructions.saveSettings(await this.scope(req, projectId), raw);
  }

  @Get('agent/relay')
  async agentRelay(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.relay.status(await this.scope(req, projectId));
  }

  @Post('agent/relay/token')
  async relayToken(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.relay.rotateToken(await this.scope(req, projectId));
  }

  @Get('monitoring')
  async monitoring(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.health.overview(await this.scope(req, projectId));
  }

  @Post('monitoring/settings')
  async monitoringSettings(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.health.saveSettings(await this.scope(req, projectId), raw);
  }

  @Post('monitoring/agent-token')
  async monitoringToken(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.health.rotateAgentToken(await this.scope(req, projectId));
  }
}
