# DDA 测试执行版验收记录

验收时间：2026-10-15T09:33:08.582368+00:00。状态：**本地待审；真实双链兑换未通过验收**。

## 已交付

本机测试执行室 http://127.0.0.1:8788，独立钱包、数据库和启动入口。主网研究采集和 GCP 服务未作本轮改动。

执行模块包含库存预留、相同 A 数量双腿、预检查、签名持久化、独立确认、余额对账、未知冻结、停止与恢复、手动平仓。初始化含测试代币发行、授权、账户创建、Pancake V3 / Raydium CLMM 自有池和流动性；后者已实现但缺免费测试币，尚未链上验证。

## 验收矩阵

| 项目 | 结果 | 证据与范围 |
|---|---|---|
| 原有研究功能回归 | PASS | 原有 18 项包含在自动验证中 |
| 新执行场景与关键不变量 | PASS | 总计 51 项自动验证通过，0 失败；dda-tests.txt |
| 签名后／提交前后真实进程 SIGKILL | PASS | WAL 恢复，原交易只查询，广播次数不增加 |
| 初始化幂等和响应丢失后确认 | PASS | 同一步只构建、广播一次 |
| 网络错误、主网程序拒绝 | PASS | 签名前拒绝；完整 genesis hash 核验 |
| 两套入口构建 | PASS | dda-build.txt；TypeScript、Vite、服务端编译 |
| 本地接口单腿、停止、恢复、平仓、拦截 | PASS | dda-api-acceptance.json；合成验证 |
| 浏览器正常运行与结果展示 | PASS | 点击运行后两腿已确认、敞口 0、对账一致 |
| 其余浏览器完整交互验收 | NOT RUN | 接口已验收，不能替代浏览器控件逐项验证 |
| BSC Testnet 身份与合约存在 | PASS | chain ID 97，四个官方部署地址有代码；dda-testnet-check.json |
| Solana Devnet 身份与 CLMM 程序 | PASS | 完整 genesis 与 executable；dda-testnet-check.json |
| 新钱包与权限隔离 | PASS | 目录 0700，钱包和数据库 0600 |
| 免费测试币领取 | FAIL | Devnet requestAirdrop 返回 Internal error；两链 native 余额均 0 |
| 自有代币、池和流动性真实初始化 | NOT RUN | 两链分别明确报告免费币不足，无提交记录 |
| 两链真实兑换、三确认／finalized、链上余额对账 | NOT RUN | 无真实 swap 哈希，不能视为完成 |
| 独立审查 | NOT RUN | 当前为同上下文本地验证 |

## 钱包与后续操作

BSC Testnet：`0x967e8e92f4fdF5a729b98ca0324C5bec600168d6`

Solana Devnet：`9tKH9sUYQb1gzRP1J99VNyMqZW2uSGpT8TTFFupjzJkg`

仅接收免费测试币。BSC 初始化至少检查 0.01 tBNB、Solana 至少 0.1 Devnet SOL，实际建池租金可能需要更多。BNB 官方水龙头可能要求同地址主网 BNB 余额；本项目不为此充值真实资产，也不购买测试币。可由用户使用免费合资格渠道或接受免费测试币赠送。

免费币到账后在面板“检查网络与余额 → 初始化测试市场／继续”，待每笔初始化确认，再运行正常和受控单腿场景、手动平仓、导出报告。状态未知先恢复原交易，不能重复发送。具体用法见 DDA测试执行使用说明.md。

## 版本与证据

运行代码 SHA256：`1a44b0804a3c67defe662ef7891e947e1e47d97e76cc83919cbedb432a5ac7de`。摘要覆盖执行模块、服务入口、代币产物及依赖锁文件，不是 Git 提交号；项目目录尚未初始化 Git。JSON 导出不包含私钥、签名原文或本地操作凭证。

本轮合成记录：3 条。其数据不进入主网收益或模型训练。测试币单位不等于美元，网络费和账户租金分列，不宣称完整净收益。公共网络适配器在缺资金情况下仅验证了身份、合约／程序存在和余额读取，实际建池、tick 跨越和真实 swap 仍需链上验证。

## 参考来源

- [PancakeSwap V3 官方地址](https://developer.pancakeswap.finance/contracts/v3/addresses)
- [Solana 集群说明](https://solana.com/docs/references/clusters)
- [Raydium CLMM 官方源码](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/lib.rs)
- [BNB 官方测试币水龙头](https://www.bnbchain.org/en/testnet-faucet)
