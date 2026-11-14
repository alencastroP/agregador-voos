import type {
  FlightProvider,
  ProviderSearchResult,
} from '../../application/ports/flight-provider.js';
import {
  ProviderContractError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../../domain/errors.js';
import type { BasisPoints } from '../../domain/money.js';
import type { ProviderId } from '../../domain/provider.js';
import type { SearchQuery } from '../../domain/search-query.js';
import type { ProviderMapper } from './mappers/map-items.js';

export interface HttpFlightProviderOptions {
  readonly id: ProviderId;
  readonly url: string;
  readonly mapper: ProviderMapper;
  readonly incentiveRateBps: BasisPoints;
  /** Injetável para teste; em produção é o fetch nativo (undici). */
  readonly fetch?: typeof fetch;
}

/** 5xx, 429 (rate limit) e 408 tendem a passar sozinhos: valem retry. 4xx de validação, não. */
export function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/**
 * Adapter HTTP de um provider. Faz POST {origin, destination, date} e entrega o JSON ao
 * mapper. O `signal` vai direto para o fetch: quando o deadline estoura, o undici aborta o
 * socket de verdade (não fica uma requisição zumbi pendurada 30 s no provider lento).
 */
export class HttpFlightProvider implements FlightProvider {
  readonly id: ProviderId;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: HttpFlightProviderOptions) {
    this.id = options.id;
    this.fetchFn = options.fetch ?? fetch;
  }

  async search(query: SearchQuery, signal: AbortSignal): Promise<ProviderSearchResult> {
    const { id, url } = this.options;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          origin: query.origin,
          destination: query.destination,
          date: query.date,
        }),
        signal,
      });
    } catch (error) {
      throw this.networkError(error, signal);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined); // libera o socket
      throw new ProviderUnavailableError(
        id,
        `HTTP ${response.status}`,
        isTransientStatus(response.status),
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (signal.aborted) throw this.networkError(error, signal);
      throw new ProviderContractError(id, 'response is not valid JSON', { cause: error });
    }
    return this.options.mapper(payload, query, this.options.incentiveRateBps);
  }

  private networkError(error: unknown, signal: AbortSignal): Error {
    if (signal.aborted) {
      return new ProviderTimeoutError(this.id, 'request aborted by deadline', {
        cause: signal.reason,
      });
    }
    // DNS, conexão recusada, reset: falhas de rede são transitórias.
    return new ProviderUnavailableError(this.id, 'network error', true, undefined, {
      cause: error,
    });
  }
}
