import { InvalidSearchError, type ValidationIssue } from '../domain/errors.js';
import { parseIataCode } from '../domain/iata-code.js';
import { daysBetween, parseIsoDate, type IsoDate } from '../domain/local-date-time.js';
import type { SearchQuery } from '../domain/search-query.js';
import type { Clock } from './ports/clock.js';

export interface SearchValidationRules {
  /** Fuso que define "hoje" para barrar data passada (a operação é no Brasil). */
  readonly timezone: string;
  /** Companhias vendem ~330 dias à frente; além disso a busca não faz sentido. */
  readonly maxDaysAhead: number;
}

/** "Hoje" no fuso de negócio, como YYYY-MM-DD (en-CA formata exatamente assim). */
export function todayIn(timezone: string, clock: Clock): IsoDate {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(clock.now());
  return formatted as IsoDate;
}

const FIELDS = ['origin', 'destination', 'date'] as const;

/**
 * Valida a entrada CRUA do cliente e devolve uma busca normalizada (IATA em maiúsculas).
 * Os mocks aceitam qualquer coisa (até rota "XXX→YYY" e data passada), então aqui é a única
 * barreira. Junta TODOS os problemas num só 400, para o front marcar todos os campos de uma vez.
 */
export function parseSearchInput(
  raw: unknown,
  clock: Clock,
  rules: SearchValidationRules,
): SearchQuery {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidSearchError([
      { field: 'body', message: 'envie um JSON { origin, destination, date }' },
    ]);
  }
  const body = raw as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const text: Partial<Record<(typeof FIELDS)[number], string>> = {};

  for (const field of FIELDS) {
    const value = body[field];
    if (value === undefined || value === null || value === '') {
      issues.push({ field, message: 'obrigatório' });
    } else if (typeof value !== 'string') {
      issues.push({ field, message: 'deve ser texto' });
    } else {
      text[field] = value;
    }
  }

  const origin = text.origin === undefined ? null : parseIataCode(text.origin);
  const destination = text.destination === undefined ? null : parseIataCode(text.destination);
  if (text.origin !== undefined && origin === null) {
    issues.push({ field: 'origin', message: 'código IATA de 3 letras (ex.: GRU)' });
  }
  if (text.destination !== undefined && destination === null) {
    issues.push({ field: 'destination', message: 'código IATA de 3 letras (ex.: GIG)' });
  }
  if (origin !== null && origin === destination) {
    issues.push({ field: 'destination', message: 'deve ser diferente da origem' });
  }

  const date = text.date === undefined ? null : parseIsoDate(text.date.trim());
  if (text.date !== undefined && date === null) {
    issues.push({ field: 'date', message: 'data válida no formato YYYY-MM-DD' });
  }
  if (date !== null) {
    const ahead = daysBetween(todayIn(rules.timezone, clock), date);
    if (ahead < 0) issues.push({ field: 'date', message: 'não pode estar no passado' });
    if (ahead > rules.maxDaysAhead) {
      issues.push({ field: 'date', message: `no máximo ${rules.maxDaysAhead} dias à frente` });
    }
  }

  if (issues.length > 0 || origin === null || destination === null || date === null) {
    throw new InvalidSearchError(issues);
  }
  return { origin, destination, date };
}
