# ADR 0006: Cache em Redis (resposta final, parciais, stampede e falha)

- **Status:** aceito
- **Data:** 2026-11-14

## Contexto

Requisito: cache com Redis e TTL de 5 minutos. Os mocks são determinísticos (mesma rota e data
geram os mesmos preços), então o cache é seguro. Num GDS real, 5 minutos é a janela típica em
que tarifa e disponibilidade ainda batem com a emissão.

## Decisões

### 1. Cachear a resposta FINAL (pós-estratégia), não cada provider

| | Resposta final (escolhida) | Por provider |
|---|---|---|
| Hit | 1 GET, zero CPU (já deduplicado, selecionado e ordenado) | 3 GETs + dedup + estratégia a cada hit |
| Trocar a estratégia | a chave inclui o fingerprint da estratégia: muda na hora | reaproveita o cache (vantagem) |
| TTL por provider | não | sim (ex.: provider com tarifa mais volátil) |
| Parcial | um provider que falhou contamina a entrada inteira (mitigado pelo TTL curto) | só o provider que falhou fica sem cache |

A resposta final venceu pela simplicidade e pelo hit mais barato. O ponto fraco dela (trocar a
estratégia) foi resolvido colocando o fingerprint na chave. **Evolução:** cache em duas camadas
(por provider + final) quando houver TTLs diferentes por fornecedor.

### 2. Chave versionada e normalizada

`search:v1:{ORIG}:{DEST}:{YYYY-MM-DD}:{estratégia:τ:teto:k}`. IATA já em maiúsculas (`gru` e
`GRU` dão a mesma chave). O `v1` invalida tudo de uma vez quando o formato do snapshot mudar.
Entrada corrompida (JSON inválido) é tratada como miss e apagada.

### 3. Resposta PARCIAL: cacheada por apenas 30 s

Um provider que caiu por 10 segundos não pode deixar a resposta degradada congelada por 5 minutos.
Não cachear nada, porém, faria toda busca durante um incidente bater de novo nos providers
saudáveis e no doente (que está pendurando 3 s). **30 s** amortecem a carga durante o incidente e
fazem o provider recuperado reaparecer rápido. Configurável (`PARTIAL_CACHE_TTL_SECONDS`, 0 =
não cacheia). Quando todos falham, não há cache (503).

### 4. Cache stampede: single-flight em processo

Buscas idênticas simultâneas compartilham **uma** ida aos providers (`SingleFlight`).
**Medido ao vivo:** 20 buscas simultâneas POA→REC numa chave nova geraram **1 chamada por
provider** (contadas nos logs de acesso dos mocks). Cada requisição ainda recebe o próprio
`searchId` e é persistida (é demanda real).
**Limite:** escopo por processo; com N réplicas, o pior caso são N chamadas por chave.
**Evolução:** lock distribuído (`SET key NX PX`) + espera pelo resultado no cache, ou
*stale-while-revalidate* (servir o valor que acabou de expirar enquanto um único worker renova).

### 5. Redis fora do ar nunca derruba a busca

- Cliente configurado para **falhar rápido**: `enableOfflineQueue: false` (o default enfileira
  comandos para sempre e a busca penduraria), `maxRetriesPerRequest: 0` e `commandTimeout: 200 ms`
  (Redis lento também vira miss).
- O use case trata qualquer erro de cache como miss e segue (log `warn`; métrica na fase de
  observabilidade).
- A conexão continua tentando voltar em background (backoff até 2 s). O boot espera até 2 s pelo
  Redis, mas **não bloqueia**: sobe degradado.
- **Testado:** Redis desligado (falha em < 100 ms e a busca responde), Redis "pendurado" (aceita
  TCP e não responde: o `commandTimeout` resolve) e, ao vivo, `docker compose stop redis` →
  buscas seguem → `start` → o cache volta sozinho.

### 6. Redis configurado como cache puro

`--save "" --appendonly no` (sem persistência: o cache se reconstrói em 5 min),
`--maxmemory 128mb --maxmemory-policy allkeys-lru` (nunca cresce sem limite) e porta publicada só
em `127.0.0.1`.

## Alternativas descartadas

- **Não cachear parciais:** é seguro, mas amplifica a carga justamente durante incidentes.
- **Cache em memória por instância:** não é compartilhado entre réplicas. Fica como fallback de
  desenvolvimento quando não há `REDIS_URL`.
- **Lock distribuído já agora:** resolve um problema que só aparece com várias réplicas, ao custo de
  latência e complexidade. Fica documentado como evolução.
