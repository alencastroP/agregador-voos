import type { Redis } from 'ioredis';
import type { ComponentHealth, HealthIndicator } from '../../application/ports/health.js';
import type { ProviderId } from '../../domain/provider.js';
import type { CircuitBreaker } from '../resilience/circuit-breaker.js';

/** Health check nunca pode pendurar o endpoint de health: cada verificação tem teto. */
export function withTimeout(indicator: HealthIndicator, timeoutMs: number): HealthIndicator {
  return {
    name: indicator.name,
    critical: indicator.critical,
    check: () =>
      Promise.race([
        indicator.check().catch((error: unknown): ComponentHealth => ({
          status: 'down',
          details: { error: error instanceof Error ? error.message : String(error) },
        })),
        new Promise<ComponentHealth>((resolve) =>
          setTimeout(() => {
            resolve({ status: 'down', details: { error: `timeout after ${timeoutMs}ms` } });
          }, timeoutMs).unref(),
        ),
      ]),
  };
}

export function redisIndicator(redis: Redis | undefined): HealthIndicator {
  return {
    name: 'cache',
    critical: false,
    check: async () => {
      if (!redis)
        return { status: 'degraded', details: { mode: 'in-memory', reason: 'REDIS_URL not set' } };
      const started = performance.now();
      await redis.ping();
      return {
        status: 'up',
        details: { mode: 'redis', latencyMs: Math.round(performance.now() - started) },
      };
    },
  };
}

/** Estado dos circuitos: informativo. Um provider fora deixa a busca parcial, não indisponível. */
export function providersIndicator(
  breakers: ReadonlyMap<ProviderId, CircuitBreaker>,
): HealthIndicator {
  return {
    name: 'providers',
    critical: false,
    check: () => {
      const circuits = Object.fromEntries(
        [...breakers].map(([id, breaker]) => [id, breaker.currentState]),
      );
      const states = Object.values(circuits);
      const status = states.every((s) => s === 'open')
        ? 'down'
        : states.some((s) => s !== 'closed')
          ? 'degraded'
          : 'up';
      return Promise.resolve({ status, details: { circuits } });
    },
  };
}

/** Postgres: informativo (persistência é fire-and-forget; o banco fora não impede a busca). */
export function postgresIndicator(
  ping: (() => Promise<unknown>) | undefined,
  pendingWrites: () => number,
): HealthIndicator {
  return {
    name: 'database',
    critical: false,
    check: async () => {
      if (!ping) {
        return {
          status: 'degraded',
          details: { mode: 'disabled', reason: 'DATABASE_URL not set' },
        };
      }
      const started = performance.now();
      await ping();
      return {
        status: 'up',
        details: {
          latencyMs: Math.round(performance.now() - started),
          pendingWrites: pendingWrites(),
        },
      };
    },
  };
}
