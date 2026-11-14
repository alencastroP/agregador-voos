# ADR 0009: Persistência analítica (Postgres + Drizzle) e dashboard de insights (Grafana)

- **Status:** aceito
- **Data:** 2026-11-14

## Contexto

Bônus do desafio: banco de dados persistindo as buscas e um dashboard com insights. O agregador
não tem estado transacional (não emite, não reserva); a persistência serve para **análise**:
quanto a estratégia rende e custa, como os providers se comportam e o que os agentes buscam.

## Decisões

### Modelo (3 tabelas, migrations versionadas com Drizzle)

| Tabela | Granularidade | Responde |
|---|---|---|
| `searches` | 1 por busca **servida** (inclusive cache hit) | demanda: top rotas, antecedência, volume, % do cache, % parcial |
| `provider_calls` | 1 por provider por busca **calculada** | operação: status, latência, tentativas, erro |
| `selected_offers` | 1 por voo exibido em busca **calculada** | negócio: escolhido × mais barato, incentivo, Δ do cliente |

**Cache hit grava só `searches`.** Repetir 60 ofertas e 3 chamadas que não aconteceram
distorceria a latência dos providers e inflaria a receita. Dinheiro em centavos (`integer`);
horário do voo em hora local (`timestamp` sem fuso), como no domínio.

**Drizzle:** schema em TypeScript → `drizzle-kit generate` → SQL versionado em
`aggregator/drizzle/` (revisável em PR). É leve, tipado e sem a "mágica" de um ORM pesado. As
migrations rodam no boot (`DB_MIGRATE_ON_BOOT`) ou via `npm run db:migrate` (o caminho certo com
várias réplicas: um job de deploy).

### Escrita fora do caminho crítico

- **Fire-and-forget** (o use case não espera) e **uma transação por busca**: ou entra tudo, ou
  nada. Testado: uma falha no meio não deixa linha órfã.
- **Pool que falha rápido:** conexão 2 s, statement 5 s, máximo de 5 conexões.
- **Backpressure:** acima de 200 escritas pendentes, o registro é **descartado na hora** (log +
  `search_persistence_failures_total`) em vez de acumular promises e estourar a memória.
- **Shutdown:** espera as escritas pendentes por até 5 s.
- **Banco fora no boot:** o serviço sobe sem insights (log `error`); a busca não é afetada.
- **Risco aceito:** perda de registros analíticos em pico, queda do banco ou crash.
  **Evolução:** outbox transacional ou fila (SQS/Kafka) → consumidor → warehouse (BigQuery,
  ClickHouse), com o Postgres fora do caminho de escrita da busca.

### Dashboard (Grafana provisionado e versionado)

Datasources (Prometheus + Postgres) e o dashboard sobem prontos via provisioning
(`observability/grafana/`). O Grafana lê o Postgres com o papel **`grafana_ro`, somente
leitura**: o dashboard nunca escreve.

| Bloco | Fonte | Painéis |
|---|---|---|
| **Negócio** | Postgres | incentivo a mais vs. sempre o mais barato · custo extra para o cliente · **R$ do cliente por R$ 1 ganho** · % de voos ≠ mais barato · custo médio por voo afetado · série ganho × custo · share por provider · escolhido × mais barato |
| **Operação** | Prometheus | disponibilidade e latência p50/p95/p99 por provider · estado dos circuitos · timeout/erro · buscas ok/parcial/falha · cache hit ratio · p95 da busca · descartes · retries e coalescência |
| **Demanda** | Postgres | buscas no período · antecedência média · % parcial · top rotas · buscas por hora (calculadas × cache) |

**As queries são testadas:** um teste de integração lê o JSON do dashboard, expande as macros
do Grafana e executa toda query SQL contra o Postgres real com dados de uma busca. Um painel
quebrado falha na CI, não na apresentação. O JSON é gerado por
`observability/grafana/build_dashboard.py`.

## Evidência (ao vivo: 240 buscas, normais + chaos + repetidas)

| Painel | Valor | Confere com |
|---|---|---|
| R$ do cliente por R$ 1 ganho | **1,17** | simulate da Fase 3: 1,17 |
| Voos ≠ mais barato | 15,7% | simulate: 16,7% (sob chaos, parte dos voos A+C vira parcial) |
| Custo extra médio por voo afetado | R$ 9,23 | mediana medida: R$ 9,07 |
| Share de vitória | B 67% · C 24% · A 9% | B domina A; C só vence dentro da banda |
| `provider_calls` | 603 linhas = 201 buscas calculadas × 3 | cache hit não grava chamadas |

Todos os 22 painéis responderam via `/api/ds/query` do Grafana.

**Achado durante a validação:** 40 buscas parciais "extras" eram uma resposta degradada
(provider-c sendo recriado pelo `make calm`) **cacheada por 30 s** e servida 39 vezes. É o
comportamento desenhado (ADR 0006); com o TTL cheio de 5 min, ela teria ficado congelada 10×
mais tempo.

## Consequências

- (+) O argumento de negócio da apresentação ("quanto a estratégia gerou e quanto custou ao
  cliente") sai do dado real, não de planilha.
- (−) `selected_offers` cresce ~60 linhas por busca calculada. Evolução: particionar por mês e
  agregar em tabelas diárias; reter o detalhe por 90 dias.
- (−) Senhas de demonstração no compose (`POSTGRES_PASSWORD`, `GRAFANA_ADMIN_PASSWORD` e
  `grafana_ro`). No deploy, vêm de `.env`/secrets.
