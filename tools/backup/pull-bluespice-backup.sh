#!/usr/bin/env bash
# Pull BlueSpice's newest daily backup off the cluster to the NAS.
#
# BlueSpice writes bluespice-<UTC timestamp>.zip (SQL dump + uploaded files)
# to /data/backup in its own volume at BACKUP_HOUR (04:00 UTC) and keeps a
# few. Those copies sit on the same disk as the wiki, so this job keeps the
# off-cluster copy. Runs on the NAS from a systemd user timer
# (tools/backup/systemd/); the cluster is reached through `ssh hetzner`.
# Pushes an ntfy alert (~/.local/bin/notify) on failure or when the newest
# backup is older than two days.
set -euo pipefail

DEST="${DEST:-/volume1/docker/ocp-backups/bluespice}"
KEEP_DAYS="${KEEP_DAYS:-30}"
OC='KUBECONFIG=/root/hetzner-ocp4/ocp/auth/kubeconfig oc --insecure-skip-tls-verify -n bluespice'

fail() { ~/.local/bin/notify "BlueSpice backup pull failed: $1" "OCP backup" high || true; echo "$1" >&2; exit 1; }
trap 'fail "line $LINENO"' ERR

mkdir -p "$DEST"
pod=$(ssh hetzner "$OC get pod -l app.kubernetes.io/name=wiki-task -o name" | head -1)
[ -n "$pod" ] || fail "no wiki-task pod"
latest=$(ssh hetzner "$OC exec $pod -- sh -c 'ls -1t /data/backup/bluespice-*.zip 2>/dev/null | head -1'")
[ -n "$latest" ] || fail "no backup zip in /data/backup"
name=$(basename "$latest")

stamp=${name#bluespice-}; stamp=${stamp%.zip}
age_h=$(( ( $(date -u +%s) - $(date -u -d "${stamp:0:8} ${stamp:8:2}:${stamp:10:2}" +%s) ) / 3600 ))
if [ "$age_h" -gt 48 ]; then
  ~/.local/bin/notify "Newest BlueSpice backup is ${age_h}h old ($name). Is the wiki-task pod running?" "OCP backup" high || true
fi

if [ -s "$DEST/$name" ]; then
  echo "already have $name"
else
  ssh hetzner "$OC exec $pod -- cat $latest" > "$DEST/.$name.part"
  python3 -c 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert "database.sql" in z.namelist()' "$DEST/.$name.part"
  mv "$DEST/.$name.part" "$DEST/$name"
  echo "saved $DEST/$name ($(du -h "$DEST/$name" | cut -f1))"
fi

find "$DEST" -name 'bluespice-*.zip' -mtime +"$KEEP_DAYS" -delete
