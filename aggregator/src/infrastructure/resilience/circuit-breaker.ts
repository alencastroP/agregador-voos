import type { Clock } from '../../application/ports/clock.js';
import type {
  FlightProvider,
  ProviderSearchResult,
} from '../../application/ports/flight-provider.js';
import {
  CircuitOpenError,
  ProviderContractError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../../domain/errors.js';
import type { ProviderId } from '../../domain/provider.js';
import type { SearchQuery } from '../../domain/search-query.js';

export const CIRCUIT_STATES = ['closed', 'open', 'half_open'] as const;
export type CircuitState = (typeof CIRCUIT_STATES)[number];

export interface CircuitBreakerPolicy {
  /** Janela deslizante: últimas N chamadas LÓGICAS (cada uma já com retry). */
  readonly windowSize: number;
  /** Não abre com amostra pequena (2 falhas em 3 chamadas não é um provider fora). */
  readonly minimumCalls: number;
  /** Taxa de falha na janela que abre o circuito (0..1). */
  readonly failureRateThreshold: number;
  /** Quanto tempo fica aberto antes de deixar UMA chamada de teste passar (half-open). */
  readonly openDurationMs: number;
}

/**
 * Circuit breaker com janela por contagem. Máquina de estados:
 *
 *   closed ──(falhas ≥ limiar em ≥ minimumCalls)──► open ──(openDuration)──► half_open
 *     ▲                                                ▲                         │
 *     └──────────────(sonda ok)────────────────────────┼─────────────────────────┤
 *                                                      └──────(sonda falhou)─────┘
 *
 * Implementação própria (~80 linhas) em vez de opossum: o opossum também faz timeout e
 * fallback, o que duplicaria o deadline/retry que já temos, e conta por tentativa. Aqui a
 * semântica (contar CHAMADA LÓGICA) fica explícita e testável com relógio injetado.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private outcomes: boolean[] = []; // true = falha
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    private readonly policy: CircuitBreakerPolicy,
    private readonly clock: Clock,
    private readonly onTransition?: (from: CircuitState, to: CircuitState) => void,
  ) {}

  get currentState(): CircuitState {
    this.refresh();
    return this.state;
  }

  /** Quanto falta para o circuito aberto deixar passar uma sonda. */
  get retryAfterMs(): number {
    return this.state === 'open'
      ? Math.max(0, this.policy.openDurationMs - (this.clock.now().getTime() - this.openedAt))
      : 0;
  }

  /** true = pode chamar o provider. Em half_open só UMA sonda por vez. */
  tryAcquire(): boolean {
    this.refresh();
    if (this.state === 'closed') return true;
    if (this.state === 'open') return false;
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  onSuccess(): void {
    if (this.state === 'half_open') {
      this.probeInFlight = false;
      this.transition('closed');
      this.outcomes = [];
      return;
    }
    this.record(false);
  }

  onFailure(): void {
    if (this.state === 'half_open') {
      this.probeInFlight = false;
      this.open();
      return;
    }
    this.record(true);
    const failures = this.outcomes.filter(Boolean).length;
    if (
      this.outcomes.length >= this.policy.minimumCalls &&
      failures / this.outcomes.length >= this.policy.failureRateThreshold
    ) {
      this.open();
    }
  }

  private record(failed: boolean): void {
    this.outcomes.push(failed);
    if (this.outcomes.length > this.policy.windowSize) this.outcomes.shift();
  }

  private open(): void {
    this.openedAt = this.clock.now().getTime();
    this.outcomes = [];
    this.transition('open');
  }

  private refresh(): void {
    if (
      this.state === 'open' &&
      this.clock.now().getTime() - this.openedAt >= this.policy.openDurationMs
    ) {
      this.transition('half_open');
    }
  }

  private transition(to: CircuitState): void {
    if (to === this.state) return;
    const from = this.state;
    this.state = to;
    this.onTransition?.(from, to);
  }
}

/**
 * O que indica provider DOENTE: timeout, 5xx/429/rede e payload fora do contrato.
 * 4xx não transitório é erro NOSSO (requisição inválida): não deve derrubar o provider.
 */
export function countsAsProviderFailure(error: unknown): boolean {
  if (error instanceof ProviderUnavailableError) return error.transient;
  return error instanceof ProviderTimeoutError || error instanceof ProviderContractError;
}

/** Decorator: circuito aberto = provider pulado na hora, sem gastar latência nem socket. */
export class CircuitBreakerFlightProvider implements FlightProvider {
  readonly id: ProviderId;

  constructor(
    private readonly inner: FlightProvider,
    readonly breaker: CircuitBreaker,
  ) {
    this.id = inner.id;
  }

  async search(query: SearchQuery, signal: AbortSignal): Promise<ProviderSearchResult> {
    if (!this.breaker.tryAcquire()) {
      throw new CircuitOpenError(
        this.id,
        `circuit open, next probe in ${this.breaker.retryAfterMs}ms`,
      );
    }
    try {
      const result = await this.inner.search(query, signal);
      this.breaker.onSuccess();
      return result;
    } catch (error) {
      if (countsAsProviderFailure(error)) this.breaker.onFailure();
      else this.breaker.onSuccess(); // respondeu algo: o provider está vivo
      throw error;
    }
  }
}
