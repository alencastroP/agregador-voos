import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { HealthIndicator } from '../../../src/application/ports/health.js';
import { withTimeout } from '../../../src/infrastructure/observability/health-indicators.js';
import { Metrics } from '../../../src/infrastructure/observability/metrics.js';
import { buildApp } from '../../../src/interfaces/http/app.js';
import { FakeProvider, testConfig, useCase } from '../../helpers/app.js';

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

const indicator = (
  name: string,
  status: 'up' | 'degraded' | 'down',
  critical = false,
): HealthIndicator => ({ name, critical, check: () => Promise.resolve({ status }) });

function appWith(indicators: HealthIndicator[], draining = false, metrics?: Metrics) {
  app = buildApp({
    config: testConfig(),
    searchFlights: useCase({
      providers: [
        new FakeProvider('provider-a', {
          kind: 'ok',
          result: () => ({
            provider: 'provider-a',
            offers: [],
            discarded: [],
            unknownAirlines: [],
          }),
        }),
      ],
    }),
    health: { indicators, isDraining: () => draining, version: '1.2.3' },
    ...(metrics ? { observability: { metrics } } : {}),
  });
  return app;
}

describe('health endpoints', () => {
  it('/health/live never checks dependencies (restart would not fix a Redis outage)', async () => {
    appWith([indicator('cache', 'down', true)]);
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
  });

  it('/health/ready stays 200 (degraded) when a NON-critical dependency is down', async () => {
    appWith([indicator('cache', 'down'), indicator('providers', 'up')]);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ready_degraded',
      checks: { cache: { status: 'down', critical: false } },
    });
  });

  it('/health/ready is 503 when a CRITICAL component is down', async () => {
    appWith([indicator('db', 'down', true)]);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
  });

  it('/health/ready is 503 while draining (shutdown), so the LB stops routing first', async () => {
    appWith([indicator('cache', 'up')], true);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });

  it('/health gives a human-readable summary', async () => {
    appWith([indicator('cache', 'up'), indicator('providers', 'degraded')]);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'degraded',
      version: '1.2.3',
      checks: { cache: { status: 'up' }, providers: { status: 'degraded' } },
    });
  });

  it('a hung health check cannot hang the endpoint (timeout per indicator)', async () => {
    const hung: HealthIndicator = {
      name: 'cache',
      critical: false,
      check: () => new Promise(() => undefined),
    };
    appWith([withTimeout(hung, 50)]);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({
      checks: { cache: { status: 'down', details: { error: 'timeout after 50ms' } } },
    });
  });
});

describe('/metrics', () => {
  it('exposes Prometheus text with HTTP latency labelled by DECLARED route', async () => {
    const metrics = new Metrics({ defaultMetrics: false });
    appWith([], false, metrics);
    await app.inject({
      method: 'POST',
      url: '/search',
      payload: { origin: 'GRU', destination: 'GIG', date: '2026-12-12' },
    });
    await app.inject({ method: 'GET', url: '/does-not-exist/123' });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toMatch(
      /http_request_duration_seconds_count\{method="POST",route="\/search",status_code="200"\} 1/,
    );
    expect(res.body).toMatch(/route="unmatched",status_code="404"/);
    expect(res.body).not.toContain('does-not-exist'); // URL crua nunca vira rótulo
  });

  it('is not exposed when metrics are not configured', async () => {
    appWith([]);
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
  });
});
