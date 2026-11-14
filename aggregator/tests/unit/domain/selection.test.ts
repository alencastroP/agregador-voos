import { describe, expect, it } from 'vitest';
import { selectOffers, createStrategy } from '../../../src/domain/selection/select-offers.js';
import {
  BalancedStrategy,
  CheapestStrategy,
  DEFAULT_BALANCED_PARAMS,
  MaxIncentiveStrategy,
} from '../../../src/domain/selection/strategies.js';
import { SelectionInvariantError } from '../../../src/domain/selection/strategy.js';
import { offer, type OfferSpec } from '../../helpers/offers.js';

const cheapest = new CheapestStrategy();
const maxIncentive = new MaxIncentiveStrategy();
const balanced = new BalancedStrategy(); // τ = 1,5%, teto R$ 25, k = 0

const pick = (strategy: { select: typeof balanced.select }, ...specs: OfferSpec[]) =>
  strategy.select(specs.map(offer));

/**
 * Markup real dos mocks sobre o preço-base: A = 1,000, B = 0,985, C = 1,012.
 * Exemplo com base R$ 800,00 → A 800,00 | B 788,00 | C 809,60.
 */
const A = { provider: 'a', reais: 800 } as const;
const B = { provider: 'b', reais: 788 } as const;
const C = { provider: 'c', reais: 809.6 } as const;

describe('selection strategies: table-driven business cases', () => {
  it.each([
    // [caso, ofertas, cheapest, balanced, max_incentive]
    ['dominância: B é mais barato E rende mais que A', [A, B], 'b', 'b', 'b'],
    ['C vs B: cliente +2,74%, fora da banda → B', [B, C], 'b', 'b', 'c'],
    ['C vs A: cliente +1,2%, dentro da banda e do teto → C', [A, C], 'a', 'c', 'c'],
    ['três providers: B domina A e C está a +2,74% de B', [A, B, C], 'b', 'b', 'c'],
    ['provider único', [C], 'c', 'c', 'c'],
  ] as const)('%s', (_case, specs, expCheapest, expBalanced, expMax) => {
    expect(pick(cheapest, ...specs).offer.provider).toBe(`provider-${expCheapest}`);
    expect(pick(balanced, ...specs).offer.provider).toBe(`provider-${expBalanced}`);
    expect(pick(maxIncentive, ...specs).offer.provider).toBe(`provider-${expMax}`);
  });

  it('empate de preço: leva o maior incentivo (ganho puro, custo zero ao cliente)', () => {
    const tie = [
      { provider: 'a', reais: 800 },
      { provider: 'c', reais: 800 },
    ] as const;
    for (const strategy of [cheapest, balanced, maxIncentive]) {
      const { offer: chosen, selection } = pick(strategy, ...tie);
      expect(chosen.provider).toBe('provider-c');
      expect(selection.deltaToCheapestCents).toBe(0);
      expect(selection.incentiveGainVsCheapestCents).toBe(0); // cheapest de referência já é C
    }
  });

  it('C ligeiramente mais caro, dentro da tolerância (+1,0%) → C', () => {
    expect(pick(balanced, A, { provider: 'c', reais: 808 }).offer.provider).toBe('provider-c');
  });

  it('C bem mais caro, fora da tolerância (+5%) → mais barato', () => {
    expect(pick(balanced, A, { provider: 'c', reais: 840 }).offer.provider).toBe('provider-a');
  });

  it('borda exata da banda: +1,50% entra, +1,51% não', () => {
    expect(pick(balanced, A, { provider: 'c', reais: 812 }).offer.provider).toBe('provider-c');
    expect(pick(balanced, A, { provider: 'c', reais: 812.08 }).offer.provider).toBe('provider-a');
  });

  it('o teto absoluto protege passagens caras: +1,2% de R$ 5.000 = R$ 60 > R$ 25', () => {
    const cheapTicket = pick(
      balanced,
      { provider: 'a', reais: 500 },
      { provider: 'c', reais: 506 },
    );
    const expensiveTicket = pick(
      balanced,
      { provider: 'a', reais: 5000 },
      { provider: 'c', reais: 5060 },
    );
    expect(cheapTicket.offer.provider).toBe('provider-c'); // +R$ 6
    expect(expensiveTicket.offer.provider).toBe('provider-a'); // +R$ 60 barrado pelo teto
  });

  it('regra k: com k = 1 a empresa precisa ganhar pelo menos o que o cliente perde', () => {
    // A→C: cliente paga +R$ 9,60; empresa ganha 16,19 − 8,00 = +R$ 8,19 → razão 0,85
    const strict = new BalancedStrategy({ ...DEFAULT_BALANCED_PARAMS, minGainRatio: 1 });
    const lenient = new BalancedStrategy({ ...DEFAULT_BALANCED_PARAMS, minGainRatio: 0.8 });
    expect(pick(strict, A, C).offer.provider).toBe('provider-a');
    expect(pick(lenient, A, C).offer.provider).toBe('provider-c');
  });

  it('nunca escolhe uma oferta mais cara que não rende mais', () => {
    // A mais caro que B e com incentivo menor: dominado em qualquer estratégia.
    const dominated = [
      { provider: 'b', reais: 800 },
      { provider: 'a', reais: 801 },
    ] as const;
    for (const strategy of [cheapest, balanced, maxIncentive]) {
      expect(pick(strategy, ...dominated).offer.provider).toBe('provider-b');
    }
  });
});

