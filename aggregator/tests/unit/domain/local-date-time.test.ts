import { describe, expect, it } from 'vitest';
import {
  addDays,
  atTime,
  daysBetween,
  isHhMm,
  minutesBetween,
  parseIsoDate,
  parseLocalDateTime,
  type LocalDateTime,
} from '../../../src/domain/local-date-time.js';
import { isoDate } from '../../helpers/fixtures.js';

const ldt = (raw: string): LocalDateTime => {
  const parsed = parseLocalDateTime(raw);
  if (parsed === null) throw new Error(raw);
  return parsed;
};

describe('parseIsoDate', () => {
  it('accepts real calendar dates', () => {
    expect(parseIsoDate('2026-12-12')).toBe('2026-12-12');
    expect(parseIsoDate('2028-02-29')).toBe('2028-02-29'); // bissexto
  });

  it.each(['2026-02-30', '2026-13-01', '12/12/2026', '2026-1-1', '', '2026-12-12T00:00'])(
    'rejects %j',
    (raw) => {
      expect(parseIsoDate(raw)).toBeNull();
    },
  );
});

describe('parseLocalDateTime', () => {
  it('normalizes to seconds precision', () => {
    expect(parseLocalDateTime('2026-12-12T08:00')).toBe('2026-12-12T08:00:00');
    expect(parseLocalDateTime('2026-12-12T08:00:30')).toBe('2026-12-12T08:00:30');
  });

  it.each(['2026-12-12T24:00:00', '2026-12-12T08:00:00Z', '2026-12-12T08:00:00-03:00', '08:00'])(
    'rejects %j (timezones and impossible times are out of contract)',
    (raw) => {
      expect(parseLocalDateTime(raw)).toBeNull();
    },
  );
});

describe('HH:MM helpers', () => {
  it.each([
    ['00:00', true],
    ['23:59', true],
    ['24:00', false],
    ['8:00', false],
    ['08:60', false],
  ])('isHhMm(%j) = %s', (raw, ok) => {
    expect(isHhMm(raw)).toBe(ok);
  });

  it('combines the search date with a time', () => {
    expect(atTime(isoDate('2026-12-12'), '22:30')).toBe('2026-12-12T22:30:00');
    expect(atTime(isoDate('2026-12-12'), '25:00')).toBeNull();
  });
});

describe('date arithmetic is timezone/DST independent', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays(ldt('2026-12-31T22:30'), 1)).toBe('2027-01-01T22:30:00');
    expect(addDays(ldt('2028-02-28T23:00'), 1)).toBe('2028-02-29T23:00:00');
  });

  it('measures overnight durations', () => {
    expect(minutesBetween(ldt('2026-12-12T22:30'), ldt('2026-12-13T01:15'))).toBe(165);
  });

  it('counts calendar days between dates', () => {
    expect(daysBetween(isoDate('2026-11-14'), isoDate('2026-12-12'))).toBe(28);
    expect(daysBetween(isoDate('2026-12-12'), isoDate('2026-11-14'))).toBe(-28);
  });
});
