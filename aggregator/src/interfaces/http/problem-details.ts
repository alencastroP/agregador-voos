import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  AllProvidersFailedError,
  DomainError,
  InvalidSearchError,
  type ValidationIssue,
} from '../../domain/errors.js';

/** RFC 9457 (antiga 7807): formato único de erro da API. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  requestId: string;
  errors?: readonly ValidationIssue[];
}

const PROBLEM_BASE = 'https://passhub.dev/problems/';

/** ÚNICO ponto de tradução erro → HTTP. Domínio não conhece status code. */
export function toProblem(error: unknown, request: FastifyRequest): ProblemDetails {
  const base = { instance: request.url, requestId: request.id };

  if (error instanceof InvalidSearchError) {
    return {
      ...base,
      type: `${PROBLEM_BASE}${error.code}`,
      title: 'Parâmetros de busca inválidos',
      status: 400,
      detail: error.message,
      errors: error.issues,
    };
  }
  if (error instanceof AllProvidersFailedError) {
    return {
      ...base,
      type: `${PROBLEM_BASE}${error.code}`,
      title: 'Nenhum fornecedor disponível',
      status: 503,
      detail: error.message,
    };
  }
  if (isFastifyClientError(error)) {
    return {
      ...base,
      type: `${PROBLEM_BASE}bad_request`,
      title: 'Requisição inválida',
      status: error.statusCode ?? 400,
      detail: error.message,
    };
  }
  const code = error instanceof DomainError ? error.code : 'internal_error';
  return {
    ...base,
    type: `${PROBLEM_BASE}${code}`,
    title: 'Erro interno',
    status: 500,
    // Nunca vaza stack/mensagem interna para o cliente; o detalhe fica no log com o requestId.
    detail: 'Erro inesperado. Informe o requestId ao suporte.',
  };
}

function isFastifyClientError(error: unknown): error is FastifyError {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return false;
  const status = (error as FastifyError).statusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
}

export function sendProblem(reply: FastifyReply, problem: ProblemDetails): FastifyReply {
  return reply.status(problem.status).type('application/problem+json').send(problem);
}
