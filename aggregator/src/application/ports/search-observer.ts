import type { DiscardReason } from '../../domain/flight-offer.js';
import type { ProviderId } from '../../domain/provider.js';
import type { ProviderReport, SearchResultItem } from '../search-response.js';

export type SearchOutcome = 'ok' | 'partial' | 'all_failed';
export type CacheLookup = 'hit' | 'miss' | 'error';

/**
 * Port de observabilidade do use case: ele conta FATOS de negócio e operação, sem saber que
 * existe Prometheus. Trocar por Datadog/OTel Metrics = outra implementação deste port.
 */
export interface SearchObserver {
  providerCall(report: ProviderReport): void;
  offersDiscarded(provider: ProviderId, reason: DiscardReason): void;
  unknownAirline(provider: ProviderId, name: string): void;
  cacheLookup(result: CacheLookup): void;
  cacheWriteFailed(): void;
  /** Cada resposta servida (inclusive cache hit): o agente VIU essas escolhas. */
  searchServed(outcome: SearchOutcome, cached: boolean, results: readonly SearchResultItem[]): void;
  searchCoalesced(): void;
  persistenceFailed(): void;
}

export const noopObserver: SearchObserver = {
  providerCall: () => undefined,
  offersDiscarded: () => undefined,
  unknownAirline: () => undefined,
  cacheLookup: () => undefined,
  cacheWriteFailed: () => undefined,
  searchServed: () => undefined,
  searchCoalesced: () => undefined,
  persistenceFailed: () => undefined,
};
