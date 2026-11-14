import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenFeature } from '@openfeature/server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../../src/application/ports/logger.js';
import type { SearchCache } from '../../../src/application/ports/search-cache.js';
import { staticFlags } from '../../../src/application/ports/feature-flags.js';
import { DEFAULT_INCENTIVE_BPS } from '../../../src/domain/provider.js';
import {
  envKeyFor,
  FileFlagProvider,
} from '../../../src/infrastructure/flags/file-flag-provider.js';
import { OpenFeatureFlags } from '../../../src/infrastructure/flags/openfeature-flags.js';
import { mapProviderA } from '../../../src/infrastructure/providers/mappers/provider-a.mapper.js';
import { mapProviderC } from '../../../src/infrastructure/providers/mappers/provider-c.mapper.js';
import { defaultFlags, FakeProvider, useCase } from '../../helpers/app.js';
import { loadProviderFixture, query } from '../../helpers/fixtures.js';

const dir = mkdtempSync(join(tmpdir(), 'flags-'));
let seq = 0;
const domains: string[] = [];

/** Cada teste usa um arquivo e um DOMAIN próprios do OpenFeature (sem estado global). */
async function setup(content: unknown, env: NodeJS.ProcessEnv = {}) {
  const path = join(dir, `flags-${++seq}.json`);
  writeFileSync(path, JSON.stringify(content));
  const reloads: { ok: boolean }[] = [];
  const invalid: string[] = [];
  const provider = new FileFlagProvider({
    path,
    pollIntervalMs: 20,
    env,
    onReload: (r) => reloads.push(r),
  });
  const domain = `test-${seq}`;
  domains.push(domain);
  await OpenFeature.setProviderAndWait(domain, provider);
  const flags = new OpenFeatureFlags(OpenFeature.getClient(domain), defaultFlags(), (key) =>
    invalid.push(key),
  );
  return { path, flags, reloads, invalid };
}

afterEach(async () => {
  await OpenFeature.close();
  domains.length = 0;
});

describe('FileFlagProvider + OpenFeatureFlags', () => {
  it('reads strategy, parameters, kill switches and cache from the file', async () => {
    const { flags } = await setup({
      'selection.strategy': { value: 'cheapest' },
      'selection.tolerancePctBps': { value: 120 },
      'provider.c.enabled': { value: false },
      'cache.enabled': { value: false },
    });
    expect(await flags.evaluate({})).toEqual({
      ...defaultFlags(),
      strategy: 'cheapest',
      balanced: { ...defaultFlags().balanced, tolerancePctBps: 120 },
      providers: { 'provider-a': true, 'provider-b': true, 'provider-c': false },
      cacheEnabled: false,
    });
  });

  it('per-agency override enables A/B tests and rollouts', async () => {
    const { flags } = await setup({
      'selection.tolerancePctBps': { value: 150, agencies: { 'agencia-ab': 200 } },
    });
    expect((await flags.evaluate({ agencyId: 'agencia-ab' })).balanced.tolerancePctBps).toBe(200);
    expect((await flags.evaluate({ agencyId: 'outra' })).balanced.tolerancePctBps).toBe(150);
    expect((await flags.evaluate({})).balanced.tolerancePctBps).toBe(150);
  });

  it('environment overrides the file (FLAG_PROVIDER_C_ENABLED=false)', async () => {
    expect(envKeyFor('provider.c.enabled')).toBe('FLAG_PROVIDER_C_ENABLED');
    const { flags } = await setup(
      { 'provider.c.enabled': { value: true } },
      { FLAG_PROVIDER_C_ENABLED: 'false', FLAG_SELECTION_MAXDELTACENTS: '1000' },
    );
    const resolved = await flags.evaluate({});
    expect(resolved.providers['provider-c']).toBe(false);
    expect(resolved.balanced.maxDeltaCents).toBe(1000);
  });

  it('missing flags and wrong types fall back to defaults (never throw)', async () => {
    const { flags } = await setup({ 'selection.tolerancePctBps': { value: 'muito' } });
    expect(await flags.evaluate({})).toEqual(defaultFlags());
  });

  it('values outside the domain (negative τ, unknown strategy) fall back and are reported', async () => {
    const { flags, invalid } = await setup({
      'selection.tolerancePctBps': { value: -5 },
      'selection.strategy': { value: 'random' },
      'selection.minGainRatio': { value: -1 },
    });
    expect(await flags.evaluate({})).toEqual(defaultFlags());
    expect(invalid.sort()).toEqual([
      'selection.minGainRatio',
      'selection.strategy',
      'selection.tolerancePctBps',
    ]);
  });

  it('hot-reloads the file: a kill switch takes effect without restart or deploy', async () => {
    const { path, flags, reloads } = await setup({ 'provider.c.enabled': { value: true } });
    expect((await flags.evaluate({})).providers['provider-c']).toBe(true);

    writeFileSync(path, JSON.stringify({ 'provider.c.enabled': { value: false } }));
    await vi.waitFor(
      async () => {
        expect((await flags.evaluate({})).providers['provider-c']).toBe(false);
      },
      { timeout: 2_000, interval: 25 },
    );
    expect(reloads.filter((r) => r.ok).length).toBeGreaterThanOrEqual(2);
  });

  it('an invalid file keeps the last good configuration', async () => {
    const { path, flags, reloads } = await setup({ 'provider.c.enabled': { value: false } });
    writeFileSync(path, '{ broken json');
    await vi.waitFor(
      () => {
        expect(reloads.some((r) => !r.ok)).toBe(true);
      },
      { timeout: 2_000, interval: 25 },
    );
    expect((await flags.evaluate({})).providers['provider-c']).toBe(false);
  });
});

