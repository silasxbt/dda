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
type Priority='quote'|'background';
export type Head={block:string;hash:string;time:number};
export class BscAdapter {
 chain='bsc' as const; cursors=new Map<string,{number:bigint;hash:string;through:number}|null>();
 /** Single-group cursor kept for callers that ingest all pools together. */
 get cursor(){return this.cursors.get('*')??null;} set cursor(v){this.cursors.set('*',v);} actorCache=new Map<string,string>(); headers=new Map<string,Head>();
 constructor(public net:Net,public cfg:Config){}
 async call(to:string,data:Hex,block='latest'){return this.net.rpc(this.cfg.bscRpc,'eth_call',[{to,data},block]);}
 async state(pool:Pool,block='latest'){
  const v=decodeFunctionResult({abi:stateAbi,functionName:'slot0',data:await this.call(pool.id,encodeFunctionData({abi:stateAbi,functionName:'slot0'}),block)}) as readonly any[];return price(pool,v[0]);
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
 latest:{head:Head;at:number}|null=null;
 async head(priority:Priority='quote',maxAgeMs=0):Promise<Head>{
  if(this.latest&&Date.now()-this.latest.at<=maxAgeMs)return this.latest.head;
  const at=Date.now(),b=await this.net.rpc(this.cfg.bscRpc,'eth_getBlockByNumber',['latest',false],priority);const head={block:b.number as string,hash:b.hash as string,time:Number(BigInt(b.timestamp))*1000};
  if(!this.latest||at>=this.latest.at)this.latest={head,at};return head;
 }
 async quotes(p:Pool,head:Head,sizes=this.cfg.sizes):Promise<Quote[]>{return (await this.quotesAll([p],head,sizes)).get(p.id)??[];}
 // All pools, sizes and slot0 reads go through one Multicall3 eth_call pinned to the same block.
 async quotesAll(pools:Pool[],head:Head,sizes=this.cfg.sizes):Promise<Map<string,Quote[]>>{
  const startedAt=Date.now();const plan=pools.map(p=>({p,qty:sizes.map(size=>atoms(dec(size).div(p.market==='USDC/USDT'?1:p.initialPrice),p.base.decimals))}));
  const calls=plan.flatMap(({p,qty})=>[{target:p.id as Address,allowFailure:true,callData:encodeFunctionData({abi:stateAbi,functionName:'slot0'})},...qty.flatMap(amount=>[
   {target:QUOTER as Address,allowFailure:true,callData:encodeFunctionData({abi:quoteAbi,functionName:'quoteExactOutputSingle',args:[{tokenIn:p.quote.address as Address,tokenOut:p.base.address as Address,amount:BigInt(amount),fee:Math.round(p.fee*1e6),sqrtPriceLimitX96:0n}]})},
   {target:QUOTER as Address,allowFailure:true,callData:encodeFunctionData({abi:quoteAbi,functionName:'quoteExactInputSingle',args:[{tokenIn:p.base.address as Address,tokenOut:p.quote.address as Address,amountIn:BigInt(amount),fee:Math.round(p.fee*1e6),sqrtPriceLimitX96:0n}]})}
  ])]);
  const result=decodeFunctionResult({abi:multiAbi,functionName:'aggregate3',data:await this.call(MULTI,encodeFunctionData({abi:multiAbi,functionName:'aggregate3',args:[calls]}),head.block)});
  const gasPrice=BigInt(await this.net.rpc(this.cfg.bscRpc,'eth_gasPrice'));const observedAt=Date.now();const out=new Map<string,Quote[]>();let k=0;
  for(const {p,qty} of plan){
   const slot=result[k++];const quotes:Quote[]=[];out.set(p.id,quotes);
   if(!slot.success){k+=sizes.length*2;continue;}
   const spot=price(p,(decodeFunctionResult({abi:stateAbi,functionName:'slot0',data:slot.returnData}) as readonly any[])[0]);
   for(let i=0;i<sizes.length;i++){
    const rb=result[k++],rs=result[k++];if(!rb.success||!rs.success)continue;
    const buy=decodeFunctionResult({abi:quoteAbi,functionName:'quoteExactOutputSingle',data:rb.returnData}),sell=decodeFunctionResult({abi:quoteAbi,functionName:'quoteExactInputSingle',data:rs.returnData});
    const b=units(buy[0],p.quote.decimals),s=units(sell[0],p.quote.decimals),baseQty=units(qty[i],p.base.decimals);
    const impact=Math.max(dec(b).div(baseQty).div(spot).sub(1).toNumber(),dec(1).sub(dec(s).div(baseQty).div(spot)).toNumber())*10000;
    quotes.push({poolId:p.id,chain:'bsc',market:p.market,size:sizes[i],baseAtoms:qty[i],baseQty,buyAtoms:buy[0].toString(),sellAtoms:sell[0].toString(),buy:b,sell:s,spot,gasBuy:units((buy[3]*3n/2n+50000n)*gasPrice,18),gasSell:units((sell[3]*3n/2n+50000n)*gasPrice,18),nativeUsd:null,feeRate:p.fee,priceImpactBps:impact,startedAt,observedAt,block:head.block,blockHash:head.hash,blockTime:head.time,slotSpan:0,valid:head.time<=observedAt+1000&&observedAt-head.time<=this.cfg.maxBlockLagMs,reason:observedAt-head.time>this.cfg.maxBlockLagMs?'区块过期':undefined});
   }
  }return out;
 }
 private async header(block:string,priority:Priority,hash?:string){
  const hit=hash?this.headers.get(hash):undefined;if(hit)return hit;
  const b=await this.net.rpc(this.cfg.bscRpc,'eth_getBlockByNumber',[block,false],priority);if(!b?.hash)throw new Error('区块不可用 '+block);
  const h={block:b.number as string,hash:b.hash as string,time:Number(BigInt(b.timestamp))*1000};
  // Only immutable-by-hash data is cached; block numbers can be reorganized and are always re-read.
  this.headers.set(h.hash,h);if(this.headers.size>2000)this.headers.delete(this.headers.keys().next().value!);return h;
 }
 /**
  * Background Swap ingestion for every pool with one chain cursor. Each pass reads at most MAX_RANGE blocks,
  * stops at a block boundary when the deadline arrives, and resumes from the cursor in the next pass.
  * Coverage intervals use block timestamps and record when they became available.
  */
 async tradesAll(pools:Pool[],deadline=Infinity,priority:Priority='background',group='*'):Promise<{trades:Trade[];coverage:Coverage[];behind:number}>{
  const rpc=(m:string,p:unknown[])=>this.net.rpc(this.cfg.bscRpc,m,p,priority);
  const head=await this.head(priority,HEAD_SHARE_MS);const target=BigInt(head.block)-LOG_LAG;const prev=this.cursors.get(group)??null;const budget=deadline-Date.now();
  const window=(from:number,through:number,complete:boolean,reason?:string,extra:Partial<Coverage>={}):Coverage[]=>pools.map(p=>({poolId:p.id,from,through,complete,availableAt:Date.now(),...extra,...(complete?{}:{reason})}));
  if(prev){
   const check=await rpc('eth_getBlockByNumber',['0x'+prev.number.toString(16),false]);
   if(check?.hash!==prev.hash){this.cursors.set(group,null);return {trades:[],behind:0,coverage:window(prev.through,head.time,false,'检测到重组，窗口作废',{invalidatedFrom:prev.through-30000,invalidatedThrough:Date.now()})};}
  }
  const from=prev?prev.number+1n:target-FIRST_SYNC;
  if(from>target)return {trades:[],behind:0,coverage:[]};
  const to=from+MAX_RANGE-1n<target?from+MAX_RANGE-1n:target;
  const start=prev?{through:prev.through}:{through:(await this.header('0x'+(from-1n).toString(16),priority)).time};
  // Public backends may lag the head; an out-of-range error leaves the cursor in place.
  const logs:any[]=await rpc('eth_getLogs',[{address:pools.map(p=>p.id),fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),topics:[swapTopic]}]);
  // The pass budget starts once logs are in hand, and the first block is always finished, so every pass makes progress.
  const until=Date.now()+Math.max(0,budget);
  const byBlock=new Map<bigint,any[]>();for(const l of logs){const n=BigInt(l.blockNumber);byBlock.set(n,[...(byBlock.get(n)??[]),l]);}
  const trades:Trade[]=[];let complete=!!prev,reason=prev?undefined:'首次同步，窗口起点未知';let done:{number:bigint;hash:string;through:number}|null=null;
  let aborted=false;
  for(const n of [...byBlock.keys()].sort((a,b)=>a<b?-1:a>b?1:0)){
   if(done&&Date.now()>=until){aborted=true;break;}
   const rows=byBlock.get(n)!.sort((a,b)=>Number(BigInt(a.logIndex)-BigInt(b.logIndex)));
   // Logs carry blockTimestamp on current BSC nodes; the header is only read when it is missing.
   const h=rows[0].blockTimestamp?{block:rows[0].blockNumber,hash:rows[0].blockHash,time:Number(BigInt(rows[0].blockTimestamp))*1000}:await this.header(rows[0].blockNumber,priority,rows[0].blockHash);
   const block:Trade[]=[];let ok=true,why:string|undefined;
   if(rows.some(l=>l.blockHash!==h.hash)){ok=false;why='日志与区块哈希不一致';}
   for(const log of rows){
    // A block is committed whole or not at all, so the cursor only ever stops on a block boundary.
    if(done&&Date.now()>=until){aborted=true;break;}
    if(log.removed){ok=false;why='日志已被移除';continue;}
    const p=pools.find(x=>x.id.toLowerCase()===String(log.address).toLowerCase());if(!p)continue;
    try{
     const e=decodeEventLog({abi:swapAbi,data:log.data,topics:log.topics});
     let actor=this.actorCache.get(log.transactionHash);if(!actor){actor=(await rpc('eth_getTransactionByHash',[log.transactionHash]))?.from;if(actor){this.actorCache.set(log.transactionHash,actor);if(this.actorCache.size>5000)this.actorCache.delete(this.actorCache.keys().next().value!);}}
     if(!actor){ok=false;why='交易发起地址缺失';continue;}
     const base0=p.base.address.toLowerCase()<p.quote.address.toLowerCase();const amount=base0?e.args.amount0:e.args.amount1;
     block.push({id:log.transactionHash+':'+log.logIndex,poolId:p.id,actor,direction:amount>0n?'sell':'buy',eventAt:h.time,availableAt:Date.now(),block:log.blockNumber,hash:log.blockHash});
    }catch{ok=false;why='成交事件解码失败';}
   }
   if(aborted)break;
   trades.push(...block);if(!ok){complete=false;reason=why;}
   done={number:n,hash:h.hash,through:h.time};
  }
  const finished=!aborted;
  if(finished&&done?.number!==to){const h=await this.header('0x'+to.toString(16),priority);done={number:to,hash:h.hash,through:h.time};}
  if(!done)return {trades,behind:Number(target-from+1n),coverage:[]};
  this.cursors.set(group,done);
  return {trades,behind:Number(target-done.number),coverage:window(start.through,done.through,complete,reason??'成交窗口不完整')};
 }
}
const LOG_LAG=2n,MAX_RANGE=200n,FIRST_SYNC=30n,HEAD_SHARE_MS=1000;
function price(p:Pool,sqrt:bigint){const raw=dec(sqrt.toString()).div(dec(2).pow(96)).pow(2);return (p.base.address.toLowerCase()<p.quote.address.toLowerCase()?raw:dec(1).div(raw)).mul(dec(10).pow(p.base.decimals-p.quote.decimals)).toNumber();}
