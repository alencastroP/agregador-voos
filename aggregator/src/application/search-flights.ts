import { randomUUID } from 'node:crypto';
import {
  AllProvidersFailedError,
  CircuitOpenError,
  DomainError,
  ProviderError,
  ProviderTimeoutError,
} from '../domain/errors.js';
import type { FlightOffer } from '../domain/flight-offer.js';
import type { ProviderId } from '../domain/provider.js';
import type { SearchQuery } from '../domain/search-query.js';
import { selectOffers } from '../domain/selection/select-offers.js';
import type { OfferSelectionStrategy } from '../domain/selection/strategy.js';
import { sortResults } from '../domain/sorting.js';
import { withDeadline } from './deadline.js';
import type { Clock } from './ports/clock.js';
import type { FlightProvider } from './ports/flight-provider.js';
import type { Logger } from './ports/logger.js';
import type { SearchCache } from './ports/search-cache.js';
import type { SearchRecord, SearchRepository } from './ports/search-repository.js';
import {
  toResponse,
  type ProviderReport,
  type ProviderStatus,
  type SearchResponse,
  type SearchSnapshot,
} from './search-response.js';
import { SingleFlight } from './single-flight.js';
import { parseSearchInput, type SearchValidationRules } from './validate-search.js';

export interface SearchFlightsConfig extends SearchValidationRules {
  /** Orçamento TOTAL por provider (requisito: 3 s), incluindo retries quando houver. */
  readonly providerTimeoutMs: number;
  /** TTL da resposta completa (requisito: 5 min). */
  readonly cacheTtlSeconds: number;
  /** TTL da resposta PARCIAL (curto: não congelar uma resposta degradada). 0 = não cacheia. */
  readonly partialCacheTtlSeconds: number;
}

export interface SearchFlightsDeps {
  readonly providers: readonly FlightProvider[];
  /** Resolvida a cada busca: a estratégia pode mudar por feature flag sem restart. */
  readonly strategy: () => OfferSelectionStrategy;
  /** Kill switch por provider (feature flag). Default: todos ligados. */
  readonly isProviderEnabled?: (id: ProviderId) => boolean;
  readonly cache: SearchCache;
  readonly repository: SearchRepository;
  readonly clock: Clock;
  readonly config: SearchFlightsConfig;
  readonly newId?: () => string;
}

export interface SearchContext {
  readonly logger: Logger;
}

interface ProviderOutcome {
  readonly report: ProviderReport;
  readonly offers: readonly FlightOffer[];
}

export function searchCacheKey(query: SearchQuery, strategyFingerprint: string): string {
  return `search:v1:${query.origin}:${query.destination}:${query.date}:${strategyFingerprint}`;
}

/**
 * Use case da busca:
 *   validar → chave de cache → hit? responde
 *   → providers em paralelo (allSettled, deadline por provider) → normalizar (adapters)
 *   → deduplicar + estratégia → ordenar → cachear → persistir (assíncrono) → responder.
 */
export class SearchFlights {
  private readonly newId: () => string;
  private readonly isEnabled: (id: ProviderId) => boolean;
  private readonly inflight = new SingleFlight<SearchSnapshot>();

  constructor(private readonly deps: SearchFlightsDeps) {
    this.newId = deps.newId ?? randomUUID;
    this.isEnabled = deps.isProviderEnabled ?? (() => true);
  }

  async execute(rawInput: unknown, { logger }: SearchContext): Promise<SearchResponse> {
    const started = performance.now();
    const { clock, config } = this.deps;
    const query = parseSearchInput(rawInput, clock, config);
    const searchId = this.newId();
    const strategy = this.deps.strategy();
    const key = searchCacheKey(query, strategy.fingerprint);
    const log = {
      searchId,
      origin: query.origin,
      destination: query.destination,
      date: query.date,
    };

    const cached = await this.readCache(key, logger);
    if (cached) {
      logger.info({ ...log, cacheHit: true }, 'search served from cache');
      this.persist(this.record(searchId, query, cached, true, started), logger);
      return toResponse(searchId, cached, true);
    }

    // Single-flight: buscas idênticas simultâneas compartilham UMA ida aos providers.
    const { value: snapshot, leader } = await this.inflight.run(key, () =>
      this.compute(query, strategy, key, logger, log),
    );
    this.persist(this.record(searchId, query, snapshot, false, started), logger);

    if (!snapshot.providers.some((r) => r.status === 'ok')) {
      throw new AllProvidersFailedError(
        `nenhum provider respondeu: ${snapshot.providers.map((r) => `${r.name}=${r.status}`).join(', ')}`,
      );
    }
    logger.info(
      {
        ...log,
        cacheHit: false,
        coalesced: !leader,
        partial: snapshot.partial,
        results: snapshot.results.length,
        latencyMs: Math.round(performance.now() - started),
        providers: snapshot.providers.map((r) => `${r.name}:${r.status}:${r.latencyMs}ms`),
      },
      'search completed',
    );
    return toResponse(searchId, snapshot, false);
  }

