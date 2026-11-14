import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AgentRunEventsService } from '../../../../packages/backend/src/modules/agents/agent-run-events.service.js';
import { AgentRunsService } from '../../../../packages/backend/src/modules/agents/agent-runs.service.js';
import type { AuthenticatedRequest } from './session.js';

const idSchema = z.uuid();
const afterSchema = z.coerce.number().int().min(0).catch(0);

const STREAM_POLL_MS = 1000;
const STREAM_HEARTBEAT_MS = 15000;
const STREAM_MAX_MS = 10 * 60 * 1000;
const FINISHED = new Set(['succeeded', 'failed', 'cancelled']);

@Controller('api/tickets/:id/agent-runs')
export class AgentRunsController {
  constructor(
    @Inject(AgentRunsService) private readonly runs: AgentRunsService,
    @Inject(AgentRunEventsService) private readonly events: AgentRunEventsService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.runs.list(request.identity, idSchema.parse(id));
  }

  @Post()
  request(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.runs.request(request.identity, idSchema.parse(id), raw);
  }

  @Post(':runId/cancel')
  cancel(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('runId') runId: string,
  ) {
    return this.runs.cancel(request.identity, idSchema.parse(id), idSchema.parse(runId));
  }

  /** Eventos da conversa posteriores a `after` (alternativa ao stream quando o SSE falha). */
  @Get(':runId/events')
  listEvents(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Query('after') after: unknown,
  ) {
    return this.events.listSince(
      request.identity,
      idSchema.parse(id),
      idSchema.parse(runId),
      afterSchema.parse(after),
    );
  }

  /**
   * Server-Sent Events da conversa. Retoma a partir de `Last-Event-ID`; termina quando o run acaba
   * ou ao fim de alguns minutos (o browser volta a ligar automaticamente).
   */
  @Get(':runId/events/stream')
  async streamEvents(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Query('after') after: unknown,
  ) {
    const ticketId = idSchema.parse(id);
    const run = idSchema.parse(runId);
    let cursor = afterSchema.parse(request.headers['last-event-id'] ?? after);
    // Valida o acesso antes de abrir o stream, para os erros seguirem o formato JSON habitual.
    const first = await this.events.listSince(request.identity, ticketId, run, cursor);
    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    let closed = false;
    // `response` e nao `request`: em Node >= 16 o `close` do pedido dispara logo apos ler o corpo.
    response.on('close', () => {
      closed = true;
    });
    const started = Date.now();
    let lastWrite = Date.now();
    let page = first;
    while (!closed) {
      for (const event of page.events) {
        response.write(`id: ${event.id}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.id;
        lastWrite = Date.now();
      }
      if (FINISHED.has(page.status) && !page.events.length) {
        response.write(`event: end\ndata: ${JSON.stringify({ status: page.status })}\n\n`);
        break;
      }
      if (Date.now() - started > STREAM_MAX_MS) break;
      if (Date.now() - lastWrite > STREAM_HEARTBEAT_MS) {
        response.write(': heartbeat\n\n');
        lastWrite = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, STREAM_POLL_MS));
      if (closed) break;
      try {
        page = await this.events.listSince(request.identity, ticketId, run, cursor);
      } catch {
        break;
      }
    }
    response.end();
  }

  /** Resposta a uma pergunta do agente ou mensagem de seguimento para o run em curso. */
  @Post(':runId/inputs')
  submitInput(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Body() raw: unknown,
  ) {
    return this.events.submitInput(
      request.identity,
      idSchema.parse(id),
      idSchema.parse(runId),
      raw,
    );
  }
}
