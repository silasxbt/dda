# DDA 本地测试执行室

状态：本地待审；主网研究不变。产品授权唯一记录为 DECISIONS.md 的 DDA-010。

## 启动与数据

在 dda 目录使用 Node.js 24 与已锁定的 pnpm 依赖：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:server
node build/test-server.js
```

浏览器访问 http://127.0.0.1:8788。独立入口 `pnpm test:serve` 用源码启动；研究服务仍使用 8787 / GCP 原入口。无常驻任务。输出目录有双击启动脚本。退出终端或 Ctrl+C 停止服务；已发送交易在下次启动恢复查询。

测试目录 `data/test-execution/`：SQLite WAL 保存全部状态和原始签名；test-wallets.json 为新建钱包与 SPL mint 密钥。目录 0700，文件 0600，属于本地敏感状态，不能提交、上传、复制到报告或云端。备份必须整体保留 SQLite/WAL（先正常停服务），不要只复制主数据库。测试钱包不能充值真实资产。

## 使用顺序

1. 确定性场景无需钱包／联网。运行成功、拦截、部分失败、超时等场景；有敞口先平仓，有未知先恢复对账。未知不可强制标成功或直接清账。
2. 创建钱包（幂等，仅返回地址）。检查网络与余额。BSC 必须 chain ID 97；Solana 必须完整 genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`。程序白名单与资产清单写死在适配器／本地初始化清单，浏览器不能输入任意地址、密钥或 RPC 方法。
3. 仅领取免费 tBNB / Devnet SOL。面板可尝试 1 SOL 免费请求；若限流／服务错误，使用官方水龙头人工操作。BSC 官方水龙头可能要求同地址主网余额，不能因此给测试钱包充值主网资金或购买测试币。需要合规的免费领取途径或他人免费赠送测试币。
4. 初始化自有 DDA-A / DDA-B 代币、Pancake V3 / Raydium CLMM 池和流动性。各步骤持久化并逐笔确认；操作可能花数分钟。若返回待确认，先“恢复初始化确认”，再“初始化测试市场／继续”。两链分别报告阻塞，一条失败不伪装另一条成功。
5. 公共测试网运行“正常”或“单腿”流程。真实报价若没有保守正价差会被拒绝；不会为通过验收放宽限制。单腿场景主动扣留第二腿，再点击手动平仓；并非伪造链上回滚。
6. 导出报告。合成记录带 synthetic 前缀；真实记录有测试网浏览器链接。报告不含签名原文或密钥，不导入研究表。

## 状态与不变量

ExecutionEngine 是唯一运行状态所有者；ExecutionStore 保存请求键、预留、操作和检查点，进程锁拒绝双服务共用数据库。相同请求键返回同一记录；参数不同则拒绝。整个钱包集合一次只处理一个机会。

两腿 A 数量匹配；BSC A/B 精度 6/18，Solana A/B 9/6；API 数量最多六位小数，不能悄悄舍入。价差按 B 测试单位计算，DEX 报价已包含手续费／冲击；额外 0.1% 保守界限。网络费以各链原生币最小单位分别记账，不假设与 B 可兑付。因此没有完整美元净收益结论。

在提交网络请求之前，先将 signed 原文和 submitting 状态同步落盘（WAL + synchronous FULL）。signed 状态代表尚未进入提交，重启后取消；submitting 代表网络边界未知，查询原 tx ID。未知或余额不一致冻结新机会。BSC 查三个确认及 canonical block hash；Solana 查询 finalized 的原交易和 meta。超过 blockhash 高度但交易历史不可见仍为未知。

停止标志单调保持；已发送腿仍确认。只反向平仓已确认的原腿，平仓同样先落盘再发送；失败确认后才允许明确的下一次手动尝试。平仓失败或未知会保留敞口。恢复不再次广播任何交易。公共节点丢失历史时可能长期未知；首版没有强制清账按钮。

初始化 journal 独立保存部署、授权、账户创建、建池、流动性步骤的 tx ID、费用、native 和 token delta。部署或初始化已明确失败／过期时不自动重新部署；须维护者核对 nonce、地址、池状态和签名。尚未运行真实链路前，不可把 SDK 构建／离线签名当作链上成功。

## 接口

全部 `/api/test/`，只监听 127.0.0.1。Host 白名单、Origin 核验、单次启动随机写凭证，禁用 CORS。GET status 返回公开钱包和状态、用于本地页面的操作凭证；报告不含凭证。

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | status | 公开环境、余额、初始化、记录 |
| POST | wallets | 幂等创建独立钱包 |
| POST | check | 异步检查链与程序、余额 |
| POST | airdrop | 一次免费 Solana Devnet 请求 |
| POST | setup | 初始化或继续已记录步骤 |
| POST | setup/recover | 查询原初始化交易 |
| POST | run | mode、scenario、requestKey、qty；拒绝其他字段 |
| POST | run/:id/stop | 阻止后续提交 |
| POST | run/:id/recover | 原交易确认、余额对账 |
| POST | run/:id/unwind | 手动反向平仓 |
| GET | export | 无密钥的 JSON 证据、实际运行代码摘要 |

## 验证与限制

`pnpm test` 包括原研究回归、执行故障、实际 SIGKILL 恢复、跨源写保护；`pnpm build` 与 `pnpm build:server` 验证两套入口。真实交换必须在报告中提供两链 signature / tx hash、finalized / 三确认与余额对账；空钱包、网络不可用、未建池一律 NOT RUN。

BSC 默认 https://bsc-testnet-rpc.publicnode.com；Solana https://api.devnet.solana.com。可在启动前设置 DDA_TEST_BSC_RPC / DDA_TEST_SOL_RPC（仅 HTTPS），仍强制网络身份门禁。网络请求串行、间隔 120ms、超时 12 秒，429 遵守 Retry-After，不自动重试写请求。公共 RPC 实测速度不代表生产延迟。

依据：
- [Pancake V3 地址表](https://developer.pancakeswap.finance/contracts/v3/addresses)
- [Raydium Devnet 程序源码](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/lib.rs)
- [Solana 集群](https://solana.com/docs/references/clusters)
- [Solana genesis 常量](https://github.com/solana-labs/solana/blob/master/sdk/src/genesis_config.rs)
- [BNB 官方水龙头](https://www.bnbchain.org/en/testnet-faucet)

已完成的历史记录若存在更晚的同验证层交易，恢复入口返回当时的已对账快照，不以当前余额重新核对旧交易。最新未完成记录仍需与当前余额核对。非运行参数接口拒绝携带额外字段，避免误把私钥发送给初始化接口。
