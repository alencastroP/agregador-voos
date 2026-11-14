import { z } from 'zod';
import { isHhMm, parseLocalDateTime, type LocalDateTime } from '../../../domain/local-date-time.js';

/** HH:MM 00:00–23:59 (providers B e C). */
export const hhmm = z.string().refine(isHhMm, 'expected HH:MM');

/** Data-hora ISO local, sem fuso (provider A). Normaliza para YYYY-MM-DDTHH:MM:SS. */
export const localDateTime = z.string().transform((raw, ctx): LocalDateTime => {
  const ldt = parseLocalDateTime(raw);
  if (ldt === null) {
    ctx.addIssue({ code: 'custom', message: 'expected local ISO datetime (no timezone)' });
    return z.NEVER;
  }
  return ldt;
});

/** Envelope `{ [key]: [...] }` → `{ items: [...] }`, para o pipeline comum. */
export function envelopeOf(key: string): z.ZodType<{ items: unknown[] }> {
  return z.object({ [key]: z.array(z.unknown()) }).transform((o) => ({
    items: o[key] as unknown[],
  }));
}
