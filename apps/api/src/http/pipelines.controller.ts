import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import {
  PIPELINE_SIGNATURE_HEADER,
  PIPELINE_TIMESTAMP_HEADER,
} from '../../../../packages/contracts/src/index.js';
import { DeliveryStore } from '../../../../packages/backend/src/modules/delivery/delivery.store.js';
import { receivePipelineCallback } from '../../../../packages/backend/src/modules/delivery/pipeline-callbacks.js';
import { PipelinesService } from '../../../../packages/backend/src/modules/delivery/pipelines.service.js';
import type { Request } from 'express';
import type { AuthenticatedRequest } from './session.js';

/** Pipelines de entrega por projeto (P09). */
@Controller('api/projects/:projectId/pipelines')
export class PipelinesController {
  constructor(@Inject(PipelinesService) private readonly pipelines: PipelinesService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.pipelines.list(req.identity, projectId);
  }

  @Post()
  create(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() raw: unknown,
  ) {
    return this.pipelines.create(req.identity, projectId, raw);
  }

  @Post(':id')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    return this.pipelines.update(req.identity, projectId, id, raw);
  }

  @Post(':id/archive')
  archive(
    @Req() req: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    return this.pipelines.archive(req.identity, projectId, id, raw);
  }
}

/** Callbacks assinadas do fornecedor (sem sessão; HMAC sobre o corpo exato). */
@Controller('api/pipelines/:pipelineId/callbacks')
export class PipelineCallbacksController {
  constructor(@Inject(DeliveryStore) private readonly deliveries: DeliveryStore) {}

  @Post()
  @HttpCode(200)
  receive(@Req() req: Request & { rawBody?: Buffer }, @Param('pipelineId') pipelineId: string) {
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    return receivePipelineCallback(this.deliveries, pipelineId, {
      timestamp: header(PIPELINE_TIMESTAMP_HEADER),
      signature: header(PIPELINE_SIGNATURE_HEADER),
      body: req.rawBody,
    });
  }
}
