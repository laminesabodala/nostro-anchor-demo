#!/usr/bin/env bash
# Consistent sandbox backup. Brief downtime; never restore and resume payments without reconciliation.
set -euo pipefail
umask 077
cd /opt/nostro-anchor-demo
exec 9>/opt/nostro-anchor-backups/backup.lock
flock -n 9 || exit 0
compose=(docker compose --env-file .env -f platform/compose.yaml -f deploy/compose.ovh.yaml)
backup_dir=$(mktemp -d /opt/nostro-anchor-backups/staging.XXXXXX)
cleanup() {
  "${compose[@]}" up -d >/dev/null
  rm -rf -- "$backup_dir"
}
trap cleanup EXIT
"${compose[@]}" stop https business observer platform kafka
"${compose[@]}" exec -T db pg_dump -U anchor -d anchor -Fc >"$backup_dir/anchor.dump"
tar -czf "$backup_dir/business.tar.gz" -C .local business-db.nosync
docker run --rm -v nostro-anchor-demo_anchor-kafka:/source:ro postgres:15.10-alpine@sha256:a58cec2ba7a60b4c08d51f2ca93c1ad65fbf96e75cf0c89b7c0d2684860d3bb3 tar -czf - -C /source . >"$backup_dir/kafka.tar.gz"
cp -a .local-platform "$backup_dir/runtime"
(cd "$backup_dir" && sha256sum anchor.dump business.tar.gz kafka.tar.gz > SHA256SUMS)
backup_path="/opt/nostro-anchor-backups/$(date -u +%Y%m%dT%H%M%SZ).tar.age"
tar -cf - -C "$backup_dir" . | age -R deploy/backup-recipient.pub -o "$backup_path"
echo "Encrypted backup created: $backup_path"
