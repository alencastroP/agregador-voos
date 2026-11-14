import { addDays, atTime, type LocalDateTime } from '../../../domain/local-date-time.js';
import type { IsoDate } from '../../../domain/local-date-time.js';

/**
 * Providers B e C mandam só HH:MM. Montamos com a data da busca e, se a chegada for ≤ partida,
 * o voo virou a noite: chegada em D+1 (ex.: VOEPASS 22:30 → 01:15).
 * Os horários de entrada já foram validados pelo schema, então atTime nunca devolve null aqui.
 */
export function scheduleFromHhMm(
  date: IsoDate,
  departure: string,
  arrival: string,
): { departureAt: LocalDateTime; arrivalAt: LocalDateTime } {
  const departureAt = atTime(date, departure);
  const sameDayArrival = atTime(date, arrival);
  if (departureAt === null || sameDayArrival === null) {
    throw new TypeError(`invalid HH:MM pair ${departure}/${arrival}`);
  }
  const arrivalAt = sameDayArrival <= departureAt ? addDays(sameDayArrival, 1) : sameDayArrival;
  return { departureAt, arrivalAt };
}
