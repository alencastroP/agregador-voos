import { describe, expect, it } from 'vitest';
import type { ProviderSearchResult } from '../../../src/application/ports/flight-provider.js';
import { ProviderContractError } from '../../../src/domain/errors.js';
import { groupByFlight } from '../../../src/domain/flight-offer.js';
import { DEFAULT_INCENTIVE_BPS } from '../../../src/domain/provider.js';
import { mapProviderA } from '../../../src/infrastructure/providers/mappers/provider-a.mapper.js';
import { mapProviderB } from '../../../src/infrastructure/providers/mappers/provider-b.mapper.js';
import { mapProviderC } from '../../../src/infrastructure/providers/mappers/provider-c.mapper.js';
import { loadProviderFixture, query } from '../../helpers/fixtures.js';

const q = query('GRU', 'GIG', '2026-12-12');
const a = mapProviderA(loadProviderFixture('a'), q, DEFAULT_INCENTIVE_BPS['provider-a']);
const b = mapProviderB(loadProviderFixture('b'), q, DEFAULT_INCENTIVE_BPS['provider-b']);
const c = mapProviderC(loadProviderFixture('c'), q, DEFAULT_INCENTIVE_BPS['provider-c']);
const all = [...a.offers, ...b.offers, ...c.offers];

describe('mappers against REAL mock responses (fixtures)', () => {
  it('provider-a: 40 offers, reais → integer cents, ISO dates kept', () => {
    expect(a.offers).toHaveLength(40);
    expect(a.discarded).toEqual([]);
    expect(a.offers[0]).toMatchObject({
      flightKey: 'LATAM|2026-12-12T08:00',
      price: { amountCents: 79633, currency: 'BRL' }, // fixture: "price": 796.33
      incentiveRateBps: 100,
      incentiveAmountCents: 796,
      departureAt: '2026-12-12T08:00:00',
      arrivalAt: '2026-12-12T11:10:00',
      durationMinutes: 190,
    });
  });

  it('provider-b: keeps cents as-is and drops the USD record (Copa Airlines)', () => {
    expect(b.offers).toHaveLength(40);
    expect(b.discarded).toHaveLength(1);
    expect(b.discarded[0]).toMatchObject({
      reason: 'unsupported_currency',
      raw: { airline_name: 'Copa Airlines', currency: 'USD' },
    });
    expect(b.offers[0]?.price.amountCents).toBe(78439); // fixture: "amount": 78439
  });

  it('provider-c: drops the zero fare record (Gol 15:00) and assumes BRL', () => {
    expect(c.offers).toHaveLength(40);
    expect(c.discarded).toHaveLength(1);
    expect(c.discarded[0]).toMatchObject({
      reason: 'invalid_price',
      raw: { carrier: 'Gol', fare: 0, departure_time: '15:00' },
    });
    expect(new Set(c.offers.map((o) => o.price.currency))).toEqual(new Set(['BRL']));
  });

  it('never produces a float price', () => {
    for (const offer of all) {
      expect(Number.isSafeInteger(offer.price.amountCents)).toBe(true);
      expect(Number.isSafeInteger(offer.incentiveAmountCents)).toBe(true);
    }
  });

  it('dedups 120 offers into 60 unique flights (15 ABC, 10 AB, 10 AC, 10 BC, 5+5+5 exclusive)', () => {
    const groups = groupByFlight(all);
    expect(all).toHaveLength(120);
    expect(groups.size).toBe(60);

    const soldBy = new Map<string, number>();
    for (const offers of groups.values()) {
      const providers = offers
        .map((o) => o.provider.at(-1))
        .sort()
        .join('');
      soldBy.set(providers, (soldBy.get(providers) ?? 0) + 1);
    }
    expect(Object.fromEntries(soldBy)).toEqual({
      abc: 15,
      ab: 10,
      ac: 10,
      bc: 10,
      a: 5,
      b: 5,
      c: 5,
    });
  });

  it('every spelling of every airline lands on a known canonical code', () => {
    const results: ProviderSearchResult[] = [a, b, c];
    expect(results.flatMap((r) => r.unknownAirlines)).toEqual([]);
    expect(new Set(all.map((o) => o.airline.code))).toEqual(
      new Set(['LATAM', 'GOL', 'AZUL', 'VOEPASS']),
    );
  });

  it('a flight sold by several providers agrees on arrival time across providers', () => {
    for (const offers of groupByFlight(all).values()) {
      expect(new Set(offers.map((o) => o.arrivalAt)).size).toBe(1);
    }
  });

  it('puts arrival on D+1 for the 4 overnight flights, for every provider', () => {
    const overnight = [...groupByFlight(all).values()]
      .map((offers) => offers[0]!)
      .filter((o) => o.arrivalAt.slice(0, 10) === '2026-12-13')
      .map((o) => `${o.airline.code} ${o.departureAt.slice(11, 16)}→${o.arrivalAt.slice(11, 16)}`)
      .sort();
    expect(overnight).toEqual([
      'AZUL 21:09→00:12',
      'LATAM 21:28→00:54',
      'VOEPASS 22:25→00:30',
      'VOEPASS 22:30→01:15',
    ]);
    const voepass = all.filter((o) => o.flightKey === 'VOEPASS|2026-12-12T22:30');
    expect(voepass.map((o) => o.durationMinutes)).toEqual(voepass.map(() => 165));
  });
});

