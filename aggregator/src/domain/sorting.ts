import type { SelectedOffer } from './selection/strategy.js';

/**
 * Ordenação dos resultados: ORDEM TOTAL, então a mesma entrada gera sempre a mesma saída
 * (cache, testes e a confiança do agente ao repetir a busca dependem disso).
 *
 *   1. preço ascendente: o que o agente mais compara;
 *   2. partida ascendente: entre preços iguais, o voo mais cedo;
 *   3. duração ascendente: entre horários iguais, o mais rápido;
 *   4. flightKey: desempate final, único por voo após a dedup (garante a ordem total).
 *
 * Datas locais no formato fixo YYYY-MM-DDTHH:MM:SS comparam corretamente como string.
 */
export function compareResults(a: SelectedOffer, b: SelectedOffer): number {
  return (
    a.offer.price.amountCents - b.offer.price.amountCents ||
    compareStrings(a.offer.departureAt, b.offer.departureAt) ||
    a.offer.durationMinutes - b.offer.durationMinutes ||
    compareStrings(a.offer.flightKey, b.offer.flightKey)
  );
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function sortResults(results: readonly SelectedOffer[]): SelectedOffer[] {
  return [...results].sort(compareResults);
}
