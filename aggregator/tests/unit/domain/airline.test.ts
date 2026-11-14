import { describe, expect, it } from 'vitest';
import {
  isKnownAirline,
  normalizeAirlineName,
  resolveAirline,
} from '../../../src/domain/airline.js';

describe('resolveAirline', () => {
  // As 12 grafias reais observadas nos mocks (docs/providers.md §3).
  it.each([
    ['LATAM', 'LATAM'],
    ['Latam', 'LATAM'],
    ['Latam Airlines', 'LATAM'],
    ['GOL', 'GOL'],
    ['Gol', 'GOL'],
    ['Gol Linhas Aéreas', 'GOL'],
    ['AZUL', 'AZUL'],
    ['Azul', 'AZUL'],
    ['Azul Linhas Aereas', 'AZUL'],
    ['VOEPASS', 'VOEPASS'],
    ['Passaredo', 'VOEPASS'], // alias histórico: não sai com normalização de texto
    ['Voepass', 'VOEPASS'],
  ])('%j → %s', (raw, code) => {
    const resolved = resolveAirline(raw);
    expect(resolved).toMatchObject({ airline: { code }, known: true });
  });

  it.each([
    ['  latam   AIRLINES ', 'LATAM'],
    ['GOL LINHAS AÉREAS INTELIGENTES', 'GOL'],
    ['Gol-Linhas-Aéreas', 'GOL'],
    ['TAM', 'LATAM'],
  ])('tolerates noise: %j → %s', (raw, code) => {
    expect(resolveAirline(raw)?.airline.code).toBe(code);
  });

  it('uses a canonical display name for known airlines', () => {
    expect(resolveAirline('Passaredo')?.airline.displayName).toBe('Voepass Linhas Aéreas');
  });

  it('keeps unknown airlines as their own key instead of dropping them', () => {
    expect(resolveAirline('Copa Airlines')).toEqual({
      airline: { code: 'COPA', displayName: 'Copa Airlines' },
      known: false,
    });
    expect(resolveAirline('Aerolíneas Argentinas')?.airline.code).toBe('AEROLINEAS_ARGENTINAS');
  });

  it('returns null only when there is no name at all', () => {
    expect(resolveAirline('   ')).toBeNull();
    expect(resolveAirline('---')).toBeNull();
  });

  it('does not strip a suffix that is the whole name', () => {
    expect(normalizeAirlineName('Airlines')).toBe('airlines');
  });

  it('isKnownAirline guards canonical codes only', () => {
    expect(isKnownAirline('VOEPASS')).toBe(true);
    expect(isKnownAirline('COPA')).toBe(false);
    expect(isKnownAirline('toString')).toBe(false);
  });
});
