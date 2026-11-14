# ADR 0005: Contrato do POST /search, paralelismo e degradação

- **Status:** aceito
- **Data:** 2026-11-14

## Contexto

O enunciado exige consultas paralelas, timeout de 3 s por provider, resposta mesmo com falha de
algum provider e ordenação consistente. Os mocks não validam nada (aceitam rota "XXX→YYY" e data
passada).

## Decisão

### Entrada (validada só no agregador)

`{ origin, destination, date }`: IATA de 3 letras (normalizado para maiúsculas), origem ≠ destino,
data `YYYY-MM-DD` real, **não passada** (no fuso `America/Sao_Paulo`, não em UTC: às 22h de
Brasília ainda é "hoje") e no máximo 365 dias à frente. Todos os problemas voltam de uma vez
(Problem Details com `errors[]`), para o front marcar todos os campos. Campos extras são
ignorados.

### Fluxo

```
validar → chave de cache → hit? responde
       → 3 providers em paralelo (Promise.allSettled, deadline por provider)
       → mappers (normalização) → dedup + estratégia → ordenação → cache → persistência async
```

- **`Promise.allSettled`, não `Promise.all`:** o `all` rejeita no primeiro provider que falha e
  descarta o que os outros responderam. Cada chamada também converte a própria falha em
  relatório; o `allSettled` é a segunda garantia caso um bug escape.
- **Deadline em duas camadas:** `AbortSignal.timeout(3000)` vai para o `fetch`, e o undici
  cancela o socket (testado: o servidor vê a conexão fechar). Além disso, o use case corre contra
  o mesmo sinal (`withDeadline`). Mesmo um adapter que ignore o sinal não segura a resposta além
  de 3 s (bulkhead).
- **Status por provider na resposta:** `ok | timeout | error | circuit_open | disabled`, com
  latência, ofertas e descartes. `errorCode` estável, nunca mensagem interna.

### Códigos HTTP

| Situação | Código | Por quê |
|---|---|---|
| Tudo ok | 200 | — |
| Algum provider falhou | **200**, `meta.partial = true` | Resultado útil é melhor que erro. O agente vê o que há e o front pode avisar "alguns fornecedores não responderam" |
| Providers responderam, sem voos | **200**, `results: []` | "Não há voos" é uma resposta válida |
| Entrada inválida | 400 Problem Details | — |
| **Todos** falharam | **503** Problem Details | Não dá para afirmar "não há voos". Um 200 vazio levaria o agente a dizer ao cliente que não existe voo. 503 é retentável e aparece nos alertas |

`disabled` (kill switch) não conta como falha nem marca `partial`: é uma decisão operacional.

### Ordenação (ordem total)

Preço ↑ → partida ↑ → duração ↑ → `flightKey`. A última chave é única após a dedup, então a mesma
entrada sempre produz a mesma saída (testado embaralhando providers e repetindo a busca ao vivo).

### Resposta

```json
{ "searchId": "...", "query": {...}, "results": [ { ...FlightOffer, "selection": {...} } ],
  "meta": { "cached", "partial", "generatedAt", "strategy", "resultsCount", "providers": [...] } }
```

`searchId` é novo a cada requisição, inclusive em cache hit (cada busca é um evento de demanda).
`generatedAt` é o momento do cálculo original, para o cliente saber a idade do dado.

**Exposição de `incentive*` e `selection`:** o consumidor é o front interno da PassHub (BFF), não
o cliente final, e a transparência da decisão é requisito. Uma API pública teria uma view sem
esses campos.

### Cache: chave inclui a estratégia

`search:v1:{ORIG}:{DEST}:{DATA}:{fingerprint da estratégia}`, por exemplo
`...:balanced:150:2500:0`. Trocar a estratégia ou τ por feature flag passa a valer **na hora**, sem
esperar 5 min de TTL. O `v1` permite invalidar tudo ao mudar o formato.

## Alternativas consideradas

- **200 vazio quando todos falham:** mais simples para o cliente, mas mente ("sem voos" ≠
  "não consegui perguntar").
- **Timeout só via `Promise.race`:** não cancela a requisição, e o provider pendurado continua
  consumindo socket e memória por 30 s. Por isso as duas camadas.
- **Validação via schema do Fastify (JSON Schema):** cobriria o formato, mas "não pode estar no
  passado no fuso de negócio" é regra de domínio e precisa do relógio injetado. Com a validação
  no use case, ela fica testável sem HTTP.

## Consequências

- A resposta parcial é cacheada por pouco tempo (30 s), detalhado no ADR de cache.
- A persistência é fire-and-forget: perder um registro analítico é aceitável, atrasar a busca não.