describe('mappers with out-of-contract payloads', () => {
  it.each([
    ['null', null],
    ['wrong envelope key', { results: [] }],
    ['envelope not an array', { flights: 'nope' }],
    ['html error page', '<html>502</html>'],
  ])('rejects the whole response when the envelope is broken (%s)', (_label, payload) => {
    expect(() => mapProviderA(payload, q, 100)).toThrow(ProviderContractError);
  });

  it('accepts an empty list (no flights is not an error)', () => {
    expect(mapProviderB({ results: [] }, q, 150).offers).toEqual([]);
  });

  it('discards only the malformed items and keeps the rest', () => {
    const result = mapProviderC(
      {
        data: [
          { carrier: 'Gol', fare: 500.1, departure_time: '10:00', arrival_time: '11:00' },
          { carrier: 'Gol', fare: '500', departure_time: '12:00', arrival_time: '13:00' },
          { carrier: 'Gol', fare: 500, departure_time: '25:00', arrival_time: '13:00' },
          { fare: 500, departure_time: '12:00', arrival_time: '13:00' },
          'garbage',
        ],
      },
      q,
      200,
    );
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]?.price.amountCents).toBe(50010);
    expect(result.discarded.map((d) => d.reason)).toEqual([
      'malformed',
      'malformed',
      'malformed',
      'malformed',
    ]);
    expect(result.discarded[0]?.detail).toMatch(/fare/);
  });

  it('provider-a rejects datetimes with timezone (out of contract)', () => {
    const result = mapProviderA(
      {
        flights: [
          {
            company: 'LATAM',
            price: 800,
            depart_at: '2026-12-12T08:00:00Z',
            arrive_at: '2026-12-12T11:00:00',
          },
        ],
      },
      q,
      100,
    );
    expect(result.discarded[0]).toMatchObject({ reason: 'malformed' });
  });

  it('provider-b rejects float cents and normalizes lowercase currency', () => {
    const item = { airline_name: 'Gol', departure: '10:00', arrival: '11:00' };
    const result = mapProviderB(
      {
        results: [
          { ...item, amount: 500.5, currency: 'BRL' },
          { ...item, amount: 50000, currency: ' brl ' },
        ],
      },
      q,
      150,
    );
    expect(result.discarded.map((d) => d.reason)).toEqual(['malformed']);
    expect(result.offers[0]?.price).toEqual({ amountCents: 50000, currency: 'BRL' });
  });

  it('reports unknown airlines while keeping their offers', () => {
    const result = mapProviderB(
      {
        results: [
          { airline_name: 'Sky', amount: 1, currency: 'BRL', departure: '10:00', arrival: '11:00' },
        ],
      },
      q,
      150,
    );
    expect(result.offers[0]?.flightKey).toBe('SKY|2026-12-12T10:00');
    expect(result.unknownAirlines).toEqual(['Sky']);
  });
});
