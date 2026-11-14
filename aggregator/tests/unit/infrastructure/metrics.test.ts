import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/application/ports/logger.js';
import type { SearchCache } from '../../../src/application/ports/search-cache.js';
import { ProviderUnavailableError } from '../../../src/domain/errors.js';
import { DEFAULT_INCENTIVE_BPS, type ProviderId } from '../../../src/domain/provider.js';
import { Metrics } from '../../../src/infrastructure/observability/metrics.js';
import { mapProviderA } from '../../../src/infrastructure/providers/mappers/provider-a.mapper.js';
import { mapProviderB } from '../../../src/infrastructure/providers/mappers/provider-b.mapper.js';
import { mapProviderC } from '../../../src/infrastructure/providers/mappers/provider-c.mapper.js';
import type { CircuitState } from '../../../src/infrastructure/resilience/circuit-breaker.js';
import { FakeProvider, useCase } from '../../helpers/app.js';
import { loadProviderFixture, query } from '../../helpers/fixtures.js';

const input = { origin: 'GRU', destination: 'GIG', date: '2026-12-12' };
const ctx = { logger: silentLogger };

const real = {
  a: () => mapProviderA(loadProviderFixture('a'), query(), DEFAULT_INCENTIVE_BPS['provider-a']),
  b: () => mapProviderB(loadProviderFixture('b'), query(), DEFAULT_INCENTIVE_BPS['provider-b']),
  c: () => mapProviderC(loadProviderFixture('c'), query(), DEFAULT_INCENTIVE_BPS['provider-c']),
};

async function value(metrics: Metrics, name: string, labels: Record<string, string> = {}) {
  const metric = (await metrics.registry.getMetricsAsJSON()).find((m) => m.name === name);
  const match = metric?.values.find((v) =>
    Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val),
  );
  return match?.value ?? 0;
}

describe('Metrics as SearchObserver (real use case, real fixtures)', () => {
  it('counts business outcome of the strategy: gain for the company, delta for the customer', async () => {
    const metrics = new Metrics({ defaultMetrics: false });
    const providers = [
      new FakeProvider('provider-a', { kind: 'ok', result: real.a }),
      new FakeProvider('provider-b', { kind: 'ok', result: real.b }),
      new FakeProvider('provider-c', { kind: 'ok', result: real.c }),
    ];
    const search = useCase({ providers, observer: metrics.observer() });
    const res = await search.execute(input, ctx);

    const gain = res.results.reduce(
      (s, r) => s + Math.max(0, r.selection.incentiveGainVsCheapestCents),
      0,
    );
    const delta = res.results.reduce((s, r) => s + r.selection.deltaToCheapestCents, 0);
    expect(
      await value(metrics, 'selection_incentive_gain_cents_total', { strategy: 'balanced' }),
    ).toBe(gain);
    expect(
      await value(metrics, 'selection_customer_delta_cents_total', { strategy: 'balanced' }),
    ).toBe(delta);
    expect(
      await value(metrics, 'selection_offers_total', {
        strategy: 'balanced',
        differs_from_cheapest: 'true',
      }),
    ).toBe(10);
    expect(await value(metrics, 'search_requests_total', { outcome: 'ok', cached: 'false' })).toBe(
      1,
    );
    // os 2 registros sujos dos mocks
    expect(
      await value(metrics, 'offers_discarded_total', {
        provider: 'provider-b',
        reason: 'unsupported_currency',
      }),
    ).toBe(1);
    expect(
      await value(metrics, 'offers_discarded_total', {
        provider: 'provider-c',
        reason: 'invalid_price',
      }),
    ).toBe(1);
    expect(await value(metrics, 'cache_misses_total')).toBe(1);

    await search.execute(input, ctx);
    expect(await value(metrics, 'cache_hits_total')).toBe(1);
    expect(await value(metrics, 'search_requests_total', { outcome: 'ok', cached: 'true' })).toBe(
      1,
    );
  });

  it('counts provider errors, retries and cache failures', async () => {
    const metrics = new Metrics({ defaultMetrics: false });
    const failing = new ProviderUnavailableError('provider-c', 'HTTP 500', true, 500);
    failing.attempts = 3;
    const broken: SearchCache = {
      get: () => Promise.reject(new Error('down')),
      set: () => Promise.reject(new Error('down')),
    };
    await useCase({
      providers: [
        new FakeProvider('provider-a', { kind: 'ok', result: real.a }),
        new FakeProvider('provider-c', { kind: 'fail', error: failing }),
      ],
      cache: broken,
      observer: metrics.observer(),
    }).execute(input, ctx);

    expect(
      await value(metrics, 'provider_errors_total', { provider: 'provider-c', type: 'error' }),
    ).toBe(1);
    expect(await value(metrics, 'provider_retries_total', { provider: 'provider-c' })).toBe(2);
    expect(await value(metrics, 'cache_errors_total', { operation: 'get' })).toBe(1);
    expect(await value(metrics, 'cache_errors_total', { operation: 'set' })).toBe(1);
    expect(
      await value(metrics, 'search_requests_total', { outcome: 'partial', cached: 'false' }),
    ).toBe(1);
  });

  it('exposes circuit breaker state as a gauge read at scrape time', async () => {
    const metrics = new Metrics({ defaultMetrics: false });
    const states: Record<string, CircuitState> = { 'provider-a': 'closed', 'provider-c': 'open' };
    metrics.trackCircuits(
      new Map(
        Object.keys(states).map((id) => [
          id as ProviderId,
          {
            get currentState() {
              return states[id] ?? 'closed';
            },
          },
        ]),
      ),
    );
    expect(await value(metrics, 'circuit_breaker_state', { provider: 'provider-c' })).toBe(2);
    states['provider-c'] = 'half_open';
    expect(await value(metrics, 'circuit_breaker_state', { provider: 'provider-c' })).toBe(1);
    expect(await value(metrics, 'circuit_breaker_state', { provider: 'provider-a' })).toBe(0);
  });
});
