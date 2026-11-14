/**
 * Normalização de companhia aérea. Cada provider escreve do seu jeito:
 *   LATAM / Latam / Latam Airlines, GOL / Gol / Gol Linhas Aéreas,
 *   AZUL / Azul / Azul Linhas Aereas, VOEPASS / Passaredo / Voepass.
 *
 * Texto normalizado resolve quase tudo; "Passaredo" (nome antigo da Voepass) só sai com
 * tabela de aliases. Companhia desconhecida NUNCA é descartada: vira chave própria
 * (o pior caso é não deduplicar, o que é visível e corrigível; descartar esconderia inventário).
 */
export const KNOWN_AIRLINES = {
  LATAM: 'LATAM Airlines',
  GOL: 'GOL Linhas Aéreas',
  AZUL: 'Azul Linhas Aéreas',
  VOEPASS: 'Voepass Linhas Aéreas',
} as const;

export type KnownAirlineCode = keyof typeof KNOWN_AIRLINES;

export interface Airline {
  /** Chave canônica usada na deduplicação (LATAM | GOL | AZUL | VOEPASS | desconhecida em CAPS). */
  readonly code: string;
  readonly displayName: string;
}

export interface ResolvedAirline {
  readonly airline: Airline;
  readonly known: boolean;
}

/** Sufixos societários/descritivos removidos antes da comparação (mais longo primeiro). */
const SUFFIXES = ['linhas aereas inteligentes', 'linhas aereas', 'airlines', 'airline'] as const;

/** Nome normalizado → código canônico. Inclui aliases históricos. */
const ALIASES: Readonly<Record<string, KnownAirlineCode>> = {
  latam: 'LATAM',
  tam: 'LATAM',
  gol: 'GOL',
  azul: 'AZUL',
  voepass: 'VOEPASS',
  passaredo: 'VOEPASS',
};

/** "Gol Linhas Aéreas" → "gol"; "  LATAM  Airlines " → "latam". */
export function normalizeAirlineName(raw: string): string {
  const base = raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  for (const suffix of SUFFIXES) {
    if (base.endsWith(` ${suffix}`)) return base.slice(0, -(suffix.length + 1)).trim();
  }
  return base;
}

export function isKnownAirline(code: string): code is KnownAirlineCode {
  return Object.hasOwn(KNOWN_AIRLINES, code);
}

/** Retorna null só para nome vazio (não dá para montar chave). */
export function resolveAirline(raw: string): ResolvedAirline | null {
  const normalized = normalizeAirlineName(raw);
  if (normalized === '') return null;

  const code = ALIASES[normalized];
  if (code !== undefined) {
    return { airline: { code, displayName: KNOWN_AIRLINES[code] }, known: true };
  }
  return {
    airline: { code: normalized.toUpperCase().replace(/ /g, '_'), displayName: raw.trim() },
    known: false,
  };
}
