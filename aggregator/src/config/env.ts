import { z } from 'zod';
import { STRATEGY_NAMES, type StrategyName } from '../domain/selection/strategy.js';

/**
 * Configuração validada no boot. Se faltar algo obrigatório o processo NÃO sobe:
 * melhor falhar no deploy do que descobrir em produção que a URL do provider-b é undefined.
 * Todas as URLs vêm daqui (dentro do compose: http://provider-a:3000/..., fora: localhost:3001).
 */
/** Variável vazia ("") conta como não definida: o compose passa `${VAR:-}` para opcionais. */
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.url().optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_VERSION: z.string().default('0.1.0'),
  /** Readiness cai, espera este tempo (o LB tira a instância) e só então fecha o servidor. */
  SHUTDOWN_GRACE_MS: z.coerce.number().int().nonnegative().default(0),

  /** OTLP/HTTP (Jaeger: http://jaeger:4318). Sem endpoint, tracing desligado. */
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  OTEL_SERVICE_NAME: z.string().default('flight-aggregator'),

  PROVIDER_A_URL: z.url(),
  PROVIDER_B_URL: z.url(),
  PROVIDER_C_URL: z.url(),
  /** Orçamento total por provider (todas as tentativas somadas). Requisito: 3s. */
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),

  // Retry (dentro do orçamento acima). Latência normal dos mocks ≤ ~480 ms; pendurado = 30 s.
  PROVIDER_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(1000),
  PROVIDER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().nonnegative().default(50),
  RETRY_MAX_DELAY_MS: z.coerce.number().int().nonnegative().default(250),
  RETRY_MIN_ATTEMPT_MS: z.coerce.number().int().nonnegative().default(500),

  // Circuit breaker por provider, contando CHAMADAS LÓGICAS (já com retry).
  CB_WINDOW_SIZE: z.coerce.number().int().positive().default(20),
  CB_MINIMUM_CALLS: z.coerce.number().int().positive().default(10),
  CB_FAILURE_RATE: z.coerce.number().gt(0).max(1).default(0.5),
  CB_OPEN_DURATION_MS: z.coerce.number().int().positive().default(10_000),

  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(300),
  PARTIAL_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(30),
  /** Sem REDIS_URL o serviço sobe com cache em memória (dev) e avisa no log. */
  REDIS_URL: optionalUrl,
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(200),

  /** Persistência analítica. Sem DATABASE_URL a busca funciona, só não grava insights. */
  DATABASE_URL: optionalUrl,
  DB_POOL_MAX: z.coerce.number().int().positive().default(5),
  DB_MIGRATE_ON_BOOT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  DB_MAX_IN_FLIGHT_WRITES: z.coerce.number().int().positive().default(200),

  /** Fuso que define "hoje" na validação de data passada. */
  BUSINESS_TIMEZONE: z.string().default('America/Sao_Paulo'),
  SEARCH_MAX_DAYS_AHEAD: z.coerce.number().int().positive().default(365),

  /** Arquivo de feature flags (OpenFeature). Sem ele, valem os defaults abaixo (estáticos). */
  FLAGS_FILE: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  FLAGS_POLL_MS: z.coerce.number().int().positive().default(2000),

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
  readonly version: string;
  readonly shutdownGraceMs: number;
  readonly telemetry: { readonly otlpEndpoint: string | undefined; readonly serviceName: string };
  readonly providers: {
    readonly timeoutMs: number;
    readonly urls: { readonly a: string; readonly b: string; readonly c: string };
    readonly retry: {
      readonly maxAttempts: number;
      readonly attemptTimeoutMs: number;
      readonly baseDelayMs: number;
      readonly maxDelayMs: number;
      readonly minAttemptMs: number;
    };
    readonly circuitBreaker: {
      readonly windowSize: number;
      readonly minimumCalls: number;
      readonly failureRateThreshold: number;
      readonly openDurationMs: number;
    };
  };
  readonly cache: {
    readonly ttlSeconds: number;
    readonly partialTtlSeconds: number;
    readonly redisUrl: string | undefined;
    readonly redisCommandTimeoutMs: number;
  };
  readonly search: { readonly timezone: string; readonly maxDaysAhead: number };
  readonly database: {
    readonly url: string | undefined;
    readonly poolMax: number;
    readonly migrateOnBoot: boolean;
    readonly maxInFlightWrites: number;
  };
  readonly flags: { readonly file: string | undefined; readonly pollMs: number };
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
    version: e.APP_VERSION,
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    telemetry: { otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT, serviceName: e.OTEL_SERVICE_NAME },
    providers: {
      timeoutMs: e.PROVIDER_TIMEOUT_MS,
      urls: { a: e.PROVIDER_A_URL, b: e.PROVIDER_B_URL, c: e.PROVIDER_C_URL },
      retry: {
        maxAttempts: e.PROVIDER_MAX_ATTEMPTS,
        attemptTimeoutMs: e.PROVIDER_ATTEMPT_TIMEOUT_MS,
        baseDelayMs: e.RETRY_BASE_DELAY_MS,
        maxDelayMs: e.RETRY_MAX_DELAY_MS,
        minAttemptMs: e.RETRY_MIN_ATTEMPT_MS,
      },
      circuitBreaker: {
        windowSize: e.CB_WINDOW_SIZE,
        minimumCalls: e.CB_MINIMUM_CALLS,
        failureRateThreshold: e.CB_FAILURE_RATE,
        openDurationMs: e.CB_OPEN_DURATION_MS,
      },
    },
    cache: {
      ttlSeconds: e.CACHE_TTL_SECONDS,
      partialTtlSeconds: e.PARTIAL_CACHE_TTL_SECONDS,
      redisUrl: e.REDIS_URL,
      redisCommandTimeoutMs: e.REDIS_COMMAND_TIMEOUT_MS,
    },
    search: { timezone: e.BUSINESS_TIMEZONE, maxDaysAhead: e.SEARCH_MAX_DAYS_AHEAD },
    database: {
      url: e.DATABASE_URL,
      poolMax: e.DB_POOL_MAX,
      migrateOnBoot: e.DB_MIGRATE_ON_BOOT,
      maxInFlightWrites: e.DB_MAX_IN_FLIGHT_WRITES,
    },
    flags: { file: e.FLAGS_FILE, pollMs: e.FLAGS_POLL_MS },
    selection: {
      strategy: e.SELECTION_STRATEGY,
      tolerancePctBps: e.SELECTION_TOLERANCE_BPS,
      maxDeltaCents: e.SELECTION_MAX_DELTA_CENTS,
      minGainRatio: e.SELECTION_MIN_GAIN_RATIO,
    },
  });
}
