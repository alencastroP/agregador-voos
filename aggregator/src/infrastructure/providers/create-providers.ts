import type { Clock } from '../../application/ports/clock.js';
import type { FlightProvider } from '../../application/ports/flight-provider.js';
import { DEFAULT_INCENTIVE_BPS, type ProviderId } from '../../domain/provider.js';
import {
  CircuitBreaker,
  CircuitBreakerFlightProvider,
  type CircuitBreakerPolicy,
  type CircuitState,
} from '../resilience/circuit-breaker.js';
import { RetryingFlightProvider, type RetryPolicy } from '../resilience/retry.js';
import { HttpFlightProvider } from './http-flight-provider.js';
import type { ProviderMapper } from './mappers/map-items.js';
import { mapProviderA } from './mappers/provider-a.mapper.js';
import { mapProviderB } from './mappers/provider-b.mapper.js';
import { mapProviderC } from './mappers/provider-c.mapper.js';

export interface ProviderUrls {
  readonly a: string;
  readonly b: string;
  readonly c: string;
}

const MAPPERS: readonly { id: ProviderId; key: keyof ProviderUrls; mapper: ProviderMapper }[] = [
  { id: 'provider-a', key: 'a', mapper: mapProviderA },
  { id: 'provider-b', key: 'b', mapper: mapProviderB },
  { id: 'provider-c', key: 'c', mapper: mapProviderC },
];

/** Os três providers "crus" (sem retry/circuito). Adicionar um 4º = um mapper + uma linha. */
export function createHttpProviders(urls: ProviderUrls, fetchFn?: typeof fetch): FlightProvider[] {
  return MAPPERS.map(
    ({ id, key, mapper }) =>
      new HttpFlightProvider({
        id,
        url: urls[key],
        mapper,
        incentiveRateBps: DEFAULT_INCENTIVE_BPS[id],
        ...(fetchFn ? { fetch: fetchFn } : {}),
      }),
  );
}

export interface ResilienceOptions {
  readonly retry: RetryPolicy;
  readonly circuitBreaker: CircuitBreakerPolicy;
  readonly clock: Clock;
  readonly onCircuitTransition?: (
    provider: ProviderId,
    from: CircuitState,
    to: CircuitState,
  ) => void;
}

export interface ResilientProviders {
  readonly providers: FlightProvider[];
  readonly breakers: ReadonlyMap<ProviderId, CircuitBreaker>;
}

/**
 * Composição por decorators (de fora para dentro):
 *   CircuitBreaker → Retry → HTTP
 * O circuito fica POR FORA para contar chamadas LÓGICAS (já com retry). Com chaos, ~51% das
 * tentativas falham, mas só ~13% das chamadas lógicas: contar tentativa abriria o circuito
 * de um provider que ainda é útil.
 */
export function createResilientProviders(
  urls: ProviderUrls,
  options: ResilienceOptions,
  fetchFn?: typeof fetch,
): ResilientProviders {
  const breakers = new Map<ProviderId, CircuitBreaker>();
  const providers = createHttpProviders(urls, fetchFn).map((http) => {
    const breaker = new CircuitBreaker(options.circuitBreaker, options.clock, (from, to) =>
      options.onCircuitTransition?.(http.id, from, to),
    );
    breakers.set(http.id, breaker);
    return new CircuitBreakerFlightProvider(
      new RetryingFlightProvider(http, options.retry),
      breaker,
    );
  });
  return { providers, breakers };
}
