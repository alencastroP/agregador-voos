import type {
  ProviderSearchResult,
  FlightProvider,
} from '../../src/application/ports/flight-provider.js';
import type { Clock } from '../../src/application/ports/clock.js';
import { SearchFlights, type SearchFlightsDeps } from '../../src/application/search-flights.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { staticFlags, type SearchFlags } from '../../src/application/ports/feature-flags.js';
import { DEFAULT_BALANCED_PARAMS } from '../../src/domain/selection/strategies.js';
import type { ProviderId } from '../../src/domain/provider.js';
import type { SearchQuery } from '../../src/domain/search-query.js';
import { InMemorySearchCache } from '../../src/infrastructure/cache/in-memory-search-cache.js';
import { NoopSearchRepository } from '../../src/infrastructure/persistence/noop-search-repository.js';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    LOG_LEVEL: 'silent',
    PROVIDER_A_URL: 'http://a.test/search',
    PROVIDER_B_URL: 'http://b.test/search',
    PROVIDER_C_URL: 'http://c.test/search',
    ...overrides,
  });
}

/** Relógio controlável: 2026-11-14 12:00 em São Paulo (15:00 UTC). */
export class FakeClock implements Clock {
  constructor(public current = new Date('2026-11-14T15:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

type Behaviour =
  | { kind: 'ok'; result: (q: SearchQuery) => ProviderSearchResult; delayMs?: number }
  | { kind: 'fail'; error: Error; delayMs?: number }
  /** Ignora o AbortSignal e nunca responde: testa o deadline do use case. */
  | { kind: 'hang' };

/** Provider falso que registra as chamadas e respeita (ou não) o AbortSignal. */
export class FakeProvider implements FlightProvider {
  calls = 0;
  lastSignal: AbortSignal | undefined;

  constructor(
    readonly id: ProviderId,
    public behaviour: Behaviour,
  ) {}

  async search(query: SearchQuery, signal: AbortSignal): Promise<ProviderSearchResult> {
    this.calls += 1;
    this.lastSignal = signal;
    const b = this.behaviour;
    if (b.kind === 'hang') return new Promise(() => undefined);
    if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
    if (b.kind === 'fail') throw b.error;
    return b.result(query);
  }
}

export function useCase(overrides: Partial<SearchFlightsDeps> & { providers: FlightProvider[] }) {
  const clock = overrides.clock ?? new FakeClock();
  return new SearchFlights({
    flags: staticFlags(defaultFlags()),
    cache: new InMemorySearchCache(clock),
    repository: new NoopSearchRepository(),
    clock,
    config: {
      providerTimeoutMs: 200,
      cacheTtlSeconds: 300,
      partialCacheTtlSeconds: 30,
      timezone: 'America/Sao_Paulo',
      maxDaysAhead: 365,
    },
    ...overrides,
  });
}

/** Flags padrão dos testes: balanced (τ 1,5%, teto R$ 25, k 0), tudo ligado. */
export function defaultFlags(overrides: Partial<SearchFlags> = {}): SearchFlags {
  return {
    strategy: 'balanced',
    balanced: DEFAULT_BALANCED_PARAMS,
    providers: { 'provider-a': true, 'provider-b': true, 'provider-c': true },
    cacheEnabled: true,
    ...overrides,
  };
}
