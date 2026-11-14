import { buildOffer, type FlightOffer } from '../../src/domain/flight-offer.js';
import { parseLocalDateTime, type LocalDateTime } from '../../src/domain/local-date-time.js';
import { DEFAULT_INCENTIVE_BPS, type ProviderId } from '../../src/domain/provider.js';
import { query } from './fixtures.js';

export interface OfferSpec {
  provider: 'a' | 'b' | 'c';
  /** Preço em REAIS para legibilidade dos testes; convertido para centavos inteiros. */
  reais: number;
  airline?: string;
  departure?: string; // HH:MM
  durationMinutes?: number;
  currency?: string;
}

/** Monta uma oferta realista pelo MESMO caminho de produção (buildOffer + incentivo padrão). */
export function offer(spec: OfferSpec): FlightOffer {
  const provider: ProviderId = `provider-${spec.provider}`;
  const departure = parseLocalDateTime(`2026-12-12T${spec.departure ?? '08:00'}`) as LocalDateTime;
  const arrival = new Date(Date.parse(`${departure}Z`) + (spec.durationMinutes ?? 120) * 60_000)
    .toISOString()
    .slice(0, 19) as LocalDateTime;
  const result = buildOffer(
    {
      provider,
      airlineName: spec.airline ?? 'LATAM',
      departureAt: departure,
      arrivalAt: arrival,
      amountCents: Math.round(spec.reais * 100),
      currency: 'BRL',
    },
    query(),
    DEFAULT_INCENTIVE_BPS[provider],
  );
  if (!result.ok) throw new Error(`bad offer spec: ${result.detail}`);
  // Moeda alternativa só para testar a invariante (o mapper nunca deixa passar).
  return spec.currency === undefined
    ? result.offer
    : ({
        ...result.offer,
        price: { ...result.offer.price, currency: spec.currency },
      } as FlightOffer);
}
