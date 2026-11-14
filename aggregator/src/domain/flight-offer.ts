import type { Airline } from './airline.js';
import { resolveAirline } from './airline.js';
import type { IataCode } from './iata-code.js';
import { minutesBetween, type LocalDateTime } from './local-date-time.js';
import { applyRate, isSupportedCurrency, money, type BasisPoints, type Money } from './money.js';
import type { ProviderId } from './provider.js';
import type { SearchQuery } from './search-query.js';

/**
 * Identidade de um voo para deduplicação: companhia canônica + partida local (minuto).
 * Origem/destino/data são os da busca, então não precisam entrar na chave.
 * Sem número de voo (nenhum provider manda), é a melhor chave disponível; confirmado no
 * catálogo que não há dois voos da mesma companhia no mesmo minuto.
 */
export type FlightKey = string & { readonly __brand: 'FlightKey' };

export function buildFlightKey(airlineCode: string, departureAt: LocalDateTime): FlightKey {
  return `${airlineCode}|${departureAt.slice(0, 16)}` as FlightKey;
}

/**
 * Modelo canônico: SÓ o que os providers realmente entregam + derivados.
 * Sem flightNumber/stops/cabin: nenhum provider manda, e inventar seria mentir para o cliente.
 */
export interface FlightOffer {
  readonly flightKey: FlightKey;
  readonly airline: Airline;
  readonly origin: IataCode;
  readonly destination: IataCode;
  readonly departureAt: LocalDateTime;
  readonly arrivalAt: LocalDateTime;
  readonly durationMinutes: number;
  readonly price: Money;
  readonly provider: ProviderId;
  readonly incentiveRateBps: BasisPoints;
  readonly incentiveAmountCents: number;
}

/** Item já traduzido do formato do provider, ainda não validado contra as regras de negócio. */
export interface RawOfferInput {
  readonly provider: ProviderId;
  readonly airlineName: string;
  readonly departureAt: LocalDateTime;
  readonly arrivalAt: LocalDateTime;
  readonly amountCents: number;
  readonly currency: string;
}

export const DISCARD_REASONS = [
  'malformed', // item fora do contrato (campo faltando/tipo errado)
  'unsupported_currency', // moeda ≠ BRL: não fazemos câmbio
  'invalid_price', // preço ≤ 0 ou não inteiro
  'invalid_schedule', // chegada ≤ partida
] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number];

export type OfferResult =
  | { readonly ok: true; readonly offer: FlightOffer; readonly knownAirline: boolean }
  | { readonly ok: false; readonly reason: DiscardReason; readonly detail: string };

/** Regras de validade de uma oferta, iguais para todos os providers. */
export function buildOffer(
  input: RawOfferInput,
  query: SearchQuery,
  incentiveRateBps: BasisPoints,
): OfferResult {
  if (!isSupportedCurrency(input.currency)) {
    return { ok: false, reason: 'unsupported_currency', detail: `currency=${input.currency}` };
  }
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, reason: 'invalid_price', detail: `amountCents=${input.amountCents}` };
  }
  const resolved = resolveAirline(input.airlineName);
  if (resolved === null) {
    return { ok: false, reason: 'malformed', detail: 'airline name is empty' };
  }
  const durationMinutes = minutesBetween(input.departureAt, input.arrivalAt);
  if (durationMinutes <= 0) {
    return {
      ok: false,
      reason: 'invalid_schedule',
      detail: `${input.departureAt} → ${input.arrivalAt}`,
    };
  }

  const price = money(input.amountCents, input.currency);
  return {
    ok: true,
    knownAirline: resolved.known,
    offer: {
      flightKey: buildFlightKey(resolved.airline.code, input.departureAt),
      airline: resolved.airline,
      origin: query.origin,
      destination: query.destination,
      departureAt: input.departureAt,
      arrivalAt: input.arrivalAt,
      durationMinutes,
      price,
      provider: input.provider,
      incentiveRateBps,
      incentiveAmountCents: applyRate(price.amountCents, incentiveRateBps),
    },
  };
}

/** Agrupa as ofertas pelo voo (deduplicação). A escolha de QUAL exibir é da estratégia. */
export function groupByFlight(offers: Iterable<FlightOffer>): Map<FlightKey, FlightOffer[]> {
  const groups = new Map<FlightKey, FlightOffer[]>();
  for (const offer of offers) {
    const group = groups.get(offer.flightKey);
    if (group) group.push(offer);
    else groups.set(offer.flightKey, [offer]);
  }
  return groups;
}
