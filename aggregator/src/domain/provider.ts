import type { BasisPoints } from './money.js';

export const PROVIDER_IDS = ['provider-a', 'provider-b', 'provider-c'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Incentivo contratual por provider, em basis points (1% = 100 bps).
 * Enunciado: A 1%, B 1,5%, C 2%. Em produção isso viria de cadastro comercial; aqui é default
 * sobrescrevível na composição.
 */
export const DEFAULT_INCENTIVE_BPS: Readonly<Record<ProviderId, BasisPoints>> = {
  'provider-a': 100,
  'provider-b': 150,
  'provider-c': 200,
};

/** Posição fixa de cada provider: último critério de desempate (garante determinismo). */
export function providerRank(id: ProviderId): number {
  return PROVIDER_IDS.indexOf(id);
}
