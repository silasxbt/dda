import {createPublicClient,custom,parseAbi,encodeFunctionData,encodeDeployData,getContractAddress,keccak256,parseTransaction,decodeEventLog,type Address,type Hex} from 'viem';
import {bscTestnet} from 'viem/chains';
import {atoms,dec} from '../math.js';
import {ExecutionStore} from './store.js';import {TestWallets} from './wallets.js';
import {TestTransport,BSC_ADDRESSES} from './network.js';
import {type Balances,type Prepared,type QuotePlan,type Settlement,decimals} from './types.js';
import artifact from './token-artifact.json' with {type:'json'};
const address=(s:string)=>s.toLowerCase() as Address;
const C=Object.fromEntries(Object.entries(BSC_ADDRESSES).map(([k,v])=>[k,address(v)])) as Record<keyof typeof BSC_ADDRESSES,Address>;
const erc=parseAbi(['function balanceOf(address) view returns (uint256)','function decimals() view returns (uint8)','function allowance(address,address) view returns (uint256)','function approve(address,uint256) returns(bool)','event Transfer(address indexed from,address indexed to,uint256 value)']);
const factory=parseAbi(['function getPool(address,address,uint24) view returns(address)','function feeAmountTickSpacing(uint24) view returns(int24)']);
const quoter=parseAbi(['function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)','function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const router=parseAbi(['function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params) payable returns(uint256 amountIn)','function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns(uint256 amountOut)']);
const position=parseAbi(['function createAndInitializePoolIfNecessary(address token0,address token1,uint24 fee,uint160 sqrtPriceX96) payable returns(address pool)','function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns(uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)']);
export interface BscMarket{A?:Address;B?:Address;pool?:Address;liquidity?:boolean;price:string;}
export type SetupSend=(key:string,chain:'bsc'|'solana',build:()=>Promise<Prepared>)=>Promise<void>;
export class BscExecution {
 client;constructor(public store:ExecutionStore,public wallets:TestWallets,public transport:TestTransport){this.client=createPublicClient({chain:bscTestnet,transport:custom({request:({method,params}:any)=>transport.rpc(transport.bscRpc,method,params??[])},{retryCount:0})});}
 market(){return this.store.getValue<BscMarket>('bsc:market')??{price:'.98'};}
 async check(){await this.transport.identity('bsc');for(const [name,a]of Object.entries(C)){const code=await this.client.getCode({address:a});if(!code||code==='0x')throw new Error('BSC 测试合约不存在：'+name);}return {network:'BSC Testnet',chainId:97,contracts:C};}
 async balances():Promise<Balances>{const owner=this.wallets.bsc().address,m=this.market();const b:Balances={'bsc:native':(await this.client.getBalance({address:owner})).toString()};for(const k of ['A','B'] as const)b['bsc:'+k]=m[k]&&await this.client.getCode({address:m[k]!})?String(await this.client.readContract({address:m[k]!,abi:erc,functionName:'balanceOf',args:[owner]})):'0';return b;}
 async build(data:Hex,to?:Address,meta:Record<string,unknown>={}):Promise<Prepared>{
  await this.transport.identity('bsc');const account=this.wallets.bsc();if(to&&!this.allowed(to))throw new Error('BSC 目标不在测试白名单');
  const nonce=await this.client.getTransactionCount({address:account.address,blockTag:'pending'}),gasPrice=await this.client.getGasPrice();
  const gas=await this.client.estimateGas({account:account.address,to,data});const gasLimit=gas*120n/100n;
  if(gasPrice*gasLimit>50000000000000000n)throw new Error('测试交易费用超过 0.05 tBNB 上限');
  if(meta.feeReserve&&gasPrice*gasLimit>BigInt(String(meta.feeReserve)))throw new Error('BSC 估计费用超过预留，拒绝签名');
  if(await this.client.getBalance({address:account.address})<gasPrice*gasLimit)throw new Error('免费 tBNB 不足，请先领取测试币');
  const raw=await account.signTransaction({chainId:97,type:'legacy',nonce,gasPrice,gas:gasLimit,to,data,value:0n});
  return {id:keccak256(raw),chain:'bsc',raw,meta:{...meta,to:to??null,nonce}};
 }
 private allowed(a:string){const m=this.market();return [...Object.values(C),m.A,m.B].filter(Boolean).some(x=>x!.toLowerCase()===a.toLowerCase());}
 async broadcast(tx:Prepared){await this.transport.identity('bsc');const parsed=parseTransaction(tx.raw as Hex);if(parsed.chainId!==97||parsed.value!==0n&&parsed.value!==undefined||parsed.to&&!this.allowed(parsed.to))throw new Error('签名交易未通过测试网络门禁');if(!parsed.to&&!tx.meta.deploy)throw new Error('未登记的部署交易');await this.transport.rpc(this.transport.bscRpc,'eth_sendRawTransaction',[tx.raw]);}
 async quote(side:'buy'|'sell',qty:string):Promise<QuotePlan>{
  await this.transport.identity('bsc');const m=this.market();if(!m.A||!m.B||!m.pool||!m.liquidity)throw new Error('BSC 测试池尚未初始化');
  for(const k of ['A','B'] as const)if(Number(await this.client.readContract({address:m[k]!,abi:erc,functionName:'decimals'}))!==decimals('bsc',k))throw new Error('BSC 代币精度不匹配');
  const amount=BigInt(atoms(qty,6)),buy=side==='buy';const {result}=await this.client.simulateContract({address:C.quoter,abi:quoter,functionName:buy?'quoteExactOutputSingle':'quoteExactInputSingle',args:[buy?{tokenIn:m.B,tokenOut:m.A,amount,fee:500,sqrtPriceLimitX96:0n}:{tokenIn:m.A,tokenOut:m.B,amountIn:amount,fee:500,sqrtPriceLimitX96:0n}] as any});
  const q=(result as readonly bigint[])[0];if(q<=0n)throw new Error('BSC 报价无可成交深度');
  return {chain:'bsc',side,qty,spend:(buy?q:amount).toString(),receive:(buy?amount:q).toString(),maxSpend:(buy?(q*10010n+9999n)/10000n:amount).toString(),minReceive:(buy?amount:q*9990n/10000n).toString(),feeReserve:atoms('.005',18),at:Date.now(),detail:{pool:m.pool}};
 }
 data(p:QuotePlan){const m=this.market(),account=this.wallets.bsc(),common={tokenIn:p.side==='buy'?m.B!:m.A!,tokenOut:p.side==='buy'?m.A!:m.B!,fee:500,recipient:account.address,deadline:BigInt(Math.floor(Date.now()/1000)+120),sqrtPriceLimitX96:0n};return encodeFunctionData({abi:router,functionName:p.side==='buy'?'exactOutputSingle':'exactInputSingle',args:[p.side==='buy'?{...common,amountOut:BigInt(p.receive),amountInMaximum:BigInt(p.maxSpend)}:{...common,amountIn:BigInt(p.spend),amountOutMinimum:BigInt(p.minReceive)}] as any});}
 async preflight(plans:QuotePlan[]){for(const p of plans){const m=this.market(),token=p.side==='buy'?m.B!:m.A!;const approved=await this.client.readContract({address:token,abi:erc,functionName:'allowance',args:[this.wallets.bsc().address,C.router]});if(approved<BigInt(p.maxSpend))throw new Error('BSC 测试代币授权不足，请运行初始化');await this.client.call({account:this.wallets.bsc().address,to:C.router,data:this.data(p)});}}
 async prepare(p:QuotePlan){return this.build(this.data(p),C.router,{side:p.side,feeReserve:p.feeReserve});}
 async settlement(tx:Prepared):Promise<Settlement>{
  await this.transport.identity('bsc');const receipt=await this.transport.rpc(this.transport.bscRpc,'eth_getTransactionReceipt',[tx.id]);if(!receipt)return {state:'unknown',delta:{},reason:'尚未查到交易回执'};
  const current=BigInt(await this.transport.rpc(this.transport.bscRpc,'eth_blockNumber'));if(current-BigInt(receipt.blockNumber)+1n<3n)return {state:'unknown',delta:{},reason:'等待三个区块确认'};
  const block=await this.transport.rpc(this.transport.bscRpc,'eth_getBlockByNumber',[receipt.blockNumber,false]);if(block?.hash!==receipt.blockHash)return {state:'unknown',delta:{},reason:'回执区块发生重组'};
  const fee=BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice),delta:Balances={'bsc:native':(-fee).toString()},owner=this.wallets.bsc().address.toLowerCase(),m=this.market();
  for(const log of receipt.logs??[]){const asset=(['A','B']as const).find(k=>m[k]?.toLowerCase()===log.address.toLowerCase());if(!asset)continue;try{const d=decodeEventLog({abi:erc,eventName:'Transfer',data:log.data,topics:log.topics}).args as {from:Address;to:Address;value:bigint};const v=(d.to.toLowerCase()===owner?d.value:0n)-(d.from.toLowerCase()===owner?d.value:0n),k='bsc:'+asset;delta[k]=(BigInt(delta[k]??'0')+v).toString();}catch{}}
  return {state:receipt.status==='0x1'?'confirmed':'failed',delta,fee:fee.toString(),block:receipt.blockHash};
 }
 async setup(send:SetupSend){
  await this.check();const owner=this.wallets.bsc().address;const b=await this.client.getBalance({address:owner});if(b<10000000000000000n)throw new Error('BSC 测试钱包缺少免费 tBNB：请在水龙头领取至少 0.01 tBNB 后重试');
  const m=this.market();
  for(const k of ['A','B']as const){const key='bsc:deploy:'+k;if(!this.store.setupOp(key)){const nonce=await this.client.getTransactionCount({address:owner,blockTag:'pending'});m[k]=getContractAddress({from:owner,nonce:BigInt(nonce)});this.store.setValue('bsc:market',m);}await send(key,'bsc',()=>this.build(encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode as Hex,args:['DDA Test '+k,'DDA-'+k,decimals('bsc',k)]}),undefined,{deploy:true,asset:k}));}
  const tickSpacing=Number(await this.client.readContract({address:C.factory,abi:factory,functionName:'feeAmountTickSpacing',args:[500]}));if(tickSpacing!==10)throw new Error('BSC 费率 500 的 tick 间隔与测试配置不符');
  const ordered=[m.A!,m.B!].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())),aFirst=ordered[0]===m.A;
  const ratio=aFirst?dec(m.price).mul('1e12'):dec(1).div(m.price).mul('1e-12');const sqrt=BigInt(ratio.sqrt().mul(dec(2).pow(96)).toFixed(0));
  await send('bsc:create-pool','bsc',()=>this.build(encodeFunctionData({abi:position,functionName:'createAndInitializePoolIfNecessary',args:[ordered[0],ordered[1],500,sqrt]}),C.position));
  m.pool=await this.client.readContract({address:C.factory,abi:factory,functionName:'getPool',args:[m.A!,m.B!,500]});if(m.pool==='0x0000000000000000000000000000000000000000')throw new Error('BSC 池创建后未找到');this.store.setValue('bsc:market',m);
  for(const k of ['A','B']as const)for(const [name,target,amount]of [['lp',C.position,'10000'],['swap',C.router,'100000']]as const)await send(`bsc:approve:${k}:${name}`,'bsc',()=>this.build(encodeFunctionData({abi:erc,functionName:'approve',args:[target,BigInt(atoms(amount,decimals('bsc',k)))]}),m[k]!));
  await send('bsc:liquidity','bsc',()=>this.build(encodeFunctionData({abi:position,functionName:'mint',args:[{token0:ordered[0],token1:ordered[1],fee:500,tickLower:-887270,tickUpper:887270,amount0Desired:BigInt(atoms('10000',decimals('bsc',aFirst?'A':'B'))),amount1Desired:BigInt(atoms('10000',decimals('bsc',aFirst?'B':'A'))),amount0Min:0n,amount1Min:0n,recipient:owner,deadline:BigInt(Math.floor(Date.now()/1000)+1200)}]}),C.position));m.liquidity=true;this.store.setValue('bsc:market',m);
  return m;
 }
}
