import { describe, expect, it } from 'vitest';
import {
  buildFlightKey,
  buildOffer,
  groupByFlight,
  type FlightOffer,
  type RawOfferInput,
} from '../../../src/domain/flight-offer.js';
import { parseLocalDateTime, type LocalDateTime } from '../../../src/domain/local-date-time.js';
import { query } from '../../helpers/fixtures.js';

const ldt = (raw: string) => parseLocalDateTime(raw) as LocalDateTime;

const base: RawOfferInput = {
  provider: 'provider-c',
  airlineName: 'Latam Airlines',
  departureAt: ldt('2026-12-12T08:00'),
  arrivalAt: ldt('2026-12-12T11:10'),
  amountCents: 100_000,
  currency: 'BRL',
};

function ok(input: Partial<RawOfferInput> = {}): FlightOffer {
  const result = buildOffer({ ...base, ...input }, query(), 200);
  if (!result.ok) throw new Error(result.detail);
  return result.offer;
}

describe('buildOffer', () => {
  it('builds the canonical offer with derived fields', () => {
    expect(ok()).toEqual({
      flightKey: 'LATAM|2026-12-12T08:00',
      airline: { code: 'LATAM', displayName: 'LATAM Airlines' },
      origin: 'GRU',
      destination: 'GIG',
      departureAt: '2026-12-12T08:00:00',
      arrivalAt: '2026-12-12T11:10:00',
      durationMinutes: 190,
      price: { amountCents: 100_000, currency: 'BRL' },
      provider: 'provider-c',
      incentiveRateBps: 200,
      incentiveAmountCents: 2_000, // R$ 1.000 x 2% = R$ 20 (exemplo do enunciado)
    });
  });

  it.each([
    [{ currency: 'USD' }, 'unsupported_currency'],
    [{ amountCents: 0 }, 'invalid_price'],
    [{ amountCents: -100 }, 'invalid_price'],
    [{ amountCents: 100.5 }, 'invalid_price'],
    [{ airlineName: '  ' }, 'malformed'],
    [{ arrivalAt: ldt('2026-12-12T08:00') }, 'invalid_schedule'],
    [{ arrivalAt: ldt('2026-12-12T07:00') }, 'invalid_schedule'],
  ] as const)('discards %j as %s', (input, reason) => {
    const result = buildOffer({ ...base, ...input }, query(), 200);
    expect(result).toMatchObject({ ok: false, reason });
  });

  it('flags unknown airlines without discarding them', () => {
    const result = buildOffer({ ...base, airlineName: 'Copa' }, query(), 200);
    expect(result).toMatchObject({ ok: true, knownAirline: false });
  });
});

describe('flight key and grouping', () => {
  it('ignores seconds in the key (minute precision)', () => {
    expect(buildFlightKey('GOL', ldt('2026-12-12T08:50:59'))).toBe('GOL|2026-12-12T08:50');
  });

  it('groups different spellings of the same flight together', () => {
    const groups = groupByFlight([
      ok({ provider: 'provider-a', airlineName: 'VOEPASS' }),
      ok({ provider: 'provider-b', airlineName: 'Passaredo' }),
      ok({ provider: 'provider-c', airlineName: 'Voepass' }),
      ok({ provider: 'provider-a', airlineName: 'GOL' }),
    ]);
    expect([...groups.keys()]).toEqual(['VOEPASS|2026-12-12T08:00', 'GOL|2026-12-12T08:00']);
    expect(groups.get(buildFlightKey('VOEPASS', ldt('2026-12-12T08:00')))).toHaveLength(3);
  });
});
