import { describe, expect, it } from 'vitest';
import {
  ProviderContractError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../../../src/domain/errors.js';
import {
  isRetryable,
  RetryingFlightProvider,
  type RetryPolicy,
} from '../../../src/infrastructure/resilience/retry.js';
import { query } from '../../helpers/fixtures.js';
import { ScriptedProvider, type Step } from '../../helpers/scripted-provider.js';

// Escala reduzida (÷10) da política real: tentativa 100 ms, orçamento 300 ms.
const policy: RetryPolicy = {
  maxAttempts: 3,
  attemptTimeoutMs: 100,
  budgetMs: 300,
  baseDelayMs: 10,
  maxDelayMs: 25,
  minAttemptMs: 50,
};

function setup(steps: Step[], overrides: Partial<RetryPolicy> = {}) {
  const inner = new ScriptedProvider(steps);
  const retrying = new RetryingFlightProvider(
    inner,
    { ...policy, ...overrides },
    { random: () => 0.5 },
  );
  const run = async () => {
    const started = performance.now();
    const outcome = await retrying
      .search(query(), AbortSignal.timeout(overrides.budgetMs ?? policy.budgetMs))
      .then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
    return { ...outcome, elapsed: performance.now() - started };
  };
  return { inner, retrying, run };
}

describe('RetryingFlightProvider', () => {
  it('retries a transient 500 and succeeds (attempts = 2)', async () => {
    const { inner, run } = setup(['e500', 'ok']);
    const { result } = await run();
    expect(result?.attempts).toBe(2);
    expect(inner.calls).toBe(2);
  });

  it.each([
    ['e400', ProviderUnavailableError],
    ['contract', ProviderContractError],
  ] as const)('never retries a permanent error (%s)', async (step, type) => {
    const { inner, run } = setup([step, 'ok']);
    const { error } = await run();
    expect(error).toBeInstanceOf(type);
    expect(inner.calls).toBe(1);
    expect(error).toMatchObject({ attempts: 1 });
  });

  it('abandons a HUNG attempt at the per-attempt timeout and retries inside the budget', async () => {
    const { inner, run } = setup(['hang', 'ok']);
    const { result, elapsed } = await run();
    expect(result?.attempts).toBe(2);
    expect(inner.calls).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(95); // esperou a 1ª tentativa estourar (100 ms)
    expect(elapsed).toBeLessThan(250); // e não o orçamento inteiro (300 ms)
    expect(inner.signals[0]?.aborted).toBe(true); // a tentativa pendurada foi cancelada
  });

  it('gives up after maxAttempts and reports how many were made', async () => {
    const { inner, run } = setup(['e500']);
    const { error } = await run();
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).toMatchObject({ attempts: 3 });
    expect(inner.calls).toBe(3);
  });

  it('respects the SHARED budget: always-hung provider stops by ~300 ms, not 3 × 100 + backoff', async () => {
    const { inner, run } = setup(['hang'], { maxAttempts: 10 });
    const { error, elapsed } = await run();
    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect(elapsed).toBeLessThan(380);
    expect(inner.calls).toBeLessThanOrEqual(3); // 100 + 100 + ~85 cabem; a 4ª não começa
  });

  it('does not start an attempt that has no time to finish (minAttemptMs)', async () => {
    const { inner, run } = setup(['e500'], { budgetMs: 120, minAttemptMs: 115, maxAttempts: 5 });
    const { error } = await run();
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(inner.calls).toBe(1);
  });

  it('when the caller deadline fires mid-attempt, reports a budget timeout', async () => {
    const { run } = setup(['hang'], { attemptTimeoutMs: 1_000, budgetMs: 80 });
    const { error, elapsed } = await run();
    expect(error).toBeInstanceOf(ProviderTimeoutError);
    // A mensagem varia (o timeout da tentativa, 79 ms após o floor, pode vencer o deadline
    // por 1 ms); o que importa: é timeout e respeitou o orçamento.
    expect(elapsed).toBeLessThan(500); // longe dos 1.000 ms da tentativa: o deadline mandou
  });
});

describe('backoff (exponential + full jitter)', () => {
  const at = (random: number) =>
    new RetryingFlightProvider(
      new ScriptedProvider(['ok']),
      { ...policy, baseDelayMs: 50, maxDelayMs: 250 },
      { random: () => random },
    );

  it('grows exponentially and is capped', () => {
    const almostOne = at(0.9999);
    expect([1, 2, 3, 4, 5].map((n) => almostOne.backoff(n))).toEqual([49, 99, 199, 249, 249]);
  });

  it('is fully jittered down to zero (spreads synchronized retries)', () => {
    expect(at(0).backoff(3)).toBe(0);
    expect(at(0.5).backoff(3)).toBe(100);
  });
});

describe('isRetryable', () => {
  it.each([
    [new ProviderUnavailableError('provider-a', '500', true, 500), true],
    [new ProviderUnavailableError('provider-a', 'net', true), true],
    [new ProviderTimeoutError('provider-a', 'attempt'), true],
    [new ProviderUnavailableError('provider-a', '400', false, 400), false],
    [new ProviderContractError('provider-a', 'bad'), false],
    [new TypeError('bug'), false],
  ])('%s → %s', (error, expected) => {
    expect(isRetryable(error)).toBe(expected);
  });
});
