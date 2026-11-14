import type { FastifyInstance } from 'fastify';
import type { ComponentHealth, HealthIndicator } from '../../../application/ports/health.js';

export interface HealthDeps {
  readonly indicators: readonly HealthIndicator[];
  /** true durante o graceful shutdown: readiness cai ANTES de fechar, para o LB parar de mandar tráfego. */
  readonly isDraining: () => boolean;
  readonly version: string;
}

async function runChecks(indicators: readonly HealthIndicator[]) {
  const results = await Promise.all(indicators.map(async (i) => [i, await i.check()] as const));
  const checks: Record<string, ComponentHealth & { critical: boolean }> = {};
  for (const [indicator, health] of results) {
    checks[indicator.name] = { ...health, critical: indicator.critical };
  }
  const criticalDown = results.some(([i, h]) => i.critical && h.status === 'down');
  const anyNotUp = results.some(([, h]) => h.status !== 'up');
  return { checks, criticalDown, anyNotUp };
}

/**
 * Três endpoints com papéis diferentes:
 *   /health/live  → LIVENESS: o processo responde? (falhar = orquestrador REINICIA o container).
 *                   Não checa dependências: reiniciar não conserta um Redis fora.
 *   /health/ready → READINESS: posso receber tráfego? (falhar = sai do balanceador, sem restart).
 *                   503 só durante o shutdown (drenagem) ou se um componente CRÍTICO cair.
 *   /health       → resumo legível para humanos e para `make health` (status + todos os componentes).
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  const startedAt = Date.now();

  app.get('/health/live', () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    if (deps.isDraining()) return reply.status(503).send({ status: 'draining' });
    const { checks, criticalDown, anyNotUp } = await runChecks(deps.indicators);
    if (criticalDown) return reply.status(503).send({ status: 'not_ready', checks });
    return { status: anyNotUp ? 'ready_degraded' : 'ready', checks };
  });

  app.get('/health', async (_request, reply) => {
    const { checks, criticalDown, anyNotUp } = await runChecks(deps.indicators);
    const status = deps.isDraining()
      ? 'draining'
      : criticalDown
        ? 'down'
        : anyNotUp
          ? 'degraded'
          : 'ok';
    return reply.status(status === 'down' || status === 'draining' ? 503 : 200).send({
      status,
      version: deps.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks,
    });
  });
}
