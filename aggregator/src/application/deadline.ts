import { ProviderTimeoutError } from '../domain/errors.js';

/**
 * Garante o orçamento de tempo MESMO que o adapter ignore o AbortSignal (bulkhead).
 * O sinal também vai para o fetch, que cancela o socket de verdade. Esta corrida é a
 * segunda linha de defesa: o use case nunca espera além do deadline por um provider.
 */
export function withDeadline<T>(
  work: Promise<T>,
  signal: AbortSignal,
  provider: string,
  budgetMs: number,
): Promise<T> {
  const timeoutError = () =>
    new ProviderTimeoutError(provider, `deadline of ${budgetMs}ms exceeded`, {
      cause: signal.reason,
    });
  if (signal.aborted) return Promise.reject(timeoutError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(timeoutError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
