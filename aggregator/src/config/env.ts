import { z } from 'zod';
import { STRATEGY_NAMES, type StrategyName } from '../domain/selection/strategy.js';

/**
 * Configuração validada no boot. Se faltar algo obrigatório o processo NÃO sobe:
 * melhor falhar no deploy do que descobrir em produção que a URL do provider-b é undefined.
 * Todas as URLs vêm daqui (dentro do compose: http://provider-a:3000/..., fora: localhost:3001).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  PROVIDER_A_URL: z.url(),
  PROVIDER_B_URL: z.url(),
  PROVIDER_C_URL: z.url(),
  /** Orçamento total por provider (todas as tentativas somadas). Requisito: 3s. */
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),

  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(300),
  PARTIAL_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(30),
  /** Sem REDIS_URL o serviço sobe com cache em memória (dev) e avisa no log. */
  REDIS_URL: z.url().optional(),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(200),

  /** Fuso que define "hoje" na validação de data passada. */
  BUSINESS_TIMEZONE: z.string().default('America/Sao_Paulo'),
  SEARCH_MAX_DAYS_AHEAD: z.coerce.number().int().positive().default(365),

  // Defaults da estratégia (feature flags podem sobrescrever em runtime).
  SELECTION_STRATEGY: z.enum(STRATEGY_NAMES).default('balanced'),
  SELECTION_TOLERANCE_BPS: z.coerce.number().int().nonnegative().default(150),
  SELECTION_MAX_DELTA_CENTS: z.coerce.number().int().nonnegative().default(2500),
  SELECTION_MIN_GAIN_RATIO: z.coerce.number().nonnegative().default(0),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly http: { readonly host: string; readonly port: number };
  readonly logLevel: Env['LOG_LEVEL'];
  readonly providers: {
    readonly timeoutMs: number;
    readonly urls: { readonly a: string; readonly b: string; readonly c: string };
  };
  readonly cache: {
    readonly ttlSeconds: number;
    readonly partialTtlSeconds: number;
    readonly redisUrl: string | undefined;
    readonly redisCommandTimeoutMs: number;
  };
  readonly search: { readonly timezone: string; readonly maxDaysAhead: number };
  readonly selection: {
    readonly strategy: StrategyName;
    readonly tolerancePctBps: number;
    readonly maxDeltaCents: number;
    readonly minGainRatio: number;
  };
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Configuração inválida:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  if (!isValidTimezone(e.BUSINESS_TIMEZONE)) {
    throw new ConfigError([`BUSINESS_TIMEZONE: fuso IANA inválido "${e.BUSINESS_TIMEZONE}"`]);
  }
  return Object.freeze({
    env: e.NODE_ENV,
    http: { host: e.HOST, port: e.PORT },
    logLevel: e.LOG_LEVEL,
    providers: {
      timeoutMs: e.PROVIDER_TIMEOUT_MS,
      urls: { a: e.PROVIDER_A_URL, b: e.PROVIDER_B_URL, c: e.PROVIDER_C_URL },
    },
    cache: {
      ttlSeconds: e.CACHE_TTL_SECONDS,
      partialTtlSeconds: e.PARTIAL_CACHE_TTL_SECONDS,
      redisUrl: e.REDIS_URL,
      redisCommandTimeoutMs: e.REDIS_COMMAND_TIMEOUT_MS,
    },
    search: { timezone: e.BUSINESS_TIMEZONE, maxDaysAhead: e.SEARCH_MAX_DAYS_AHEAD },
    selection: {
      strategy: e.SELECTION_STRATEGY,
      tolerancePctBps: e.SELECTION_TOLERANCE_BPS,
      maxDeltaCents: e.SELECTION_MAX_DELTA_CENTS,
      minGainRatio: e.SELECTION_MIN_GAIN_RATIO,
    },
  });
}
