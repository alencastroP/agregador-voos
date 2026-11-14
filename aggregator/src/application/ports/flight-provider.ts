import type { DiscardReason, FlightOffer } from '../../domain/flight-offer.js';
import type { ProviderId } from '../../domain/provider.js';
import type { SearchQuery } from '../../domain/search-query.js';

/** Item que o provider mandou mas não entra na resposta (vira log + métrica, nunca erro). */
export interface DiscardedOffer {
  readonly reason: DiscardReason;
  readonly detail: string;
  readonly raw: unknown;
}

export interface ProviderSearchResult {
  readonly provider: ProviderId;
  readonly offers: readonly FlightOffer[];
  readonly discarded: readonly DiscardedOffer[];
  /** Nomes de companhia sem mapeamento conhecido (mantidos como chave própria). */
  readonly unknownAirlines: readonly string[];
  /** Tentativas até o sucesso (1 sem retry). Preenchido pela política de retry. */
  readonly attempts?: number;
}

/**
 * Port de um fornecedor de voos. O adapter traduz o contrato legado para o modelo canônico.
 * `signal` cancela a requisição de verdade (timeout/deadline).
 * Erros esperados: ProviderTimeoutError, ProviderUnavailableError, ProviderContractError.
 */
export interface FlightProvider {
  readonly id: ProviderId;
  search(query: SearchQuery, signal: AbortSignal): Promise<ProviderSearchResult>;
}
