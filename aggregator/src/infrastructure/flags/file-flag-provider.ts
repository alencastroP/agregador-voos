import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import {
  FlagNotFoundError,
  OpenFeatureEventEmitter,
  ProviderEvents,
  StandardResolutionReasons,
  TypeMismatchError,
  type EvaluationContext,
  type JsonValue,
  type Provider,
  type ResolutionDetails,
} from '@openfeature/server-sdk';
import { z } from 'zod';

/**
 * Formato do arquivo (flags/flags.json):
 *   { "provider.c.enabled": { "value": true },
 *     "selection.tolerancePctBps": { "value": 150, "agencies": { "agencia-teste-ab": 200 } } }
 * `agencies` sobrescreve o valor para um targetingKey (agência) específico: A/B ou rollout.
 */
const FlagValue = z.union([z.boolean(), z.string(), z.number()]);
const FlagFile = z.record(
  z.string(),
  z.object({
    value: FlagValue,
    agencies: z.record(z.string(), FlagValue).optional(),
    description: z.string().optional(),
  }),
);
type FlagDefinitions = z.infer<typeof FlagFile>;
type Primitive = z.infer<typeof FlagValue>;

export interface FileFlagProviderOptions {
  readonly path: string;
  /** Intervalo de checagem do arquivo (polling funciona também em bind mount do Docker). */
  readonly pollIntervalMs?: number;
  /** Overrides por variável de ambiente: FLAG_PROVIDER_C_ENABLED=false → "provider.c.enabled". */
  readonly env?: NodeJS.ProcessEnv;
  readonly onReload?: (result: { ok: boolean; error?: string; flags: number }) => void;
}

/** "provider.c.enabled" → "FLAG_PROVIDER_C_ENABLED" */
export function envKeyFor(flagKey: string): string {
  return `FLAG_${flagKey.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}`;
}

/**
 * Provider OpenFeature baseado em ARQUIVO, com recarga a quente.
 * Precedência: variável de ambiente > arquivo (por agência > valor) > default do código.
 * Arquivo inválido NÃO derruba nada: mantém a última versão boa e avisa.
 * Trocar por flagd/Unleash/LaunchDarkly = trocar este provider; domínio e use case não mudam.
 */
export class FileFlagProvider implements Provider {
  readonly metadata = { name: 'file-flag-provider' } as const;
  readonly runsOn = 'server' as const;
  readonly events = new OpenFeatureEventEmitter();
  private definitions: FlagDefinitions = {};
  private readonly env: NodeJS.ProcessEnv;
  private readonly listener = () => {
    this.reload();
  };

  constructor(private readonly options: FileFlagProviderOptions) {
    this.env = options.env ?? process.env;
  }

  initialize(): Promise<void> {
    this.reload();
    watchFile(this.options.path, { interval: this.options.pollIntervalMs ?? 2_000 }, this.listener);
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    unwatchFile(this.options.path, this.listener);
    return Promise.resolve();
  }

  /** Lê e valida o arquivo. Em erro, mantém a última versão válida. */
  reload(): void {
    try {
      const parsed = FlagFile.parse(JSON.parse(readFileSync(this.options.path, 'utf-8')));
      this.definitions = parsed;
      this.options.onReload?.({ ok: true, flags: Object.keys(parsed).length });
      this.events.emit(ProviderEvents.ConfigurationChanged, { flagsChanged: Object.keys(parsed) });
    } catch (error) {
      this.options.onReload?.({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        flags: Object.keys(this.definitions).length,
      });
    }
  }

  resolveBooleanEvaluation(key: string, _default: boolean, ctx: EvaluationContext) {
    return this.resolve(key, ctx, 'boolean');
  }

  resolveStringEvaluation(key: string, _default: string, ctx: EvaluationContext) {
    return this.resolve(key, ctx, 'string');
  }

  resolveNumberEvaluation(key: string, _default: number, ctx: EvaluationContext) {
    return this.resolve(key, ctx, 'number');
  }

  resolveObjectEvaluation<T extends JsonValue>(key: string): Promise<ResolutionDetails<T>> {
    return Promise.reject(new TypeMismatchError(`object flags are not supported (${key})`));
  }

  private resolve<T extends 'boolean' | 'string' | 'number'>(
    key: string,
    ctx: EvaluationContext,
    type: T,
  ): Promise<
    ResolutionDetails<T extends 'boolean' ? boolean : T extends 'string' ? string : number>
  > {
    type Out = T extends 'boolean' ? boolean : T extends 'string' ? string : number;
    const fromEnv = this.env[envKeyFor(key)];
    if (fromEnv !== undefined && fromEnv !== '') {
      return Promise.resolve({
        value: this.coerce(key, fromEnv, type) as Out,
        reason: StandardResolutionReasons.STATIC,
        variant: 'env',
      });
    }

    const definition = this.definitions[key];
    if (!definition) return Promise.reject(new FlagNotFoundError(`flag "${key}" not defined`));

    const agency = ctx.targetingKey;
    const byAgency = agency !== undefined ? definition.agencies?.[agency] : undefined;
    const value: Primitive = byAgency ?? definition.value;
    if (typeof value !== type) {
      return Promise.reject(
        new TypeMismatchError(`flag "${key}" is ${typeof value}, expected ${type}`),
      );
    }
    return Promise.resolve({
      value: value as Out,
      reason:
        byAgency !== undefined
          ? StandardResolutionReasons.TARGETING_MATCH
          : StandardResolutionReasons.STATIC,
      variant: byAgency !== undefined ? `agency:${String(agency)}` : 'default',
    });
  }

  private coerce(key: string, raw: string, type: 'boolean' | 'string' | 'number'): Primitive {
    if (type === 'string') return raw;
    if (type === 'boolean') {
      if (raw === 'true' || raw === 'false') return raw === 'true';
    } else {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
    throw new TypeMismatchError(`env ${envKeyFor(key)}="${raw}" is not a ${type}`);
  }
}
