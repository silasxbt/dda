# DDA 研究报告

证据不足：当前采集只能验证软件与报价链路，不能证明策略有增量价值或可持续盈利。

- 会话：d286ab8c-2f6c-4598-8701-253bbc223bd4
- UTC：2026-10-15T08:33:59.191Z → 2026-10-15T08:35:32.617Z
- 状态：stopped；回放版本：dda-replay-1.0.0
- 输入摘要：cbf20dca5dde93935f6f86aaaf9091a1885cacfe98897438234f0bf0d400b780

## 真实观测与覆盖

| 指标 | 值 |
|---|---:|
| 实际观测秒数 | 93.4 |
| 周期 / 报价 / 有效报价 | 8 / 192 / 192 |
| 有效报价覆盖（已启用池） | 100.0% |
| 采样间隔中位 / P95 | 12181 / 12297 ms |
| 大于两倍目标间隔的断档 | 7 |
| 成交记录 / 错误 | 57 / 5 |
| 独立正毛利事件 | 0 |
| 竞争信息完整的候选 | 0 / 384 |
| 5 秒 / 15 秒结果可观测 | 0 / 0 |

## 固定池与资产关系

- bsc USDC/USDT：0x92b7807bF19b7DDdf89b706143896d05228f3121；费率 0.01%；启用；基础资产 0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d（18 位）；Binance-Peg；不等同 Circle 原生 USDC；跨链兑付路径未验证
- bsc USDC/USDT：0x4f31Fa980a675570939B737Ebdde0471a4Be40Eb；费率 0.05%；启用；基础资产 0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d（18 位）；Binance-Peg；不等同 Circle 原生 USDC；跨链兑付路径未验证
- bsc WBNB/USDT：0x172fcD41E0913e95784454622d1c3724f546f849；费率 0.01%；启用；基础资产 0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c（18 位）；BNB 原生币的链内封装
- bsc WBNB/USDT：0x36696169C63e42cd08ce11f5deeBbCeBae652050；费率 0.05%；启用；基础资产 0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c（18 位）；BNB 原生币的链内封装
- solana USDC/USDT：BZtgQEyS6eXUXicYPHecYQ7PybqodXQMvkjUbP4R8mUU；费率 0.01%；启用；基础资产 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v（6 位）；Circle 原生 USDC
- solana USDC/USDT：3NeUgARDmFgnKtkJLqUcEUNCfknFCcGsFfMJCtx6bAgx；费率 0.01%；启用；基础资产 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v（6 位）；Circle 原生 USDC
- solana SOL/USDC：3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv；费率 0.04%；启用；基础资产 So11111111111111111111111111111111111111112（9 位）；SOL 原生币的链内封装
- solana SOL/USDC：CYbD9RaToYMtWKA7QZyoLahnHdWq553Vm62Lh6qWtuxq；费率 0.02%；启用；基础资产 So11111111111111111111111111111111111111112（9 位）；SOL 原生币的链内封装

BSC 与 Solana 同名资产的发行、封装与兑付路径没有被验证为等价。跨链组合仅展示价差，不计入可盈利机会。稳定币金额按名义 $1 计量，并非美元兑付承诺。

## 成本、库存与情景

指定规模先固定基础币数量，买入 exact-output、卖出 exact-input。DEX 手续费和价格冲击已在报价中，不重复扣除。额外滑点 2 bps，网络费采用 Quoter gas 估算或 Solana 300000 CU + 5000 lamport 的估算情景，并非实际成交费。

本金 10000，两链各半、各链稳定币均分。原生币费用余额单列；WBNB/SOL 控制市场没有获得可卖出基础币库存。各策略从同一库存独立回放，每个市场价差事件最多执行一次；5 秒后的双侧报价为模拟成交，未知结果跳过，资金在延迟期间锁定。

再平衡成本：未知 bps；延迟情景 600 秒。当前没有已验证路径，不会发起虚拟跨链搬币；只给再平衡前价差和盈亏平衡成本。失败开关：买腿 成功，卖腿 成功，是压力情景而非观测失败率。单腿残余资产按期末观测标记，无法平仓的暴露不当作已实现利润。

## 三组样本外比较（模拟）

按时间分组，跨边界事件整组剔除；严格门槛仅在前 60% 校准交易数、名义成交额和资金秒；测试不保证匹配。无成交或匹配不足不作增量有效性结论。

校准候选 144；测试候选 192；剔除 48；严格利润门槛 0.0000；有效校准：否。

| 策略 | 成交 | 交易已实现损益 | 持有基准末值 | 期末值减持有 | 名义成交额 | 资金秒 |
|---|---:|---:|---:|---:|---:|---:|
| 传统基线 | 0 | 0.0000 | 10000.0000 | 0.0000 | 0.0000 | 0.0000 |
| 提高利润门槛 | 0 | 0.0000 | 10000.0000 | 0.0000 | 0.0000 | 0.0000 |
| DDA 竞争过滤 | 0 | 0.0000 | 10000.0000 | 0.0000 | 0.0000 | 0.0000 |

| 策略 | 样本数 | 中位收益 | 5%分位 | 最差 | 亏损比例 |
|---|---:|---:|---:|---:|---:|
| 传统基线 | 0 | 未知 | 未知 | 未知 | 未知 |
| 提高利润门槛 | 0 | 未知 | 未知 | 未知 | 未知 |
| DDA 竞争过滤 | 0 | 未知 | 未知 | 未知 | 未知 |

误拦（拦截后 5 秒名义净收益仍正）0/0；漏放（放行后 5 秒净收益负）0/0。这是按报价记录的描述统计，同一事件内相关；零分母不表示零风险。缺失标签不进分母；不能据此得出因果结论。

## 模型门槛

未满足，不训练：0 天，0 独立事件，恶化 0，未恶化 0。至少 7 个 UTC 自然日、1000 个独立可观测事件、两类各 100；数量达标后仍需样本外验证。

竞争分数是成交密度、方向压力、重复活跃发送者与集中度的可解释代理，不是经证实的竞争者参与概率。地址为发起人或费用支付者代理；路由器、代付与多地址会影响含义。

## 拦截与异常

- 完整成本后无正收益：384
- 跨链资产等价与兑付路径未验证，仅观察：192
- 再平衡成本未知：192
- 两侧报价时间偏差过大：102

- CYbD9RaToYMtWKA7QZyoLahnHdWq553Vm62Lh6qWtuxq:trades：Error: getTransaction: Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1
- CYbD9RaToYMtWKA7QZyoLahnHdWq553Vm62Lh6qWtuxq:trades：Error: getTransaction: Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1
- 3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv:trades：Error: getTransaction: Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1
- CYbD9RaToYMtWKA7QZyoLahnHdWq553Vm62Lh6qWtuxq:trades：Error: getTransaction: Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1
- CYbD9RaToYMtWKA7QZyoLahnHdWq553Vm62Lh6qWtuxq:trades：Error: getTransaction: Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1

## 可重复与不确定性

回放使用 SQLite 中保存的双向报价、时间和成交事实，压缩原始记录可审计；回放不请求当前网络。哈希覆盖版本、配置、固定池和周期输入。采集持续期短、市场覆盖有限、非原子执行未得到真实交易验证。没有足够独立样本，不报告伪精确置信区间；结果保留为证据不足。
