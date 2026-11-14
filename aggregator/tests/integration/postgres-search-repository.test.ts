import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/application/ports/logger.js';
import type { SearchRecord } from '../../src/application/ports/search-repository.js';
import { DEFAULT_INCENTIVE_BPS } from '../../src/domain/provider.js';
import {
  createDatabase,
  runMigrations,
  type Database,
} from '../../src/infrastructure/persistence/database.js';
import {
  PersistenceOverloadedError,
  PostgresSearchRepository,
} from '../../src/infrastructure/persistence/postgres-search-repository.js';
import { mapProviderA } from '../../src/infrastructure/providers/mappers/provider-a.mapper.js';
import { mapProviderB } from '../../src/infrastructure/providers/mappers/provider-b.mapper.js';
import { mapProviderC } from '../../src/infrastructure/providers/mappers/provider-c.mapper.js';
import { FakeProvider, useCase } from '../helpers/app.js';
import { loadProviderFixture, query } from '../helpers/fixtures.js';

let container: StartedPostgreSqlContainer;
let db: Database;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  ({ db, pool } = createDatabase({ url: container.getConnectionUri(), poolMax: 5 }));
  await runMigrations(db);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE searches CASCADE');
});

const count = async (table: string) =>
  Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);

const input = { origin: 'GRU', destination: 'GIG', date: '2026-12-12' };
const providers = () => [
  new FakeProvider('provider-a', {
    kind: 'ok',
    result: () =>
      mapProviderA(loadProviderFixture('a'), query(), DEFAULT_INCENTIVE_BPS['provider-a']),
  }),
  new FakeProvider('provider-b', {
    kind: 'ok',
    result: () =>
      mapProviderB(loadProviderFixture('b'), query(), DEFAULT_INCENTIVE_BPS['provider-b']),
  }),
  new FakeProvider('provider-c', {
    kind: 'ok',
    result: () =>
      mapProviderC(loadProviderFixture('c'), query(), DEFAULT_INCENTIVE_BPS['provider-c']),
  }),
];

describe('migrations', () => {
  it('create the analytics schema on an empty database (and are idempotent)', async () => {
    await runMigrations(db); // 2ª vez: não faz nada
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'provider_calls',
      'searches',
      'selected_offers',
    ]);
  });
});

describe('PostgresSearchRepository with the real use case', () => {
  it('persists search + provider calls + selected offers, matching the response', async () => {
    const repo = new PostgresSearchRepository(db);
    const res = await useCase({ providers: providers(), repository: repo }).execute(input, {
      logger: silentLogger,
    });
    await repo.drain(5_000);

    expect(await count('searches')).toBe(1);
    expect(await count('provider_calls')).toBe(3);
    expect(await count('selected_offers')).toBe(60);

    const search = (await pool.query('SELECT * FROM searches')).rows[0] as Record<string, unknown>;
    expect(search).toMatchObject({
      id: res.searchId,
      origin: 'GRU',
      destination: 'GIG',
      cache_hit: false,
      partial: false,
      results_count: 60,
      strategy: 'balanced',
    });

    // O que o dashboard vai somar bate, centavo a centavo, com a resposta servida.
    const sums = (
      await pool.query<{ gain: string; delta: string; differs: string }>(`
        SELECT sum(incentive_gain_vs_cheapest_cents) AS gain,
               sum(customer_delta_cents)             AS delta,
               count(*) FILTER (WHERE customer_delta_cents > 0) AS differs
        FROM selected_offers`)
    ).rows[0];
    expect(Number(sums?.gain)).toBe(
      res.results.reduce((s, r) => s + r.selection.incentiveGainVsCheapestCents, 0),
    );
    expect(Number(sums?.delta)).toBe(
      res.results.reduce((s, r) => s + r.selection.deltaToCheapestCents, 0),
    );
    expect(Number(sums?.differs)).toBe(10);

    const calls = await pool.query(
      'SELECT provider, status, offers_count, discarded_count, attempts FROM provider_calls ORDER BY provider',
    );
    expect(calls.rows).toEqual([
      { provider: 'provider-a', status: 'ok', offers_count: 40, discarded_count: 0, attempts: 1 },
      { provider: 'provider-b', status: 'ok', offers_count: 40, discarded_count: 1, attempts: 1 },
      { provider: 'provider-c', status: 'ok', offers_count: 40, discarded_count: 1, attempts: 1 },
    ]);
  });

  it('a cache hit records demand only (no fake provider calls or duplicated offers)', async () => {
    const repo = new PostgresSearchRepository(db);
    const search = useCase({ providers: providers(), repository: repo });
    await search.execute(input, { logger: silentLogger });
    await search.execute(input, { logger: silentLogger });
    await repo.drain(5_000);

    expect(await count('searches')).toBe(2);
    expect(await count('provider_calls')).toBe(3);
    expect(await count('selected_offers')).toBe(60);
    const hits = await pool.query('SELECT cache_hit FROM searches ORDER BY cache_hit');
    expect(hits.rows.map((r: { cache_hit: boolean }) => r.cache_hit)).toEqual([false, true]);
  });

  it('is atomic: if any insert fails, nothing of that search is stored', async () => {
    const repo = new PostgresSearchRepository(db);
    const res = await useCase({ providers: providers() }).execute(input, { logger: silentLogger });
    const broken: SearchRecord = {
      searchId: res.searchId,
      query: query(),
      requestedAt: new Date(),
      cacheHit: false,
      partial: false,
      latencyMs: 10,
      strategy: 'balanced',
      providers: res.meta.providers,
      // flight_key NOT NULL: a 3ª inserção da transação falha
      results: [{ ...res.results[0]!, flightKey: null as unknown as never }],
    };
    await expect(repo.save(broken)).rejects.toThrow();
    expect(await count('searches')).toBe(0);
    expect(await count('provider_calls')).toBe(0);
  });

  it('applies backpressure: beyond maxInFlight, records are dropped immediately', async () => {
    const repo = new PostgresSearchRepository(db, 1);
    const res = await useCase({ providers: providers() }).execute(input, { logger: silentLogger });
    const record = (id: string): SearchRecord => ({
      searchId: id,
      query: query(),
      requestedAt: new Date(),
      cacheHit: true,
      partial: false,
      latencyMs: 1,
      strategy: 'balanced',
      providers: [],
      results: res.results,
    });
    const first = repo.save(record('00000000-0000-4000-8000-000000000001'));
    await expect(repo.save(record('00000000-0000-4000-8000-000000000002'))).rejects.toBeInstanceOf(
      PersistenceOverloadedError,
    );
    await first;
    expect(repo.pendingWrites).toBe(0);
  });
});

