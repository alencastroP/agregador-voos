import type {
  FlightProvider,
  ProviderSearchResult,
} from '../../src/application/ports/flight-provider.js';
import {
  ProviderContractError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../../src/domain/errors.js';
import type { ProviderId } from '../../src/domain/provider.js';

/**
 * Comportamento por chamada, na ordem (a última se repete):
 *   ok | e500 (transitório) | e400 (permanente) | contract | hang (pendura até o AbortSignal)
 */
export type Step = 'ok' | 'e500' | 'e400' | 'contract' | 'hang';

export class ScriptedProvider implements FlightProvider {
  calls = 0;
  readonly signals: AbortSignal[] = [];

  constructor(
    private readonly steps: Step[],
    readonly id: ProviderId = 'provider-c',
  ) {}

  search(_query: unknown, signal: AbortSignal): Promise<ProviderSearchResult> {
    const step = this.steps[Math.min(this.calls, this.steps.length - 1)] ?? 'ok';
    this.calls += 1;
    this.signals.push(signal);
    switch (step) {
      case 'ok':
        return Promise.resolve({
          provider: this.id,
          offers: [],
          discarded: [],
          unknownAirlines: [],
        });
      case 'e500':
        return Promise.reject(new ProviderUnavailableError(this.id, 'HTTP 500', true, 500));
      case 'e400':
        return Promise.reject(new ProviderUnavailableError(this.id, 'HTTP 400', false, 400));
      case 'contract':
        return Promise.reject(new ProviderContractError(this.id, 'bad payload'));
      case 'hang':
        // Igual ao HttpFlightProvider: só "volta" quando o sinal aborta.
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new ProviderTimeoutError(this.id, 'aborted'));
            },
            { once: true },
          );
        });
    }
  }
}