describe('selection metadata (transparency)', () => {
  it('reports how much the customer pays and the company gains vs the cheapest', () => {
    expect(pick(balanced, A, B, C).selection).toEqual({
      strategy: 'balanced',
      alternativesCount: 2,
      cheapestPriceCents: 78_800,
      cheapestProvider: 'provider-b',
      deltaToCheapestCents: 0,
      incentiveGainVsCheapestCents: 0,
    });
    expect(pick(balanced, A, C).selection).toEqual({
      strategy: 'balanced',
      alternativesCount: 1,
      cheapestPriceCents: 80_000,
      cheapestProvider: 'provider-a',
      deltaToCheapestCents: 960, // cliente paga R$ 9,60 a mais
      incentiveGainVsCheapestCents: 819, // empresa ganha R$ 16,19 − R$ 8,00
    });
  });
});

describe('determinism and tie-breaks', () => {
  it('same input in any order → same choice (total order)', () => {
    const specs = [A, B, C, { provider: 'a', reais: 788 }] as const;
    const offers = specs.map(offer);
    const reversed = [...offers].reverse();
    for (const strategy of [cheapest, balanced, maxIncentive]) {
      expect(strategy.select(offers)).toEqual(strategy.select(reversed));
    }
  });

  it('ties on price and incentive fall back to shorter duration, then provider order', () => {
    const slow = offer({ provider: 'c', reais: 800, durationMinutes: 200 });
    const fast = offer({ provider: 'c', reais: 800, durationMinutes: 90 });
    expect(cheapest.select([slow, fast]).offer).toBe(fast);
  });
});

describe('invariants', () => {
  it('refuses to compare different currencies (no FX: it would be a silent wrong answer)', () => {
    expect(() => balanced.select([offer(A), offer({ ...C, currency: 'USD' })])).toThrow(
      SelectionInvariantError,
    );
  });

  it('refuses to compare different flights', () => {
    expect(() => balanced.select([offer(A), offer({ ...C, departure: '09:00' })])).toThrow(
      SelectionInvariantError,
    );
  });

  it('refuses an empty group', () => {
    expect(() => balanced.select([])).toThrow(SelectionInvariantError);
  });

  it.each([
    { tolerancePctBps: -1 },
    { tolerancePctBps: 1.5 },
    { maxDeltaCents: -1 },
    { minGainRatio: Number.NaN },
    { minGainRatio: -0.1 },
  ])('rejects invalid balanced params %j', (params) => {
    expect(() => new BalancedStrategy({ ...DEFAULT_BALANCED_PARAMS, ...params })).toThrow(
      SelectionInvariantError,
    );
  });
});

describe('selectOffers + createStrategy', () => {
  it('dedups by flight and applies the strategy per group', () => {
    const offers = [
      offer(A),
      offer(C),
      offer({ provider: 'b', reais: 500, airline: 'Gol', departure: '10:00' }),
    ];
    const selected = selectOffers(offers, createStrategy('balanced'));
    expect(selected.map((s) => [s.offer.flightKey, s.offer.provider])).toEqual([
      ['LATAM|2026-12-12T08:00', 'provider-c'],
      ['GOL|2026-12-12T10:00', 'provider-b'],
    ]);
  });

  it.each(['cheapest', 'balanced', 'max_incentive'] as const)('creates %s', (name) => {
    expect(createStrategy(name).name).toBe(name);
  });

  it('passes custom balanced params through', () => {
    const strategy = createStrategy('balanced', { ...DEFAULT_BALANCED_PARAMS, tolerancePctBps: 0 });
    expect(strategy.select([offer(A), offer(C)]).offer.provider).toBe('provider-a');
  });
});
