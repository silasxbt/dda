#!/bin/zsh
set -euo pipefail
SCRIPT_DIR=${0:A:h}
cd "$SCRIPT_DIR/.."
export PATH="${PNPM_HOME:-$HOME/Library/pnpm}:/opt/homebrew/bin:/usr/local/bin:$PATH"
if curl --silent --fail --max-time 2 'http://127.0.0.1:8788/api/test/status' | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("source")=="本地测试；不进入主网研究统计"' 2>/dev/null; then
  open 'http://127.0.0.1:8788'
  print '测试执行室已在运行。'
  exit 0
fi
if lsof -iTCP:8788 -sTCP:LISTEN -t >/dev/null 2>&1; then
  print '8788 端口由其他程序使用，未停止该程序。请先核对。'
  read '?按回车退出…'
  exit 1
fi
pnpm build
pnpm build:server
print '测试执行室启动后打开 http://127.0.0.1:8788；Ctrl+C 停止。'
(
  for dda_attempt in {1..30}; do
    if curl --silent --fail --max-time 1 'http://127.0.0.1:8788/api/test/status' >/dev/null; then
      open 'http://127.0.0.1:8788'
      exit 0
    fi
    sleep 1
  done
) &
node build/test-server.js
