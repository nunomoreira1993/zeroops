import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ProjectLogoService } from '../../../../packages/backend/src/modules/identity/project-logo.service.js';
import type { AuthenticatedRequest } from './session.js';

@Controller('api')
export class ProjectLogoController {
  constructor(@Inject(ProjectLogoService) private readonly logos: ProjectLogoService) {}

  @Get('projects/:id/logo')
  async read(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Res() response: Response,
  ) {
    const logo = await this.logos.read(request.identity, z.uuid().parse(id));
    // URL versionado (?v=): pode ficar em cache privada; SVG isolado de scripts e navegação.
    response.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    response.setHeader('Content-Type', logo.mime);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    response.setHeader('Content-Disposition', 'inline; filename="logo"');
    response.end(logo.data);
  }

  @Post('instance/projects/:id/logo')
  update(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.logos.update(request.identity, z.uuid().parse(id), raw);
  }

  @Post('instance/projects/:id/logo/remove')
  remove(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    z.strictObject({}).parse(raw ?? {});
    return this.logos.remove(request.identity, z.uuid().parse(id));
  }
}
