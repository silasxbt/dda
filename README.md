# DDA 本地研究系统

真实指定金额报价 → 传统套利基线 → 竞争压力过滤 → 库存模拟 → 对照报告。BSC / Solana、PancakeSwap V3 / Raydium CLMM。主网只读采集与模拟；测试网执行使用独立入口与隔离钱包。

## 获取完整项目

```sh
git clone --recurse-submodules https://github.com/silasxbt/dda.git
cd dda
```

已有副本运行 `git submodule update --init --recursive`。三个参考仓库以固定提交的子模块保留原始来源；项目本身不依赖它们启动。源码、前端、合约、部署脚本、锁文件、研究与维护文档均在本仓库。

历史报告与导出见 `artifacts/deliverables/`；只读研究数据库备份与原始记录见 `artifacts/research-data/`，它们是 2026-10-15 的历史证据，不是实时行情。备份不会自动覆盖运行数据库。Mac 启动入口见 `launchers/`。文件范围与验证状态见 [仓库导入记录](notes/repository-import.md)。

## 启动

需要 Node.js 24+、pnpm 10；已在当前 Mac 安装依赖。首次或迁移后：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

打开 http://127.0.0.1:8787 。启动服务本身不采集；点击「启动采集」后核验市场，默认采集 60 分钟，可修改。页面可停止、回放、查看机会证据/库存/三组对照，导出报告、CSV、建模数据、快照和原始响应。终端 Ctrl+C 优雅停止服务及它启动的会话。

仓库 launchers 内提供「启动DDA.command」，双击启动；脚本不触发采集。数据存 data，默认只使用免费公共 RPC。可通过 BSC_RPC_URL / SOLANA_RPC_URL 指定自己的只读节点；主网研究入口不会购买服务、读取钱包或索取私钥。

## 无界面采集与复现

云端托管与加密访问见 [GCP 运行说明](notes/cloud.md)。云端数据独立保存；启动面板不自动采集。

```sh
pnpm collect 30
pnpm replay <会话ID>
pnpm report <会话ID> exports/report.md
pnpm exec tsx src/cli.ts snapshot <会话ID> exports/snapshot.json.gz
pnpm exec tsx src/cli.ts dataset <会话ID> exports/dataset.json
DDA_DATA_DIR=work/restored pnpm exec tsx src/cli.ts import exports/snapshot.json.gz
DDA_DATA_DIR=work/restored pnpm replay <会话ID>
```

同一数据目录只允许一个采集进程；回放可同时读取已保存的周期。快照导入需要目标库没有同名会话，不覆盖既有记录。比较两次回放的 SHA256 摘要，验证输入与计算口径一致。

## 验证与离线模型

```sh
pnpm test
pnpm build
uv sync --project research --locked
uv run --project research --locked python -m unittest discover -s research -p 'test_*.py' -v
uv run --project research --locked python research/evaluate.py exports/dataset.json --output exports/model-report.json
```

测试包括已捕获 Raydium 账户离线报价、深度边界、数量/费用/库存、缺口/重组、未来信息隔离、限流/断线、快照一致性、API 控制与模型门槛。测试用合成样本只验证软件，不进入研究报告。

## 当前边界

跨链同名稳定币未完成兑付路径验证，因此只观察，不能计入可盈利机会。控制市场默认没有基础币库存。公共节点可能无法达成 5 秒采样，缺失成交数据会阻止 DDA 放行；缺失标签不会变成成功。初期没有足够独立样本，报告应显示「证据不足」，不会强行训练模型。

- AGENTS.md / DECISIONS.md / LESSONS.md：维护入口、唯一产品决定和真实教训。
- notes/architecture.md：模块、计算、API、状态和保守近似。
- notes/assets.json：发行方、封装关系与兑付边界。
- notes/research-review.md / references-lock.json：原始资料核对与参考仓库提交。
- notes/acceptance.md：本轮验证结果与未运行项。

默认原始工作副本 30 天后先归档快照再清理。SQLite 和证据归档不自动删除；请按需管理磁盘。本文和本地验证不代表独立审查、合并或策略盈利证明。

## Mac 本地测试执行室

新增独立入口 `pnpm test:serve`（http://127.0.0.1:8788），使用 `data/test-execution/` 保存测试钱包和执行账本。确定性故障测试可离线运行；公共测试网需先免费领取 tBNB / Devnet SOL，再初始化自有池。详见 [测试执行维护说明](notes/test-execution.md)。真实兑换尚未取得链上验证证据前保持 NOT RUN；本地待审，不接主网资金。
