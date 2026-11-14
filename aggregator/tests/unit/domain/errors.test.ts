import { describe, expect, it } from 'vitest';
import {
  AllProvidersFailedError,
  CircuitOpenError,
  DomainError,
  InvalidSearchError,
  ProviderContractError,
  ProviderError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../../../src/domain/errors.js';

describe('domain errors', () => {
  it.each([
    [new ProviderTimeoutError('provider-a', 'deadline 3000ms'), 'provider_timeout'],
    [new ProviderUnavailableError('provider-a', 'HTTP 500', true, 500), 'provider_unavailable'],
    [new ProviderContractError('provider-a', 'missing "flights"'), 'provider_contract_violation'],
    [new CircuitOpenError('provider-a', 'open'), 'circuit_open'],
  ])('%s carries a stable code and the provider name', (error, code) => {
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe(code);
    expect(error.provider).toBe('provider-a');
    expect(error.message).toMatch(/^\[provider-a\] /);
    expect(error.name).toBe(error.constructor.name);
  });

  it('ProviderUnavailableError tells whether a retry makes sense', () => {
    const transient = new ProviderUnavailableError('provider-b', 'HTTP 503', true, 503);
    const permanent = new ProviderUnavailableError('provider-b', 'HTTP 400', false, 400);
    expect([transient.transient, transient.httpStatus]).toEqual([true, 503]);
    expect([permanent.transient, permanent.httpStatus]).toEqual([false, 400]);
  });

  it('keeps the original cause for logs', () => {
    const cause = new TypeError('fetch failed');
    const error = new ProviderUnavailableError('provider-c', 'network', true, undefined, { cause });
    expect(error.cause).toBe(cause);
    expect(error.httpStatus).toBeUndefined();
  });

  it('InvalidSearchError summarises every issue', () => {
    const error = new InvalidSearchError([
      { field: 'origin', message: 'obrigatório' },
      { field: 'date', message: 'no passado' },
    ]);
    expect(error.code).toBe('invalid_search');
    expect(error.message).toBe('origin: obrigatório; date: no passado');
  });

  it('AllProvidersFailedError is a domain error', () => {
    expect(new AllProvidersFailedError('x').code).toBe('all_providers_failed');
  });
});
