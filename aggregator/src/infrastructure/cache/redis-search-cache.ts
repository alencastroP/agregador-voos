import { Redis } from 'ioredis';
import type { SearchCache } from '../../application/ports/search-cache.js';
import type { SearchSnapshot } from '../../application/search-response.js';

export interface RedisCacheOptions {
  readonly url: string;
  /** Teto por comando. Cache lento não pode virar latência da busca: estourou, é miss. */
  readonly commandTimeoutMs: number;
}

/**
 * Cliente configurado para FALHAR RÁPIDO quando o Redis está fora:
 *  - enableOfflineQueue: false → sem conexão, o comando rejeita na hora (o default enfileira
 *    para sempre e a busca ficaria pendurada esperando o Redis voltar);
 *  - maxRetriesPerRequest: 0  → não reenvia o comando; o use case trata como miss;
 *  - commandTimeout           → Redis lento também vira miss;
 *  - retryStrategy            → a CONEXÃO segue tentando voltar em background (backoff até 2 s).
 */
export function createRedisClient({ url, commandTimeoutMs }: RedisCacheOptions): Redis {
  return new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: commandTimeoutMs,
    connectTimeout: 2_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    lazyConnect: false,
  });
}

/**
 * Espera a conexão ficar pronta (até `timeoutMs`). Sem fila offline, comandos enviados antes do
 * 'ready' falham na hora, então o boot espera um pouco, mas NUNCA bloqueia: se o Redis não vier,
 * o serviço sobe degradado (sem cache) e o cliente segue reconectando em background.
 */
export function waitForRedis(redis: Redis, timeoutMs: number): Promise<boolean> {
  if (redis.status === 'ready') return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      redis.off('ready', onReady);
      resolve(false);
    }, timeoutMs);
    const onReady = () => {
      clearTimeout(timer);
      resolve(true);
    };
    redis.once('ready', onReady);
  });
}

/**
 * Cache da resposta final em Redis: chave → JSON, com TTL nativo (SET ... EX).
 * Erros sobem; quem decide degradar para "sem cache" é o use case (política fica na aplicação).
 */
export class RedisSearchCache implements SearchCache {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<SearchSnapshot | null> {
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as SearchSnapshot;
    } catch {
      // Entrada corrompida (deploy com formato novo sem trocar o `v1` da chave?): trata como miss.
      await this.redis.del(key).catch(() => undefined);
      return null;
    }
  }

  async set(key: string, value: SearchSnapshot, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }
}
