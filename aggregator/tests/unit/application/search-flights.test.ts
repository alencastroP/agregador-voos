import { describe, expect, it, vi } from 'vitest';
import type { ProviderSearchResult } from '../../../src/application/ports/flight-provider.js';
import type { SearchCache } from '../../../src/application/ports/search-cache.js';
import type { SearchRepository } from '../../../src/application/ports/search-repository.js';
import { silentLogger } from '../../../src/application/ports/logger.js';
import { searchCacheKey } from '../../../src/application/search-flights.js';
import {
  AllProvidersFailedError,
  CircuitOpenError,
  InvalidSearchError,
  ProviderUnavailableError,
} from '../../../src/domain/errors.js';
import { DEFAULT_INCENTIVE_BPS } from '../../../src/domain/provider.js';
import { mapProviderA } from '../../../src/infrastructure/providers/mappers/provider-a.mapper.js';
import { mapProviderB } from '../../../src/infrastructure/providers/mappers/provider-b.mapper.js';
import { mapProviderC } from '../../../src/infrastructure/providers/mappers/provider-c.mapper.js';
import { FakeClock, FakeProvider, useCase } from '../../helpers/app.js';
import { loadProviderFixture, query } from '../../helpers/fixtures.js';

const input = { origin: 'GRU', destination: 'GIG', date: '2026-12-12' };
const ctx = { logger: silentLogger };

// Respostas reais dos mocks: o use case roda ponta a ponta sobre dados verdadeiros.
const realA = (): ProviderSearchResult =>
  mapProviderA(loadProviderFixture('a'), query(), DEFAULT_INCENTIVE_BPS['provider-a']);
const realB = (): ProviderSearchResult =>
  mapProviderB(loadProviderFixture('b'), query(), DEFAULT_INCENTIVE_BPS['provider-b']);
const realC = (): ProviderSearchResult =>
  mapProviderC(loadProviderFixture('c'), query(), DEFAULT_INCENTIVE_BPS['provider-c']);

const healthy = () => [
  new FakeProvider('provider-a', { kind: 'ok', result: realA }),
  new FakeProvider('provider-b', { kind: 'ok', result: realB }),
  new FakeProvider('provider-c', { kind: 'ok', result: realC }),
];
const down = (id: 'provider-a' | 'provider-b' | 'provider-c') =>
  new FakeProvider(id, {
    kind: 'fail',
    error: new ProviderUnavailableError(id, 'HTTP 500', true, 500),
  });

