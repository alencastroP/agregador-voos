import type { SearchSnapshot } from '../search-response.js';

/**
 * Cache da resposta final (pós-estratégia). Implementações podem falhar (Redis fora do ar):
 * o use case trata erro de cache como "sem cache" e segue, nunca derruba a busca.
 */
export interface SearchCache {
  get(key: string): Promise<SearchSnapshot | null>;
  set(key: string, value: SearchSnapshot, ttlSeconds: number): Promise<void>;
}
