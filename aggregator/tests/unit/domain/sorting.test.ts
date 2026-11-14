import { describe, expect, it } from 'vitest';
import { CheapestStrategy } from '../../../src/domain/selection/strategies.js';
import { sortResults } from '../../../src/domain/sorting.js';
import { offer } from '../../helpers/offers.js';

const pick = (spec: Parameters<typeof offer>[0]) => new CheapestStrategy().select([offer(spec)]);

describe('sortResults (total order)', () => {
  const cheap = pick({ provider: 'a', reais: 500, departure: '18:00' });
  const sameP_early = pick({ provider: 'a', reais: 800, departure: '07:00', airline: 'Gol' });
  const sameP_late_slow = pick({
    provider: 'a',
    reais: 800,
    departure: '09:00',
    durationMinutes: 200,
    airline: 'Gol',
  });
  const sameP_late_fast = pick({
    provider: 'a',
    reais: 800,
    departure: '09:00',
    durationMinutes: 90,
    airline: 'Azul',
  });
  const sameAll_latam = pick({
    provider: 'a',
    reais: 800,
    departure: '09:00',
    durationMinutes: 90,
  });

  const expected = [cheap, sameP_early, sameP_late_fast, sameAll_latam, sameP_late_slow];

  it('price → departure → duration → flightKey', () => {
    expect(sortResults([...expected].reverse()).map((s) => s.offer.flightKey)).toEqual(
      expected.map((s) => s.offer.flightKey),
    );
  });

  it('is stable under any input permutation and does not mutate the input', () => {
    const shuffled = [expected[3]!, expected[0]!, expected[4]!, expected[2]!, expected[1]!];
    const copy = [...shuffled];
    expect(sortResults(shuffled)).toEqual(expected);
    expect(shuffled).toEqual(copy);
  });
});
