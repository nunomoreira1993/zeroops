import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { IdentityService } from '../../../../packages/backend/src/modules/identity/identity.service.js';
import { sessionToken, type AuthenticatedRequest } from './session.js';
import { challengeToken } from './session.js';
import { AccountService } from '../../../../packages/backend/src/modules/identity/account.service.js';
import type { AuthenticationStep } from '../../../../packages/backend/src/modules/identity/authentication.js';

export const HTTP_CONFIG = Symbol('HTTP_CONFIG');
export interface HttpConfig {
  publicUrl: string;
  staticDirectory?: string;
  /** Aceita o ultimo X-Forwarded-For quando o pedido chega de um proxy em loopback (Apache). */
  trustLoopbackProxy?: boolean;
}
const loginSchema = z.strictObject({
  email: z.email().max(320),
  password: z.string().min(1).max(200),
});
const activationSchema = z.strictObject({
  token: z.string().min(32).max(256),
  password: z.string().min(12).max(200),
  displayName: z.string().trim().min(2).max(100),
});

@Controller('api')
export class AuthController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(HTTP_CONFIG) private readonly config: HttpConfig,
    @Inject(AccountService) private readonly accounts: AccountService,
  ) {}

  private attach(response: Response, token: string) {
    response.cookie('zeroops_session', token, {
      httpOnly: true,
      secure: this.config.publicUrl.startsWith('https:'),
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 60 * 60 * 1000,
    });
  }
  private result(response: Response, step: AuthenticationStep) {
    if (step.status === 'authenticated') {
      this.attach(response, step.token);
      response.clearCookie('zeroops_challenge', { path: '/' });
      return {
        status: step.status,
        user: step.user,
        csrfToken: step.csrfToken,
        ...(step.recoveryCodes ? { recoveryCodes: step.recoveryCodes } : {}),
      };
    }
    response.clearCookie('zeroops_session', { path: '/' });
    response.cookie('zeroops_challenge', step.token, {
      httpOnly: true,
      secure: this.config.publicUrl.startsWith('https:'),
      sameSite: 'strict',
      path: '/',
      maxAge: 5 * 60000,
    });
    return { status: step.status, csrfToken: step.csrfToken };
  }

  @Post('auth/login')
  async login(@Body() raw: unknown, @Res({ passthrough: true }) response: Response) {
    const input = loginSchema.parse(raw);
    const session = await this.identity.login(input.email, input.password);
    return this.result(response, session);
  }

  @Post('auth/activate')
  async activate(@Body() raw: unknown, @Res({ passthrough: true }) response: Response) {
    const session = await this.identity.activate(activationSchema.parse(raw));
    return this.result(response, session);
  }

  @Post('auth/logout')
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.identity.logout(sessionToken(request));
    response.clearCookie('zeroops_session', {
      path: '/',
      secure: this.config.publicUrl.startsWith('https:'),
      sameSite: 'strict',
      httpOnly: true,
    });
    return { ok: true };
  }

  @Get('session')
  session(@Req() request: AuthenticatedRequest) {
    return { user: request.identity, csrfToken: request.csrfToken };
  }
  @Get('projects')
  projects(@Req() request: AuthenticatedRequest) {
    return this.identity.projects(request.identity);
  }
  @Post('projects/select')
  async selectProject(
    @Req() request: AuthenticatedRequest,
    @Body() raw: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { projectId } = z.strictObject({ projectId: z.uuid() }).parse(raw);
    return this.result(
      response,
      await this.identity.switchProject(request.identity, sessionToken(request), projectId),
    );
  }
  @Get('instance/projects')
  instanceProjects(@Req() request: AuthenticatedRequest) {
    return this.identity.instanceProjects(request.identity);
  }
  @Get('instance/users')
  instanceUsers(@Req() request: AuthenticatedRequest) {
    return this.identity.instanceUsers(request.identity);
  }
  @Post('instance/projects')
  createProject(@Req() request: AuthenticatedRequest, @Body() raw: unknown) {
    return this.identity.createProject(request.identity, raw);
  }

  @Post('instance/projects/:id')
  updateProject(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    return this.identity.updateProject(request.identity, z.uuid().parse(id), raw);
  }

  @Post('invitations')
  async invite(@Req() request: AuthenticatedRequest, @Body() raw: unknown) {
    return this.accounts.invite(request.identity, raw);
  }
  @Get('auth/challenge')
  challenge(@Req() req: AuthenticatedRequest) {
    return this.identity.authentication.challenge(challengeToken(req));
  }
  @Post('auth/challenge')
  async complete(
    @Req() req: AuthenticatedRequest,
    @Body() raw: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { code } = z.strictObject({ code: z.string().min(1).max(128) }).parse(raw);
    return this.result(
      response,
      await this.identity.authentication.complete(challengeToken(req), code),
    );
  }
  @Post('auth/enrollment')
  enrollment(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    z.strictObject({}).parse(raw);
    return this.identity.authentication.enrollment(challengeToken(req));
  }
  @Post('auth/enrollment/confirm')
  async enrollmentConfirm(
    @Req() req: AuthenticatedRequest,
    @Body() raw: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { code } = z.strictObject({ code: z.string().regex(/^\d{6}$/) }).parse(raw);
    return this.result(
      response,
      await this.identity.authentication.complete(challengeToken(req), code, true),
    );
  }
  @Post('auth/reset/request')
  resetRequest(@Body() raw: unknown) {
    return this.accounts.requestReset(raw);
  }
  @Post('auth/reset/confirm')
  async resetConfirm(@Body() raw: unknown) {
    const input = z
      .strictObject({ token: z.string(), password: z.string().min(12).max(128) })
      .parse(raw);
    await this.identity.resetPassword(input);
    return { ok: true };
  }
  @Post('auth/email/confirm')
  emailConfirm(@Body() raw: unknown) {
    return this.accounts.confirmEmail(z.strictObject({ token: z.string() }).parse(raw).token);
  }
  @Post('auth/mfa-reset/confirm')
  async mfaReset(@Body() raw: unknown, @Res({ passthrough: true }) response: Response) {
    return this.result(response, await this.accounts.confirmMfaReset(raw));
  }
}
