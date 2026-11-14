import type { FlightOffer } from '../domain/flight-offer.js';
import type { IsoDate } from '../domain/local-date-time.js';
import type { ProviderId } from '../domain/provider.js';
import type { SelectionMeta, StrategyName } from '../domain/selection/strategy.js';

export const PROVIDER_STATUSES = ['ok', 'timeout', 'error', 'circuit_open', 'disabled'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

/** Como cada provider se saiu nesta busca: vai na resposta (meta), em log, métrica e banco. */
export interface ProviderReport {
  readonly name: ProviderId;
  readonly status: ProviderStatus;
  readonly latencyMs: number;
  readonly offersCount: number;
  readonly discardedCount: number;
  /** Tentativas feitas (retry). 0 quando o provider nem foi chamado (disabled/circuit_open). */
  readonly attempts: number;
  /** Código estável do erro (provider_timeout, provider_unavailable...). Nunca mensagem interna. */
  readonly errorCode?: string;
}

export interface SearchResultItem extends FlightOffer {
  readonly selection: SelectionMeta;
}

/** Parte cacheável da resposta: tudo menos o que é por requisição (searchId, cached). */
export interface SearchSnapshot {
  readonly query: { readonly origin: string; readonly destination: string; readonly date: IsoDate };
  readonly results: readonly SearchResultItem[];
  readonly partial: boolean;
  readonly generatedAt: string;
  readonly strategy: StrategyName;
  readonly providers: readonly ProviderReport[];
}

export interface SearchResponse {
  readonly searchId: string;
  readonly query: SearchSnapshot['query'];
  readonly results: readonly SearchResultItem[];
  readonly meta: {
    readonly cached: boolean;
    readonly partial: boolean;
    /** Quando os resultados foram calculados (num cache hit, é o momento do cálculo original). */
    readonly generatedAt: string;
    readonly strategy: StrategyName;
    readonly resultsCount: number;
    readonly providers: readonly ProviderReport[];
  };
}

export function toResponse(
  searchId: string,
  snapshot: SearchSnapshot,
  cached: boolean,
): SearchResponse {
  return {
    searchId,
    query: snapshot.query,
    results: snapshot.results,
    meta: {
      cached,
      partial: snapshot.partial,
      generatedAt: snapshot.generatedAt,
      strategy: snapshot.strategy,
      resultsCount: snapshot.results.length,
      providers: snapshot.providers,
    },
  };
}
