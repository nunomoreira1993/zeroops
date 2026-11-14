import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { AccountService } from '../../../../packages/backend/src/modules/identity/account.service.js';
import { sessionToken, type AuthenticatedRequest } from './session.js';

const confirmation = z.strictObject({ confirmationToken: z.string() });
@Controller('api')
export class AccountController {
  constructor(@Inject(AccountService) private readonly accounts: AccountService) {}
  @Get('account')
  account(@Req() req: AuthenticatedRequest) {
    return this.accounts.account(req.identity);
  }
  @Post('account/profile')
  profile(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.accounts.profile(req.identity, body);
  }
  @Post('account/reauth')
  reauth(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.accounts.reauthenticate(req.identity, sessionToken(req), body);
  }
  @Post('account/password')
  password(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.accounts.password(req.identity, body);
  }
  @Post('account/initial-password')
  initialPassword(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.accounts.initialPassword(req.identity, body);
  }
  @Post('account/sessions/revoke')
  revoke(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.accounts.revokeSessions(req.identity, confirmation.parse(body).confirmationToken);
  }
  @Post('account/mfa/start')
  start(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.accounts.mfaStart(req.identity, confirmation.parse(body).confirmationToken);
  }
  @Post('account/mfa/confirm')
  confirm(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.accounts.mfaConfirm(
      req.identity,
      z.strictObject({ code: z.string().regex(/^\d{6}$/) }).parse(body).code,
    );
  }
  @Post('account/mfa/disable')
  disable(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.accounts.mfaManage(
      req.identity,
      confirmation.parse(body).confirmationToken,
      'mfa-disable',
    );
  }
  @Post('account/mfa/codes')
  codes(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.accounts.mfaManage(
      req.identity,
      confirmation.parse(body).confirmationToken,
      'mfa-codes',
    );
  }
  @Get('users')
  users(@Req() req: AuthenticatedRequest) {
    return this.accounts.users(req.identity);
  }
  @Get('users/:id/deliveries')
  deliveries(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.accounts.deliveries(req.identity, z.uuid().parse(id));
  }
  @Post('users/:id/deliveries/:deliveryId/retry')
  retryDelivery(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('deliveryId') deliveryId: string,
  ) {
    return this.accounts.retryDelivery(
      req.identity,
      z.uuid().parse(id),
      z.uuid().parse(deliveryId),
    );
  }
  @Post('users/:id')
  update(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.accounts.update(req.identity, z.uuid().parse(id), body);
  }
  @Post('users/:id/action')
  action(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.accounts.action(req.identity, z.uuid().parse(id), body);
  }
  @Post('users/:id/email')
  email(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.accounts.email(req.identity, z.uuid().parse(id), body);
  }
  @Get('invitations')
  invitations(@Req() req: AuthenticatedRequest) {
    return this.accounts.invitations(req.identity);
  }
  @Post('invitations/:id/action')
  invitationAction(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.accounts.invitationAction(req.identity, z.uuid().parse(id), body);
  }
}
