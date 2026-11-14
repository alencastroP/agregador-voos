import type { Client } from '@openfeature/server-sdk';
import type {
  FeatureFlags,
  FlagContext,
  SearchFlags,
} from '../../application/ports/feature-flags.js';
import { STRATEGY_NAMES, type StrategyName } from '../../domain/selection/strategy.js';

/** Chaves das flags (documentadas em docs/adr/0010 e no README). */
export const FLAG_KEYS = {
  strategy: 'selection.strategy',
  tolerancePctBps: 'selection.tolerancePctBps',
  maxDeltaCents: 'selection.maxDeltaCents',
  minGainRatio: 'selection.minGainRatio',
  providerA: 'provider.a.enabled',
  providerB: 'provider.b.enabled',
  providerC: 'provider.c.enabled',
  cache: 'cache.enabled',
} as const;

const isStrategy = (v: string): v is StrategyName =>
  (STRATEGY_NAMES as readonly string[]).includes(v);
const isNonNegInt = (v: number) => Number.isSafeInteger(v) && v >= 0;

/**
 * Adapter do port FeatureFlags sobre o OpenFeature. Avalia todas as flags de uma vez (em
 * paralelo) e VALIDA o domínio de cada valor: um τ negativo ou uma estratégia inexistente
 * vindos da configuração caem no default (com aviso), nunca quebram a busca.
 */
export class OpenFeatureFlags implements FeatureFlags {
  constructor(
    private readonly client: Client,
    private readonly defaults: SearchFlags,
    private readonly onInvalid: (key: string, value: unknown) => void = () => undefined,
  ) {}

  async evaluate({ agencyId }: FlagContext): Promise<SearchFlags> {
    const ctx = agencyId ? { targetingKey: agencyId } : {};
    const d = this.defaults;
    const [strategy, tolerance, maxDelta, minGain, a, b, c, cache] = await Promise.all([
      this.client.getStringValue(FLAG_KEYS.strategy, d.strategy, ctx),
      this.client.getNumberValue(FLAG_KEYS.tolerancePctBps, d.balanced.tolerancePctBps, ctx),
      this.client.getNumberValue(FLAG_KEYS.maxDeltaCents, d.balanced.maxDeltaCents, ctx),
      this.client.getNumberValue(FLAG_KEYS.minGainRatio, d.balanced.minGainRatio, ctx),
      this.client.getBooleanValue(FLAG_KEYS.providerA, d.providers['provider-a'], ctx),
      this.client.getBooleanValue(FLAG_KEYS.providerB, d.providers['provider-b'], ctx),
      this.client.getBooleanValue(FLAG_KEYS.providerC, d.providers['provider-c'], ctx),
      this.client.getBooleanValue(FLAG_KEYS.cache, d.cacheEnabled, ctx),
    ]);

    return {
      strategy: this.check(FLAG_KEYS.strategy, strategy, isStrategy, d.strategy),
      balanced: {
        tolerancePctBps: this.check(
          FLAG_KEYS.tolerancePctBps,
          tolerance,
          isNonNegInt,
          d.balanced.tolerancePctBps,
        ),
        maxDeltaCents: this.check(
          FLAG_KEYS.maxDeltaCents,
          maxDelta,
          isNonNegInt,
          d.balanced.maxDeltaCents,
        ),
        minGainRatio: this.check(
          FLAG_KEYS.minGainRatio,
          minGain,
          (v) => Number.isFinite(v) && v >= 0,
          d.balanced.minGainRatio,
        ),
      },
      providers: { 'provider-a': a, 'provider-b': b, 'provider-c': c },
      cacheEnabled: cache,
    };
  }

  private check<T, V extends T>(key: string, value: T, valid: (v: T) => v is V, fallback: V): V;
  private check<T>(key: string, value: T, valid: (v: T) => boolean, fallback: T): T;
  private check<T>(key: string, value: T, valid: (v: T) => boolean, fallback: T): T {
    if (valid(value)) return value;
    this.onInvalid(key, value);
    return fallback;
  }
}
