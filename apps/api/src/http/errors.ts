import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { DomainError } from '../../../../packages/backend/src/errors.js';

export function sendError(error: unknown, response: Response) {
  const requestId = response.getHeader('X-Request-Id');
  if (error instanceof DomainError) {
    response
      .status(error.status)
      .json({ error: { code: error.code, message: error.message, requestId } });
  } else if (error instanceof Error && 'type' in error && error.type === 'entity.parse.failed') {
    response.status(400).json({
      error: { code: 'invalid_json', message: 'O pedido nao contem JSON valido.', requestId },
    });
  } else if (error instanceof Error && 'type' in error && error.type === 'entity.too.large') {
    response.status(413).json({
      error: { code: 'body_limit', message: 'Pedido demasiado grande.', requestId },
    });
  } else if (error instanceof ZodError) {
    response.status(400).json({
      error: { code: 'invalid_input', message: 'Verifique os campos do pedido.', requestId },
    });
  } else if (error instanceof HttpException) {
    response
      .status(error.getStatus())
      .json({ error: { code: 'http_error', message: error.message, requestId } });
  } else {
    console.error(
      JSON.stringify({
        event: 'request.failed',
        requestId,
        type: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    response.status(500).json({
      error: {
        code: 'internal_error',
        message: 'Falha interna. Comunique o identificador do pedido.',
        requestId,
      },
    });
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    sendError(error, host.switchToHttp().getResponse<Response>());
  }
}
