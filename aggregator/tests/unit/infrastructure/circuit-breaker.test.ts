import { describe, expect, it } from 'vitest';
import { CircuitOpenError } from '../../../src/domain/errors.js';
import {
  CircuitBreaker,
  CircuitBreakerFlightProvider,
  type CircuitBreakerPolicy,
  type CircuitState,
} from '../../../src/infrastructure/resilience/circuit-breaker.js';
import { FakeClock } from '../../helpers/app.js';
import { query } from '../../helpers/fixtures.js';
import { ScriptedProvider, type Step } from '../../helpers/scripted-provider.js';

const policy: CircuitBreakerPolicy = {
  windowSize: 10,
  minimumCalls: 5,
  failureRateThreshold: 0.5,
  openDurationMs: 1_000,
};

function setup(steps: Step[], overrides: Partial<CircuitBreakerPolicy> = {}) {
  const clock = new FakeClock();
  const transitions: string[] = [];
  const breaker = new CircuitBreaker({ ...policy, ...overrides }, clock, (from, to) =>
    transitions.push(`${from}→${to}`),
  );
  const inner = new ScriptedProvider(steps);
  const provider = new CircuitBreakerFlightProvider(inner, breaker);
  const call = () =>
    provider.search(query(), AbortSignal.timeout(1_000)).then(
      () => 'ok',
      (e: unknown) => e,
    );
  const callN = async (n: number) => {
    for (let i = 0; i < n; i++) await call();
  };
  return { clock, breaker, inner, call, callN, transitions };
}

describe('CircuitBreaker', () => {
  it('does not open on a small sample, even at 100% failures (minimumCalls)', async () => {
    const { breaker, callN } = setup(['e500']);
    await callN(4);
    expect(breaker.currentState).toBe('closed');
  });

  it('opens when the failure rate reaches the threshold and then skips the provider instantly', async () => {
    const { breaker, inner, call, callN } = setup(['e500']);
    await callN(5);
    expect(breaker.currentState).toBe('open');

    const callsBefore = inner.calls;
    const error = await call();
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect(inner.calls).toBe(callsBefore); // nem tocou no provider
  });

  it('half-open lets exactly ONE probe through; success closes the circuit', async () => {
    const steps: Step[] = ['e500', 'e500', 'e500', 'e500', 'e500', 'ok'];
    const { clock, breaker, inner, call, callN, transitions } = setup(steps);
    await callN(5);
    clock.advance(1_000);
    expect(breaker.currentState).toBe('half_open');

    // duas chamadas "simultâneas": só uma vira sonda
    const [probe, concurrent] = await Promise.all([call(), call()]);
    expect(probe).toBe('ok');
    expect(concurrent).toBeInstanceOf(CircuitOpenError);
    expect(inner.calls).toBe(6);
    expect(breaker.currentState).toBe('closed');
    expect(transitions).toEqual(['closed→open', 'open→half_open', 'half_open→closed']);
  });

  it('a failed probe re-opens the circuit for another full period', async () => {
    const { clock, breaker, call, callN } = setup(['e500']);
    await callN(5);
    clock.advance(1_000);
    await call(); // sonda falha
    expect(breaker.currentState).toBe('open');
    clock.advance(999);
    expect(breaker.currentState).toBe('open');
    expect(breaker.retryAfterMs).toBe(1);
    clock.advance(1);
    expect(breaker.currentState).toBe('half_open');
  });

  it('client errors (4xx) do not count against the provider; timeouts and bad payloads do', async () => {
    const fourxx = setup(['e400']);
    await fourxx.callN(10);
    expect(fourxx.breaker.currentState).toBe('closed');

    const timeouts = setup(['contract']);
    await timeouts.callN(5);
    expect(timeouts.breaker.currentState).toBe('open');
  });

  it('old failures slide out of the window', async () => {
    // 4 falhas e depois só sucesso: a janela de 10 esquece as falhas
    const { breaker, callN } = setup(['e500', 'e500', 'e500', 'e500', 'ok']);
    await callN(20);
    expect(breaker.currentState).toBe('closed');
  });
});

describe('calibration: count LOGICAL calls, not attempts (real numbers, real policy)', () => {
  const realPolicy: CircuitBreakerPolicy = {
    windowSize: 20,
    minimumCalls: 10,
    failureRateThreshold: 0.5,
    openDurationMs: 10_000,
  };

  /** Padrão determinístico com uma taxa de falha `rate`, para 400 chamadas. */
  function run(rate: number): CircuitState[] {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker(realPolicy, clock);
    const seen = new Set<CircuitState>();
    let acc = 0;
    for (let i = 0; i < 400; i++) {
      if (!breaker.tryAcquire()) {
        seen.add('open');
        clock.advance(100);
        continue;
      }
      acc += rate;
      if (acc >= 1) {
        acc -= 1;
        breaker.onFailure();
      } else {
        breaker.onSuccess();
      }
      seen.add(breaker.currentState);
      clock.advance(100);
    }
    return [...seen];
  }

  it('chaos AFTER retry (~13% of logical calls fail) never opens the circuit', () => {
    expect(run(0.13)).toEqual(['closed']);
  });

  it('chaos PER ATTEMPT (~51% fail) would keep opening it: that is why we count logical calls', () => {
    expect(run(0.51)).toContain('open');
  });

  it('a dead provider (100%) opens after minimumCalls', () => {
    expect(run(1)).toContain('open');
  });
});
