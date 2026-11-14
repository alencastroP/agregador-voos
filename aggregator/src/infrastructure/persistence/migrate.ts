/**
 * `npm run db:migrate`: aplica as migrations e sai. Em produção com várias réplicas este é o
 * caminho certo (um job de deploy), em vez de cada réplica migrar no boot.
 */
import { createDatabase, runMigrations } from './database.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL não definida');
  process.exit(1);
}
const { db, pool } = createDatabase({ url, poolMax: 1 });
try {
  await runMigrations(db);
  console.log('migrations aplicadas');
} finally {
  await pool.end();
}
