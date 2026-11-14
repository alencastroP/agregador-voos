import { describe, expect, it } from 'vitest';
import { parseIataCode } from '../../../src/domain/iata-code.js';

describe('parseIataCode', () => {
  it.each([
    ['GRU', 'GRU'],
    ['gig', 'GIG'],
    ['  cgh ', 'CGH'],
  ])('accepts %j as %s', (raw, expected) => {
    expect(parseIataCode(raw)).toBe(expected);
  });

  it.each(['', 'GR', 'GRUU', 'G1U', 'GR-', 'ÁÉÍ'])('rejects %j', (raw) => {
    expect(parseIataCode(raw)).toBeNull();
  });
});