describe('use case honours the flags', () => {
  const input = { origin: 'GRU', destination: 'GIG', date: '2026-12-12' };
  const providers = () => [
    new FakeProvider('provider-a', {
      kind: 'ok',
      result: () =>
        mapProviderA(loadProviderFixture('a'), query(), DEFAULT_INCENTIVE_BPS['provider-a']),
    }),
    new FakeProvider('provider-c', {
      kind: 'ok',
      result: () =>
        mapProviderC(loadProviderFixture('c'), query(), DEFAULT_INCENTIVE_BPS['provider-c']),
    }),
  ];

  it('cache.enabled=false skips both cache read and write', async () => {
    const get = vi.fn<SearchCache['get']>(() => Promise.resolve(null));
    const set = vi.fn<SearchCache['set']>(() => Promise.resolve());
    await useCase({
      providers: providers(),
      cache: { get, set },
      flags: staticFlags(defaultFlags({ cacheEnabled: false })),
    }).execute(input, { logger: silentLogger });
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('the strategy flag changes the decision (and the cache key), per agency', async () => {
    const byAgency = {
      evaluate: ({ agencyId }: { agencyId?: string }) =>
        Promise.resolve(defaultFlags(agencyId === 'agencia-b' ? { strategy: 'cheapest' } : {})),
    };
    const search = useCase({ providers: providers(), flags: byAgency });
    const balanced = await search.execute(input, { logger: silentLogger, agencyId: 'agencia-a' });
    const cheapest = await search.execute(input, { logger: silentLogger, agencyId: 'agencia-b' });

    expect(balanced.meta.strategy).toBe('balanced');
    expect(cheapest.meta.strategy).toBe('cheapest');
    expect(cheapest.meta.cached).toBe(false); // chave diferente: não reaproveitou a da balanced
    const swapped = (r: typeof balanced) =>
      r.results.filter((x) => x.selection.deltaToCheapestCents > 0).length;
    expect(swapped(balanced)).toBe(25); // sem B: A→C em todos os 25 voos vendidos por A e C
    expect(swapped(cheapest)).toBe(0);
  });

  it('a provider kill switch is not shared through the cache with other agencies', async () => {
    const flags = {
      evaluate: ({ agencyId }: { agencyId?: string }) =>
        Promise.resolve(
          defaultFlags(
            agencyId === 'sem-c'
              ? { providers: { 'provider-a': true, 'provider-b': true, 'provider-c': false } }
              : {},
          ),
        ),
    };
    const search = useCase({ providers: providers(), flags });
    const withC = await search.execute(input, { logger: silentLogger, agencyId: 'normal' });
    const withoutC = await search.execute(input, { logger: silentLogger, agencyId: 'sem-c' });
    expect(withoutC.meta.cached).toBe(false);
    expect(withoutC.meta.providers.find((p) => p.name === 'provider-c')?.status).toBe('disabled');
    expect(withC.results.length).toBeGreaterThan(withoutC.results.length);
  });
});
