# Agregador de Voos: Desafio PassHub

> README em construção: as seções de arquitetura, estratégia, resiliência, cache, observabilidade,
> testes e deploy entram conforme as fases forem concluídas.

- Contratos dos providers, medidos contra os mocks rodando: [docs/providers.md](docs/providers.md)

## Ajustes no ambiente fornecido

Nenhum arquivo de `mocks/` foi alterado (`git diff a31f827 -- mocks/` é vazio; o commit `a31f827`
é o scaffold original, intocado). Os ajustes abaixo são de configuração e tooling:

| # | Problema encontrado | Correção |
|---|---|---|
| 1 | `docker-compose.yml` com **YAML inválido**: as linhas `FAIL_RATE`/`TIMEOUT_RATE` do provider-c estavam descomentadas com 7 espaços de indentação (o resto usa 6), e o `docker compose up` falhava (`ParserError` na linha 39, coluna 8) | Voltaram a ficar comentadas, que é a intenção do comentário original ("descomente para ver..."). O chaos fica desligado por padrão |
| 2 | `make chaos` rodava `docker compose run --service-ports provider-c` com o provider-c original ainda ocupando a porta 3003, o que dava conflito de porta. Além disso, o container avulso não substitui o serviço que o agregador acessa | Novo `docker-compose.chaos.yml` (override só com as envs de chaos). `make chaos` recria o **próprio** serviço `provider-c` com o override, e `make calm` volta ao normal |
| 3 | `make search` usava a data fixa `2026-10-12`, que já passou e é rejeitada pela validação do agregador | Data dinâmica (hoje + 30 dias), sobrescrevível: `make search SEARCH_DATE=2026-12-12 ORIGIN=CGH DEST=SDU`. O interpretador é configurável (`PYTHON=python`) para ambientes sem `python3` |
| 4 | `mocks/app/__pycache__/*.pyc` vinham no pacote | Ficam fora do git pelo `.gitignore` da raiz. O bytecode foi conferido e é idêntico ao `.py` correspondente; só muda o caminho de origem gravado no arquivo |
| 5 | Checkout no Windows converte o texto para CRLF, o que quebra Makefile e scripts shell dentro de containers Linux | `.gitattributes` com `* text=auto eol=lf` |

**Taxas reais do chaos:** o mock sorteia o "pendurar" (30 s) **antes** do 500. Com
`FAIL_RATE=0.3` e `TIMEOUT_RATE=0.3`, as taxas efetivas por chamada são ~30% pendurado, ~21% de
500 imediato e ~49% de sucesso. Medição em [docs/providers.md](docs/providers.md#8-comportamento-de-latência-e-falha-medido).
