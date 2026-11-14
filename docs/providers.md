# Providers: contratos, diferenças e comportamento medido

> Fonte da verdade: os mocks rodando (`mocks/app/main.py` + `mocks/app/catalog.py`, sem modificação).
> Tudo abaixo foi confirmado com chamadas reais em 2026-11-14. As respostas brutas de GRU→GIG em
> 2026-12-12 estão em `aggregator/tests/fixtures/provider-{a,b,c}.2026-12-12.GRU-GIG.json`.

## 1. Interface comum dos três

| Aspecto | Comportamento observado |
|---|---|
| Rota | `/provider-{a,b,c}/search`, porta interna 3000 (expostas no host em 3001/3002/3003) |
| Métodos | `GET` (query string) e `POST` (JSON) devolvem **exatamente** a mesma resposta |
| Parâmetros | `origin`, `destination`, `date` (também aceitam `origem`, `destino`, `data`) |
| Rota inválida (`XXX→YYY`) | **200** com a malha completa. O mock não valida IATA, então a validação é responsabilidade do agregador |
| Data inválida (`12/12/2026`) | **400** `{"detail": "date inválida (use YYYY-MM-DD)"}` |
| Data passada (`2020-01-01`) | **200**. O mock aceita, então o agregador precisa barrar |
| Body vazio / sem body | **200**, com defaults `GRU`, `GIG` e a data de hoje do servidor |
| Malha | Ignora origem/destino: qualquer rota devolve os mesmos voos. Só o preço muda (±4%, por hash de rota+data) |
| Determinismo | Mesma (rota, data) gera sempre os mesmos preços, o que favorece cache e testes |
| Health | `GET /health` → `{"status":"ok","provider":"a",...}` |

## 2. Contrato de cada provider

### provider-a
```json
{ "flights": [ { "company": "LATAM", "price": 796.33,
                 "depart_at": "2026-12-12T08:00:00", "arrive_at": "2026-12-12T11:10:00" } ] }
```
- Preço em **reais, float**. Converter com `Math.round(price * 100)`.
- Data e hora ISO completas, **sem fuso**. A chegada já vem em D+1 quando o voo vira a noite.

### provider-b
```json
{ "results": [ { "airline_name": "Latam", "amount": 78439, "currency": "BRL",
                 "departure": "08:00", "arrival": "11:10" } ] }
```
- Preço em **centavos, inteiro**, com moeda explícita.
- Só `HH:MM`. A data vem da busca, e a chegada recebe +1 dia quando `chegada ≤ partida`.

### provider-c
```json
{ "data": [ { "carrier": "Azul Linhas Aereas", "fare": 776.91,
              "departure_time": "08:15", "arrival_time": "11:30" } ] }
```
- Preço em **reais, float**, **sem moeda**. Suposição declarada: BRL.
- Só `HH:MM`, com a mesma regra de D+1 do provider-b.

### Tabela de diferenças

| | A | B | C |
|---|---|---|---|
| Lista | `flights` | `results` | `data` |
| Companhia | `company` | `airline_name` | `carrier` |
| Preço | `price` (R$ float) | `amount` (centavos int) | `fare` (R$ float) |
| Moeda | implícita (BRL) | `currency` | implícita (BRL) |
| Partida | `depart_at` (ISO datetime) | `departure` (HH:MM) | `departure_time` (HH:MM) |
| Chegada | `arrive_at` (ISO datetime, já em D+1) | `arrival` (HH:MM) | `arrival_time` (HH:MM) |
| Itens por busca | 40 | 40 + 1 sujo | 40 + 1 sujo |

Nenhum provider devolve número de voo, escalas, cabine, bagagem ou id da oferta. O modelo canônico
**não** terá esses campos.

## 3. Grafia das companhias e mapa de aliases

| Canônica | provider-a | provider-b | provider-c |
|---|---|---|---|
| LATAM | `LATAM` | `Latam` | `Latam Airlines` |
| GOL | `GOL` | `Gol` | `Gol Linhas Aéreas` |
| AZUL | `AZUL` | `Azul` | `Azul Linhas Aereas` (sem acento) |
| VOEPASS | `VOEPASS` | **`Passaredo`** | `Voepass` |

Algoritmo de normalização:
1. NFKD, remover diacríticos, lowercase, trim e colapsar espaços;
2. remover sufixos: `airlines`, `linhas aereas`;
3. aplicar o mapa de aliases: `passaredo → VOEPASS`. "Passaredo" é o nome antigo da Voepass e não
   se resolve com normalização de texto, só com tabela;
