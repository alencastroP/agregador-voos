import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseIataCode, type IataCode } from '../../src/domain/iata-code.js';
import { parseIsoDate, type IsoDate } from '../../src/domain/local-date-time.js';
import type { SearchQuery } from '../../src/domain/search-query.js';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');

/** Respostas REAIS dos mocks (GRU→GIG, 2026-12-12), capturadas na Fase 0. */
export function loadProviderFixture(provider: 'a' | 'b' | 'c'): unknown {
  const file = join(FIXTURES_DIR, `provider-${provider}.2026-12-12.GRU-GIG.json`);
  return JSON.parse(readFileSync(file, 'utf-8')) as unknown;
}

export function iata(code: string): IataCode {
  const parsed = parseIataCode(code);
  if (parsed === null) throw new Error(`bad IATA in test: ${code}`);
  return parsed;
}

export function isoDate(raw: string): IsoDate {
  const parsed = parseIsoDate(raw);
  if (parsed === null) throw new Error(`bad date in test: ${raw}`);
  return parsed;
}

export function query(origin = 'GRU', destination = 'GIG', date = '2026-12-12'): SearchQuery {
  return { origin: iata(origin), destination: iata(destination), date: isoDate(date) };
}
