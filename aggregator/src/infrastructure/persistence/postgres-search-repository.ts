import type { SearchRecord, SearchRepository } from '../../application/ports/search-repository.js';
import type { Database } from './database.js';
import { providerCalls, searches, selectedOffers } from './schema.js';

export class PersistenceOverloadedError extends Error {
  constructor(readonly inFlight: number) {
    super(`persistence overloaded: ${inFlight} writes in flight, dropping record`);
    this.name = 'PersistenceOverloadedError';
  }
}

/**
 * Grava a busca em UMA transação (searches + provider_calls + selected_offers): ou entra tudo,
 * ou nada; o dashboard nunca vê busca sem ofertas.
 *
 * Backpressure: a escrita é fire-and-forget. Se o banco ficar lento, as promises se acumulam em
 * memória. Acima de `maxInFlight` o registro é DESCARTADO na hora (erro → log + métrica), em vez
 * de arriscar a memória do processo. Perder dado analítico é aceitável; derrubar a busca, não.
 * Evolução: outbox/fila (SQS, Kafka) para não perder nada.
 */
export class PostgresSearchRepository implements SearchRepository {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly maxInFlight = 200,
  ) {}

  get pendingWrites(): number {
    return this.inFlight.size;
  }

  save(record: SearchRecord): Promise<void> {
    if (this.inFlight.size >= this.maxInFlight) {
      return Promise.reject(new PersistenceOverloadedError(this.inFlight.size));
    }
    const write = this.write(record).finally(() => {
      this.inFlight.delete(write);
    });
    this.inFlight.add(write);
    return write;
  }

  /** Graceful shutdown: espera as escritas em curso, com teto (não segura o deploy para sempre). */
  async drain(timeoutMs: number): Promise<void> {
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  private async write(record: SearchRecord): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(searches).values({
        id: record.searchId,
        origin: record.query.origin,
        destination: record.query.destination,
        travelDate: record.query.date,
        requestedAt: record.requestedAt,
        cacheHit: record.cacheHit,
        partial: record.partial,
        latencyMs: record.latencyMs,
        resultsCount: record.results.length,
        strategy: record.strategy,
      });
      if (record.cacheHit) return; // ver schema.ts: cache hit não repete chamadas nem ofertas

      if (record.providers.length > 0) {
        await tx.insert(providerCalls).values(
          record.providers.map((p) => ({
            searchId: record.searchId,
            provider: p.name,
            status: p.status,
            latencyMs: p.latencyMs,
            offersCount: p.offersCount,
            discardedCount: p.discardedCount,
            attempts: p.attempts,
            errorCode: p.errorCode ?? null,
          })),
        );
      }
      if (record.results.length > 0) {
        await tx.insert(selectedOffers).values(
          record.results.map((r) => ({
            searchId: record.searchId,
            flightKey: r.flightKey,
            airline: r.airline.code,
            departureAt: r.departureAt,
            chosenProvider: r.provider,
            chosenPriceCents: r.price.amountCents,
            cheapestPriceCents: r.selection.cheapestPriceCents,
            cheapestProvider: r.selection.cheapestProvider,
            incentiveCents: r.incentiveAmountCents,
            incentiveGainVsCheapestCents: r.selection.incentiveGainVsCheapestCents,
            customerDeltaCents: r.selection.deltaToCheapestCents,
            alternativesCount: r.selection.alternativesCount,
            strategy: r.selection.strategy,
          })),
        );
      }
    });
  }
}