4. se o resultado estiver no conjunto conhecido (`LATAM | GOL | AZUL | VOEPASS`), usar a chave canônica.

**Companhia desconhecida:** nunca descartar. A chave passa a ser o nome normalizado em maiúsculas,
o sistema loga um `warn` e incrementa `airline_unknown_total{provider,name}`. Motivo: descartar
esconderia inventário legítimo. O pior caso de manter é não deduplicar um voo que deveria ser
deduplicado, o que é visível e corrigível pela tabela de aliases.

## 4. Chave de deduplicação

`flightKey = {AIRLINE_CANONICA}|{YYYY-MM-DDTHH:MM da partida local}` (origem, destino e data vêm da query).

Validado na fixture:
- 120 ofertas válidas viram **60 voos únicos**;
- distribuição: 15 vendidos por A+B+C, 10 por A+B, 10 por A+C, 10 por B+C e 5 exclusivos de cada provider;
- nenhuma chave tem duas ofertas do mesmo provider;
- dentro de uma mesma chave, a chegada é sempre a mesma nos três providers (sem conflito de horário).

Limitação conhecida: sem número de voo, dois voos da mesma companhia no mesmo minuto colidiriam.
O catálogo não tem esse caso. Num provider real, a chave incluiria o número do voo.

## 5. Voos que viram a noite (4)

| Companhia | Partida | Chegada |
|---|---|---|
| AZUL | 21:09 | 00:12 (D+1) |
| LATAM | 21:28 | 00:54 (D+1) |
| VOEPASS | 22:25 | 00:30 (D+1) |
| VOEPASS | 22:30 | 01:15 (D+1) |

## 6. Dados sujos (ativos por padrão, `DIRTY=1`)

| Provider | Registro | Motivo do descarte |
|---|---|---|
| B | `Copa Airlines`, 21000 **USD**, 14:40 | `unsupported_currency`: não fazemos câmbio |
| C | `Gol`, fare **0.0**, 15:00 | `invalid_price`: tarifa zerada (assento esgotado) |

Nenhum dos dois colide com uma chave real. Ambos são descartados e contados em
`offers_discarded_total{provider,reason}`, sem derrubar a resposta.

## 7. Preços relativos (markup do mock)

Medido na fixture e constante em todos os voos: **B/A = 0,9850**, **C/A = 1,0120**, **C/B = 1,0274**.
A análise de negócio disso está no ADR da estratégia de seleção.

## 8. Comportamento de latência e falha (medido)

Latência normal, 30 chamadas sequenciais por provider:

| Provider | min | p50 | p95 | max |
|---|---|---|---|---|
| A | 110 ms | 294 ms | 421 ms | 450 ms |
| B | 99 ms | 307 ms | 462 ms | 478 ms |
| C | 95 ms | 318 ms | 449 ms | 468 ms |

Chaos (`FAIL_RATE=0.3`, `TIMEOUT_RATE=0.3`), 200 chamadas com timeout de 3 s no cliente:

| Resultado | Medido | Esperado pelo código |
|---|---|---|
| 200 OK | 54,0% | 49% |
| 500 | 22,0% (mediana de **8 ms**, imediato) | 21% |
| Pendurado (> 3 s) | 24,0% | 30% |

**Atenção:** o mock sorteia o timeout **antes** do 500 (`_simulate_conditions`). Por isso as taxas
reais são 30% de pendurados, 0,7 × 0,3 = **21%** de 500 e **49%** de sucesso por tentativa, e não
"30% de 500 + 30% de pendurados" independentes. A taxa de sucesso por tentativa (49%) coincide com
a conta 0,7 × 0,7. A diferença entre medido e esperado está dentro do ruído amostral (n = 200,
desvio padrão de cerca de 3,5 pontos).

Implicação de desenho: como a latência normal é ≤ ~480 ms e uma falha pendurada dura 30 s, um
timeout **por tentativa** de ~1 s dentro do deadline de 3 s por provider permite abandonar a
chamada pendurada e tentar de novo. O 500 chega em ~8 ms, então o retry nesse caso é quase grátis.

## 9. Fuso horário

Nenhum provider informa fuso. Decisão: tratar todos os horários como **hora local do aeroporto de
origem** e mantê-los como data-hora local ISO, sem `Z` nem offset. Sem uma tabela IATA→timezone,
converter para UTC seria inventar dado. `durationMinutes` é calculado como chegada − partida, o que
é exato para voos domésticos no mesmo fuso e aproximado entre fusos diferentes.
Evolução: tabela IATA→IANA timezone (ex.: OurAirports), com partida e chegada em UTC mais o offset local.
