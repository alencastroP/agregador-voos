import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type {
  CacheLookup,
  SearchObserver,
  SearchOutcome,
} from '../../application/ports/search-observer.js';
import type { ProviderReport, SearchResultItem } from '../../application/search-response.js';
import type { DiscardReason } from '../../domain/flight-offer.js';
import type { ProviderId } from '../../domain/provider.js';
import type { CircuitState } from '../resilience/circuit-breaker.js';

/** Buckets pensados para o orçamento de 3 s: resolução fina até 500 ms e marcos em 1/2/3 s. */
const LATENCY_BUCKETS = [0.025, 0.05, 0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1, 1.5, 2, 2.5, 3, 5];

/** Estado numérico para gráfico: 0 fechado (saudável), 1 half-open, 2 aberto. */
export const CIRCUIT_STATE_VALUE: Record<CircuitState, number> = {
  closed: 0,
  half_open: 1,
  open: 2,
};

/**
 * Todas as métricas do serviço num registry próprio (testável, sem estado global).
 * Rótulos com cardinalidade BAIXA e fechada: nunca rota/data/searchId (explodiria séries).
 */
export class Metrics {
  readonly registry = new Registry();

  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Latência das requisições HTTP do agregador',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  readonly searches = new Counter({
    name: 'search_requests_total',
    help: 'Buscas servidas por resultado',
    labelNames: ['outcome', 'cached'] as const,
    registers: [this.registry],
  });

  readonly coalesced = new Counter({
    name: 'search_coalesced_total',
    help: 'Buscas que esperaram uma busca idêntica em andamento (single-flight)',
    registers: [this.registry],
  });

  readonly providerDuration = new Histogram({
    name: 'provider_request_duration_seconds',
    help: 'Latência por provider (chamada lógica, incluindo retries)',
    labelNames: ['provider', 'status'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  readonly providerErrors = new Counter({
    name: 'provider_errors_total',
    help: 'Falhas por provider e tipo (timeout, error, circuit_open)',
    labelNames: ['provider', 'type'] as const,
    registers: [this.registry],
  });

  readonly providerRetries = new Counter({
    name: 'provider_retries_total',
    help: 'Tentativas extras feitas pelo retry (tentativas − 1)',
    labelNames: ['provider'] as const,
    registers: [this.registry],
  });

  readonly cacheHits = new Counter({
    name: 'cache_hits_total',
    help: 'Buscas servidas do cache',
    registers: [this.registry],
  });

  readonly cacheMisses = new Counter({
    name: 'cache_misses_total',
    help: 'Buscas que não estavam no cache',
    registers: [this.registry],
  });

  readonly cacheErrors = new Counter({
    name: 'cache_errors_total',
    help: 'Falhas do cache (Redis fora/lento): a busca seguiu sem cache',
    labelNames: ['operation'] as const,
    registers: [this.registry],
  });

  readonly offersDiscarded = new Counter({
    name: 'offers_discarded_total',
    help: 'Ofertas descartadas na normalização, por provider e motivo',
    labelNames: ['provider', 'reason'] as const,
    registers: [this.registry],
  });

  readonly unknownAirlines = new Counter({
    name: 'airline_unknown_total',
    help: 'Ofertas com companhia sem alias conhecido (mantidas como chave própria)',
    labelNames: ['provider'] as const,
    registers: [this.registry],
  });

  readonly selectedOffers = new Counter({
    name: 'selection_offers_total',
    help: 'Voos exibidos, por estratégia e se a escolha diferiu do mais barato',
    labelNames: ['strategy', 'differs_from_cheapest'] as const,
    registers: [this.registry],
  });

  readonly incentiveGain = new Counter({
    name: 'selection_incentive_gain_cents_total',
    help: 'Incentivo a mais (vs. sempre o mais barato) nas ofertas exibidas, em centavos',
    labelNames: ['strategy'] as const,
    registers: [this.registry],
  });

  readonly customerDelta = new Counter({
    name: 'selection_customer_delta_cents_total',
    help: 'Quanto o cliente pagaria a mais (vs. o mais barato) nas ofertas exibidas, em centavos',
    labelNames: ['strategy'] as const,
    registers: [this.registry],
  });

  readonly persistenceFailures = new Counter({
    name: 'search_persistence_failures_total',
    help: 'Registros analíticos que não foram gravados (fire-and-forget)',
    registers: [this.registry],
  });

  constructor({ defaultMetrics = true }: { defaultMetrics?: boolean } = {}) {
    if (defaultMetrics) collectDefaultMetrics({ register: this.registry });
  }

  /** O gauge é lido na hora do scrape: sempre reflete o estado atual (inclusive open → half_open). */
  trackCircuits(breakers: ReadonlyMap<ProviderId, { readonly currentState: CircuitState }>): void {
    new Gauge({
      name: 'circuit_breaker_state',
      help: 'Estado do circuit breaker: 0 closed, 1 half_open, 2 open',
      labelNames: ['provider'] as const,
      registers: [this.registry],
      collect() {
        for (const [provider, breaker] of breakers) {
          this.set({ provider }, CIRCUIT_STATE_VALUE[breaker.currentState]);
        }
      },
    });
  }

  /** Implementação do port SearchObserver em cima destas métricas. */
  observer(): SearchObserver {
    return {
      providerCall: (r: ProviderReport) => {
        if (r.status === 'disabled') return;
        this.providerDuration.observe({ provider: r.name, status: r.status }, r.latencyMs / 1000);
        if (r.status !== 'ok') this.providerErrors.inc({ provider: r.name, type: r.status });
        if (r.attempts > 1) this.providerRetries.inc({ provider: r.name }, r.attempts - 1);
      },
      offersDiscarded: (provider: ProviderId, reason: DiscardReason) => {
        this.offersDiscarded.inc({ provider, reason });
      },
      unknownAirline: (provider: ProviderId) => {
        this.unknownAirlines.inc({ provider });
      },
      cacheLookup: (result: CacheLookup) => {
        if (result === 'hit') this.cacheHits.inc();
        else if (result === 'miss') this.cacheMisses.inc();
        else this.cacheErrors.inc({ operation: 'get' });
      },
      cacheWriteFailed: () => {
        this.cacheErrors.inc({ operation: 'set' });
      },
      searchServed: (
        outcome: SearchOutcome,
        cached: boolean,
        results: readonly SearchResultItem[],
      ) => {
        this.searches.inc({ outcome, cached: String(cached) });
        for (const { selection } of results) {
          const differs = selection.deltaToCheapestCents > 0;
          this.selectedOffers.inc({
            strategy: selection.strategy,
            differs_from_cheapest: String(differs),
          });
          if (selection.incentiveGainVsCheapestCents > 0) {
            this.incentiveGain.inc(
              { strategy: selection.strategy },
              selection.incentiveGainVsCheapestCents,
            );
          }
          if (differs) {
            this.customerDelta.inc(
              { strategy: selection.strategy },
              selection.deltaToCheapestCents,
            );
          }
        }
      },
      searchCoalesced: () => {
        this.coalesced.inc();
      },
      persistenceFailed: () => {
        this.persistenceFailures.inc();
      },
    };
  }
}
