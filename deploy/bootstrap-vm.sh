#!/usr/bin/env bash
# Prepara UMA VEZ uma VM Ubuntu da Oracle Cloud (Always Free) para receber o deploy.
# Uso (na VM, como o usuário padrão "ubuntu"):  bash bootstrap-vm.sh
# Idempotente: pode rodar de novo sem estragar nada.
set -euo pipefail

APP_DIR=/opt/agregador-voos
PUBLIC_PORTS=(8000 3000)   # API e Grafana. Mocks, Redis, Postgres, Jaeger e Prometheus: NÃO.

echo "== pacotes base"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl rsync jq make python3 iptables-persistent openssl

echo "== Docker Engine + plugin compose"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker

echo "== firewall do host"
# As imagens Ubuntu da Oracle vêm com iptables restritivo (REJECT no INPUT): abrir só o público.
# A barreira principal continua sendo a Security List / NSG da VCN (fora da VM).
for port in "${PUBLIC_PORTS[@]}"; do
  sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null \
    || sudo iptables -I INPUT 5 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
done
sudo netfilter-persistent save

echo "== diretório da aplicação"
sudo mkdir -p "$APP_DIR"
sudo chown "$USER:$USER" "$APP_DIR"

echo "== .env com segredos (gerado uma vez, nunca versionado)"
if [ ! -f "$APP_DIR/.env" ]; then
  GRAFANA_PASS=$(openssl rand -base64 18 | tr -d '/+=')
  cat > "$APP_DIR/.env" <<EOF
# Gerado por bootstrap-vm.sh em $(date -u +%FT%TZ). NÃO versionar.
COMPOSE_PROFILES=observability
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
GRAFANA_ADMIN_PASSWORD=$GRAFANA_PASS
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
LOG_LEVEL=info
EOF
  chmod 600 "$APP_DIR/.env"
  echo "Senha do Grafana (admin): $GRAFANA_PASS   ← guarde agora"
else
  echo "(.env já existe: mantido)"
fi

echo
echo "Pronto. Saia e entre de novo no SSH (grupo docker) e configure o GitHub Actions (docs/DEPLOY.md)."
