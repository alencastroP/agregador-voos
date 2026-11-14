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
import { createStrategy } from '../domain/selection/select-offers.js';
import type { OfferSelectionStrategy } from '../domain/selection/strategy.js';
import { sortResults } from '../domain/sorting.js';
import { withDeadline } from './deadline.js';
import type { Clock } from './ports/clock.js';
import type { FeatureFlags, SearchFlags } from './ports/feature-flags.js';
import type { FlightProvider } from './ports/flight-provider.js';
import type { Logger } from './ports/logger.js';
import type { SearchCache } from './ports/search-cache.js';
import { noopObserver, type SearchObserver } from './ports/search-observer.js';
import { noopTracer, type Tracer } from './ports/tracer.js';
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
  /** Estratégia, kill switches e cache: resolvidos a cada busca (mudam sem restart/deploy). */
  readonly flags: FeatureFlags;
  readonly cache: SearchCache;
  readonly repository: SearchRepository;
  readonly clock: Clock;
  readonly config: SearchFlightsConfig;
  readonly newId?: () => string;
  /** Métricas (Prometheus em produção). Default: no-op. */
  readonly observer?: SearchObserver;
  /** Tracing (OpenTelemetry em produção). Default: no-op. */
  readonly tracer?: Tracer;
}

export interface SearchContext {
  readonly logger: Logger;
  /** Agência que busca (header x-agency-id): permite flag por agência (A/B, rollout). */
  readonly agencyId?: string;
}

interface ProviderOutcome {
  readonly report: ProviderReport;
  readonly offers: readonly FlightOffer[];
}

/**
 * A chave inclui TUDO que muda a resposta: rota/data, estratégia (com parâmetros) e quais
 * providers estão ligados. Sem o último, uma agência com o provider-c desligado por flag
 * receberia do cache a resposta de outra que o tem ligado (e vice-versa).
 */
export function searchCacheKey(
  query: SearchQuery,
  strategyFingerprint: string,
  enabledProviders = 'abc',
): string {
  return `search:v1:${query.origin}:${query.destination}:${query.date}:${strategyFingerprint}:${enabledProviders}`;
}

function enabledFingerprint(flags: SearchFlags): string {
  return (
    Object.entries(flags.providers)
      .filter(([, on]) => on)
      .map(([id]) => id.slice(-1))
      .sort()
      .join('') || 'none'
  );
}

/**
 * Use case da busca:
 *   validar → chave de cache → hit? responde
 *   → providers em paralelo (allSettled, deadline por provider) → normalizar (adapters)
 *   → deduplicar + estratégia → ordenar → cachear → persistir (assíncrono) → responder.
 */
export class SearchFlights {
  private readonly newId: () => string;
  /** Estratégias construídas por combinação de parâmetros (evita recriar a cada busca). */
  private readonly strategies = new Map<string, OfferSelectionStrategy>();
  private readonly inflight = new SingleFlight<SearchSnapshot>();
  private readonly observer: SearchObserver;
  private readonly tracer: Tracer;

  constructor(private readonly deps: SearchFlightsDeps) {
    this.newId = deps.newId ?? randomUUID;
    this.observer = deps.observer ?? noopObserver;
    this.tracer = deps.tracer ?? noopTracer;
  }

  execute(rawInput: unknown, context: SearchContext): Promise<SearchResponse> {
    return this.tracer.withSpan('search', {}, async (span) => {
      const response = await this.run(rawInput, context);
      span.setAttributes({
        'search.id': response.searchId,
        'search.origin': response.query.origin,
        'search.destination': response.query.destination,
        'search.date': response.query.date,
        'search.cached': response.meta.cached,
        'search.partial': response.meta.partial,
        'search.results': response.meta.resultsCount,
        'search.strategy': response.meta.strategy,
      });
      return response;
    });
  }

  private strategyFor(flags: SearchFlags): OfferSelectionStrategy {
    const { tolerancePctBps, maxDeltaCents, minGainRatio } = flags.balanced;
    const id = `${flags.strategy}:${tolerancePctBps}:${maxDeltaCents}:${minGainRatio}`;
    let strategy = this.strategies.get(id);
    if (!strategy) {
      strategy = createStrategy(flags.strategy, flags.balanced);
      this.strategies.set(id, strategy);
    }
    return strategy;
  }

