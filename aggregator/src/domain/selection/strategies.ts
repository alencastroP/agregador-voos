import type { FlightOffer } from '../flight-offer.js';
import {
  assertComparable,
  best,
  byDurationAsc,
  byIncentiveDesc,
  byPriceAsc,
  byProviderRank,
  chain,
  cheapestFirst,
  describeSelection,
  SelectionInvariantError,
  type OfferSelectionStrategy,
  type SelectedOffer,
} from './strategy.js';

/**
 * Baseline do cliente: sempre o menor preço. Em empate de preço leva o maior incentivo
 * (ganho grátis). É a referência contra a qual as outras são medidas.
 */
export class CheapestStrategy implements OfferSelectionStrategy {
  readonly name = 'cheapest';
  readonly fingerprint = 'cheapest';

  select(offers: readonly FlightOffer[]): SelectedOffer {
    assertComparable(offers);
    return describeSelection(this.name, best(offers, cheapestFirst), offers);
  }
}

/**
 * Baseline do negócio: sempre o maior incentivo em R$. Existe para MOSTRAR por que não usar:
 * como o incentivo é % do preço, ela empurra para a oferta mais cara.
 */
export class MaxIncentiveStrategy implements OfferSelectionStrategy {
  readonly name = 'max_incentive';
  readonly fingerprint = 'max_incentive';
  private readonly order = chain(byIncentiveDesc, byPriceAsc, byDurationAsc, byProviderRank);

  select(offers: readonly FlightOffer[]): SelectedOffer {
    assertComparable(offers);
    return describeSelection(this.name, best(offers, this.order), offers);
  }
}

export interface BalancedParams {
  /** Banda relativa sobre o mais barato, em bps (150 = 1,5%). */
  readonly tolerancePctBps: number;
  /** Teto absoluto de quanto o cliente pode pagar a mais, em centavos. */
  readonly maxDeltaCents: number;
  /**
   * k: só aceita pagar mais se ganhoEmpresa ≥ k × custoExtraCliente. 0 desliga a regra.
   * (k = 1 → a empresa precisa ganhar pelo menos o que o cliente perde.)
   */
  readonly minGainRatio: number;
}

export const DEFAULT_BALANCED_PARAMS: BalancedParams = {
  tolerancePctBps: 150,
  maxDeltaCents: 2_500,
  minGainRatio: 0,
};

/**
 * Banda de tolerância: entre as ofertas "quase tão baratas quanto a mais barata", escolhe a de
 * maior incentivo.
 *
 *   p_min     = menor preço do voo
 *   elegíveis = { o | o.preço ≤ p_min·(1+τ)  ∧  o.preço − p_min ≤ teto
 *                    ∧  (ganho_o ≥ k·custo_o, se k > 0) }
 *   escolha   = maior incentivo entre elegíveis; desempate: menor preço → menor duração → provider
 *
 * τ limita o prejuízo relativo (percepção de preço); o teto limita o absoluto (em passagem cara,
 * 1,5% vira R$ 75, e isso já é "prejudicar significativamente"). Aritmética 100% inteira.
 */
export class BalancedStrategy implements OfferSelectionStrategy {
  readonly name = 'balanced';
  readonly fingerprint: string;
  private readonly order = chain(byIncentiveDesc, byPriceAsc, byDurationAsc, byProviderRank);

  constructor(readonly params: BalancedParams = DEFAULT_BALANCED_PARAMS) {
    const { tolerancePctBps, maxDeltaCents, minGainRatio } = params;
    if (!Number.isSafeInteger(tolerancePctBps) || tolerancePctBps < 0) {
      throw new SelectionInvariantError(`tolerancePctBps inválido: ${tolerancePctBps}`);
    }
    if (!Number.isSafeInteger(maxDeltaCents) || maxDeltaCents < 0) {
      throw new SelectionInvariantError(`maxDeltaCents inválido: ${maxDeltaCents}`);
    }
    if (!Number.isFinite(minGainRatio) || minGainRatio < 0) {
      throw new SelectionInvariantError(`minGainRatio inválido: ${minGainRatio}`);
    }
    this.fingerprint = `balanced:${tolerancePctBps}:${maxDeltaCents}:${minGainRatio}`;
  }

  select(offers: readonly FlightOffer[]): SelectedOffer {
    assertComparable(offers);
    const cheapest = best(offers, cheapestFirst);
    const pMin = cheapest.price.amountCents;
    const { tolerancePctBps, maxDeltaCents, minGainRatio } = this.params;

    const eligible = offers.filter((offer) => {
      const delta = offer.price.amountCents - pMin;
      if (delta === 0) return true; // empatou com o mais barato: sem custo para o cliente
      const withinBand = offer.price.amountCents * 10_000 <= pMin * (10_000 + tolerancePctBps);
      const withinCap = delta <= maxDeltaCents;
      const gain = offer.incentiveAmountCents - cheapest.incentiveAmountCents;
      const worthIt = minGainRatio === 0 ? gain > 0 : gain >= minGainRatio * delta;
      return withinBand && withinCap && worthIt;
    });

    return describeSelection(this.name, best(eligible, this.order), offers);
  }
}
