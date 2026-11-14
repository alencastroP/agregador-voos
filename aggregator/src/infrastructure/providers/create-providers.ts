import type { FlightProvider } from '../../application/ports/flight-provider.js';
import { DEFAULT_INCENTIVE_BPS } from '../../domain/provider.js';
import { HttpFlightProvider } from './http-flight-provider.js';
import { mapProviderA } from './mappers/provider-a.mapper.js';
import { mapProviderB } from './mappers/provider-b.mapper.js';
import { mapProviderC } from './mappers/provider-c.mapper.js';

export interface ProviderUrls {
  readonly a: string;
  readonly b: string;
  readonly c: string;
}

/** Os três providers do desafio. Adicionar um 4º = um mapper + uma linha aqui. */
export function createHttpProviders(urls: ProviderUrls, fetchFn?: typeof fetch): FlightProvider[] {
  const extra = fetchFn ? { fetch: fetchFn } : {};
  return [
    new HttpFlightProvider({
      id: 'provider-a',
      url: urls.a,
      mapper: mapProviderA,
      incentiveRateBps: DEFAULT_INCENTIVE_BPS['provider-a'],
      ...extra,
    }),
    new HttpFlightProvider({
      id: 'provider-b',
      url: urls.b,
      mapper: mapProviderB,
      incentiveRateBps: DEFAULT_INCENTIVE_BPS['provider-b'],
      ...extra,
    }),
    new HttpFlightProvider({
      id: 'provider-c',
      url: urls.c,
      mapper: mapProviderC,
      incentiveRateBps: DEFAULT_INCENTIVE_BPS['provider-c'],
      ...extra,
    }),
  ];
}