  /** Ida aos providers + seleção + cache. Roda UMA vez por chave em andamento (single-flight). */
  private async compute(
    query: SearchQuery,
    strategy: OfferSelectionStrategy,
    key: string,
    logger: Logger,
    log: object,
  ): Promise<SearchSnapshot> {
    // allSettled e não all: Promise.all rejeitaria no PRIMEIRO provider que falhasse e
    // jogaria fora o resultado dos outros. callProvider já converte falha em relatório;
    // allSettled é a garantia extra caso algo inesperado escape.
    const settled = await Promise.allSettled(
      this.deps.providers.map((provider) => this.callProvider(provider, query, logger, log)),
    );
    const outcomes = this.deps.providers.map((provider, i) =>
      this.toOutcome(settled[i], provider.id, logger),
    );
    const reports = outcomes.map((o) => o.report);

    if (!reports.some((r) => r.status === 'ok')) {
      return this.snapshot(query, [], true, strategy, reports); // nada a cachear
    }

    const failed = reports.some((r) => r.status !== 'ok' && r.status !== 'disabled');
    const results = sortResults(
      selectOffers(
        outcomes.flatMap((o) => o.offers),
        strategy,
      ),
    ).map(({ offer, selection }) => ({ ...offer, selection }));
    const snapshot = this.snapshot(query, results, failed, strategy, reports);
    await this.writeCache(key, snapshot, logger);
    return snapshot;
  }

  private async callProvider(
    provider: FlightProvider,
    query: SearchQuery,
    logger: Logger,
    log: object,
  ): Promise<ProviderOutcome> {
    const base = { name: provider.id, offersCount: 0, discardedCount: 0 };
    if (!this.isEnabled(provider.id)) {
      return { report: { ...base, status: 'disabled', latencyMs: 0, attempts: 0 }, offers: [] };
    }

    const budgetMs = this.deps.config.providerTimeoutMs;
    const signal = AbortSignal.timeout(budgetMs);
    const started = performance.now();
    try {
      const result = await withDeadline(
        provider.search(query, signal),
        signal,
        provider.id,
        budgetMs,
      );
      const latencyMs = Math.round(performance.now() - started);
      if (result.discarded.length > 0) {
        logger.warn(
          {
            ...log,
            provider: provider.id,
            discarded: result.discarded.map((d) => ({ reason: d.reason, detail: d.detail })),
          },
          'provider offers discarded',
        );
      }
      if (result.unknownAirlines.length > 0) {
        logger.warn(
          { ...log, provider: provider.id, airlines: result.unknownAirlines },
          'unknown airline kept as its own key (add an alias?)',
        );
      }
      return {
        report: {
          ...base,
          status: 'ok',
          latencyMs,
          offersCount: result.offers.length,
          discardedCount: result.discarded.length,
          attempts: result.attempts ?? 1,
        },
        offers: result.offers,
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const status = classify(error);
      const errorCode = error instanceof DomainError ? error.code : 'unexpected_error';
      // circuit_open não chama o provider; demais erros carregam as tentativas feitas.
      const attempts =
        status === 'circuit_open' ? 0 : error instanceof ProviderError ? error.attempts : 1;
      logger.warn(
        { ...log, provider: provider.id, status, errorCode, latencyMs, attempts, err: error },
        'provider call failed',
      );
      return { report: { ...base, status, latencyMs, errorCode, attempts }, offers: [] };
    }
  }

  private toOutcome(
    settled: PromiseSettledResult<ProviderOutcome> | undefined,
    provider: ProviderId,
    logger: Logger,
  ): ProviderOutcome {
    if (settled?.status === 'fulfilled') return settled.value;
    const reason: unknown = settled?.reason;
    logger.error({ err: reason, provider }, 'unexpected provider failure');
    return {
      report: {
        name: provider,
        status: 'error',
        latencyMs: 0,
        offersCount: 0,
        discardedCount: 0,
        attempts: 1,
        errorCode: 'unexpected_error',
      },
      offers: [],
    };
  }

  private snapshot(
    query: SearchQuery,
    results: SearchSnapshot['results'],
    partial: boolean,
    strategy: OfferSelectionStrategy,
    providers: readonly ProviderReport[],
  ): SearchSnapshot {
    return {
      query: { origin: query.origin, destination: query.destination, date: query.date },
      results,
      partial,
      generatedAt: this.deps.clock.now().toISOString(),
      strategy: strategy.name,
      providers,
    };
  }

  private async readCache(key: string, logger: Logger): Promise<SearchSnapshot | null> {
    try {
      return await this.deps.cache.get(key);
    } catch (error) {
      logger.warn({ err: error, key }, 'cache read failed, continuing without cache');
      return null;
    }
  }

  private async writeCache(key: string, snapshot: SearchSnapshot, logger: Logger): Promise<void> {
    const { cacheTtlSeconds, partialCacheTtlSeconds } = this.deps.config;
    const ttl = snapshot.partial ? partialCacheTtlSeconds : cacheTtlSeconds;
    if (ttl <= 0) return;
    try {
      await this.deps.cache.set(key, snapshot, ttl);
    } catch (error) {
      logger.warn({ err: error, key }, 'cache write failed, response still served');
    }
  }

  private record(
    searchId: string,
    query: SearchQuery,
    snapshot: SearchSnapshot,
    cacheHit: boolean,
    started: number,
  ): SearchRecord {
    return {
      searchId,
      query,
      requestedAt: this.deps.clock.now(),
      cacheHit,
      partial: snapshot.partial,
      latencyMs: Math.round(performance.now() - started),
      strategy: snapshot.strategy,
      providers: snapshot.providers,
      results: snapshot.results,
    };
  }

  /** Fire-and-forget: a persistência analítica nunca atrasa nem derruba a resposta. */
  private persist(record: SearchRecord, logger: Logger): void {
    this.deps.repository.save(record).catch((error: unknown) => {
      logger.error({ err: error, searchId: record.searchId }, 'search persistence failed');
    });
  }
}

function classify(error: unknown): ProviderStatus {
  if (error instanceof ProviderTimeoutError) return 'timeout';
  if (error instanceof CircuitOpenError) return 'circuit_open';
  return 'error';
}
