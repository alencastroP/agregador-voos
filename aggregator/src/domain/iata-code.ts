/**
 * Código IATA de aeroporto (3 letras). Branded type: uma string só vira IataCode passando
 * por parseIataCode, então o resto do código não precisa revalidar.
 *
 * Validamos só o FORMATO. Os mocks aceitam qualquer rota (até "XXX"), e não temos a tabela de
 * aeroportos; validar existência é evolução documentada (tabela IATA/OurAirports).
 */
export type IataCode = string & { readonly __brand: 'IataCode' };

const IATA_PATTERN = /^[A-Z]{3}$/;

export function parseIataCode(raw: string): IataCode | null {
  const normalized = raw.trim().toUpperCase();
  return IATA_PATTERN.test(normalized) ? (normalized as IataCode) : null;
}
