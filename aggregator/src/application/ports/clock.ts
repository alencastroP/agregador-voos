/**
 * Port de relógio. O use case nunca chama `new Date()` direto: com o relógio injetado,
 * "data no passado", antecedência da busca e circuit breaker ficam testáveis sem fake timers globais.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
