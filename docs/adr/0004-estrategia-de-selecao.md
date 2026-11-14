# ADR 0004: Estratégia de seleção de ofertas (banda de tolerância)

- **Status:** aceito (checkpoint da Fase 3: τ = 1,5%, teto R$ 25, **k = 0**)
- **Data:** 2026-11-14

## Contexto

Quando vários providers vendem o mesmo voo, precisamos escolher **uma** oferta para exibir. O
enunciado pede uma estratégia que (a) **maximize o resultado do negócio** e (b) **não prejudique
significativamente o cliente**. Incentivo por emissão: A 1%, B 1,5%, C 2%.

### O sinal de alerta

O incentivo é um **percentual do preço**. "Maximizar incentivo em R$" sem limite empurra para a
oferta **mais cara**: quanto mais o cliente paga, mais ganhamos. Só que a receita real é
`P(emissão) × incentivo`, e preço pior derruba `P(emissão)`. O agente compara com outras
ferramentas e o cliente final pesquisa no Google Flights. Ganhar R$ 10 deixando o cliente R$ 10
mais pobre é transferência de valor, não criação de valor, e corrói a confiança do agente na
plataforma.

### Como os mocks precificam (medido, constante em todos os voos)

Markup sobre o mesmo preço-base: **A = 1,000 · B = 0,985 · C = 1,012**.

| Par | Cliente paga | Empresa ganha (% do base) | Leitura |
|---|---|---|---|
| B vs A | **−1,5%** | +0,48 p.p. (1,48% vs 1,00%) | **B domina A** (Pareto): mais barato **e** rende mais. Até a `cheapest` escolhe B |
| C vs B | +2,74% | +0,55 p.p. | Cliente perde ~5× o que a empresa ganha. Troca ruim |
| C vs A | +1,20% | +1,02 p.p. | **A única decisão discutível do dataset**: cliente perde R$ 1,17 para cada R$ 1,00 que a empresa ganha |

## Decisão

Implementar o padrão **Strategy** (`OfferSelectionStrategy`) com três estratégias, escolhidas por
feature flag, sendo a **`balanced` o padrão**:

1. `cheapest`: menor preço; em empate de preço, maior incentivo (ganho sem custo). Baseline do
   cliente e referência de todas as métricas.
2. `max_incentive`: maior incentivo em R$. Baseline do negócio, que existe para **mostrar por que
   não usar**.
3. **`balanced`** (banda de tolerância):

```
p_min     = menor preço do voo
elegível  ⇔ preço ≤ p_min × (1 + τ)                  (limite relativo)
          ∧ preço − p_min ≤ teto                       (limite absoluto)
          ∧ ganho ≥ k × (preço − p_min)   [se k > 0]   (a empresa precisa "pagar" o custo do cliente)
escolha   = maior incentivo entre as elegíveis
desempate = menor preço → menor duração → ordem fixa de provider (determinístico)
```

Parâmetros iniciais: **τ = 1,5% (150 bps), teto = R$ 25, k = 0**. Toda a aritmética é inteira
(centavos × basis points).

### Exemplo numérico (preço-base R$ 800, vendido por A e C)

| | A | C |
|---|---|---|
| Preço | R$ 800,00 | R$ 809,60 (+1,2%) |
| Incentivo | R$ 8,00 (1%) | R$ 16,19 (2%) |

- Banda: 809,60 ≤ 800 × 1,015 = 812,00 ✔ · Teto: 9,60 ≤ 25 ✔ → elegível, e C tem o maior
  incentivo → **C**.
- Metadados: `deltaToCheapestCents = 960`, `incentiveGainVsCheapestCents = 819`.
- Com k = 1: 819 ≥ 960? ✘ → **A**.

### Resultado do `npm run simulate` (mocks reais)

GRU→GIG em 2026-12-12, 60 voos (a soma é um indicador relativo; o cliente compra um voo só):

| Estratégia | Incentivo total | Δ vs cheapest | Custo extra p/ cliente | R$ cliente por R$ 1 (marginal) | Voos ≠ mais barato |
|---|---|---|---|---|---|
| cheapest | R$ 625,61 | — | R$ 0,00 | — | 0/60 |
| balanced k = 1 | R$ 625,61 | R$ 0,00 | R$ 0,00 | — | 0/60 |
| **balanced τ=1,5% R$25** | **R$ 701,90** | **+R$ 76,29 (+12,2%)** | **R$ 89,38** | **1,17** | **10/60** |
| max_incentive | R$ 803,47 | +R$ 177,86 (+28,4%) | R$ 591,11 | **4,94** | 35/60 |

Em 15 buscas (5 rotas × 3 datas, 900 voos), as proporções são **idênticas**: +12,2% / R$ 1,17 /
16,7% de voos diferentes do mais barato. A diferença de 1–2 centavos em relação à análise prévia
vem de arredondar o incentivo por oferta, em centavos, e não somar floats.

