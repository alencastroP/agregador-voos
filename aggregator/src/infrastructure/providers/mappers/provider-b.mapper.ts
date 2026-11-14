import { z } from 'zod';
import { createMapper } from './map-items.js';
import { scheduleFromHhMm } from './overnight.js';
import { envelopeOf, hhmm } from './schemas.js';

/**
 * provider-b: { results: [{ airline_name, amount (CENTAVOS int), currency, departure, arrival (HH:MM) }] }
 * Única fonte com moeda explícita: moeda ≠ BRL é descartada pela regra de domínio.
 */
const ItemB = z.object({
  airline_name: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  departure: hhmm,
  arrival: hhmm,
});

export const mapProviderB = createMapper({
  provider: 'provider-b',
  envelope: envelopeOf('results'),
  item: ItemB,
  toInput: (item, query) => ({
    airlineName: item.airline_name,
    ...scheduleFromHhMm(query.date, item.departure, item.arrival),
    amountCents: item.amount,
    currency: item.currency.trim().toUpperCase(),
  }),
});
