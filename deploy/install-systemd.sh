#!/usr/bin/env bash
# Install CopyPage as a systemd *user* service (no sudo, inherits ~/.pi credentials).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/copypage.service"
ENV_FILE="$REPO/deploy/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$REPO/deploy/.env.example" "$ENV_FILE"
  if command -v openssl >/dev/null; then
    TOKEN="$(openssl rand -hex 32)"
  else
    TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  sed -i "s/^COPYPAGE_TOKEN=.*/COPYPAGE_TOKEN=$TOKEN/" "$ENV_FILE"
  echo "created $ENV_FILE with a random token"
fi

mkdir -p "$UNIT_DIR"
sed -e "s|__REPO__|$REPO|g" "$REPO/deploy/systemd/copypage.service.in" > "$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now copypage.service

echo
echo "CopyPage service installed → http://127.0.0.1:4400"
echo "  token : $(grep '^COPYPAGE_TOKEN=' "$ENV_FILE" | cut -d= -f2 | cut -c1-8)… (see $ENV_FILE)"
echo "  logs  : journalctl --user -u copypage -f"
echo "  stop  : systemctl --user disable --now copypage"
echo "  survive logout: loginctl enable-linger $USER"