**Leitura:** a `balanced` captura **43%** do ganho máximo possível (76,29 de 177,86) com **15%**
do custo para o cliente (89,38 de 591,11). Ir além dela custa ao cliente **R$ 4,94 por R$ 1,00**
de incentivo extra, e escolhe o mais caro em 58% dos voos.

### Calibração de τ (varredura sobre 900 voos)

| τ | Efeito |
|---|---|
| < 1,20% | nenhuma troca (idêntico ao cheapest) |
| **1,20% a 2,74%** | **platô**: troca só A→C nos voos vendidos por A+C (+12,2% de incentivo, R$ 1,17 por R$ 1) |
| ≥ 2,75% | libera C sobre B: incentivo +26,8%, mas o custo para o cliente sobe 6× (R$ 4,94 por R$ 1 na margem) |

**τ = 1,5% fica no meio do platô:** pequenas variações de preço não mudam a decisão. O teto de
R$ 25 não morde neste dataset (200 trocas A→C medidas em 20 buscas: delta entre R$ 5,89 e
R$ 12,79, mediana R$ 9,07; passagens de R$ 406 a R$ 1.132), mas protege passagens acima de
~R$ 2.080 (25 / 1,2%), onde 1,2% já vira dinheiro que o cliente sente.

### k = 0 ou k = 1? Decidido: **k = 0** (aceita a troca A→C)

Motivo: o enunciado pede para **maximizar** o resultado do negócio, com o limite de não
prejudicar **significativamente** o cliente. Uma diferença de +1,2% (mediana de R$ 9,07),
limitada por τ e pelo teto absoluto, fica dentro da variação normal de tarifa. O argumento
contrário (o cliente perde R$ 1,17 por R$ 1 ganho) está registrado abaixo. k continua
configurável por feature flag, para um A/B ou para endurecer a regra sem deploy.

| | k = 0 (aceita A→C) | k = 1 (conservador) |
|---|---|---|
| Incentivo | **+12,2%** | +0% neste dataset |
| Cliente | paga +1,2% em 1 a cada 6 voos (~R$ 9 por voo afetado) | nunca paga a mais sem a empresa ganhar pelo menos o mesmo |
| Defesa | "1,2% está dentro da variação normal de tarifa e é limitado por τ e pelo teto: não é *significativo*" | "Só troco quando gero mais valor do que transfiro: a soma empresa + cliente nunca piora" |
| Risco | percepção de "plataforma que não mostra o mais barato" | deixa receita na mesa; aqui equivale ao cheapest |

O limiar exato é **k ≈ 0,85**: abaixo dele a troca A→C acontece; acima, não.

## Alternativas consideradas

1. **Sempre o mais barato.** Seguro para o cliente, mas ignora metade do enunciado
   ("maximizar o negócio"). Aqui já captura a dominância de B, mas não decide nada sozinho.
2. **Sempre o maior incentivo.** Maximiza a receita por emissão, mas não a receita esperada:
   +28% de incentivo à custa de R$ 591 do cliente, escolhendo o mais caro em 58% dos voos.
3. **Score ponderado** (`α·incentivo − β·preço`). Contínuo e flexível, mas α e β não têm
   significado de negócio: ninguém na operação sabe dizer se α = 0,7 é "justo". Além disso, um
   score linear pode aceitar delta grande quando o incentivo é grande, exatamente o caso a evitar.
4. **Banda de tolerância (escolhida).** Os parâmetros falam a língua do negócio ("aceito até 1,5%
   ou R$ 25 a mais"), são auditáveis por voo (metadados) e fáceis de testar em A/B.

## Consequências e riscos

- **Transparência:** cada oferta carrega `selection { strategy, alternativesCount,
  cheapestPriceCents, cheapestProvider, deltaToCheapestCents, incentiveGainVsCheapestCents }`.
  Isso alimenta o dashboard ("quanto ganhamos a mais e quanto custou ao cliente").
- **Percepção de preço / confiança do agente:** mitigada por τ e pelo teto. A evolução é mostrar
  ao agente o "mais barato disponível" quando a escolha diferir.
- **Regulação/transparência ao consumidor:** o preço exibido é real e emitível; não há preço
  oculto. Mesmo assim, a política deve ser documentada para auditoria (os metadados permitem).
- **Moedas diferentes:** a estratégia **rejeita** (`SelectionInvariantError`). Converter exigiria
  câmbio que não temos, e o mapper já descarta moeda ≠ BRL.
- **Evolução:** (1) calibrar τ com dados reais de conversão por faixa de delta; (2) trocar a regra
  por receita esperada `P(emissão | Δpreço) × incentivo` quando houver dados; (3) teste A/B de τ
  e k por agência via feature flag; (4) τ por faixa de preço ou por rota.
