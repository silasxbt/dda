#!/bin/zsh
set -eu
SCRIPT_DIR=${0:A:h}
PROJECT_DIR="$SCRIPT_DIR/.."
cd "$PROJECT_DIR"
command -v node >/dev/null || { print '请安装 Node.js 24 或更新版本。'; exit 1; }
command -v pnpm >/dev/null || { print '请安装 pnpm 10。'; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || { print '需要 Node.js 24 或更新版本。'; exit 1; }
if curl -fsS --max-time 2 http://127.0.0.1:8787/api/status 2>/dev/null | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{try{const x=JSON.parse(s);process.exit(Array.isArray(x.sessions)&&x.defaults?.durationMinutes===60?0:1)}catch{process.exit(1)}})'; then
  print 'DDA 已在运行。'
  [[ ${DDA_NO_OPEN:-0} == 1 ]] || open http://127.0.0.1:8787
  exit 0
fi
[[ -d node_modules ]] || pnpm install --frozen-lockfile
pnpm build
print 'DDA 正在启动。关闭本窗口或按 Ctrl+C 可停止；启动服务不会自动采集。'
node --import tsx src/server.ts &
DDA_SERVER_PID=$!
cleanup() { kill -TERM "$DDA_SERVER_PID" 2>/dev/null || true; wait "$DDA_SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
DDA_READY=0
for attempt in {1..60}; do
  kill -0 "$DDA_SERVER_PID" 2>/dev/null || break
  if curl -fsS --max-time 1 http://127.0.0.1:8787/api/status >/dev/null 2>&1; then DDA_READY=1; break; fi
  sleep 1
done
[[ $DDA_READY == 1 ]] || { print '启动失败，请查看上方提示；不会关闭其他占用端口的程序。'; exit 1; }
[[ ${DDA_NO_OPEN:-0} == 1 ]] || open http://127.0.0.1:8787
wait "$DDA_SERVER_PID"
