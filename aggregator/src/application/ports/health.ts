export type ComponentStatus = 'up' | 'degraded' | 'down';

export interface ComponentHealth {
  readonly status: ComponentStatus;
  readonly details?: Record<string, unknown>;
}

/**
 * Um componente verificável (Redis, Postgres, providers). `critical` decide se o componente
 * fora derruba a READINESS. Aqui nenhum é: o agregador funciona sem cache e sem persistência
 * (degrada), e uma readiness que dependesse deles tiraria TODAS as réplicas do balanceador
 * por causa de uma dependência opcional (ver ADR 0008).
 */
export interface HealthIndicator {
  readonly name: string;
  readonly critical: boolean;
  check(): Promise<ComponentHealth>;
}
