import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { ConnectorGateway } from '../../../packages/backend/src/modules/connectors/connector-gateway.js';

const BODY_LIMIT = 16384;

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('BODY_TOO_LARGE'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * API interna dos conectores (`127.0.0.1`): `GET /v1/tools` e `POST /v1/[ambiente/]<ferramenta>`
 * (ambiente `quality` por omissão), ambos com `Authorization: Bearer <token do run>`.
 */
export function createConnectorServer(gateway: ConnectorGateway): Server {
  return createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method === 'GET' && request.url === '/v1/health')
        return send(200, { status: 'ready' });
      const authorization = request.headers.authorization ?? '';
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      if (request.method === 'GET' && request.url === '/v1/tools') {
        const tools = await gateway.toolsFor(token);
        return tools
          ? send(200, { tools })
          : send(401, { error: 'Token do run inválido ou run terminado.' });
      }
      const match = /^\/v1\/(?:(quality|production)\/)?([a-z][a-z0-9]{0,15})$/.exec(
        request.url ?? '',
      );
      if (request.method !== 'POST' || !match) return send(404, { error: 'Rota inexistente.' });
      let payload: unknown;
      try {
        payload = JSON.parse(await readBody(request));
      } catch {
        return send(400, { error: 'JSON inválido ou demasiado grande.' });
      }
      const environment = match[1] === 'production' ? 'production' : 'quality';
      const result = await gateway.call(token, match[2] ?? '', payload, environment);
      send(result.status, result.body);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'connectors.request_failed',
          type: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      if (!response.headersSent) send(500, { error: 'Erro interno dos conectores.' });
    }
  });
}
