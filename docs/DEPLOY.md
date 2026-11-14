# Deploy: Oracle Cloud (Always Free) + GitHub Actions

Arquitetura: **uma VM** rodando o mesmo `docker-compose.yml` do desenvolvimento (mocks + Redis +
Postgres + agregador + observabilidade). A imagem do agregador vem do **GHCR**, publicada pelo
GitHub Actions em `amd64` e `arm64`; os mocks são construídos na própria VM.

```
push na main ─► CI (lint, typecheck, testes, smoke da stack)
             └► Deploy: build multi-arch → GHCR → rsync dos arquivos → SSH: deploy.sh → smoke pelo IP público
```

## 1. Criar a VM (console da Oracle Cloud)

1. **Compute → Instances → Create instance**
   - Image: **Canonical Ubuntu 24.04**
   - Shape: **VM.Standard.A1.Flex (Ampere, ARM)**, com **2 OCPU / 12 GB**. Fica dentro do Always
     Free (até 4 OCPU / 24 GB). A E2.1.Micro (1 GB) **não** comporta a stack com observabilidade.
   - Networking: VCN padrão, sub-rede **pública**, **"Assign a public IPv4 address"** marcado.
   - SSH keys: gere um par **só para o deploy** (`ssh-keygen -t ed25519 -f oci_deploy -C deploy`) e
     cole a **pública** (`oci_deploy.pub`).
   - Se der "Out of capacity" na Ampere: tente outro Availability Domain ou mais tarde (é comum
     no Always Free).
2. **Networking → VCN → Security List** da sub-rede → **Add Ingress Rules** (origem
   `0.0.0.0/0`, TCP):
   - `8000`: API
   - `3000`: Grafana (com senha; leitura anônima do dashboard)

   **Não** abra 3001–3003, 5432, 6379, 9090 nem 16686: Redis, Postgres, Prometheus e Jaeger
   escutam só em `127.0.0.1`, e os mocks ficam protegidos por esta Security List. Para ver o
   Jaeger e o Prometheus da VM, use um túnel:
   `ssh -L 16686:localhost:16686 -L 9090:localhost:9090 ubuntu@IP`.

   > Atenção: o Docker publica portas por fora do `ufw`/INPUT do host. A barreira real é a
   > **Security List da VCN** (fora da VM).

## 2. Preparar a VM (uma vez)

```bash
scp -i oci_deploy deploy/bootstrap-vm.sh ubuntu@IP_PUBLICO:~
ssh -i oci_deploy ubuntu@IP_PUBLICO 'bash bootstrap-vm.sh'
```

O script instala Docker e o plugin compose, libera 8000/3000 no iptables (as imagens Ubuntu da
Oracle vêm com REJECT no INPUT), cria `/opt/agregador-voos` e gera o `.env` com **senhas
aleatórias** (Postgres e Grafana). **Anote a senha do Grafana** que ele imprime.

## 3. Configurar o GitHub

No repositório: **Settings → Secrets and variables → Actions**

| Tipo | Nome | Valor |
|---|---|---|
| Secret | `OCI_VM_HOST` | IP público da VM |
| Secret | `OCI_VM_USER` | `ubuntu` |
| Secret | `OCI_VM_SSH_KEY` | conteúdo da chave **privada** `oci_deploy` |
| Variable | `DEPLOY_ENABLED` | `true` |

O token do GHCR é o `GITHUB_TOKEN` efêmero do job: nenhum segredo de registry fica na VM.

## 4. Deploy

Push na `main` (ou **Actions → Deploy → Run workflow**). O pipeline:

1. builda a imagem para `linux/amd64` e `linux/arm64` e publica `ghcr.io/<owner>/<repo>/aggregator:<sha>`;
2. envia `docker-compose*.yml`, `mocks/`, `observability/` e `deploy/` para a VM. O `flags/` só
   vai na primeira vez, porque depois é editado **na VM** como kill switch, sem deploy;
3. roda `deploy/deploy.sh`: pull da imagem, `docker compose up -d --wait` e fixa a versão no
   `.env` (para sobreviver a reboot);
4. smoke test pelo IP público: readiness, 60 voos, cache hit, 400 de validação e versão = sha.

URLs depois do deploy:

- API: `http://IP_PUBLICO:8000/search` · `http://IP_PUBLICO:8000/health`
- Grafana: `http://IP_PUBLICO:3000` (dashboard "Agregador de Voos · Insights")

## Operação na VM

```bash
cd /opt/agregador-voos
docker compose ps                     # estado
docker compose logs -f aggregator     # logs JSON
make chaos / make calm                # demo de degradação do provider-c
nano flags/flags.json                 # kill switch / A-B, sem restart (vale em ~2 s)
```

## Rollback

Rode de novo o workflow **Deploy** a partir do commit anterior (**Run workflow** no SHA), ou, na
VM, aponte `AGGREGATOR_IMAGE` no `.env` para a tag anterior e rode
`docker compose up -d aggregator`. As imagens antigas ficam no GHCR por SHA.

## Limitações (conscientes) e evolução

- **Uma VM, sem alta disponibilidade.** Evolução: 2+ instâncias atrás do Load Balancer da OCI
  (Always Free inclui um LB flexível de 10 Mbps), Redis e Postgres gerenciados, e migrations como
  job de deploy.
- **HTTP sem TLS.** Evolução: Caddy ou Traefik na frente com Let's Encrypt (domínio próprio).
- **Segredos em `.env` na VM** (fora do git, `chmod 600`). Evolução: OCI Vault.
