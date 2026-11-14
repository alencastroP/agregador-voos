import { InvalidMoneyError } from './errors.js';

/**
 * Dinheiro é SEMPRE inteiro em centavos + moeda explícita. Float nunca representa preço:
 * 0.1 + 0.2 !== 0.3, e um centavo errado somado em 60 voos vira divergência de relatório.
 */
export const SUPPORTED_CURRENCIES = ['BRL'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export interface Money {
  readonly amountCents: number;
  readonly currency: Currency;
}

export function isSupportedCurrency(value: string): value is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export function money(amountCents: number, currency: Currency = 'BRL'): Money {
  if (!Number.isSafeInteger(amountCents)) {
    throw new InvalidMoneyError(`amountCents precisa ser inteiro, recebido ${amountCents}`);
  }
  return Object.freeze({ amountCents, currency });
}

/**
 * Converte reais (float vindo de provider) para centavos.
 * Para valores com até 2 casas decimais o erro de representação (ex.: 796.33 * 100 =
 * 79632.99999999999) é muito menor que 0,5 centavo, então Math.round é exato.
 */
export function reaisToCents(reais: number): number {
  if (!Number.isFinite(reais)) {
    throw new InvalidMoneyError(`valor em reais inválido: ${reais}`);
  }
  return Math.round(reais * 100);
}

/** Taxa em basis points (1% = 100 bps): mantém a aritmética de incentivo em inteiros. */
export type BasisPoints = number;

/** Aplica uma taxa (bps) a um valor em centavos, arredondando para o centavo mais próximo. */
export function applyRate(amountCents: number, rateBps: BasisPoints): number {
  if (!Number.isSafeInteger(amountCents) || !Number.isSafeInteger(rateBps)) {
    throw new InvalidMoneyError('applyRate exige inteiros (centavos e basis points)');
  }
  return Math.round((amountCents * rateBps) / 10_000);
}

export function formatBRL(amountCents: number): string {
  return (amountCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
