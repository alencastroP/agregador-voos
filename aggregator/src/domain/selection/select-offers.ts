import { groupByFlight, type FlightOffer } from '../flight-offer.js';
import { BalancedStrategy, CheapestStrategy, MaxIncentiveStrategy } from './strategies.js';
import type { BalancedParams } from './strategies.js';
import type { OfferSelectionStrategy, SelectedOffer, StrategyName } from './strategy.js';

/** Deduplica (agrupa por voo) e aplica a estratégia em cada grupo. */
export function selectOffers(
  offers: Iterable<FlightOffer>,
  strategy: OfferSelectionStrategy,
): SelectedOffer[] {
  return [...groupByFlight(offers).values()].map((group) => strategy.select(group));
}

export function createStrategy(
  name: StrategyName,
  balanced?: BalancedParams,
): OfferSelectionStrategy {
  switch (name) {
    case 'cheapest':
      return new CheapestStrategy();
    case 'max_incentive':
      return new MaxIncentiveStrategy();
    case 'balanced':
      return new BalancedStrategy(balanced);
  }
}
