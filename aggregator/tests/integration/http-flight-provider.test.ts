import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ProviderContractError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../../src/domain/errors.js';
import {
  HttpFlightProvider,
  isTransientStatus,
} from '../../src/infrastructure/providers/http-flight-provider.js';
import { mapProviderB } from '../../src/infrastructure/providers/mappers/provider-b.mapper.js';
import { query } from '../helpers/fixtures.js';

/**
 * Servidor HTTP real em porta efêmera: exercita fetch/undici de verdade (serialização,
 * status, corpo inválido e, principalmente, o cancelamento do socket no timeout).
 */
type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
let server: Server;
let baseUrl: string;
let handler: Handler = (_req, res) => res.end();
const closedConnections: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      handler(req, res, body);
    });
    res.on('close', () => {
      if (!res.writableEnded) closedConnections.push(req.url ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const provider = (path = '/provider-b/search') =>
  new HttpFlightProvider({
    id: 'provider-b',
    url: `${baseUrl}${path}`,
    mapper: mapProviderB,
    incentiveRateBps: 150,
  });

const json = (res: ServerResponse, status: number, payload: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

describe('HttpFlightProvider (real HTTP)', () => {
  it('POSTs the normalized query as JSON and maps the response', async () => {
    let received: unknown;
    handler = (req, res, body) => {
      received = {
        method: req.method,
        contentType: req.headers['content-type'],
        body: JSON.parse(body) as unknown,
      };
      json(res, 200, {
        results: [
          {
            airline_name: 'Latam',
            amount: 78439,
            currency: 'BRL',
            departure: '08:00',
            arrival: '11:10',
          },
        ],
      });
    };
    const result = await provider().search(query(), AbortSignal.timeout(1000));
    expect(received).toEqual({
      method: 'POST',
      contentType: 'application/json',
      body: { origin: 'GRU', destination: 'GIG', date: '2026-12-12' },
    });
    expect(result.offers[0]).toMatchObject({
      flightKey: 'LATAM|2026-12-12T08:00',
      incentiveAmountCents: 1177,
    });
  });

  it.each([
    [500, true],
    [503, true],
    [429, true],
    [400, false],
    [404, false],
  ])('HTTP %i → ProviderUnavailableError(transient=%s)', async (status, transient) => {
    handler = (_req, res) => {
      json(res, status, { detail: 'nope' });
    };
    const error = await provider()
      .search(query(), AbortSignal.timeout(1000))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).toMatchObject({ transient, httpStatus: status });
  });

  it('invalid JSON → ProviderContractError (not retryable)', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>maintenance</html>');
    };
    await expect(provider().search(query(), AbortSignal.timeout(1000))).rejects.toBeInstanceOf(
      ProviderContractError,
    );
  });

  it('timeout aborts the request AND closes the socket on the provider side', async () => {
    handler = () => undefined; // nunca responde (igual ao TIMEOUT_RATE do mock: 30 s)
    const started = performance.now();
    const error = await provider('/hang')
      .search(query(), AbortSignal.timeout(150))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect(performance.now() - started).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 50));
    expect(closedConnections).toContain('/hang'); // o servidor viu a conexão ser cortada
  });

  it('connection refused → transient ProviderUnavailableError', async () => {
    const dead = new HttpFlightProvider({
      id: 'provider-b',
      url: 'http://127.0.0.1:1/provider-b/search',
      mapper: mapProviderB,
      incentiveRateBps: 150,
    });
    const error = await dead.search(query(), AbortSignal.timeout(2000)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).toMatchObject({ transient: true });
  });

  it('isTransientStatus covers 5xx, 429 and 408 only', () => {
    expect([500, 502, 503, 504, 429, 408].every(isTransientStatus)).toBe(true);
    expect([400, 401, 403, 404, 422].some(isTransientStatus)).toBe(false);
  });
});
