import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../../src/config/env.js';
import type { SearchUseCase } from '../../../src/interfaces/http/routes/search.route.js';
import { AllProvidersFailedError, InvalidSearchError } from '../../../src/domain/errors.js';
import { buildApp } from '../../../src/interfaces/http/app.js';

const config = loadConfig({
  LOG_LEVEL: 'silent',
  PROVIDER_A_URL: 'http://a.test/search',
  PROVIDER_B_URL: 'http://b.test/search',
  PROVIDER_C_URL: 'http://c.test/search',
});

const searchFlights: SearchUseCase = {
  execute: () => Promise.reject(new Error('not used in these tests')),
};

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

function appWithThrowingRoute(error: unknown): FastifyInstance {
  app = buildApp({ config, searchFlights });
  app.get('/boom', () => {
    throw error;
  });
  return app;
}

describe('http app skeleton', () => {
  it('GET /health/live answers ok', async () => {
    app = buildApp({ config, searchFlights });
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('propagates an incoming x-request-id', async () => {
    app = buildApp({ config, searchFlights });
    const res = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'agency-123' },
    });
    expect(res.headers['x-request-id']).toBe('agency-123');
  });

  it('generates a request id when absent or unsafe', async () => {
    app = buildApp({ config, searchFlights });
    const res = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'bad id with spaces <script>' },
    });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps InvalidSearchError to 400 problem+json with field issues', async () => {
    appWithThrowingRoute(new InvalidSearchError([{ field: 'origin', message: 'IATA inválido' }]));
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.json()).toMatchObject({
      status: 400,
      errors: [{ field: 'origin', message: 'IATA inválido' }],
      requestId: res.headers['x-request-id'],
    });
  });

  it('maps AllProvidersFailedError to 503', async () => {
    appWithThrowingRoute(new AllProvidersFailedError('a, b, c falharam'));
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(503);
  });

  it('hides internal error details behind a generic 500', async () => {
    appWithThrowingRoute(new Error('db password is hunter2'));
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
  });

  it('returns 404 problem for unknown routes', async () => {
    app = buildApp({ config, searchFlights });
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status: 404, title: 'Rota não encontrada' });
  });

  it('rejects malformed JSON bodies with 400', async () => {
    app = buildApp({ config, searchFlights });
    app.post('/echo', (req) => req.body);
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});
