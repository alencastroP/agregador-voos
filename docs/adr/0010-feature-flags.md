# ADR 0010: Feature flags com OpenFeature (provider de arquivo com recarga a quente)

- **Status:** aceito
- **Data:** 2026-11-14

## Contexto

Três decisões precisam mudar **sem deploy**: (1) desligar um provider em incidente (kill
switch); (2) calibrar a estratégia (τ, teto, k) e testá-la em A/B por agência; (3) desligar o
cache se ele causar problema.

## Decisão

- **Port na aplicação:** `FeatureFlags.evaluate({ agencyId })` → `SearchFlags` (estratégia +
  parâmetros, kill switch por provider, cache), resolvido **uma vez por busca**. O use case não
  conhece o OpenFeature.
- **OpenFeature** (padrão aberto, CNCF) no adapter. O provider é **próprio, baseado em arquivo**
  (`flags/flags.json`, montado read-only no container), relido por polling a cada 2 s.
  **Precedência:** variável de ambiente (`FLAG_PROVIDER_C_ENABLED=false`) > arquivo (valor por
  agência > valor geral) > default do `.env`.
- **Nunca quebra a busca:** flag ausente, tipo errado ou valor fora do domínio (τ negativo,
  estratégia inexistente) caem no default, com log `warn`. Arquivo inválido mantém a última
  versão boa.
- **Chave de cache inclui estratégia + parâmetros + providers ligados.** Sem isso, uma agência
  com o provider-c desligado receberia do cache a resposta de outra (há teste para isso).
- **Agência:** header opcional `x-agency-id` vira o `targetingKey` do OpenFeature.

| Flag | Tipo | Default | Caso de uso real |
|---|---|---|---|
| `selection.strategy` | string | `balanced` | trocar a política inteira (ex.: `cheapest` para uma agência sensível a preço) |
| `selection.tolerancePctBps` | number | `150` | **A/B de τ** por agência; calibrar com dados de conversão |
| `selection.maxDeltaCents` | number | `2500` | apertar o teto em alta temporada |
| `selection.minGainRatio` | number | `0` | endurecer para "a empresa precisa ganhar ≥ k × o que o cliente perde" |
| `provider.{a,b,c}.enabled` | boolean | `true` | **kill switch** em incidente ou tarifa errada de um fornecedor |
| `cache.enabled` | boolean | `true` | desligar o cache se ele servir dado ruim |

## Evidência (ao vivo, container rodando)

Editando `flags/flags.json` sem reiniciar nada: `provider.c.enabled=false` → a próxima busca
veio com `provider-c: disabled` e 55 voos (~2 s depois). Um override por agência
(`"agencies": {"agencia-teste": "cheapest"}`) → a `agencia-teste` recebeu `cheapest`, enquanto
as outras seguiram com `balanced`.

## Alternativas consideradas

- **Variáveis de ambiente apenas:** exigem restart, e não permitem valor por agência.
- **flagd, Unleash ou LaunchDarkly já agora:** é mais um serviço para operar no desafio. Com
  OpenFeature, a migração é trocar o provider em `main.ts`. Em produção eu usaria flagd (mesmo
  formato de arquivo, com sync via Git/Kubernetes) ou LaunchDarkly (UI, auditoria, rollout
  percentual).
- **Rollout percentual (hash do targetingKey):** fácil de acrescentar no provider; ficou de fora
  porque A/B por lista de agências é suficiente para calibrar τ com um grupo controlado.

## Consequências

- (+) O incidente "fornecedor mandando tarifa errada" se resolve em segundos, sem deploy.
- (+) Calibrar τ vira experimento, não discussão: um grupo de agências com τ = 1,2% e outro com
  1,5%, comparando conversão no dashboard.
- (−) O arquivo é local a cada instância. Com N réplicas, o arquivo precisa vir de um volume
  compartilhado ou ConfigMap; a evolução natural é o flagd.
- (−) Sem auditoria de quem mudou a flag (só o histórico do git do arquivo).
