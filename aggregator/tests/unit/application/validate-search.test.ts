import { describe, expect, it } from 'vitest';
import { InvalidSearchError } from '../../../src/domain/errors.js';
import { parseSearchInput, todayIn } from '../../../src/application/validate-search.js';
import { FakeClock } from '../../helpers/app.js';

const rules = { timezone: 'America/Sao_Paulo', maxDaysAhead: 365 };
const clock = new FakeClock(); // 2026-11-14 12:00 em São Paulo

function issuesOf(raw: unknown): { field: string; message: string }[] {
  try {
    parseSearchInput(raw, clock, rules);
  } catch (error) {
    if (error instanceof InvalidSearchError) return [...error.issues];
    throw error;
  }
  throw new Error('expected InvalidSearchError');
}

describe('parseSearchInput', () => {
  it('normalizes IATA codes to upper case', () => {
    expect(
      parseSearchInput({ origin: 'gru', destination: ' gig ', date: '2026-12-12' }, clock, rules),
    ).toEqual({ origin: 'GRU', destination: 'GIG', date: '2026-12-12' });
  });

  it('accepts today and ignores unknown fields (passengers, cabin...)', () => {
    expect(
      parseSearchInput(
        { origin: 'GRU', destination: 'GIG', date: '2026-11-14', passengers: 2 },
        clock,
        rules,
      ).date,
    ).toBe('2026-11-14');
  });

  it.each([
    [null, 'body'],
    [[], 'body'],
    ['GRU-GIG', 'body'],
  ])('rejects a non-object body %j', (raw, field) => {
    expect(issuesOf(raw)).toEqual([{ field, message: expect.any(String) as string }]);
  });

  it('reports EVERY problem at once (front marks all fields)', () => {
    expect(issuesOf({ origin: 'GR', destination: 123 })).toEqual([
      { field: 'destination', message: 'deve ser texto' },
      { field: 'date', message: 'obrigatório' },
      { field: 'origin', message: 'código IATA de 3 letras (ex.: GRU)' },
    ]);
  });

  it.each([
    [
      { origin: 'GRU', destination: 'gru', date: '2026-12-12' },
      'destination',
      'deve ser diferente da origem',
    ],
    [
      { origin: 'GRU', destination: 'GIG', date: '12/12/2026' },
      'date',
      'data válida no formato YYYY-MM-DD',
    ],
    [
      { origin: 'GRU', destination: 'GIG', date: '2026-02-30' },
      'date',
      'data válida no formato YYYY-MM-DD',
    ],
    [
      { origin: 'GRU', destination: 'GIG', date: '2026-11-13' },
      'date',
      'não pode estar no passado',
    ],
    [
      { origin: 'GRU', destination: 'GIG', date: '2027-11-15' },
      'date',
      'no máximo 365 dias à frente',
    ],
    [{ origin: '', destination: 'GIG', date: '2026-12-12' }, 'origin', 'obrigatório'],
  ])('rejects %j (%s)', (raw, field, message) => {
    expect(issuesOf(raw)).toEqual([{ field, message }]);
  });

  it('uses the BUSINESS timezone for "today", not UTC', () => {
    // 2026-11-15 01:00 UTC ainda é 2026-11-14 22:00 em São Paulo.
    const lateNight = new FakeClock(new Date('2026-11-15T01:00:00Z'));
    expect(todayIn('America/Sao_Paulo', lateNight)).toBe('2026-11-14');
    expect(todayIn('UTC', lateNight)).toBe('2026-11-15');
    expect(
      parseSearchInput({ origin: 'GRU', destination: 'GIG', date: '2026-11-14' }, lateNight, rules)
        .date,
    ).toBe('2026-11-14');
  });
});
