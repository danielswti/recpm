#!/usr/bin/env bash
# Prepara uma VPS Ubuntu 22.04/24.04 nova para o Rec PM. Rode como root, uma vez:
#   curl -fsSL .../provision.sh | bash   (ou: sudo ./infra/prod/provision.sh)
# Instala Docker, firewall (22/80/443), fail2ban, atualizações automáticas, swap,
# limite de logs do Docker e o cron do backup diário.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Rode como root"; exit 1; }
REPO_DIR="${REPO_DIR:-/opt/recpm}"

apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git ufw fail2ban unattended-upgrades

# Docker (repositório oficial)
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<JSON
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" }, "live-restore": true }
JSON
systemctl restart docker

# Firewall: só SSH e web. Postgres/Valkey/API nunca ficam expostos (rede interna do Docker).
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

# fail2ban para o SSH e atualizações de segurança automáticas
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades

# 4 GB de swap como folga para picos (build de imagens)
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/99-recpm.conf
fi

# Backup diário às 03:15 (horário do servidor)
cat > /etc/cron.d/recpm-backup <<CRON
15 3 * * * root cd $REPO_DIR/infra/prod && ./backup.sh daily >> /var/log/recpm-backup.log 2>&1
CRON

echo "✔ VPS pronta. Próximos passos:"
echo "  git clone <repo> $REPO_DIR && cd $REPO_DIR/infra/prod"
echo "  cp .env.example .env && chmod 600 .env && nano .env"
echo "  ./deploy.sh"
