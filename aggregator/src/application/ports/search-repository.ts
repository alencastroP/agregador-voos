import type { SearchQuery } from '../../domain/search-query.js';
import type { ProviderReport, SearchResultItem } from '../search-response.js';
import type { StrategyName } from '../../domain/selection/strategy.js';

/** Registro analítico de uma busca (alimenta o dashboard de insights). */
export interface SearchRecord {
  readonly searchId: string;
  readonly query: SearchQuery;
  readonly requestedAt: Date;
  readonly cacheHit: boolean;
  readonly partial: boolean;
  readonly latencyMs: number;
  readonly strategy: StrategyName;
  readonly providers: readonly ProviderReport[];
  readonly results: readonly SearchResultItem[];
}

/** Escrita assíncrona, fora do caminho crítico: falha aqui vira log/métrica, nunca erro ao cliente. */
export interface SearchRepository {
  save(record: SearchRecord): Promise<void>;
}
