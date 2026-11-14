import type {
  FlightProvider,
  ProviderSearchResult,
} from '../../application/ports/flight-provider.js';
import {
  ProviderError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../../domain/errors.js';
import type { ProviderId } from '../../domain/provider.js';
import type { SearchQuery } from '../../domain/search-query.js';

export interface RetryPolicy {
  /** Máximo de tentativas (1 = sem retry). */
  readonly maxAttempts: number;
  /** Teto de CADA tentativa. Menor que o orçamento: abandona chamada pendurada e tenta de novo. */
  readonly attemptTimeoutMs: number;
  /** Orçamento TOTAL compartilhado por todas as tentativas (requisito: 3 s). */
  readonly budgetMs: number;
  /** Backoff exponencial com full jitter: espera ∈ [0, min(maxDelay, base·2^(n−1))]. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Não começa uma tentativa que não teria tempo de terminar (latência normal ≈ 100–450 ms). */
  readonly minAttemptMs: number;
}

export interface RetryDeps {
  readonly random?: () => number;
  readonly now?: () => number;
}

/**
 * Só vale retry o que tende a passar sozinho: 5xx/429/rede (transient) e tentativa que estourou
 * o PRÓPRIO timeout. 4xx de validação e payload fora do contrato falhariam igual de novo.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderUnavailableError) return error.transient;
  return error instanceof ProviderTimeoutError;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Decorator de retry. O `deadline` recebido do use case é o orçamento total (3 s); cada
 * tentativa ganha um sinal próprio = deadline ∧ timeout(min(attemptTimeout, tempo restante)).
 *
 * Por que timeout por tentativa: o mock pendura 30 s em ~30% das chamadas e responde em
 * ≤ 450 ms no resto. Com tentativas de 1 s cabem 3 dentro de 3 s; uma tentativa única de 3 s
 * gastaria o orçamento inteiro esperando uma resposta que nunca vem.
 */
export class RetryingFlightProvider implements FlightProvider {
  readonly id: ProviderId;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(
    private readonly inner: FlightProvider,
    private readonly policy: RetryPolicy,
    deps: RetryDeps = {},
  ) {
    this.id = inner.id;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? (() => performance.now());
  }

  async search(query: SearchQuery, deadline: AbortSignal): Promise<ProviderSearchResult> {
    const { maxAttempts, attemptTimeoutMs, budgetMs, minAttemptMs } = this.policy;
    const started = this.now();
    const remaining = () => budgetMs - (this.now() - started);
    // Função (e não `deadline.aborted` direto): o valor muda durante os awaits.
    const expired = () => deadline.aborted;

    for (let attempt = 1; ; attempt++) {
      const attemptSignal = AbortSignal.any([
        deadline,
        // AbortSignal.timeout exige INTEIRO; remaining() é fracionário (performance.now).
        AbortSignal.timeout(Math.max(1, Math.floor(Math.min(attemptTimeoutMs, remaining())))),
      ]);
      try {
        const result = await this.inner.search(query, attemptSignal);
        return { ...result, attempts: attempt };
      } catch (error) {
        if (expired()) {
          throw withAttempts(
            new ProviderTimeoutError(this.id, `budget of ${budgetMs}ms exhausted`, {
              cause: error,
            }),
            attempt,
          );
        }
        if (!isRetryable(error) || attempt >= maxAttempts) throw withAttempts(error, attempt);

        const delay = this.backoff(attempt);
        if (remaining() - delay < minAttemptMs) throw withAttempts(error, attempt);
        await abortableSleep(delay, deadline);
        if (expired()) {
          throw withAttempts(
            new ProviderTimeoutError(this.id, `budget of ${budgetMs}ms exhausted`, {
              cause: error,
            }),
            attempt,
          );
        }
      }
    }
  }

  /** Full jitter (AWS Architecture Blog): espalha os retries e evita "manada" sincronizada. */
  backoff(attempt: number): number {
    const cap = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** (attempt - 1));
    return Math.floor(this.random() * cap);
  }
}

function withAttempts(error: unknown, attempts: number): unknown {
  if (error instanceof ProviderError) error.attempts = attempts;
  return error;
}
