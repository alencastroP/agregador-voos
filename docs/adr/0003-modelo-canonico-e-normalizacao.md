# ADR 0003: Modelo canônico, normalização e chave de deduplicação

- **Status:** aceito
- **Data:** 2026-11-14

## Contexto

Os três providers devolvem o mesmo voo com nomes de campo, unidade de preço, granularidade de data
e grafia de companhia diferentes (detalhes em `docs/providers.md`). Nenhum manda número de voo,
escalas, cabine ou fuso. Dois deles mandam lixo de propósito (moeda estrangeira, tarifa zero).

## Decisão

1. **Modelo `FlightOffer` só com o que existe:** `flightKey`, `airline {code, displayName}`,
   `origin`, `destination`, `departureAt`, `arrivalAt`, `durationMinutes` (derivado),
   `price {amountCents, currency}`, `provider`, `incentiveRateBps`, `incentiveAmountCents`.
   **Sem** `flightNumber`/`stops`/`cabin`: nenhum provider manda, e inventar seria mentir para o
   agente.
2. **Preço em centavos inteiros** (ADR 0002 / `money.ts`), convertido uma única vez na borda.
3. **Horário local sem fuso**, no formato `YYYY-MM-DDTHH:MM:SS`. Para B e C: data da busca +
   `HH:MM`, com chegada em D+1 quando `chegada ≤ partida`.
4. **Companhia:** NFKD → sem acento → minúsculas → só `[a-z0-9]` → remove sufixos (`airlines`,
   `linhas aereas`...) → tabela de aliases (`passaredo → VOEPASS`). Companhia desconhecida
   **não é descartada**: vira chave própria e é reportada (log `warn` + métrica).
5. **Chave de dedup:** `AIRLINE|YYYY-MM-DDTHH:MM` da partida. Origem, destino e data já são os da
   busca.
6. **Falha em dois níveis:**
   - envelope fora do contrato (sem a lista, HTML de erro...) → `ProviderContractError`. O
     provider inteiro conta como falha naquela busca;
   - item ruim → descartado com motivo (`malformed`, `unsupported_currency`, `invalid_price`,
     `invalid_schedule`), sem afetar os outros itens.
7. **Mapper puro** (`createMapper`): payload + query → `{offers, discarded, unknownAirlines}`.
   Log e métrica ficam com quem chama, então o mapper é testável com as fixtures reais.

## Alternativas consideradas

- **Converter para UTC.** Exigiria uma tabela IATA→timezone que não temos. Ficou como evolução
  (OurAirports).
- **Descartar companhia desconhecida.** Esconde inventário real. Manter tem como pior caso não
  deduplicar, o que é visível e se corrige com a tabela de aliases.
- **Rejeitar a resposta inteira por um item ruim.** Um registro sujo derrubaria 40 ofertas
  boas.
- **Similaridade de texto (Levenshtein) para companhia.** "Passaredo" × "Voepass" não tem
  similaridade nenhuma; alias explícito é previsível e auditável.
- **Chave com chegada ou preço.** A chegada é redundante (é igual entre providers, confirmado) e o
  preço varia por provider, que é justamente o que queremos comparar.

## Consequências

- (+) Os 4 voos noturnos, as 12 grafias e os 2 registros sujos ficaram cobertos por testes contra
  respostas reais (`tests/unit/infrastructure/mappers.test.ts`).
- (−) Sem número de voo, dois voos da mesma companhia no mesmo minuto colidiriam. Não acontece no
  catálogo; com provider real, o número do voo entra na chave.
- (−) Suposição: o provider-c cobra em BRL. Se mudar, a moeda vira campo explícito no schema
  dele.
