#!/usr/bin/env bash
# Run as root on the selected Debian x86_64 host with an already-built release archive.
set -euo pipefail
archive=${1:?release archive required}
release=${2:?release id required}
[[ "$release" =~ ^[a-zA-Z0-9._-]+$ ]] || exit 2
test "$(uname -m)" = x86_64
if ! systemctl cat dda.service >/dev/null 2>&1 && ss -ltnH 'sport = :8787' | read -r _; then
  printf 'Port 8787 already in use; refusing first installation.\n' >&2; exit 1
fi
install -d -m 755 /opt/dda/releases
if ! id dda >/dev/null 2>&1; then useradd --system --home-dir /var/lib/dda --shell /usr/sbin/nologin dda; fi
install -d -o dda -g dda -m 700 /var/lib/dda
install -d -o root -g dda -m 750 /etc/dda
if [[ ! -f /etc/dda/dda.env ]]; then install -o root -g dda -m 640 /dev/null /etc/dda/dda.env; fi
task_tmp=$(mktemp -d /opt/dda/setup.XXXXXX)
trap 'rm -rf "$task_tmp"' EXIT
node_version=v24.15.0
node_file=node-${node_version}-linux-x64.tar.xz
if [[ ! -x /opt/dda/runtime/bin/node ]]; then
  curl --fail --silent --show-error --location "https://nodejs.org/dist/${node_version}/${node_file}" -o "$task_tmp/$node_file"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" -o "$task_tmp/SHASUMS256.txt"
  (cd "$task_tmp"; awk -v f="$node_file" '$2==f {print}' SHASUMS256.txt > selected.sha256; test -s selected.sha256; sha256sum --check selected.sha256)
  tar -xJf "$task_tmp/$node_file" -C "$task_tmp"
  mv "$task_tmp/node-${node_version}-linux-x64" /opt/dda/runtime
fi
chown -R root:root /opt/dda/runtime
chmod -R go-w /opt/dda/runtime
[[ "$(/opt/dda/runtime/bin/node --version)" == "$node_version" ]]
destination=/opt/dda/releases/$release
test ! -e "$destination"
install -d -m 755 "$destination"
tar -xzf "$archive" -C "$destination"
cd "$destination"
export PATH=/opt/dda/runtime/bin:$PATH
test -d node_modules/.pnpm
test -s build/server.js
test -s dist/index.html
chown -R root:root "$destination"
chmod -R go-w "$destination"
previous=$(readlink /opt/dda/current || true)
if systemctl cat dda.service >/dev/null 2>&1; then cp /etc/systemd/system/dda.service "$task_tmp/previous.service"; fi
install -m 644 deploy/dda.service /etc/systemd/system/dda.service
ln -s "$destination" /opt/dda/current.next
mv -Tf /opt/dda/current.next /opt/dda/current
systemctl daemon-reload
systemctl restart dda.service
ready=false
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:8787/api/status > "$task_tmp/status.json"; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  journalctl -u dda.service -n 30 --no-pager
  if [[ -n "$previous" ]]; then
    ln -s "$previous" /opt/dda/current.rollback
    mv -Tf /opt/dda/current.rollback /opt/dda/current
    if [[ -f "$task_tmp/previous.service" ]]; then cp "$task_tmp/previous.service" /etc/systemd/system/dda.service; fi
    systemctl daemon-reload
    systemctl restart dda.service
  else systemctl stop dda.service; fi
  exit 1
fi
systemctl enable dda.service
cat "$task_tmp/status.json"
printf '\nrelease=%s\n' "$release"
