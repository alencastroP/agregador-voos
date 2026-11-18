# ADR 0011: CI no GitHub Actions; execução local com Docker; deploy fora do escopo

- **Status:** aceito (revisto em 2026-11-16: deploy em cloud retirado do escopo)
- **Data:** 2026-11-14

## Contexto

Bônus: GitHub Actions, Docker multi-stage e deploy em cloud com rota via IP público. O que quem
avalia ou usa o projeto faz de fato é clonar o repositório e rodar `docker compose up`. Esse caminho precisa
funcionar em qualquer máquina com Docker, sem `.env`, sem Node e sem Python.

## Decisões

### CI (`.github/workflows/ci.yml`), em todo PR e push na `main`

1. `npm ci` com cache → **commitlint** (no PR) → **eslint + prettier** → **tsc** →
   **testes com cobertura** (unit + integração com Redis e Postgres **reais** via Testcontainers,
   que usa o Docker do runner) → build.
2. Job `stack`: builda a imagem (cache do GHA), sobe **a stack inteira** com
   `docker compose up --wait` numa máquina limpa e roda `scripts/smoke-test.sh` (readiness, 60
   voos, cache hit e 400) e os testes **e2e** contra os mocks reais. É o mesmo comando do README,
   testado a cada commit.

Essa CI já pegou um problema real de portabilidade: o `build.network: host` herdado do scaffold
é recusado pelas versões recentes do Docker Compose. Ele foi removido (README, seção 12).

### Execução local como entrega

Um único `docker-compose.yml` sobe os mocks, o agregador, Redis, Postgres e a observabilidade
(Jaeger, Prometheus, Grafana). Todas as variáveis têm default; portas de infraestrutura ficam
em `127.0.0.1`.

### Deploy em cloud: fora do escopo desta entrega

Um pipeline de CD para uma VM ARM (imagem multi-arch no GHCR + SSH) chegou a ser escrito, mas foi
retirado: sem a VM acessível ele nunca seria exercitado, e o build ARM emulado (QEMU) no runner
gratuito ficou pendurado até o limite de 6 h. Código de deploy que nunca rodou é passivo, não
entrega.

## Como seria em produção

1. **Imagem imutável por SHA** num registry (GHCR/ECR), construída uma vez pela CI. Builds ARM em
   runner ARM nativo, não em QEMU.
2. **Deploy** com o mesmo compose numa VM (rsync + `docker compose pull && up --wait`) para uma
   demo, ou, para produção de verdade, um orquestrador (ECS/Kubernetes) com N réplicas atrás de
   um load balancer, rolling deploy e readiness gate. O `/health/ready` já devolve 503 durante a
   drenagem, então o rolling deploy não derruba requisições.
3. **Smoke test pelo endereço público** depois de cada deploy, conferindo que `/health.version` é
   o SHA implantado. O `scripts/smoke-test.sh` já aceita a versão esperada como argumento.
4. **Segredos** (senhas do Postgres e do Grafana) no secret manager do ambiente, nunca no
   repositório; TLS na borda (Caddy/ALB).

## Alternativas consideradas

- **Manter o CD desligado no repositório:** mostraria intenção, mas um workflow que nunca rodou
  com sucesso é exatamente o tipo de artefato que não se sustenta.
- **Túnel (Cloudflare Tunnel/ngrok) da máquina local:** expõe uma URL, mas não é deploy em cloud.

## Consequências

- (+) O caminho de quem clona (`git clone` + `docker compose up`) é o que a CI testa.
- (+) Rollback e kill switch locais: `git checkout` de um SHA anterior; `flags/flags.json` sem
  restart.
- (−) Não há URL pública para a demo; ela roda na máquina de quem executa.
