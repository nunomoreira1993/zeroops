import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { IntegrationSettingsService } from '../../../../packages/backend/src/modules/integrations/integration-settings.service.js';
import type { AuthenticatedRequest } from './session.js';

@Controller('api/integration-settings')
export class IntegrationSettingsController {
  constructor(
    @Inject(IntegrationSettingsService) private readonly settings: IntegrationSettingsService,
  ) {}
  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.settings.list(req.identity);
  }
  @Post()
  save(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    return this.settings.save(req.identity, raw);
  }
  @Post(':id/test')
  test(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.settings.test(req.identity, z.uuid().parse(id), raw);
  }
  @Post(':id/revoke')
  revoke(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.settings.revoke(req.identity, z.uuid().parse(id), raw);
  }
}
