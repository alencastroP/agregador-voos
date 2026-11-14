import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ProviderUnavailableError } from '../../../src/domain/errors.js';
import { DEFAULT_INCENTIVE_BPS } from '../../../src/domain/provider.js';
import { mapProviderA } from '../../../src/infrastructure/providers/mappers/provider-a.mapper.js';
import { buildApp } from '../../../src/interfaces/http/app.js';
import { FakeProvider, testConfig, useCase } from '../../helpers/app.js';
import { loadProviderFixture, query } from '../../helpers/fixtures.js';

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

const okA = () =>
  new FakeProvider('provider-a', {
    kind: 'ok',
    result: () =>
      mapProviderA(loadProviderFixture('a'), query(), DEFAULT_INCENTIVE_BPS['provider-a']),
  });
const fail = (id: 'provider-a' | 'provider-b' | 'provider-c') =>
  new FakeProvider(id, {
    kind: 'fail',
    error: new ProviderUnavailableError(id, 'HTTP 500', true, 500),
  });

function appWith(providers: FakeProvider[]): FastifyInstance {
  app = buildApp({ config: testConfig(), searchFlights: useCase({ providers }) });
  return app;
}

const post = (payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/search', payload: payload as object, headers });

describe('POST /search', () => {
  it('200 with partial=true when some providers fail', async () => {
    appWith([okA(), fail('provider-b'), fail('provider-c')]);
    const res = await post({ origin: 'GRU', destination: 'GIG', date: '2026-12-12' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ results: unknown[]; meta: { partial: boolean; cached: boolean } }>();
    expect(body.results).toHaveLength(40);
    expect(body.meta).toMatchObject({ partial: true, cached: false });
  });

  it('400 problem+json listing invalid fields', async () => {
    appWith([okA()]);
    const res = await post({ origin: 'XX', destination: 'GIG', date: '2020-01-01' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.json()).toMatchObject({
      status: 400,
      type: 'https://passhub.dev/problems/invalid_search',
      errors: [
        { field: 'origin', message: expect.any(String) as string },
        { field: 'date', message: 'não pode estar no passado' },
      ],
    });
  });

  it('400 when the body is missing', async () => {
    appWith([okA()]);
    const res = await app.inject({ method: 'POST', url: '/search' });
    expect(res.statusCode).toBe(400);
  });

  it('503 only when ALL providers failed', async () => {
    appWith([fail('provider-a'), fail('provider-b'), fail('provider-c')]);
    const res = await post({ origin: 'GRU', destination: 'GIG', date: '2026-12-12' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ type: 'https://passhub.dev/problems/all_providers_failed' });
  });

  it('echoes x-request-id for correlation', async () => {
    appWith([okA()]);
    const res = await post(
      { origin: 'GRU', destination: 'GIG', date: '2026-12-12' },
      { 'x-request-id': 'agency-42' },
    );
    expect(res.headers['x-request-id']).toBe('agency-42');
  });
});
