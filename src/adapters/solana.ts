import {Connection,PublicKey} from '@solana/web3.js';
import {Raydium,PoolUtils} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import {assets} from '../config.js';import {Net} from '../net.js';import {atoms,dec,units} from '../math.js';
import type {Pool,Quote,Config,Trade,Coverage} from '../types.js';
const PROGRAM='CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
export class SolanaAdapter {
 chain='solana' as const; covered=new Map<string,number>(); connection:Connection; sdk!:Raydium; seen=new Map<string,string>();
 constructor(public net:Net,public cfg:Config){
  this.connection=new Connection(cfg.solanaRpc,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:async (_url,options)=>{
   const body=JSON.parse(options?.body as string);if(body.params?.[1]&&['getMultipleAccounts','getAccountInfo'].includes(body.method))body.params[1].commitment='confirmed';
   let result:any;
   if(body.method==='getMultipleAccounts'&&body.params[0].length>5){
    const values:any[]=[];let context:any;for(let i=0;i<body.params[0].length;i+=5){const r=await net.rpc(cfg.solanaRpc,body.method,[body.params[0].slice(i,i+5),body.params[1]]);values.push(...r.value);context=r.context;}result={context,value:values};
   }else result=await net.rpc(cfg.solanaRpc,body.method,body.params);return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{headers:{'content-type':'application/json'}});
  }});
 }
 async init(){this.sdk=await Raydium.load({connection:this.connection,disableLoadToken:true,disableFeatureCheck:true});}
 async discover():Promise<Pool[]>{
  if(!this.sdk)await this.init();const pools:Pool[]=[];
  for(const [base,quote,market] of [[assets.solUSDC,assets.solUSDT,'USDC/USDT'],[assets.sol,assets.solUSDC,'SOL/USDC']] as const){
   const api=await this.net.json(`https://api-v3.raydium.io/pools/info/mint?mint1=${base.address}&mint2=${quote.address}&poolType=concentrated&poolSortField=liquidity&sortType=desc&pageSize=5&page=1`);
   const found:{p:Pool;impact:number}[]=[];
   for(const item of api.data?.data??[]){
    if(item.programId!==PROGRAM)continue;
    const ids=[item.mintA.address,item.mintB.address];if(!ids.includes(base.address)||!ids.includes(quote.address))continue;
    const p:Pool={id:item.id,chain:'solana',market,dex:'Raydium CLMM',base,quote,fee:item.feeRate,program:PROGRAM,initialPrice:base.address===item.mintA.address?item.price:1/item.price,enabled:false};
    try{const qs=await this.quotes(p,[1000]);const q=qs[0];p.enabled=!!q?.valid&&q.priceImpactBps<=this.cfg.maxImpactBps;if(!p.enabled)p.reason=q?.reason??'深度、冲击或状态时效核验失败';found.push({p,impact:q?dec(q.buy).sub(q.sell).div(q.buy).toNumber():Infinity});}catch(e){p.reason=String(e);found.push({p,impact:Infinity});}
    if(found.filter(x=>x.p.enabled).length>=3)break;
   }
   pools.push(...found.sort((a,b)=>a.impact-b.impact).slice(0,2).map(x=>x.p));
  }return pools;
 }
 async quotes(p:Pool,sizes=this.cfg.sizes):Promise<Quote[]>{
  const traced:number[]=[];return this.net.traceSlots(traced,async()=>{
  const startedAt=Date.now(),slotStart=this.net.slots.length;
  const info=await this.sdk.clmm.getPoolInfoFromRpc(p.id);
  if(info.rpcPoolInfo.programId.toBase58()!==p.program)throw new Error('池程序不匹配');
  if(info.poolInfo.mintA.address!==p.base.address&&info.poolInfo.mintB.address!==p.base.address)throw new Error('基础资产不匹配');
  for(const asset of [p.base,p.quote]){const mint=info.poolInfo.mintA.address===asset.address?info.poolInfo.mintA:info.poolInfo.mintB;if(mint.address!==asset.address||mint.decimals!==asset.decimals)throw new Error('mint 或精度不匹配');}
  const epoch=await this.connection.getEpochInfo('confirmed');const fees=await this.net.rpc(this.cfg.solanaRpc,'getRecentPrioritizationFees',[[]]);
  const priority=(fees as any[]).map(x=>Number(x.prioritizationFee)).sort((a,b)=>a-b);const micro=priority[Math.floor(priority.length*0.75)]??0;
  const slots=traced.length?traced:this.net.slots.slice(slotStart),slot=slots.length?Math.max(...slots):epoch.absoluteSlot;const span=slots.length?slot-Math.min(...slots):0;
  const blockTime=(await this.net.rpc(this.cfg.solanaRpc,'getBlockTime',[slot]))*1000;if(!blockTime)throw new Error('slot 时间不可用');
  const observedAt=Date.now();const spot=p.base.address===info.poolInfo.mintA.address?info.poolInfo.price:1/info.poolInfo.price;
  const gas=dec(5000).add(dec(micro).mul(300000).div(1e6)).div(1e9).toFixed();const quotes:Quote[]=[];
  for(const size of sizes){
   const amount=atoms(dec(size).div(p.market==='USDC/USDT'?1:p.initialPrice),p.base.decimals);
   const common={poolInfo:info.computePoolInfo,tickarrayBitmapExtension:info.computePoolInfo.exBitmapInfo,tickArrayCache:Object.fromEntries(info.tickArrays.map(t=>[t.address.toBase58(),t])),baseMint:new PublicKey(p.base.address),epochInfo:epoch,slippage:0,blockTimestamp:Math.floor(blockTime/1000)};
   try{
    const buy=PoolUtils.computeAmountIn({...common,amountOut:new BN(amount)});const sell=PoolUtils.computeAmountOut({...common,amountIn:new BN(amount),catchLiquidityInsufficient:false});
    if(!buy.allTrade||!sell.allTrade||buy.amountIn.amount.lten(0)||sell.amountOut.amount.lten(0))continue;
    const b=units(buy.amountIn.amount.toString(),p.quote.decimals),s=units(sell.amountOut.amount.toString(),p.quote.decimals),baseQty=units(amount,p.base.decimals);
    quotes.push({poolId:p.id,chain:'solana',market:p.market,size,baseAtoms:amount,baseQty,buyAtoms:buy.amountIn.amount.toString(),sellAtoms:sell.amountOut.amount.toString(),buy:b,sell:s,spot,gasBuy:gas,gasSell:gas,nativeUsd:null,feeRate:p.fee,priceImpactBps:Math.max(dec(b).div(baseQty).div(spot).sub(1).toNumber(),dec(1).sub(dec(s).div(baseQty).div(spot)).toNumber())*10000,startedAt,observedAt,block:String(slot),blockHash:'',blockTime,slotSpan:span,valid:span<=this.cfg.maxSolanaSlotSpan&&observedAt-blockTime<=this.cfg.maxBlockLagMs&&blockTime<=observedAt+1000,reason:span>this.cfg.maxSolanaSlotSpan?'状态跨 slot 范围过大':observedAt-blockTime>this.cfg.maxBlockLagMs?'slot 过期':undefined});
   }catch(e){this.net.record({type:'quote-depth-error',pool:p.id,size,error:e instanceof Error?e.stack:String(e)});}
  }return quotes;
  });
 }
 async trades(p:Pool,deadline=Infinity):Promise<{trades:Trade[];coverage:Coverage}>{
  const now=Date.now();const last=this.seen.get(p.id);const signatures=await this.connection.getSignaturesForAddress(new PublicKey(p.id),{limit:3,until:last},'confirmed');
  const trades:Trade[]=[];let complete=signatures.length<3;
  for(const sig of [...signatures].reverse()){
   if(Date.now()>=deadline){complete=false;break;}
   if(sig.err)continue;
   const tx=await this.connection.getParsedTransaction(sig.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
   if(!tx?.meta||!tx.blockTime){complete=false;continue;}
   if(!tx.meta.logMessages?.some(l=>/Instruction: Swap/.test(l)))continue;
   // Use pool vault deltas rather than transaction-wide user deltas; routing may touch many tokens.
   const poolInfo=await this.sdk.clmm.getRpcClmmPoolInfo({poolId:p.id});
   const vault=(p.base.address===poolInfo.mintA.toBase58()?poolInfo.vaultA:poolInfo.vaultB).toBase58();
   const ix=tx.transaction.message.accountKeys.findIndex(k=>k.pubkey.toBase58()===vault);
   const pre=tx.meta.preTokenBalances?.find(b=>b.accountIndex===ix),post=tx.meta.postTokenBalances?.find(b=>b.accountIndex===ix);
   if(!pre||!post){complete=false;continue;}
   const delta=BigInt(post.uiTokenAmount.amount)-BigInt(pre.uiTokenAmount.amount);if(delta===0n)continue;
   const actor=tx.transaction.message.accountKeys[0].pubkey.toBase58();
   trades.push({id:sig.signature+':'+p.id,poolId:p.id,actor,direction:delta>0n?'sell':'buy',eventAt:tx.blockTime*1000,availableAt:Date.now(),block:String(tx.slot),hash:sig.signature});
  }
  if(signatures[0])this.seen.set(p.id,signatures[0].signature);
  const previous=this.covered.get(p.id);const through=now-2000;this.covered.set(p.id,through);return {trades,coverage:{poolId:p.id,from:previous??through-1000,through,complete:complete&&!!last,reason:complete&&last?undefined:'成交窗口截断、首次同步或解析缺失'}};
 }
}
