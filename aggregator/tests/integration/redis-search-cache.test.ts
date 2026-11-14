import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/application/ports/logger.js';
import type { SearchSnapshot } from '../../src/application/search-response.js';
import { DEFAULT_INCENTIVE_BPS } from '../../src/domain/provider.js';
import {
  createRedisClient,
  RedisSearchCache,
  waitForRedis,
} from '../../src/infrastructure/cache/redis-search-cache.js';
import { mapProviderA } from '../../src/infrastructure/providers/mappers/provider-a.mapper.js';
import { FakeProvider, useCase } from '../helpers/app.js';
import { loadProviderFixture, query } from '../helpers/fixtures.js';

/** Redis REAL via Testcontainers: TTL, serialização e comportamento de falha de verdade. */
let container: StartedRedisContainer;
let redis: Redis;
let cache: RedisSearchCache;

beforeAll(async () => {
  container = await new RedisContainer('redis:7.4-alpine').start();
  redis = createRedisClient({ url: container.getConnectionUrl(), commandTimeoutMs: 200 });
  expect(await waitForRedis(redis, 5_000)).toBe(true);
  cache = new RedisSearchCache(redis);
}, 120_000);

afterAll(async () => {
  await redis.quit();
  await container.stop();
});

const snapshot: SearchSnapshot = {
  query: { origin: 'GRU', destination: 'GIG', date: query().date },
  results: [],
  partial: false,
  generatedAt: '2026-11-14T15:00:00.000Z',
  strategy: 'balanced',
  providers: [],
};

const input = { origin: 'GRU', destination: 'GIG', date: '2026-12-12' };
const providerA = () =>
  new FakeProvider('provider-a', {
    kind: 'ok',
    result: () =>
      mapProviderA(loadProviderFixture('a'), query(), DEFAULT_INCENTIVE_BPS['provider-a']),
  });

describe('RedisSearchCache (real Redis)', () => {
  it('round-trips a snapshot with a native TTL', async () => {
    await cache.set('search:v1:test:roundtrip', snapshot, 300);
    expect(await cache.get('search:v1:test:roundtrip')).toEqual(snapshot);
    const ttl = await redis.ttl('search:v1:test:roundtrip');
    expect(ttl).toBeGreaterThan(295);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('expires entries after the TTL', async () => {
    await cache.set('search:v1:test:expire', snapshot, 1);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(await cache.get('search:v1:test:expire')).toBeNull();
  });

  it('returns null for a miss', async () => {
    expect(await cache.get('search:v1:test:missing')).toBeNull();
  });

  it('treats a corrupted entry as a miss and deletes it', async () => {
    await redis.set('search:v1:test:corrupt', '{not json');
    expect(await cache.get('search:v1:test:corrupt')).toBeNull();
    expect(await redis.exists('search:v1:test:corrupt')).toBe(0);
  });

  it('use case end-to-end: second search is a Redis cache hit', async () => {
    const providers = [providerA()];
    const search = useCase({ providers, cache });
    const first = await search.execute(input, { logger: silentLogger });
    const second = await search.execute(input, { logger: silentLogger });
    expect([first.meta.cached, second.meta.cached]).toEqual([false, true]);
    expect(second.results).toEqual(first.results);
    expect(providers[0]!.calls).toBe(1);
    expect(await redis.keys('search:v1:GRU:GIG:2026-12-12:*')).toHaveLength(1);
  });
});

describe('Redis failures never break the search', () => {
  it('Redis DOWN: commands fail fast (no offline queue) and the search still answers', async () => {
    const down = createRedisClient({ url: 'redis://127.0.0.1:1', commandTimeoutMs: 200 });
    down.on('error', () => undefined);
    try {
      expect(await waitForRedis(down, 300)).toBe(false); // boot não bloqueia
      const started = performance.now();
      await expect(new RedisSearchCache(down).get('k')).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(100); // falha imediata, sem fila

      const res = await useCase({
        providers: [providerA()],
        cache: new RedisSearchCache(down),
      }).execute(input, { logger: silentLogger });
      expect(res.results).toHaveLength(40);
      expect(res.meta.cached).toBe(false);
    } finally {
      down.disconnect();
    }
  });

  it('Redis HUNG (accepts TCP, never answers): commandTimeout turns it into a miss', async () => {
    const blackhole: Server = createServer(() => undefined); // aceita e não responde nada
    await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
    const port = (blackhole.address() as AddressInfo).port;
    const hung = createRedisClient({ url: `redis://127.0.0.1:${port}`, commandTimeoutMs: 200 });
    hung.on('error', () => undefined);
    try {
      await new Promise((r) => setTimeout(r, 100)); // conexão TCP estabelecida
      const started = performance.now();
      const res = await useCase({
        providers: [providerA()],
        cache: new RedisSearchCache(hung),
      }).execute(input, { logger: silentLogger });
      const elapsed = performance.now() - started;
      expect(res.results).toHaveLength(40);
      // get (200 ms) + set (200 ms) no pior caso; nunca "pendura" a busca
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      hung.disconnect();
      blackhole.close();
    }
  });
});
