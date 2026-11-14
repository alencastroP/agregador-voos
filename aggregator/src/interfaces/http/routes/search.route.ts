import type { FastifyInstance } from 'fastify';
import type { SearchContext } from '../../../application/search-flights.js';
import type { SearchResponse } from '../../../application/search-response.js';

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
 */
export function registerSearchRoutes(app: FastifyInstance, useCase: SearchUseCase): void {
  app.post('/search', async (request) => useCase.execute(request.body, { logger: request.log }));
}