describe('SearchFlights: happy path over real mock data', () => {
  it('returns 60 deduplicated, selected and sorted flights with full metadata', async () => {
    const res = await useCase({ providers: healthy(), newId: () => 'search-1' }).execute(
      input,
      ctx,
    );

    expect(res.searchId).toBe('search-1');
    expect(res.query).toEqual({ origin: 'GRU', destination: 'GIG', date: '2026-12-12' });
    expect(res.results).toHaveLength(60);
    expect(res.meta).toMatchObject({
      cached: false,
      partial: false,
      strategy: 'balanced',
      resultsCount: 60,
      generatedAt: '2026-11-14T15:00:00.000Z',
    });
    expect(
      res.meta.providers.map((p) => [p.name, p.status, p.offersCount, p.discardedCount]),
    ).toEqual([
      ['provider-a', 'ok', 40, 0],
      ['provider-b', 'ok', 40, 1],
      ['provider-c', 'ok', 40, 1],
    ]);
    // nenhum registro sujo na saída
    expect(res.results.some((r) => r.airline.displayName.includes('Copa'))).toBe(false);
    expect(res.results.every((r) => r.price.amountCents > 0)).toBe(true);
    // a balanced trocou A→C exatamente nos 10 voos vendidos só por A e C
    expect(res.results.filter((r) => r.selection.deltaToCheapestCents > 0)).toHaveLength(10);
  });

  it('is deterministic: same input → same ordering', async () => {
    const first = await useCase({ providers: healthy() }).execute(input, ctx);
    const second = await useCase({ providers: healthy().reverse() }).execute(input, ctx);
    expect(second.results.map((r) => r.flightKey)).toEqual(first.results.map((r) => r.flightKey));
    const prices = first.results.map((r) => r.price.amountCents);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it('calls the providers in parallel, not one after the other', async () => {
    const slow = (
      id: 'provider-a' | 'provider-b' | 'provider-c',
      result: () => ProviderSearchResult,
    ) => new FakeProvider(id, { kind: 'ok', result, delayMs: 80 });
    const started = performance.now();
    await useCase({
      providers: [slow('provider-a', realA), slow('provider-b', realB), slow('provider-c', realC)],
    }).execute(input, ctx);
    expect(performance.now() - started).toBeLessThan(200); // sequencial seria ≥ 240 ms
  });

  it('returns 200 with empty results when providers answer but have no flights', async () => {
    const empty = (id: 'provider-a' | 'provider-b' | 'provider-c') =>
      new FakeProvider(id, {
        kind: 'ok',
        result: () => ({ provider: id, offers: [], discarded: [], unknownAirlines: [] }),
      });
    const res = await useCase({
      providers: [empty('provider-a'), empty('provider-b'), empty('provider-c')],
    }).execute(input, ctx);
    expect(res.results).toEqual([]);
    expect(res.meta.partial).toBe(false);
  });
});

describe('SearchFlights: degradation', () => {
  it('keeps answering when one provider fails (partial = true)', async () => {
    const [a, b] = healthy();
    const res = await useCase({ providers: [a!, b!, down('provider-c')] }).execute(input, ctx);
    expect(res.meta.partial).toBe(true);
    expect(res.meta.providers[2]).toMatchObject({
      name: 'provider-c',
      status: 'error',
      errorCode: 'provider_unavailable',
    });
    expect(res.results).toHaveLength(55); // 60 voos − 5 exclusivos do C
  });

  it('enforces the per-provider deadline even if the adapter ignores the AbortSignal', async () => {
    const [a, b] = healthy();
    const hung = new FakeProvider('provider-c', { kind: 'hang' });
    const started = performance.now();
    const res = await useCase({ providers: [a!, b!, hung] }).execute(input, ctx);
    const elapsed = performance.now() - started;

    expect(res.meta.providers[2]).toMatchObject({
      status: 'timeout',
      errorCode: 'provider_timeout',
    });
    expect(elapsed).toBeGreaterThanOrEqual(190); // deadline de teste: 200 ms
    expect(elapsed).toBeLessThan(600);
    expect(hung.lastSignal?.aborted).toBe(true); // o sinal entregue ao adapter foi abortado
  });

  it('reports circuit_open distinctly', async () => {
    const [a, b] = healthy();
    const open = new FakeProvider('provider-c', {
      kind: 'fail',
      error: new CircuitOpenError('provider-c', 'circuit open'),
    });
    const res = await useCase({ providers: [a!, b!, open] }).execute(input, ctx);
    expect(res.meta.providers[2]?.status).toBe('circuit_open');
  });

  it('marks disabled providers without calling them and without flagging partial', async () => {
    const providers = healthy();
    const res = await useCase({
      providers,
      isProviderEnabled: (id) => id !== 'provider-b',
    }).execute(input, ctx);
    expect(providers[1]!.calls).toBe(0);
    expect(res.meta.providers[1]).toMatchObject({ status: 'disabled', latencyMs: 0 });
    expect(res.meta.partial).toBe(false);
  });

  it('throws AllProvidersFailedError (→ 503) when nobody answers', async () => {
    await expect(
      useCase({ providers: [down('provider-a'), down('provider-b'), down('provider-c')] }).execute(
        input,
        ctx,
      ),
    ).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  it('a bug that escapes a provider call does not take the others down', async () => {
    const [a, b] = healthy();
    const buggy = new FakeProvider('provider-c', {
      kind: 'ok',
      result: () => {
        throw new TypeError('boom');
      },
    });
    const res = await useCase({ providers: [a!, b!, buggy] }).execute(input, ctx);
    expect(res.meta.providers[2]).toMatchObject({ status: 'error', errorCode: 'unexpected_error' });
    expect(res.results.length).toBeGreaterThan(0);
  });
});

describe('SearchFlights: cache', () => {
  it('serves the second identical search from cache without calling providers', async () => {
    const providers = healthy();
    const search = useCase({ providers });
    const first = await search.execute(input, ctx);
    const second = await search.execute({ ...input, origin: 'gru' }, ctx); // mesma chave normalizada

    expect(first.meta.cached).toBe(false);
    expect(second.meta.cached).toBe(true);
    expect(second.searchId).not.toBe(first.searchId);
    expect(second.results).toEqual(first.results);
    expect(second.meta.generatedAt).toBe(first.meta.generatedAt);
    expect(providers.map((p) => p.calls)).toEqual([1, 1, 1]);
  });

  it('expires the full response after 5 minutes', async () => {
    const clock = new FakeClock();
    const providers = healthy();
    const search = useCase({ providers, clock });
    await search.execute(input, ctx);
    clock.advance(299_000);
    expect((await search.execute(input, ctx)).meta.cached).toBe(true);
    clock.advance(2_000);
    expect((await search.execute(input, ctx)).meta.cached).toBe(false);
  });

  it('caches a PARTIAL response only briefly (30 s), so a recovered provider shows up fast', async () => {
    const clock = new FakeClock();
    const [a, b] = healthy();
    const c = down('provider-c');
    const search = useCase({ providers: [a!, b!, c], clock });

    await search.execute(input, ctx);
    clock.advance(29_000);
    expect((await search.execute(input, ctx)).meta.cached).toBe(true);

    c.behaviour = { kind: 'ok', result: realC };
    clock.advance(2_000);
    const recovered = await search.execute(input, ctx);
    expect(recovered.meta).toMatchObject({ cached: false, partial: false });
  });

  it('coalesces concurrent identical searches into ONE provider round-trip (stampede)', async () => {
    const slow = (
      id: 'provider-a' | 'provider-b' | 'provider-c',
      result: () => ProviderSearchResult,
    ) => new FakeProvider(id, { kind: 'ok', result, delayMs: 50 });
    const providers = [
      slow('provider-a', realA),
      slow('provider-b', realB),
      slow('provider-c', realC),
    ];
    const records: string[] = [];
    const search = useCase({
      providers,
      repository: {
        save: (r) => {
          records.push(r.searchId);
          return Promise.resolve();
        },
      },
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => search.execute(input, ctx)),
    );

    expect(providers.map((p) => p.calls)).toEqual([1, 1, 1]); // 10 buscas, 3 chamadas
    expect(new Set(responses.map((r) => r.searchId)).size).toBe(10); // cada busca é um evento
    expect(responses.every((r) => r.results.length === 60)).toBe(true);
    expect(records).toHaveLength(10); // demanda registrada por requisição
  });

  it('uses a cache key that includes the strategy fingerprint', () => {
    expect(searchCacheKey(query(), 'balanced:150:2500:0')).toBe(
      'search:v1:GRU:GIG:2026-12-12:balanced:150:2500:0',
    );
  });

  it('degrades to "no cache" when the cache is down (Redis outage never breaks search)', async () => {
    const broken: SearchCache = {
      get: () => Promise.reject(new Error('ECONNREFUSED')),
      set: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const warn = vi.fn();
    const res = await useCase({ providers: healthy(), cache: broken }).execute(input, {
      logger: { ...silentLogger, warn },
    });
    expect(res.results).toHaveLength(60);
    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/cache read failed/),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/cache write failed/),
    );
  });
});

describe('SearchFlights: persistence and validation', () => {
  it('persists asynchronously and never fails the search when the database is down', async () => {
    const saved: unknown[] = [];
    let release: () => void = () => undefined;
    const slowRepo: SearchRepository = {
      save: (record) =>
        new Promise((resolve) => {
          saved.push(record);
          release = resolve;
        }),
    };
    const res = await useCase({ providers: healthy(), repository: slowRepo }).execute(input, ctx);
    expect(res.results).toHaveLength(60); // respondeu sem esperar o save terminar
    expect(saved).toHaveLength(1);
    release();

    const error = vi.fn();
    const failing: SearchRepository = { save: () => Promise.reject(new Error('db down')) };
    await useCase({ providers: healthy(), repository: failing }).execute(input, {
      logger: { ...silentLogger, error },
    });
    await new Promise((r) => setImmediate(r));
    expect(error).toHaveBeenCalledWith(expect.anything(), 'search persistence failed');
  });

  it('records cache hits too (demand analytics)', async () => {
    const records: { cacheHit: boolean }[] = [];
    const repo: SearchRepository = {
      save: (r) => {
        records.push(r);
        return Promise.resolve();
      },
    };
    const search = useCase({ providers: healthy(), repository: repo });
    await search.execute(input, ctx);
    await search.execute(input, ctx);
    expect(records.map((r) => r.cacheHit)).toEqual([false, true]);
  });

  it('rejects invalid input before calling any provider', async () => {
    const providers = healthy();
    await expect(
      useCase({ providers }).execute(
        { origin: 'GRU', destination: 'GRU', date: '2020-01-01' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidSearchError);
    expect(providers.every((p) => p.calls === 0)).toBe(true);
  });
});
