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
import { NoopSearchRepository } from './infrastructure/persistence/noop-search-repository.js';
import { createHttpProviders } from './infrastructure/providers/create-providers.js';
import { buildApp } from './interfaces/http/app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const clock = systemClock;

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

  const searchFlights = new SearchFlights({
    providers: createHttpProviders(config.providers.urls),
    strategy: () => strategy,
    cache,
    repository: new NoopSearchRepository(),
    clock,
    config: {
      providerTimeoutMs: config.providers.timeoutMs,
      cacheTtlSeconds: config.cache.ttlSeconds,
      partialCacheTtlSeconds: config.cache.partialTtlSeconds,
      timezone: config.search.timezone,
      maxDaysAhead: config.search.maxDaysAhead,
    },
  });

  const app = buildApp({ config, searchFlights });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close(); // para de aceitar conexões e drena as em andamento
    await redis?.quit().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.http.host, port: config.http.port });
  app.log.info(
    { strategy: strategy.fingerprint, cache: redis ? 'redis' : 'in-memory' },
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
