import { join } from 'node:path';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseOptions {
  readonly url: string;
  readonly poolMax: number;
}

/**
 * Pool configurado para FALHAR RÁPIDO (mesma filosofia do Redis): persistência analítica nunca
 * pode segurar a busca. Conexão em 2 s, statement em 5 s, e um teto baixo de conexões (a
 * escrita é assíncrona; não precisamos de paralelismo alto, e protegemos o banco).
 */
export function createDatabase({ url, poolMax }: DatabaseOptions): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: url,
    max: poolMax,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
  });
  return { db: drizzle(pool, { schema }), pool };
}

/** Pasta das migrations geradas pelo drizzle-kit (aggregator/drizzle), resolvida a partir do build. */
export const MIGRATIONS_FOLDER = join(import.meta.dirname, '..', '..', '..', 'drizzle');

/**
 * Aplica as migrations pendentes. O migrator do Drizzle registra o que já rodou em
 * `drizzle.__drizzle_migrations` e aplica tudo numa transação. Rodar no boot é aceitável aqui
 * (1 réplica, schema aditivo); em produção com N réplicas, vira um job de deploy separado.
 */
export async function runMigrations(db: Database, folder = MIGRATIONS_FOLDER): Promise<void> {
  await migrate(db, { migrationsFolder: folder });
}
