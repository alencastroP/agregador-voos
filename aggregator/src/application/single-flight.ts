/**
 * Single-flight (coalescing): enquanto uma busca para a chave K está em andamento, outras
 * buscas para K esperam a MESMA promise em vez de disparar novas chamadas aos providers.
 *
 * Protege contra cache stampede: no instante em que a entrada expira (ou na primeira busca de
 * uma rota quente), 50 agentes pedindo GRU→GIG viram 1 ida aos providers, não 150.
 *
 * Escopo: por processo. Com N réplicas, o pior caso são N chamadas por chave, o que é aceitável.
 * Evolução: lock distribuído no Redis (SET NX PX) + espera pelo resultado no cache.
 */
export class SingleFlight<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  /** `leader` é true para quem de fato executou o trabalho (útil para log/métrica). */
  async run(key: string, work: () => Promise<T>): Promise<{ value: T; leader: boolean }> {
    const existing = this.inflight.get(key);
    if (existing) return { value: await existing, leader: false };

    const promise = work().finally(() => {
      this.inflight.delete(key); // sucesso OU erro: a próxima busca tenta de novo
    });
    this.inflight.set(key, promise);
    return { value: await promise, leader: true };
  }

  get size(): number {
    return this.inflight.size;
  }
}
