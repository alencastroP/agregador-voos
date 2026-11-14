import type { FastifyInstance } from 'fastify';
import { noopTracer, type Tracer } from '../../../application/ports/tracer.js';
import type { SearchContext } from '../../../application/search-flights.js';
import type { SearchResponse } from '../../../application/search-response.js';

/** Identificador da agência (opcional): habilita feature flag por agência (A/B, rollout). */
const AGENCY_PATTERN = /^[\w.-]{1,64}$/;

/** O que a rota precisa do use case (facilita stub em teste de HTTP). */
export interface SearchUseCase {
  execute(input: unknown, context: SearchContext): Promise<SearchResponse>;
}

/**
 * POST /search { origin, destination, date }
 *   200: sucesso, inclusive parcial (meta.partial = true) e sem voos (results = [])
 *   400: entrada inválida (Problem Details com a lista de campos)
 *   503: TODOS os providers falharam (não dá para afirmar "não há voos")
 * A rota não valida nem decide nada: só traduz HTTP ↔ use case. Erros sobem para o handler único.
 * O span "POST /search" é a raiz do trace; leva o requestId para cruzar log ↔ trace ↔ resposta.
 */
export function registerSearchRoutes(
  app: FastifyInstance,
  useCase: SearchUseCase,
  tracer: Tracer = noopTracer,
): void {
  app.post('/search', (request) =>
    tracer.withSpan(
      'POST /search',
      { 'http.request.method': 'POST', 'http.route': '/search', 'request.id': request.id },
      () => {
        const agency = request.headers['x-agency-id'];
        const agencyId =
          typeof agency === 'string' && AGENCY_PATTERN.test(agency) ? agency : undefined;
        return useCase.execute(request.body, {
          logger: agencyId ? request.log.child({ agencyId }) : request.log,
          ...(agencyId ? { agencyId } : {}),
        });
      },
    ),
  );
}