describe('database outage', () => {
  it('fails fast and never breaks the search', async () => {
    const dead = createDatabase({ url: 'postgres://u:p@127.0.0.1:1/x', poolMax: 1 });
    try {
      const repo = new PostgresSearchRepository(dead.db);
      const started = performance.now();
      const res = await useCase({ providers: providers(), repository: repo }).execute(input, {
        logger: silentLogger,
      });
      expect(res.results).toHaveLength(60);
      expect(performance.now() - started).toBeLessThan(1_000); // não esperou o banco
      await repo.drain(3_000);
    } finally {
      await dead.pool.end();
    }
  });
});

describe('Grafana dashboard SQL (versioned JSON) runs against the real schema', () => {
  interface Target {
    datasource?: { uid?: string };
    rawSql?: string;
  }
  interface Panel {
    title: string;
    targets?: Target[];
  }

  /** Macros do Grafana → SQL equivalente (mesma semântica, janela fixa). */
  const expandMacros = (raw: string) =>
    raw
      .replace(/\$__timeFilter\(([^)]+)\)/g, "$1 > now() - interval '30 days'")
      .replace(/\$__timeGroupAlias\(([^,]+),\s*'1h'\)/g, "date_trunc('hour', $1) AS time");

  it('every Postgres panel query is valid and returns data after a search', async () => {
    const dashboard = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          '..',
          '..',
          '..',
          'observability',
          'grafana',
          'dashboards',
          'aggregator.json',
        ),
        'utf-8',
      ),
    ) as { panels: Panel[] };

    const repo = new PostgresSearchRepository(db);
    const search = useCase({ providers: providers(), repository: repo });
    await search.execute(input, { logger: silentLogger });
    await search.execute(input, { logger: silentLogger }); // um cache hit também
    await repo.drain(5_000);

    const queries = dashboard.panels.flatMap((p) =>
      (p.targets ?? [])
        .filter((t) => t.datasource?.uid === 'postgres' && t.rawSql)
        .map((t) => ({ title: p.title, sql: expandMacros(t.rawSql ?? '') })),
    );
    expect(queries.length).toBeGreaterThanOrEqual(10);

    for (const { title, sql } of queries) {
      const result = await pool.query(sql).catch((error: unknown) => {
        throw new Error(`painel "${title}": ${String(error)}\n${sql}`);
      });
      expect(result.rows.length, title).toBeGreaterThan(0);
    }

    // Spot-check dos números de negócio do painel principal
    const ratio = await pool.query<{ razao: string }>(
      expandMacros(
        queries.find((q) => q.title === 'R$ do cliente por R$ 1 ganho')?.sql ?? 'select 0 as razao',
      ),
    );
    expect(Number(ratio.rows[0]?.razao)).toBeCloseTo(1.17, 2);
  });
});
