import { z } from 'zod';

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
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Configuração inválida:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
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
  return Object.freeze({
    env: e.NODE_ENV,
    http: { host: e.HOST, port: e.PORT },
    logLevel: e.LOG_LEVEL,
    providers: {
      timeoutMs: e.PROVIDER_TIMEOUT_MS,
      urls: { a: e.PROVIDER_A_URL, b: e.PROVIDER_B_URL, c: e.PROVIDER_C_URL },
    },
  });
}
