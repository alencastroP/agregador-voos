/**
 * Composition root: o ÚNICO lugar que conhece as implementações concretas.
 * Injeção de dependência manual, sem container/decorators: dá para ler o grafo de cima a baixo.
 */
import { systemClock } from './application/ports/clock.js';
import { SearchFlights } from './application/search-flights.js';
import { ConfigError, loadConfig } from './config/env.js';
import { createStrategy } from './domain/selection/select-offers.js';
import { InMemorySearchCache } from './infrastructure/cache/in-memory-search-cache.js';
import {
  createRedisClient,
  RedisSearchCache,
  waitForRedis,
} from './infrastructure/cache/redis-search-cache.js';
import {
  providersIndicator,
  redisIndicator,
  withTimeout,
} from './infrastructure/observability/health-indicators.js';
import { Metrics } from './infrastructure/observability/metrics.js';
import {
  activeTraceIds,
  OtelTracer,
  startTelemetry,
} from './infrastructure/observability/telemetry.js';
import { NoopSearchRepository } from './infrastructure/persistence/noop-search-repository.js';
import { createResilientProviders } from './infrastructure/providers/create-providers.js';
import { buildApp } from './interfaces/http/app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const clock = systemClock;

  // Telemetria ANTES de qualquer fetch: a instrumentação do undici precisa estar registrada.
  const telemetry = startTelemetry({
    endpoint: config.telemetry.otlpEndpoint,
    serviceName: config.telemetry.serviceName,
    serviceVersion: config.version,
  });
  const tracer = new OtelTracer();
  const metrics = new Metrics();

  const { strategy: name, ...balanced } = config.selection;
  const strategy = createStrategy(name, balanced);

  const redis = config.cache.redisUrl
    ? createRedisClient({
        url: config.cache.redisUrl,
        commandTimeoutMs: config.cache.redisCommandTimeoutMs,
      })
    : undefined;
  // Sem listener de 'error' o ioredis loga cada tentativa de reconexão como erro não tratado.
  redis?.on('error', (err: Error) => {
    console.error(JSON.stringify({ level: 40, msg: 'redis connection error', err: err.message }));
  });
  const redisReady = redis ? await waitForRedis(redis, 2_000) : false;
  const cache = redis ? new RedisSearchCache(redis) : new InMemorySearchCache(clock);

  // Logger do app ainda não existe aqui: transições de circuito são registradas depois do build.
  let onCircuitTransition: (provider: string, from: string, to: string) => void = () => undefined;
  const { providers, breakers } = createResilientProviders(config.providers.urls, {
    retry: { ...config.providers.retry, budgetMs: config.providers.timeoutMs },
    circuitBreaker: config.providers.circuitBreaker,
    clock,
    onCircuitTransition: (provider, from, to) => {
      onCircuitTransition(provider, from, to);
    },
  });
  metrics.trackCircuits(breakers);

  const searchFlights = new SearchFlights({
    providers,
    strategy: () => strategy,
    cache,
    repository: new NoopSearchRepository(),
    clock,
    observer: metrics.observer(),
    tracer,
    config: {
      providerTimeoutMs: config.providers.timeoutMs,
      cacheTtlSeconds: config.cache.ttlSeconds,
      partialCacheTtlSeconds: config.cache.partialTtlSeconds,
      timezone: config.search.timezone,
      maxDaysAhead: config.search.maxDaysAhead,
    },
  });

  let draining = false;
  const app = buildApp({
    config,
    searchFlights,
    health: {
      indicators: [withTimeout(redisIndicator(redis), 500), providersIndicator(breakers)],
      isDraining: () => draining,
      version: config.version,
    },
    observability: { metrics, tracer, logMixin: activeTraceIds },
  });
  onCircuitTransition = (provider, from, to) => {
    app.log.warn({ provider, from, to }, 'circuit breaker transition');
  };

  /**
   * Graceful shutdown em etapas: (1) readiness → 503 e espera o LB tirar a instância,
   * (2) fecha o servidor drenando requisições em curso, (3) fecha Redis e faz flush dos traces.
   */
  const shutdown = async (signal: string): Promise<void> => {
    draining = true;
    app.log.info({ signal, graceMs: config.shutdownGraceMs }, 'shutting down');
    await new Promise((resolve) => setTimeout(resolve, config.shutdownGraceMs));
    await app.close();
    await redis?.quit().catch(() => undefined);
    await telemetry?.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.http.host, port: config.http.port });
  app.log.info(
    {
      version: config.version,
      strategy: strategy.fingerprint,
      cache: redis ? 'redis' : 'in-memory',
      tracing: telemetry ? config.telemetry.otlpEndpoint : 'disabled',
    },
    'aggregator ready',
  );
  if (!redis) app.log.warn('REDIS_URL not set: using in-memory cache (single instance only)');
  else if (!redisReady) app.log.warn('redis not ready at boot: serving without cache until it is');
}

main().catch((error: unknown) => {
  // Logger do Fastify pode nem existir ainda (ex.: config inválida), então stderr direto.
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
