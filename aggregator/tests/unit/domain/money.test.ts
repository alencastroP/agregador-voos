import { describe, expect, it } from 'vitest';
import { InvalidMoneyError } from '../../../src/domain/errors.js';
import {
  applyRate,
  formatBRL,
  isSupportedCurrency,
  money,
  reaisToCents,
} from '../../../src/domain/money.js';

describe('money', () => {
  it('builds an immutable BRL amount from integer cents', () => {
    const m = money(82040);
    expect(m).toEqual({ amountCents: 82040, currency: 'BRL' });
    expect(Object.isFrozen(m)).toBe(true);
  });

  it.each([820.4, Number.NaN, Number.POSITIVE_INFINITY])('rejects non-integer cents (%s)', (v) => {
    expect(() => money(v)).toThrow(InvalidMoneyError);
  });
});

describe('reaisToCents', () => {
  it.each([
    [820.4, 82040],
    [796.33, 79633], // 796.33 * 100 = 79632.99999999999 em float
    [0.1 + 0.2, 30],
    [1.15, 115], // 1.15 * 100 = 114.99999999999999
    [0, 0],
  ])('converts R$ %s to %s cents', (reais, cents) => {
    expect(reaisToCents(reais)).toBe(cents);
  });

  it('rejects NaN/Infinity', () => {
    expect(() => reaisToCents(Number.NaN)).toThrow(InvalidMoneyError);
    expect(() => reaisToCents(Number.NEGATIVE_INFINITY)).toThrow(InvalidMoneyError);
  });
});

describe('applyRate (basis points)', () => {
  it.each([
    // exemplo literal do enunciado: R$ 1.000 → A R$10, B R$15, C R$20
    [100_000, 100, 1_000],
    [100_000, 150, 1_500],
    [100_000, 200, 2_000],
    [79633, 150, 1194], // 1194.495 → 1194
    [79635, 150, 1195], // 1194.525 → 1195
  ])('%s cents x %s bps = %s cents', (cents, bps, expected) => {
    expect(applyRate(cents, bps)).toBe(expected);
  });

  it('refuses float inputs', () => {
    expect(() => applyRate(100.5, 100)).toThrow(InvalidMoneyError);
    expect(() => applyRate(100, 1.5)).toThrow(InvalidMoneyError);
  });
});

describe('currency helpers', () => {
  it('only BRL is supported (no FX)', () => {
    expect(isSupportedCurrency('BRL')).toBe(true);
    expect(isSupportedCurrency('USD')).toBe(false);
  });

  it('formats pt-BR currency', () => {
    expect(formatBRL(82040).replace(/\s/g, ' ')).toBe('R$ 820,40');
  });
});
