import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Tracer } from '../../application/ports/tracer.js';
import type { AppConfig } from '../../config/env.js';
import type { Metrics } from '../../infrastructure/observability/metrics.js';
import { sendProblem, toProblem } from './problem-details.js';
import { registerHealthRoutes, type HealthDeps } from './routes/health.route.js';
import { registerSearchRoutes, type SearchUseCase } from './routes/search.route.js';

export interface AppDeps {
  readonly config: AppConfig;
  readonly searchFlights: SearchUseCase;
  readonly health?: HealthDeps;
  readonly observability?: {
    readonly metrics?: Metrics;
    readonly tracer?: Tracer;
    /** Campos extras em todo log (ex.: traceId/spanId do span ativo). */
    readonly logMixin?: () => object;
  };
}

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[\w.:-]{1,128}$/;

/**
 * Monta o servidor HTTP sem dar `listen`: testes usam `app.inject()` sem abrir porta.
 * As dependências chegam prontas do composition root (main.ts); aqui só tem HTTP.
 */
export function buildApp({
  config,
  searchFlights,
  health,
  observability,
}: AppDeps): FastifyInstance {
  const metrics = observability?.metrics;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Nada sensível em log: credenciais de cabeçalho nunca aparecem.
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
      ...(observability?.logMixin ? { mixin: observability.logMixin } : {}),
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

  if (metrics) {
    // Rótulo = rota DECLARADA (/search), nunca a URL crua: cardinalidade fechada.
    app.addHook('onResponse', async (request, reply) => {
      metrics.httpDuration.observe(
        {
          method: request.method,
          route: request.routeOptions.url ?? 'unmatched',
          status_code: String(reply.statusCode),
        },
        reply.elapsedTime / 1000,
      );
    });
    app.get('/metrics', async (_request, reply) =>
      reply.type(metrics.registry.contentType).send(await metrics.registry.metrics()),
    );
  }

  app.setErrorHandler((error, request, reply) => {
    const problem = toProblem(error, request);
    // 500 é bug (error); 503 é degradação esperada e já logada por provider (warn).
    if (problem.status === 500) request.log.error({ err: error }, 'request failed');
    else if (problem.status === 503) request.log.warn({ err: error }, 'service degraded');
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

  registerHealthRoutes(app, health ?? { indicators: [], isDraining: () => false, version: 'dev' });
  registerSearchRoutes(app, searchFlights, observability?.tracer);

  return app;
}
