import type { Asset, Config } from './types.js';
export const assets:Record<string,Asset>={
 bscUSDC:{id:'bsc:USDC-peg',chain:'bsc',address:'0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',symbol:'USDC',decimals:18,kind:'wrapped',provenance:'Binance-Peg；不等同 Circle 原生 USDC；跨链兑付路径未验证'},
 bscUSDT:{id:'bsc:USDT-peg',chain:'bsc',address:'0x55d398326f99059ff775485246999027b3197955',symbol:'USDT',decimals:18,kind:'wrapped',provenance:'BSC 封装表示；跨链兑付路径未验证'},
 wbnb:{id:'bsc:WBNB',chain:'bsc',address:'0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',symbol:'WBNB',decimals:18,kind:'native',provenance:'BNB 原生币的链内封装'},
 solUSDC:{id:'solana:USDC',chain:'solana',address:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',symbol:'USDC',decimals:6,kind:'issuer',provenance:'Circle 原生 USDC'},
 solUSDT:{id:'solana:USDT',chain:'solana',address:'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',symbol:'USDT',decimals:6,kind:'issuer',provenance:'Solana USDT；与 BSC 封装关系分别登记'},
 sol:{id:'solana:SOL',chain:'solana',address:'So11111111111111111111111111111111111111112',symbol:'SOL',decimals:9,kind:'native',provenance:'SOL 原生币的链内封装'}
};
export const defaults:Config={intervalMs:5000,durationMinutes:60,sizes:[100,500,1000],maxAgeMs:10000,maxSkewMs:2000,maxBlockLagMs:10000,maxSolanaSlotSpan:16,maxImpactBps:50,extraSlippageBps:2,pressureThreshold:0.65,initialCapital:10000,feesNative:{bsc:0.02,solana:0.1},rebalance:{costBps:null,delaySeconds:600},failure:{buy:false,sell:false},bscRpc:process.env.BSC_RPC_URL||'https://bsc-rpc.publicnode.com',solanaRpc:process.env.SOLANA_RPC_URL||'https://solana-rpc.publicnode.com'};
export function validateConfig(input:Partial<Config>={}):Config {
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('配置必须为对象');
 const c={...defaults,...input,feesNative:{...defaults.feesNative,...input.feesNative},rebalance:{...defaults.rebalance,...input.rebalance},failure:{...defaults.failure,...input.failure}};
 for(const [k,min,max] of [['durationMinutes',0.05,1440],['intervalMs',5000,60000],['maxAgeMs',1000,60000],['maxSkewMs',100,30000],['maxBlockLagMs',1000,60000],['maxSolanaSlotSpan',1,64],['maxImpactBps',0,1000],['extraSlippageBps',0,1000],['pressureThreshold',0,1],['initialCapital',100,1e8]] as const) if(!Number.isFinite(c[k])||c[k]<min||c[k]>max) throw new Error(`配置 ${k} 超出范围`);
 if(!Array.isArray(c.sizes)||!c.sizes.length||c.sizes.length>3||c.sizes.some(x=>!Number.isFinite(x)||x<1||x>10000))throw new Error('报价规模需要 1–3 个 1–10000 的数值');
 if(c.rebalance.costBps!==null&&(!Number.isFinite(c.rebalance.costBps)||c.rebalance.costBps<0||c.rebalance.costBps>10000))throw new Error('再平衡成本无效');
 if(!Number.isFinite(c.rebalance.delaySeconds)||c.rebalance.delaySeconds<0||c.rebalance.delaySeconds>86400)throw new Error('再平衡延迟无效');
 for(const n of Object.values(c.feesNative))if(!Number.isFinite(n)||n<0)throw new Error('费用余额无效');
 if(new Set(c.sizes).size!==c.sizes.length)throw new Error('报价规模不能重复');
 if(typeof c.failure.buy!=='boolean'||typeof c.failure.sell!=='boolean')throw new Error('失败情景必须是布尔值');
 for(const u of [c.bscRpc,c.solanaRpc])if(!['https:','http:'].includes(new URL(u).protocol))throw new Error('RPC 地址协议无效');
 return c;
}
