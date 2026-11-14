import type { Clock } from '../../application/ports/clock.js';
import type { SearchCache } from '../../application/ports/search-cache.js';
import type { SearchSnapshot } from '../../application/search-response.js';

/**
 * Cache em memória com TTL e limite de entradas. Uso: desenvolvimento local sem Redis e
 * testes. NÃO serve para produção com várias réplicas (cada uma teria o seu cache).
 */
export class InMemorySearchCache implements SearchCache {
  private readonly entries = new Map<string, { value: SearchSnapshot; expiresAt: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly maxEntries = 1_000,
  ) {}

  get(key: string): Promise<SearchSnapshot | null> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt <= this.clock.now().getTime()) {
      this.entries.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }

  set(key: string, value: SearchSnapshot, ttlSeconds: number): Promise<void> {
    this.entries.delete(key); // reinserir move para o fim (ordem de inserção = idade)
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.clock.now().getTime() + ttlSeconds * 1_000 });
    return Promise.resolve();
  }
}
