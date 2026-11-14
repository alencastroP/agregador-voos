import { z } from 'zod';
import { reaisToCents } from '../../../domain/money.js';
import { createMapper } from './map-items.js';
import { envelopeOf, localDateTime } from './schemas.js';

/**
 * provider-a: { flights: [{ company, price (R$ float), depart_at, arrive_at (ISO sem fuso) }] }
 * A chegada já vem em D+1 quando o voo vira a noite. Moeda implícita: BRL.
 */
const ItemA = z.object({
  company: z.string(),
  price: z.number(),
  depart_at: localDateTime,
  arrive_at: localDateTime,
});

export const mapProviderA = createMapper({
  provider: 'provider-a',
  envelope: envelopeOf('flights'),
  item: ItemA,
  toInput: (item) => ({
    airlineName: item.company,
    departureAt: item.depart_at,
    arrivalAt: item.arrive_at,
    amountCents: reaisToCents(item.price),
    currency: 'BRL',
  }),
});
