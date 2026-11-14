import { z } from 'zod';
import { reaisToCents } from '../../../domain/money.js';
import { createMapper } from './map-items.js';
import { scheduleFromHhMm } from './overnight.js';
import { envelopeOf, hhmm } from './schemas.js';

/**
 * provider-c: { data: [{ carrier, fare (R$ float), departure_time, arrival_time (HH:MM) }] }
 * Sem campo de moeda. SUPOSIÇÃO DECLARADA: BRL (docs/providers.md).
 */
const ItemC = z.object({
  carrier: z.string(),
  fare: z.number(),
  departure_time: hhmm,
  arrival_time: hhmm,
});

export const mapProviderC = createMapper({
  provider: 'provider-c',
  envelope: envelopeOf('data'),
  item: ItemC,
  toInput: (item, query) => ({
    airlineName: item.carrier,
    ...scheduleFromHhMm(query.date, item.departure_time, item.arrival_time),
    amountCents: reaisToCents(item.fare),
    currency: 'BRL',
  }),
});
