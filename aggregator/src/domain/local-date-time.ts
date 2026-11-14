/**
 * Datas e horas LOCAIS, sem fuso. Nenhum provider informa fuso, então tratamos tudo como hora
 * local do aeroporto (docs/providers.md §9). Converter para UTC sem tabela IATA→timezone seria
 * inventar dado.
 *
 * Internamente as contas usam Date.UTC como "relógio neutro": assim o fuso/DST da máquina que
 * roda o serviço nunca altera o resultado (um voo 22:30 + 1 dia nunca vira 23:30 por horário de verão).
 */
export type IsoDate = string & { readonly __brand: 'IsoDate' }; // YYYY-MM-DD
export type LocalDateTime = string & { readonly __brand: 'LocalDateTime' }; // YYYY-MM-DDTHH:MM:SS

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LDT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

function formatLdt(epochMs: number): LocalDateTime {
  return new Date(epochMs).toISOString().slice(0, 19) as LocalDateTime;
}

function toEpochMs(ldt: LocalDateTime): number {
  return Date.parse(`${ldt}Z`);
}

export function parseIsoDate(raw: string): IsoDate | null {
  const m = DATE_RE.exec(raw);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Round-trip rejeita datas de calendário impossíveis (2026-02-30 viraria 03-02).
  return new Date(ms).toISOString().slice(0, 10) === raw ? (raw as IsoDate) : null;
}

export function parseLocalDateTime(raw: string): LocalDateTime | null {
  const m = LDT_RE.exec(raw);
  if (!m) return null;
  // A regex casa a string inteira; só falta completar os segundos quando vierem omitidos.
  const normalized = m[6] === undefined ? `${raw}:00` : raw;
  const ms = Date.parse(`${normalized}Z`);
  return Number.isNaN(ms) || formatLdt(ms) !== normalized ? null : (normalized as LocalDateTime);
}

export function isHhMm(raw: string): boolean {
  return HHMM_RE.test(raw);
}

/** Combina a data da busca com um horário HH:MM (formato dos providers B e C). */
export function atTime(date: IsoDate, hhmm: string): LocalDateTime | null {
  return isHhMm(hhmm) ? parseLocalDateTime(`${date}T${hhmm}`) : null;
}

export function addDays(ldt: LocalDateTime, days: number): LocalDateTime {
  return formatLdt(toEpochMs(ldt) + days * MS_PER_DAY);
}

export function minutesBetween(from: LocalDateTime, to: LocalDateTime): number {
  return Math.round((toEpochMs(to) - toEpochMs(from)) / MS_PER_MINUTE);
}

/** Dias inteiros de `from` até `to` (datas de calendário). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}
