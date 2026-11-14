/**
 * Erros de domínio tipados. Cada um carrega um `code` estável; a tradução para HTTP
 * (status + Problem Details) acontece num único lugar, em interfaces/http.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface ValidationIssue {
  readonly field: string;
  readonly message: string;
}

/** Entrada de busca inválida (vira 400). */
export class InvalidSearchError extends DomainError {
  readonly code = 'invalid_search';

  constructor(readonly issues: readonly ValidationIssue[]) {
    super(issues.map((i) => `${i.field}: ${i.message}`).join('; '));
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'invalid_money';
}

/** Base dos erros de provider: sempre sabemos QUAL provider falhou. */
export abstract class ProviderError extends DomainError {
  /** Quantas tentativas foram feitas até desistir (preenchido pela política de retry). */
  attempts = 1;

  constructor(
    readonly provider: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`[${provider}] ${message}`, options);
  }
}

/** Estourou o orçamento de tempo (deadline) do provider. */
export class ProviderTimeoutError extends ProviderError {
  readonly code = 'provider_timeout';
}

/** Provider respondeu erro (5xx/429) ou a conexão falhou. `transient` decide se vale retry. */
export class ProviderUnavailableError extends ProviderError {
  readonly code = 'provider_unavailable';

  constructor(
    provider: string,
    message: string,
    readonly transient: boolean,
    readonly httpStatus?: number,
    options?: ErrorOptions,
  ) {
    super(provider, message, options);
  }
}

/** Resposta fora do contrato (JSON inválido ou formato inesperado no envelope). Não é transitório. */
export class ProviderContractError extends ProviderError {
  readonly code = 'provider_contract_violation';
}

/** Circuit breaker aberto: o provider é pulado sem chamada de rede. */
export class CircuitOpenError extends ProviderError {
  readonly code = 'circuit_open';
}

/** Todos os providers falharam: não há como montar resposta (vira 503). */
export class AllProvidersFailedError extends DomainError {
  readonly code = 'all_providers_failed';
}
