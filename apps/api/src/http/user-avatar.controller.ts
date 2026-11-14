import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { UserAvatarService } from '../../../../packages/backend/src/modules/identity/user-avatar.service.js';
import type { AuthenticatedRequest } from './session.js';

@Controller('api')
export class UserAvatarController {
  constructor(@Inject(UserAvatarService) private readonly avatars: UserAvatarService) {}

  @Get('users/:id/avatar')
  async read(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Res() response: Response,
  ) {
    const avatar = await this.avatars.read(request.identity, z.uuid().parse(id));
    // URL versionado (?v=): pode ficar em cache privada.
    response.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    response.setHeader('Content-Type', avatar.mime);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.setHeader('Content-Disposition', 'inline; filename="avatar"');
    response.end(avatar.data);
  }

  @Post('account/avatar')
  update(@Req() request: AuthenticatedRequest, @Body() raw: unknown) {
    return this.avatars.update(request.identity, raw);
  }

  @Post('account/avatar/remove')
  remove(@Req() request: AuthenticatedRequest, @Body() raw: unknown) {
    z.strictObject({}).parse(raw ?? {});
    return this.avatars.remove(request.identity);
  }
}
