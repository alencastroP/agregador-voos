import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { sendProblem, toProblem } from './problem-details.js';

export interface AppDeps {
  readonly config: AppConfig;
}

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[\w.:-]{1,128}$/;

/**
 * Monta o servidor HTTP sem dar `listen`: testes usam `app.inject()` sem abrir porta.
 * As dependências chegam prontas do composition root (main.ts); aqui só tem HTTP.
 */
export function buildApp({ config }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    // Correlation id: reaproveita o do cliente (se for seguro) ou gera um novo.
    genReqId: (req) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    const problem = toProblem(error, request);
    if (problem.status >= 500) request.log.error({ err: error }, 'request failed');
    return sendProblem(reply, problem);
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(reply, {
      type: 'about:blank',
      title: 'Rota não encontrada',
      status: 404,
      detail: `${request.method} ${request.url} não existe`,
      instance: request.url,
      requestId: request.id,
    }),
  );

  // Liveness: o processo responde. Readiness (Redis/Postgres) entra na fase de observabilidade.
  app.get('/health/live', () => ({ status: 'ok' }));

  return app;
}
