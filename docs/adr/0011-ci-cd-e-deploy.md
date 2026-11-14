# ADR 0011: CI/CD (GitHub Actions) e deploy em VM na Oracle Cloud

- **Status:** aceito
- **Data:** 2026-11-14

## Contexto

Bônus: GitHub Actions, Docker multi-stage e deploy em cloud com rota via IP público. Restrições:
conta **Oracle Cloud Always Free**, custo zero, e uma demo que precisa sobreviver a 30 minutos de
apresentação, incluindo derrubar um provider ao vivo.

## Decisões

### CI (`.github/workflows/ci.yml`), em todo PR e push na `main`

1. `npm ci` com cache → **commitlint** (no PR) → **eslint + prettier** → **tsc** →
   **testes com cobertura** (unit + integração com Redis e Postgres **reais** via Testcontainers,
   que usa o Docker do runner) → build.
2. Job `stack`: builda a imagem (cache do GHA), sobe **a stack inteira** com
   `docker compose up --wait` e roda `deploy/smoke-test.sh`: readiness, 60 voos, cache hit e 400.
   É o mesmo comando que o avaliador roda (`make up`), testado a cada commit.

### CD (`.github/workflows/deploy.yml`), na `main`

1. **Imagem multi-arch** (`linux/amd64` + `linux/arm64`, via QEMU/buildx) no **GHCR**, com tag
   pelo SHA e `latest`. Multi-arch porque a VM Always Free que comporta a stack (Ampere A1) é
   **ARM**.
2. **Deploy por SSH** (só com `DEPLOY_ENABLED=true`): rsync dos arquivos da stack → `deploy.sh`
   na VM (pull da imagem pelo SHA, `docker compose up -d --wait`, versão fixada no `.env`).
3. **Smoke test pelo IP público**, inclusive conferindo que `/health.version` é o SHA implantado.

Login no GHCR com o `GITHUB_TOKEN` **efêmero** do job; nenhum segredo de registry fica na VM.
Segredos da aplicação (senhas do Postgres e do Grafana) são gerados **na VM** pelo
`bootstrap-vm.sh` (`.env`, `chmod 600`), nunca no repositório.

### Topologia: uma VM com o mesmo compose do desenvolvimento

O que roda em produção é o que foi testado na CI e na máquina do avaliador. Os mocks precisam
rodar junto (o enunciado exige o serviço completo no IP público).

## Alternativas consideradas

- **OKE (Kubernetes) / Container Instances:** mais "produção", mas mais peças, e o OKE não cabe
  no Always Free com observabilidade. Para um serviço e uma demo, é complexidade sem retorno.
- **Build na VM (`git pull && compose build`):** é mais simples, mas o artefato que roda não é o
  mesmo que a CI testou, e a VM ARM pequena compila devagar. Imagem imutável por SHA no registry
  permite rollback trivial.
- **Runners ARM nativos em vez de QEMU:** são mais rápidos. Ficam como evolução se o build
  emulado passar a incomodar.

## Consequências

- (+) Rollback = rodar o deploy num SHA anterior (a imagem continua no GHCR).
- (+) Kill switch em produção sem deploy: editar `flags/flags.json` na VM. O CD não sobrescreve
  o arquivo depois da primeira vez.
- (−) Uma VM só: sem alta disponibilidade, e o deploy tem alguns segundos de indisponibilidade
  (recreate). Evolução: 2 VMs atrás do LB da OCI com rolling deploy, readiness gate (o
  `/health/ready` já dá 503 durante a drenagem) e TLS (Caddy + Let's Encrypt).
