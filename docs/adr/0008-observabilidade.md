# ADR 0008: Observabilidade (logs, métricas, traces e health checks)

- **Status:** aceito
- **Data:** 2026-11-14

## Contexto

Para operar um agregador de terceiros, é preciso responder rápido a três perguntas:
(1) **qual provider** está lento ou falhando? (2) **essa busca específica** do agente, o que
aconteceu? (3) **a estratégia está gerando o resultado de negócio** esperado, e a que custo para
o cliente?

## Decisões

### Portas na aplicação, implementação na infraestrutura

O use case conhece só dois ports: `SearchObserver` (fatos de negócio e operação) e `Tracer`
(spans). Prometheus e OpenTelemetry são adapters. Testes e desenvolvimento usam no-op, e trocar
para Datadog seria outro adapter.

### Logs (pino, JSON)

Cada linha traz `requestId` (do header `x-request-id` ou gerado), `searchId` e, dentro de um span,
**`traceId`/`spanId`** (mixin do pino). Do log se chega ao trace. Nível configurável
(`LOG_LEVEL`); redact de `authorization`, `cookie` e `x-api-key`.

### Métricas (prom-client, `GET /metrics`)

| Métrica | Pergunta que responde |
|---|---|
| `http_request_duration_seconds{method,route,status_code}` | latência e erros da API (`route` = rota **declarada**, nunca a URL crua) |
| `provider_request_duration_seconds{provider,status}` | p50/p95/p99 por provider |
| `provider_errors_total{provider,type}` | timeout × erro × circuito aberto |
| `provider_retries_total{provider}` | quanto o retry está trabalhando |
| `circuit_breaker_state{provider}` | 0 fechado, 1 half-open, 2 aberto (lido na hora do scrape) |
| `cache_hits_total`, `cache_misses_total`, `cache_errors_total{operation}` | hit ratio e saúde do Redis |
| `search_requests_total{outcome,cached}` | ok × parcial × todos falharam |
| `search_coalesced_total` | single-flight em ação |
| `offers_discarded_total{provider,reason}` | qualidade de dados de cada provider |
| `airline_unknown_total{provider}` | alias faltando na tabela de companhias |
| `selection_offers_total{strategy,differs_from_cheapest}` | % de voos em que a escolha diferiu do mais barato |
| `selection_incentive_gain_cents_total{strategy}` | **receita incremental** da estratégia |
| `selection_customer_delta_cents_total{strategy}` | **custo extra para o cliente** |
| `search_persistence_failures_total` | perda no fire-and-forget |

Rótulos com cardinalidade **fechada**: nunca rota, data ou id. As métricas de seleção contam cada
resposta **servida** (inclusive cache hit), porque o agente viu aquelas escolhas.

### Traces (OpenTelemetry → OTLP/HTTP → Jaeger)

Trace por busca: `POST /search` → `search` → `cache.get`, `provider provider-x` (com o `POST` HTTP
do undici como filho, **um por tentativa**) e `cache.set`. Os atributos levam status, tentativas,
ofertas e descartes.

**Spans manuais + undici, sem auto-instrumentação de http/fastify:** em ESM, a
auto-instrumentação exige loader hooks (`import-in-the-middle`) frágeis. O undici usa
`diagnostics_channel` e funciona sem loader. O resultado é um trace limpo e com atributos de
negócio. Sem `OTEL_EXPORTER_OTLP_ENDPOINT`, o tracing fica desligado e a API do OTel vira no-op.

**Verificado ao vivo:** trace normal com a hierarquia acima; trace sob chaos com o provider-c em
`attempts=3` e 3 spans HTTP filhos; o log `search completed` com o mesmo `traceId`.

### Health checks: liveness × readiness × resumo

| Endpoint | Pergunta | Se falhar, o orquestrador… | Checa |
|---|---|---|---|
| `/health/live` | o processo responde? | **reinicia** o container | nada externo (reiniciar não conserta um Redis fora) |
| `/health/ready` | posso receber tráfego? | **tira do balanceador** (sem reiniciar) | componentes **críticos**, mais o estado de drenagem |
| `/health` | resumo para humanos e `make health` | — | todos os componentes, versão, uptime |

**Desvio consciente do plano original:** Redis e Postgres **não** derrubam a readiness. O
agregador funciona sem cache e sem persistência (degrada). Se a readiness dependesse deles, um
Redis fora tiraria **todas** as réplicas do balanceador ao mesmo tempo: uma dependência opcional
viraria indisponibilidade total. Eles aparecem como `ready_degraded`, com detalhes. A readiness
dá **503 durante a drenagem**: no SIGTERM, ela cai, espera `SHUTDOWN_GRACE_MS` (o LB tira a
instância), fecha o servidor drenando as requisições, fecha o Redis e faz flush dos traces.

Cada indicador tem timeout (500 ms): um health check pendurado não pendura o endpoint.

## Consequências

- (+) Do alerta ao trace em 2 cliques: métrica (qual provider) → log (`requestId`) → trace
  (`traceId`).
- (+) As métricas de negócio da estratégia alimentam o dashboard da fase de insights.
- (−) Sem trace de entrada HTTP automático (headers W3C `traceparent` do cliente não são
  continuados). Evolução: aceitar `traceparent` na rota, ou auto-instrumentação quando o loader
  ESM estabilizar.
- (−) Sem alertas configurados. Evolução: SLOs (ex.: 99% das buscas < 3,5 s; taxa de parcial
  < 5%) com alertas no Prometheus/Alertmanager.
