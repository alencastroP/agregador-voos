import { DomainError } from '../errors.js';
import type { FlightOffer } from '../flight-offer.js';
import { providerRank, type ProviderId } from '../provider.js';

export const STRATEGY_NAMES = ['cheapest', 'balanced', 'max_incentive'] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

/** Transparência da decisão: vai na resposta e alimenta o dashboard de negócio. */
export interface SelectionMeta {
  readonly strategy: StrategyName;
  /** Quantas OUTRAS ofertas do mesmo voo foram preteridas (0 = provider único). */
  readonly alternativesCount: number;
  readonly cheapestPriceCents: number;
  readonly cheapestProvider: ProviderId;
  /** Quanto o cliente paga a mais que a opção mais barata (≥ 0). */
  readonly deltaToCheapestCents: number;
  /** Quanto a empresa ganha a mais que na opção mais barata (pode ser < 0 se a estratégia priorizar preço). */
  readonly incentiveGainVsCheapestCents: number;
}

export interface SelectedOffer {
  readonly offer: FlightOffer;
  readonly selection: SelectionMeta;
}

/** Decide QUAL oferta exibir quando vários providers vendem o mesmo voo. */
export interface OfferSelectionStrategy {
  readonly name: StrategyName;
  /** Nome + parâmetros. Entra na chave de cache: trocar a estratégia por flag não serve resposta velha. */
  readonly fingerprint: string;
  select(offers: readonly FlightOffer[]): SelectedOffer;
}

export class SelectionInvariantError extends DomainError {
  readonly code = 'selection_invariant_violated';
}

// ---------------------------------------------------------------- comparadores

export type OfferComparator = (a: FlightOffer, b: FlightOffer) => number;

export const byPriceAsc: OfferComparator = (a, b) => a.price.amountCents - b.price.amountCents;
export const byIncentiveDesc: OfferComparator = (a, b) =>
  b.incentiveAmountCents - a.incentiveAmountCents;
export const byDurationAsc: OfferComparator = (a, b) => a.durationMinutes - b.durationMinutes;
export const byProviderRank: OfferComparator = (a, b) =>
  providerRank(a.provider) - providerRank(b.provider);

export function chain(...comparators: OfferComparator[]): OfferComparator {
  return (a, b) => {
    for (const cmp of comparators) {
      const result = cmp(a, b);
      if (result !== 0) return result;
    }
    return 0;
  };
}

/** Menor elemento segundo `cmp` (O(n), sem ordenar). Como a cadeia termina em provider, é total. */
export function best(offers: readonly FlightOffer[], cmp: OfferComparator): FlightOffer {
  const [first, ...rest] = offers;
  if (first === undefined) throw new SelectionInvariantError('cannot select from zero offers');
  return rest.reduce((winner, offer) => (cmp(offer, winner) < 0 ? offer : winner), first);
}

/**
 * Referência "mais barata" usada por TODAS as estratégias nos metadados.
 * Em empate de preço, prefere o maior incentivo: é ganho sem custo para o cliente.
 */
export const cheapestFirst = chain(byPriceAsc, byIncentiveDesc, byDurationAsc, byProviderRank);

/** Garante que só comparamos ofertas do MESMO voo e na MESMA moeda (não fazemos câmbio). */
export function assertComparable(offers: readonly FlightOffer[]): void {
  const [first] = offers;
  if (first === undefined) throw new SelectionInvariantError('cannot select from zero offers');
  // Lido como string de propósito: hoje Currency só admite 'BRL', mas esta invariante existe
  // justamente para o dia em que entrar uma 2ª moeda (ou um dado corrompido chegar até aqui).
  const expected: string = first.price.currency;
  for (const offer of offers) {
    if (offer.flightKey !== first.flightKey) {
      throw new SelectionInvariantError(`mixed flights: ${first.flightKey} vs ${offer.flightKey}`);
    }
    const actual: string = offer.price.currency;
    if (actual !== expected) {
      throw new SelectionInvariantError(
        `mixed currencies for ${first.flightKey}: ${expected} vs ${actual}`,
      );
    }
  }
}

export function describeSelection(
  strategy: StrategyName,
  chosen: FlightOffer,
  offers: readonly FlightOffer[],
): SelectedOffer {
  const cheapest = best(offers, cheapestFirst);
  return {
    offer: chosen,
    selection: {
      strategy,
      alternativesCount: offers.length - 1,
      cheapestPriceCents: cheapest.price.amountCents,
      cheapestProvider: cheapest.provider,
      deltaToCheapestCents: chosen.price.amountCents - cheapest.price.amountCents,
      incentiveGainVsCheapestCents: chosen.incentiveAmountCents - cheapest.incentiveAmountCents,
    },
  };
}
