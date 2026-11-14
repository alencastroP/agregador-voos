/**
 * Composition root: o ÚNICO lugar que conhece as implementações concretas.
 * Injeção de dependência manual, sem container/decorators: dá para ler o grafo de cima a baixo.
 */
import { OpenFeature } from '@openfeature/server-sdk';
import { systemClock } from './application/ports/clock.js';
import {
  staticFlags,
  type FeatureFlags,
  type SearchFlags,
} from './application/ports/feature-flags.js';
import { SearchFlights } from './application/search-flights.js';
import { ConfigError, loadConfig } from './config/env.js';
import { createStrategy } from './domain/selection/select-offers.js';
import { FileFlagProvider } from './infrastructure/flags/file-flag-provider.js';
import { OpenFeatureFlags } from './infrastructure/flags/openfeature-flags.js';
import { InMemorySearchCache } from './infrastructure/cache/in-memory-search-cache.js';
import {
  createRedisClient,
  RedisSearchCache,
  waitForRedis,
} from './infrastructure/cache/redis-search-cache.js';
import {
  postgresIndicator,
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
import { createDatabase, runMigrations } from './infrastructure/persistence/database.js';
import { NoopSearchRepository } from './infrastructure/persistence/noop-search-repository.js';
import { PostgresSearchRepository } from './infrastructure/persistence/postgres-search-repository.js';
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

  // Logger do app só existe depois do build: eventos de boot são enfileirados até lá.
  const bootEvents: { level: 'info' | 'warn'; obj: object; msg: string }[] = [];
  let logEvent = (level: 'info' | 'warn', obj: object, msg: string) => {
    bootEvents.push({ level, obj, msg });
  };

  // Feature flags: defaults vêm do .env; o arquivo (se houver) sobrescreve em runtime.
  const { strategy: name, ...balanced } = config.selection;
  const defaultFlags: SearchFlags = {
    strategy: name,
    balanced,
    providers: { 'provider-a': true, 'provider-b': true, 'provider-c': true },
    cacheEnabled: true,
  };
  const defaultStrategy = createStrategy(name, balanced); // valida os defaults no boot
  let flags: FeatureFlags = staticFlags(defaultFlags);
  if (config.flags.file) {
    await OpenFeature.setProviderAndWait(
      new FileFlagProvider({
        path: config.flags.file,
        pollIntervalMs: config.flags.pollMs,
        onReload: (r) => {
          logEvent(
            r.ok ? 'info' : 'warn',
            r,
            r.ok ? 'feature flags loaded' : 'feature flags file invalid, keeping last good',
          );
        },
      }),
    );
    flags = new OpenFeatureFlags(OpenFeature.getClient(), defaultFlags, (key, value) => {
      logEvent('warn', { key, value }, 'invalid feature flag value, using default');
    });
  }

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

  // Persistência analítica: opcional e nunca bloqueante. Migration falhou → sobe sem gravar.
  const database = config.database.url
    ? createDatabase({ url: config.database.url, poolMax: config.database.poolMax })
    : undefined;
  let persistence: PostgresSearchRepository | undefined;
  let persistenceProblem: string | undefined;
  if (database) {
    try {
      if (config.database.migrateOnBoot) await runMigrations(database.db);
      persistence = new PostgresSearchRepository(database.db, config.database.maxInFlightWrites);
    } catch (error) {
      persistenceProblem = error instanceof Error ? error.message : String(error);
    }
  }

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
    flags,
    cache,
    repository: persistence ?? new NoopSearchRepository(),
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
      indicators: [
        withTimeout(redisIndicator(redis), 500),
        withTimeout(
          postgresIndicator(
            persistence && database ? () => database.pool.query('select 1') : undefined,
            () => persistence?.pendingWrites ?? 0,
          ),
          500,
        ),
        providersIndicator(breakers),
      ],
      isDraining: () => draining,
      version: config.version,
    },
    observability: { metrics, tracer, logMixin: activeTraceIds },
  });
  onCircuitTransition = (provider, from, to) => {
    app.log.warn({ provider, from, to }, 'circuit breaker transition');
  };
  logEvent = (level, obj, msg) => {
    app.log[level](obj, msg);
  };
  for (const e of bootEvents.splice(0)) logEvent(e.level, e.obj, e.msg);

  /**
   * Graceful shutdown em etapas: (1) readiness → 503 e espera o LB tirar a instância,
   * (2) fecha o servidor drenando requisições em curso, (3) fecha Redis e faz flush dos traces.
   */
  const shutdown = async (signal: string): Promise<void> => {
    draining = true;
    app.log.info({ signal, graceMs: config.shutdownGraceMs }, 'shutting down');
    await new Promise((resolve) => setTimeout(resolve, config.shutdownGraceMs));
    await app.close();
    await persistence?.drain(5_000); // não perder as últimas buscas gravadas em background
    await database?.pool.end().catch(() => undefined);
    await redis?.quit().catch(() => undefined);
    await OpenFeature.close().catch(() => undefined);
    await telemetry?.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.http.host, port: config.http.port });
  app.log.info(
    {
      version: config.version,
      strategy: defaultStrategy.fingerprint,
      flags: config.flags.file ?? 'static (env)',
      cache: redis ? 'redis' : 'in-memory',
      tracing: telemetry ? config.telemetry.otlpEndpoint : 'disabled',
      persistence: persistence ? 'postgres' : 'disabled',
    },
    'aggregator ready',
  );
  if (!redis) app.log.warn('REDIS_URL not set: using in-memory cache (single instance only)');
  else if (!redisReady) app.log.warn('redis not ready at boot: serving without cache until it is');
  if (persistenceProblem) {
    app.log.error({ err: persistenceProblem }, 'database unavailable at boot: insights disabled');
  }
}

main().catch((error: unknown) => {
  // Logger do Fastify pode nem existir ainda (ex.: config inválida), então stderr direto.
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
