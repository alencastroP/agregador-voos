/**
 * Composition root: o ÚNICO lugar que conhece as implementações concretas.
 * Injeção de dependência manual, sem container/decorators: dá para ler o grafo de cima a baixo.
 */
import { ConfigError, loadConfig } from './config/env.js';
import { buildApp } from './interfaces/http/app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildApp({ config });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close(); // para de aceitar conexões e drena as em andamento
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.http.host, port: config.http.port });
}

main().catch((error: unknown) => {
  // Logger do Fastify pode nem existir ainda (ex.: config inválida), então stderr direto.
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
