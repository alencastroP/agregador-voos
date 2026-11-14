# ADR 0007: Resiliência (retry dentro do orçamento + circuit breaker por chamada lógica)

- **Status:** aceito
- **Data:** 2026-11-14

## Contexto

Comportamento medido dos mocks (docs/providers.md §8):

- latência normal: **≤ ~480 ms**;
- chaos (`make chaos`): o mock sorteia **pendurar 30 s** (30%) **antes** de devolver **500
  imediato** (0,7 × 0,3 = 21%), então só **49% das tentativas** dão certo;
- requisito: **3 s por provider**.

## Decisões

### 1. Composição por decorators

```
CircuitBreaker → Retry → HTTP (fetch + AbortSignal)
```

O circuito fica **por fora** para contar **chamadas lógicas** (já com retry), não tentativas.

### 2. Retry: só transitório, orçamento compartilhado, timeout por tentativa

| Parâmetro | Valor | Por quê |
|---|---|---|
| Orçamento total | **3.000 ms** | Requisito. É **compartilhado** entre as tentativas (não são 3 s por tentativa) |
| Timeout por tentativa | **1.000 ms** | ~2× o p99 normal (480 ms). Abandona a chamada pendurada (30 s) e tenta de novo |
| Máx. tentativas | 3 | 3 × 1 s cabem no orçamento |
| Backoff | exponencial **com full jitter**: `random() × min(250, 50·2ⁿ⁻¹)` ms | Espalha retries simultâneos (sem "manada" sincronizada) |
| Tentativa mínima | 500 ms | Não começa uma tentativa que não teria tempo de terminar |

- **Retentável:** 5xx, 429, 408, erro de rede, tentativa que estourou o **próprio** timeout.
- **Não retentável:** 4xx de validação e payload fora do contrato (falhariam igual de novo).
- Cada tentativa recebe `AbortSignal.any([deadline, timeout(min(1 s, restante))])`. Quando o
  deadline do use case dispara, a tentativa em curso é cancelada e o erro vira "orçamento
  esgotado".

**Conta (para a banca):** 1 tentativa acerta 0,7 × 0,7 = 49%; 3 tentativas acertam
1 − 0,51³ ≈ **87%**.

### 3. Circuit breaker por provider

Janela deslizante das **últimas 20 chamadas lógicas**, mínimo de 10 chamadas, abre com **≥ 50%**
de falha e fica aberto **10 s**. Depois, half-open deixa passar **uma** sonda: sucesso fecha,
falha reabre. Circuito aberto: o provider é pulado **na hora** (`status: circuit_open`, zero
latência).

Conta como falha: timeout, 5xx/429/rede e payload fora do contrato. **4xx não conta** (é erro
nosso, não do provider).

**Por que por chamada lógica:** por tentativa, a taxa de falha sob chaos é 51%, acima do limiar,
e o circuito abriria o tempo todo, desligando um provider que, com retry, entrega 87–89%.

**Implementação própria (~80 linhas) e não opossum:** o opossum também faz timeout e fallback
(duplicaria o deadline e o retry) e conta por tentativa da função que envolve. Aqui a semântica
fica explícita e testável com relógio injetado.

### 4. Bulkhead

Cada provider tem deadline próprio (`withDeadline` + `AbortSignal`), e as chamadas são
independentes (`allSettled`). Um provider lento ou fora nunca segura os outros: no teste de carga,
A e B ficaram em 100% com latência normal enquanto o C sofria chaos.

## Evidência: `make chaos` + `npm run load` (200 buscas únicas, concorrência 10)

| | provider-c ok | timeout | error | circuit_open | tentativas (1/2/3) | p99 provider-c | buscas parciais |
|---|---|---|---|---|---|---|---|
| **Com retry** (padrão) | **89,0%** | 6,5% | 4,5% | **0%** | 88 / 56 / 56 | **3.004 ms** | 11% |
| Sem retry (`PROVIDER_MAX_ATTEMPTS=1`) | 3,0% | 4,5% | 2,0% | **90,5%** | — | 1.005 ms | 97% |

- O retry entregou **89%** (teoria: 87%) **sem abrir o circuito**.
- Sem retry, a falha por tentativa (~51%) abriu o circuito após 19 chamadas, e ele ficou aberto
  pelo resto do teste. Isso confirma por que o breaker **não** deve contar tentativas.
- O p99 do provider-c ficou em 3.004 ms: o orçamento de 3 s é respeitado.
- Em todos os casos: **100% HTTP 200**.

## Consequências

- (+) Com um provider instável, a busca continua rápida para os outros e recupera ~89% das
  ofertas do instável.
- (−) O p95 da busca sobe para ~2,4 s quando o provider com chaos precisa de retry. É o preço de
  recuperar as ofertas dele. A alternativa (retornar sem esperar o C) é uma evolução possível:
  **resposta progressiva** (streaming/SSE por provider) ou um "soft deadline" que devolve
  parcial aos 1,5 s e completa o cache em background.
- (−) Os parâmetros foram calibrados contra mocks. Em produção, o timeout por tentativa sairia do
  p99 real de cada provider (métrica `provider_request_duration_seconds`).
