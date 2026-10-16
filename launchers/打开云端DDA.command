#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v gcloud >/dev/null 2>&1; then
  print '需要先安装并登录 Google Cloud CLI。'
  read '?按回车关闭'; exit 1
fi
if lsof -nP -iTCP:18787 -sTCP:LISTEN >/dev/null 2>&1; then
  print '18787 端口已被使用。若已有 DDA 云端连接，请直接打开 http://127.0.0.1:18787；否则关闭占用后重试。'
  read '?按回车关闭'; exit 1
fi
print '正在连接 GCP 美西 DDA。此窗口保持打开；关闭窗口或按 Ctrl+C 断开面板连接。'
gcloud compute ssh silasvps --project=tothemoon-477410 --zone=us-west1-b --tunnel-through-iap --quiet -- -N -L 127.0.0.1:18787:127.0.0.1:8787 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 &
dda_tunnel_pid=$!
trap 'kill "$dda_tunnel_pid" 2>/dev/null || true' EXIT
trap 'exit 130' INT TERM HUP
dda_ready=false
for attempt in {1..60}; do
  if ! kill -0 "$dda_tunnel_pid" 2>/dev/null; then break; fi
  if curl --fail --silent --max-time 2 http://127.0.0.1:18787/api/status >/dev/null; then dda_ready=true; break; fi
  sleep 1
done
if [[ "$dda_ready" != true ]]; then
  print '连接未就绪，请检查 GCP 登录和 IAP 权限。'; read '?按回车关闭'; exit 1
fi
open http://127.0.0.1:18787
print '已打开云端面板。关闭连接不会停止云端采集；请先在面板中停止，或等待会话到时结束。'
wait "$dda_tunnel_pid"
