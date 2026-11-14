import type { z } from 'zod';
import type {
  DiscardedOffer,
  ProviderSearchResult,
} from '../../../application/ports/flight-provider.js';
import { ProviderContractError } from '../../../domain/errors.js';
import { buildOffer, type FlightOffer, type RawOfferInput } from '../../../domain/flight-offer.js';
import type { BasisPoints } from '../../../domain/money.js';
import type { ProviderId } from '../../../domain/provider.js';
import type { SearchQuery } from '../../../domain/search-query.js';

export interface MapperSpec<Item> {
  readonly provider: ProviderId;
  /** Envelope: falha aqui = resposta inteira fora do contrato (ProviderContractError). */
  readonly envelope: z.ZodType<{ items: unknown[] }>;
  /** Item: falha aqui = só este item é descartado (`malformed`). */
  readonly item: z.ZodType<Item>;
  readonly toInput: (item: Item, query: SearchQuery) => Omit<RawOfferInput, 'provider'>;
}

export type ProviderMapper = (
  payload: unknown,
  query: SearchQuery,
  incentiveRateBps: BasisPoints,
) => ProviderSearchResult;

/**
 * Pipeline comum aos três providers: envelope → item a item (schema + regras de negócio).
 * Um item ruim NUNCA derruba a resposta; ele é descartado com o motivo para log e métrica.
 */
export function createMapper<Item>(spec: MapperSpec<Item>): ProviderMapper {
  return (payload, query, incentiveRateBps) => {
    const envelope = spec.envelope.safeParse(payload);
    if (!envelope.success) {
      throw new ProviderContractError(
        spec.provider,
        `unexpected response envelope: ${envelope.error.issues[0]?.message ?? 'invalid'}`,
      );
    }

    const offers: FlightOffer[] = [];
    const discarded: DiscardedOffer[] = [];
    const unknownAirlines = new Set<string>();

    for (const raw of envelope.data.items) {
      const parsed = spec.item.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const detail = issue ? `${issue.path.map(String).join('.')}: ${issue.message}` : 'invalid';
        discarded.push({ reason: 'malformed', detail, raw });
        continue;
      }
      const result = buildOffer(
        { provider: spec.provider, ...spec.toInput(parsed.data, query) },
        query,
        incentiveRateBps,
      );
      if (!result.ok) {
        discarded.push({ reason: result.reason, detail: result.detail, raw });
        continue;
      }
      if (!result.knownAirline) unknownAirlines.add(result.offer.airline.displayName);
      offers.push(result.offer);
    }

    return { provider: spec.provider, offers, discarded, unknownAirlines: [...unknownAirlines] };
  };
}
