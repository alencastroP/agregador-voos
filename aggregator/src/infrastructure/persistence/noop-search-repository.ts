import type { SearchRepository } from '../../application/ports/search-repository.js';

/** Persistência desligada (sem DATABASE_URL). O Postgres entra na fase de insights. */
export class NoopSearchRepository implements SearchRepository {
  save(): Promise<void> {
    return Promise.resolve();
  }
}
