#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "$0")"
hostname=${1:-}
if [[ ! "$hostname" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$ ]] || [[ "$hostname" == *..* ]] || [[ "$hostname" == *.-* ]] || [[ "$hostname" == *-.* ]]; then
  echo 'Usage: bash install.sh your-verified-domain.example' >&2
  exit 1
fi
release=$(cat RELEASE)
[[ "$release" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid release.' >&2; exit 1; }
sha256sum --check SHA256SUMS
docker compose version >/dev/null
docker load --input images.tar.gz
if [[ -f .env ]]; then
  grep -Fx "TENNIS_HOSTNAME=$hostname" .env >/dev/null || { echo 'The existing hostname differs; refusing to overwrite settings.' >&2; exit 1; }
  # Keep the operator-selected maintenance state and persistent volume.
  sed -i "s/^TENNIS_RELEASE=.*/TENNIS_RELEASE=$release/" .env
else
  printf 'TENNIS_HOSTNAME=%s\nTENNIS_RELEASE=%s\nMAINTENANCE_MODE=1\n' "$hostname" "$release" >.env
fi
docker compose config --quiet
docker compose up --detach --wait --wait-timeout 90
printf 'Loaded release %s. Verify https://%s/healthz and finish data migration before enabling the application.\n' "$release" "$hostname"
