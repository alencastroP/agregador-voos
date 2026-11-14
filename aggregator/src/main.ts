/**
 * Composition root: o ÚNICO lugar que conhece as implementações concretas.
 * Injeção de dependência manual, sem container/decorators: dá para ler o grafo de cima a baixo.
 */
import { systemClock } from './application/ports/clock.js';
import { SearchFlights } from './application/search-flights.js';
import { ConfigError, loadConfig } from './config/env.js';
import { createStrategy } from './domain/selection/select-offers.js';
import { InMemorySearchCache } from './infrastructure/cache/in-memory-search-cache.js';
import { NoopSearchRepository } from './infrastructure/persistence/noop-search-repository.js';
import { createHttpProviders } from './infrastructure/providers/create-providers.js';
import { buildApp } from './interfaces/http/app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const clock = systemClock;

  const { strategy: name, ...balanced } = config.selection;
  const strategy = createStrategy(name, balanced);

  const searchFlights = new SearchFlights({
    providers: createHttpProviders(config.providers.urls),
    strategy: () => strategy,
    cache: new InMemorySearchCache(clock),
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
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.http.host, port: config.http.port });
  app.log.info({ strategy: strategy.fingerprint }, 'aggregator ready');
}

main().catch((error: unknown) => {
  // Logger do Fastify pode nem existir ainda (ex.: config inválida), então stderr direto.
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
