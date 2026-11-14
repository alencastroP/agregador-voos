# ADR 0001: Agregador em Node.js 22 + TypeScript (e não Python)

- **Status:** aceito
- **Data:** 2026-11-14

## Contexto

O scaffold do desafio sugere um agregador em Python: o `Makefile` chama `uv run pytest`/`ruff`, o
`.gitignore` é voltado a Python e os mocks são FastAPI. O enunciado, porém, **não exige
linguagem**: pede um `POST /search`, Docker Compose e testes. O critério de avaliação é a revisão
técnica ao vivo, em que preciso defender cada linha.

## Decisão

Node.js 22 LTS + TypeScript em modo `strict`, na pasta `aggregator/`, mantendo **intacta a
interface de quem avalia**:

| Contrato implícito do scaffold | Mantido? |
|---|---|
| Serviço `aggregator` no mesmo `docker-compose.yml` | sim |
| Porta 8000, `POST /search`, `GET /health` | sim |
| Alvos `make up/down/restart/logs/ps/test/cov/lint/fmt/search/health/chaos` | sim (mesmos nomes; `test/cov/lint/fmt` agora chamam npm) |

## Alternativas consideradas

1. **Python (FastAPI + httpx + pydantic + pytest).** Alinha com o scaffold e com os mocks. Foi
   descartada porque meu domínio é TypeScript, e defender decisões finas (cancelamento de
   requisição, event loop, tipagem) é mais sólido na stack que uso no dia a dia.
2. **Go.** Ótimo para I/O concorrente, mas é uma stack em que não consigo defender idiomatismos ao
   vivo com a mesma profundidade.

## Consequências

- (+) Defesa linha a linha numa stack de domínio; tipos compartilhados com um front React, se
  houver.
- (+) `fetch`/undici nativo com `AbortController` cancela a requisição de verdade no timeout.
- (−) Quem avalia esperando Python encontra outra linguagem. Mitigação: a interface `make` é
  idêntica e este ADR explica a troca.
- (−) `make test/cov/lint/fmt` passam a exigir Node 22 instalado, ou podem rodar via container
  na CI.
- `.gitignore` foi ampliado para Node (`node_modules`, `dist`, `coverage`).
