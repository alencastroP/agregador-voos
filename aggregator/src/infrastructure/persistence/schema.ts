import {
  bigserial,
  boolean,
  char,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Modelo ANALÍTICO (alimenta o dashboard), não transacional:
 *   searches        1 linha por busca servida (inclusive cache hit): demanda
 *   provider_calls  1 linha por provider por busca CALCULADA: operação
 *   selected_offers 1 linha por voo exibido em busca CALCULADA: negócio
 * Cache hit grava só em `searches`: repetir 60 ofertas e 3 chamadas que não aconteceram
 * distorceria latência de provider e inflaria a receita.
 * Dinheiro em centavos (integer); horários dos voos em hora LOCAL (sem fuso), como no domínio.
 */
export const searches = pgTable(
  'searches',
  {
    id: uuid('id').primaryKey(),
    origin: char('origin', { length: 3 }).notNull(),
    destination: char('destination', { length: 3 }).notNull(),
    travelDate: date('travel_date').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    cacheHit: boolean('cache_hit').notNull(),
    partial: boolean('partial').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    resultsCount: integer('results_count').notNull(),
    strategy: text('strategy').notNull(),
  },
  (t) => [
    index('searches_requested_at_idx').on(t.requestedAt),
    index('searches_route_idx').on(t.origin, t.destination),
  ],
);

export const providerCalls = pgTable(
  'provider_calls',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    searchId: uuid('search_id')
      .notNull()
      .references(() => searches.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    status: text('status').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    offersCount: integer('offers_count').notNull(),
    discardedCount: integer('discarded_count').notNull(),
    attempts: smallint('attempts').notNull(),
    errorCode: text('error_code'),
  },
  (t) => [
    index('provider_calls_search_idx').on(t.searchId),
    index('provider_calls_provider_idx').on(t.provider, t.status),
  ],
);

export const selectedOffers = pgTable(
  'selected_offers',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    searchId: uuid('search_id')
      .notNull()
      .references(() => searches.id, { onDelete: 'cascade' }),
    flightKey: text('flight_key').notNull(),
    airline: text('airline').notNull(),
    departureAt: timestamp('departure_at', { withTimezone: false, mode: 'string' }).notNull(),
    chosenProvider: text('chosen_provider').notNull(),
    chosenPriceCents: integer('chosen_price_cents').notNull(),
    cheapestPriceCents: integer('cheapest_price_cents').notNull(),
    cheapestProvider: text('cheapest_provider').notNull(),
    incentiveCents: integer('incentive_cents').notNull(),
    incentiveGainVsCheapestCents: integer('incentive_gain_vs_cheapest_cents').notNull(),
    customerDeltaCents: integer('customer_delta_cents').notNull(),
    alternativesCount: smallint('alternatives_count').notNull(),
    strategy: text('strategy').notNull(),
  },
  (t) => [
    index('selected_offers_search_idx').on(t.searchId),
    index('selected_offers_provider_idx').on(t.chosenProvider),
  ],
);
