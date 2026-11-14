import type { ProviderId } from '../../domain/provider.js';
import type { BalancedParams } from '../../domain/selection/strategies.js';
import type { StrategyName } from '../../domain/selection/strategy.js';

/** Quem está buscando: permite rollout/A-B por agência (header x-agency-id). */
export interface FlagContext {
  readonly agencyId?: string;
}

/** Tudo que pode mudar em runtime numa busca, resolvido UMA vez por busca. */
export interface SearchFlags {
  readonly strategy: StrategyName;
  readonly balanced: BalancedParams;
  /** Kill switch por provider: desligar um provider em incidente, sem deploy. */
  readonly providers: Readonly<Record<ProviderId, boolean>>;
  readonly cacheEnabled: boolean;
}

/**
 * Port de feature flags. O use case pergunta "como devo buscar agora, para esta agência?" e não
 * sabe se a resposta vem de arquivo, flagd, Unleash ou LaunchDarkly. A implementação NUNCA
 * lança: na dúvida, devolve os defaults.
 */
export interface FeatureFlags {
  evaluate(context: FlagContext): Promise<SearchFlags>;
}

export function staticFlags(flags: SearchFlags): FeatureFlags {
  return { evaluate: () => Promise.resolve(flags) };
}