  private async run(rawInput: unknown, context: SearchContext): Promise<SearchResponse> {
    const { logger } = context;
    const started = performance.now();
    const { clock, config } = this.deps;
    const query = parseSearchInput(rawInput, clock, config);
    const searchId = this.newId();
    const flags = await this.deps.flags.evaluate(
      context.agencyId ? { agencyId: context.agencyId } : {},
    );
    const strategy = this.strategyFor(flags);
    const key = searchCacheKey(query, strategy.fingerprint, enabledFingerprint(flags));
    const log = {
      searchId,
      origin: query.origin,
      destination: query.destination,
      date: query.date,
    };

    const cached = flags.cacheEnabled ? await this.readCache(key, logger) : null;
    if (cached) {
      logger.info({ ...log, cacheHit: true }, 'search served from cache');
      this.persist(this.record(searchId, query, cached, true, started), logger);
      this.observer.searchServed(cached.partial ? 'partial' : 'ok', true, cached.results);
      return toResponse(searchId, cached, true);
    }

    // Single-flight: buscas idênticas simultâneas compartilham UMA ida aos providers.
    const { value: snapshot, leader } = await this.inflight.run(key, () =>
      this.compute(query, strategy, key, flags, logger, log),
    );
    this.persist(this.record(searchId, query, snapshot, false, started), logger);
    if (!leader) this.observer.searchCoalesced();

    if (!snapshot.providers.some((r) => r.status === 'ok')) {
      this.observer.searchServed('all_failed', false, []);
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
    this.observer.searchServed(snapshot.partial ? 'partial' : 'ok', false, snapshot.results);
    return toResponse(searchId, snapshot, false);
  }

  /** Ida aos providers + seleção + cache. Roda UMA vez por chave em andamento (single-flight). */
  private async compute(
    query: SearchQuery,
    strategy: OfferSelectionStrategy,
    key: string,
    flags: SearchFlags,
    logger: Logger,
    log: object,
  ): Promise<SearchSnapshot> {
    // allSettled e não all: Promise.all rejeitaria no PRIMEIRO provider que falhasse e
    // jogaria fora o resultado dos outros. callProvider já converte falha em relatório;
    // allSettled é a garantia extra caso algo inesperado escape.
    const settled = await Promise.allSettled(
      this.deps.providers.map((provider) =>
        this.callProvider(provider, query, flags.providers[provider.id], logger, log),
      ),
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
    if (flags.cacheEnabled) await this.writeCache(key, snapshot, logger);
    return snapshot;
  }

  /** Um span por provider: no Jaeger, o fetch (undici) aparece como filho deste span. */
  private callProvider(
    provider: FlightProvider,
    query: SearchQuery,
    enabled: boolean,
    logger: Logger,
    log: object,
  ): Promise<ProviderOutcome> {
    return this.tracer.withSpan(
      `provider ${provider.id}`,
      { 'provider.name': provider.id },
      async (span) => {
        const outcome = await this.callProviderUntraced(provider, query, enabled, logger, log);
        const r = outcome.report;
        span.setAttributes({
          'provider.status': r.status,
          'provider.latency_ms': r.latencyMs,
          'provider.attempts': r.attempts,
          'provider.offers': r.offersCount,
          'provider.discarded': r.discardedCount,
        });
        if (r.status !== 'ok' && r.status !== 'disabled') span.recordError(r.errorCode ?? r.status);
        this.observer.providerCall(r);
        return outcome;
      },
    );
  }

  private async callProviderUntraced(
    provider: FlightProvider,
    query: SearchQuery,
    enabled: boolean,
    logger: Logger,
    log: object,
  ): Promise<ProviderOutcome> {
    const base = { name: provider.id, offersCount: 0, discardedCount: 0 };
    if (!enabled) {
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
      for (const d of result.discarded) this.observer.offersDiscarded(provider.id, d.reason);
      for (const name of result.unknownAirlines) this.observer.unknownAirline(provider.id, name);
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

  private readCache(key: string, logger: Logger): Promise<SearchSnapshot | null> {
    return this.tracer.withSpan('cache.get', { 'cache.key': key }, async (span) => {
      try {
        const value = await this.deps.cache.get(key);
        this.observer.cacheLookup(value ? 'hit' : 'miss');
        span.setAttributes({ 'cache.hit': value !== null });
        return value;
      } catch (error) {
        this.observer.cacheLookup('error');
        span.recordError(error);
        logger.warn({ err: error, key }, 'cache read failed, continuing without cache');
        return null;
      }
    });
  }

  private async writeCache(key: string, snapshot: SearchSnapshot, logger: Logger): Promise<void> {
    const { cacheTtlSeconds, partialCacheTtlSeconds } = this.deps.config;
    const ttl = snapshot.partial ? partialCacheTtlSeconds : cacheTtlSeconds;
    if (ttl <= 0) return;
    await this.tracer.withSpan(
      'cache.set',
      { 'cache.key': key, 'cache.ttl_s': ttl },
      async (span) => {
        try {
          await this.deps.cache.set(key, snapshot, ttl);
        } catch (error) {
          this.observer.cacheWriteFailed();
          span.recordError(error);
          logger.warn({ err: error, key }, 'cache write failed, response still served');
        }
      },
    );
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
      this.observer.persistenceFailed();
      logger.error({ err: error, searchId: record.searchId }, 'search persistence failed');
    });
  }
}

function classify(error: unknown): ProviderStatus {
  if (error instanceof ProviderTimeoutError) return 'timeout';
  if (error instanceof CircuitOpenError) return 'circuit_open';
  return 'error';
}
