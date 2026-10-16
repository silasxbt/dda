import {parseAbi,encodeFunctionData,decodeFunctionResult,decodeEventLog,toEventSelector,type Address,type Hex} from 'viem';
import {assets} from '../config.js';import {Net} from '../net.js';import {atoms,dec,units} from '../math.js';
import type {Pool,Quote,Config,Trade,Coverage} from '../types.js';
const FACTORY='0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', QUOTER='0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', MULTI='0xca11bde05977b3631167028862be2a173976ca11';
const factory=parseAbi(['function getPool(address,address,uint24) view returns(address)']);
const stateAbi=parseAbi(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)','function token0() view returns(address)','function token1() view returns(address)','function decimals() view returns(uint8)']);
const quoteAbi=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)','function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const multiAbi=parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[] results)']);
const swapAbi=parseAbi(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)']);
// Pancake V3 appends protocol fee fields to the Uniswap-style Swap event.
const swapTopic=toEventSelector(swapAbi[0]);
export class BscAdapter {
 chain='bsc' as const; cursor=new Map<string,{number:bigint;hash:string;through:number}>(); actorCache=new Map<string,string>();
 constructor(public net:Net,public cfg:Config){}
 async call(to:string,data:Hex,block='latest'){return this.net.rpc(this.cfg.bscRpc,'eth_call',[{to,data},block]);}
 async state(pool:Pool,block='latest'){
  const data=encodeFunctionData({abi:stateAbi,functionName:'slot0'});const v=decodeFunctionResult({abi:stateAbi,functionName:'slot0',data:await this.call(pool.id,data,block)}) as readonly any[];
  const raw=dec(v[0].toString()).div(dec(2).pow(96)).pow(2);
  return (pool.base.address.toLowerCase()<pool.quote.address.toLowerCase()?raw:dec(1).div(raw)).mul(dec(10).pow(pool.base.decimals-pool.quote.decimals)).toNumber();
 }
 async discover():Promise<Pool[]>{
  const pools:Pool[]=[];
  for(const [base,quote,market] of [[assets.bscUSDC,assets.bscUSDT,'USDC/USDT'],[assets.wbnb,assets.bscUSDT,'WBNB/USDT']] as const){
   for(const asset of [base,quote]){const data=await this.call(asset.address,encodeFunctionData({abi:stateAbi,functionName:'decimals'}));if(Number(decodeFunctionResult({abi:stateAbi,functionName:'decimals',data}))!==asset.decimals)throw new Error('代币精度与登记不符 '+asset.symbol);}
   const found:Pool[]=[];
   for(const fee of [100,500,2500,10000]){
    try{
     const id=decodeFunctionResult({abi:factory,functionName:'getPool',data:await this.call(FACTORY,encodeFunctionData({abi:factory,functionName:'getPool',args:[base.address as Address,quote.address as Address,fee]}))});
     if(/^0x0+$/.test(id))continue;
     const p:Pool={id,chain:'bsc',market,dex:'PancakeSwap V3',base,quote,fee:fee/1e6,program:FACTORY,initialPrice:0,enabled:false};
     p.initialPrice=await this.state(p);
     const result=await this.quotes(p,await this.head(),[1000]);p.enabled=result.length===1&&result[0].valid;if(!p.enabled)p.reason='1000 美元档深度核验失败';
     found.push(p);
    }catch(e){this.net.record({type:'pool-discovery-error',market,fee,error:String(e)});}
   }
   // Rank by measured round-trip cost at the largest requested size, not advertised TVL.
   const ranked=await Promise.all(found.map(async p=>{try{const q=(await this.quotes(p,await this.head(),[1000]))[0];return {p,impact:q?dec(q.buy).sub(q.sell).div(q.buy).toNumber():Infinity};}catch{return {p,impact:Infinity}}}));
   pools.push(...ranked.sort((a,b)=>a.impact-b.impact).slice(0,2).map(x=>x.p));
  }return pools;
 }
 async head(){const b=await this.net.rpc(this.cfg.bscRpc,'eth_getBlockByNumber',['latest',false]);return {block:b.number as string,hash:b.hash as string,time:Number(BigInt(b.timestamp))*1000};}
 async quotes(p:Pool,head:Awaited<ReturnType<BscAdapter['head']>>,sizes=this.cfg.sizes):Promise<Quote[]>{
  const startedAt=Date.now();const qty=sizes.map(size=>atoms(dec(size).div(p.market==='USDC/USDT'?1:p.initialPrice),p.base.decimals));
  const calls=qty.flatMap(amount=>[
   {target:QUOTER as Address,allowFailure:true,callData:encodeFunctionData({abi:quoteAbi,functionName:'quoteExactOutputSingle',args:[{tokenIn:p.quote.address as Address,tokenOut:p.base.address as Address,amount:BigInt(amount),fee:Math.round(p.fee*1e6),sqrtPriceLimitX96:0n}]})},
   {target:QUOTER as Address,allowFailure:true,callData:encodeFunctionData({abi:quoteAbi,functionName:'quoteExactInputSingle',args:[{tokenIn:p.base.address as Address,tokenOut:p.quote.address as Address,amountIn:BigInt(amount),fee:Math.round(p.fee*1e6),sqrtPriceLimitX96:0n}]})}
  ]);
  const result=decodeFunctionResult({abi:multiAbi,functionName:'aggregate3',data:await this.call(MULTI,encodeFunctionData({abi:multiAbi,functionName:'aggregate3',args:[calls]}),head.block)});
  const gasPrice=BigInt(await this.net.rpc(this.cfg.bscRpc,'eth_gasPrice'));const spot=await this.state(p,head.block);const observedAt=Date.now();const quotes:Quote[]=[];
  for(let i=0;i<sizes.length;i++){
   if(!result[i*2].success||!result[i*2+1].success)continue;
   const buy=decodeFunctionResult({abi:quoteAbi,functionName:'quoteExactOutputSingle',data:result[i*2].returnData}),sell=decodeFunctionResult({abi:quoteAbi,functionName:'quoteExactInputSingle',data:result[i*2+1].returnData});
   const b=units(buy[0],p.quote.decimals),s=units(sell[0],p.quote.decimals),baseQty=units(qty[i],p.base.decimals);
   const impact=Math.max(dec(b).div(baseQty).div(spot).sub(1).toNumber(),dec(1).sub(dec(s).div(baseQty).div(spot)).toNumber())*10000;
   quotes.push({poolId:p.id,chain:'bsc',market:p.market,size:sizes[i],baseAtoms:qty[i],baseQty,buyAtoms:buy[0].toString(),sellAtoms:sell[0].toString(),buy:b,sell:s,spot,gasBuy:units((buy[3]*3n/2n+50000n)*gasPrice,18),gasSell:units((sell[3]*3n/2n+50000n)*gasPrice,18),nativeUsd:null,feeRate:p.fee,priceImpactBps:impact,startedAt,observedAt,block:head.block,blockHash:head.hash,blockTime:head.time,slotSpan:0,valid:head.time<=observedAt+1000&&observedAt-head.time<=this.cfg.maxBlockLagMs,reason:observedAt-head.time>this.cfg.maxBlockLagMs?'区块过期':undefined});
  }return quotes;
 }
 async trades(p:Pool,head:Awaited<ReturnType<BscAdapter['head']>>,deadline=Infinity):Promise<{trades:Trade[];coverage:Coverage}>{
  const prev=this.cursor.get(p.id);let reorg=false;
  if(prev){const check=await this.net.rpc(this.cfg.bscRpc,'eth_getBlockByNumber',['0x'+prev.number.toString(16),false]);if(check?.hash!==prev.hash){reorg=true;this.cursor.delete(p.id);}}
  const block=BigInt(head.block);const from=prev&&!reorg?prev.number+1n:block>60n?block-60n:0n;
  if(from>block)return {trades:[],coverage:{poolId:p.id,from:prev?.through??Date.now(),through:head.time,complete:true}};
  const logs=await this.net.rpc(this.cfg.bscRpc,'eth_getLogs',[{address:p.id,fromBlock:'0x'+from.toString(16),toBlock:head.block,topics:[swapTopic]}]);
  const trades:Trade[]=[];let complete=!reorg&&logs.length<=12;
  for(const log of logs.slice(-12)){
   if(Date.now()>=deadline){complete=false;break;}
   if(log.removed){complete=false;continue;}
   try{
    const e=decodeEventLog({abi:swapAbi,data:log.data,topics:log.topics});
    let actor=this.actorCache.get(log.transactionHash);if(!actor){actor=(await this.net.rpc(this.cfg.bscRpc,'eth_getTransactionByHash',[log.transactionHash]))?.from;if(actor)this.actorCache.set(log.transactionHash,actor);}
    if(!actor){complete=false;continue;}
    const h=await this.net.rpc(this.cfg.bscRpc,'eth_getBlockByNumber',[log.blockNumber,false]);
    const base0=p.base.address.toLowerCase()<p.quote.address.toLowerCase();const amount=base0?e.args.amount0:e.args.amount1;
    trades.push({id:log.transactionHash+':'+log.logIndex,poolId:p.id,actor,direction:amount>0n?'sell':'buy',eventAt:Number(BigInt(h.timestamp))*1000,availableAt:Date.now(),block:log.blockNumber,hash:log.blockHash});
   }catch{complete=false;}
  }
  this.cursor.set(p.id,{number:block,hash:head.hash,through:head.time});return {trades,coverage:{poolId:p.id,from:prev&&!reorg?prev.through:head.time-10000,through:head.time,complete,...(reorg?{invalidatedFrom:(prev?.through??head.time)-30000,invalidatedThrough:Date.now()}:{}),reason:reorg?'检测到重组，窗口作废':!complete?'成交窗口截断或交易身份缺失':undefined}};
 }
}
