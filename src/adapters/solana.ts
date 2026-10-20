import {Connection,PublicKey} from '@solana/web3.js';
import {Raydium,PoolUtils,fetchMultipleMintInfos,getPdaExBitmapAccount} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import {assets} from '../config.js';import {Net} from '../net.js';import {atoms,dec,units} from '../math.js';
import type {Pool,Quote,Config,Trade,Coverage} from '../types.js';
const PROGRAM='CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',MINT_SIZE=82;
// Public endpoint limit measured on 2026-10-19: 10 accounts per getMultipleAccounts; JSON-RPC batches are rejected.
const CHUNK=10,PAGE=25,MAX_PAGES=4;
type Priority='quote'|'background';
type View={accounts:Map<string,{value:any;slot:number}>;requested:Set<string>;trace:number[]};
export class SolanaAdapter {
 chain='solana' as const; covered=new Map<string,number>(); connection:Connection; sdk!:Raydium; seen=new Map<string,string>();
 /** Account keys each pool's last quote actually read; prefetched together at the start of the next quote. */
 learned=new Map<string,string[]>();
 /** Classic SPL mint accounts: decimals and program are immutable and are the only fields the quote uses. */
 immutable=new Map<string,any>();
 /** Per-pool constants read once from pool state: vault and mint used to measure swap direction. */
 static=new Map<string,{vault:string;mint:string}>();
 pending=new Map<string,{items:{signature:string;slot:number;blockTime:number|null;err:unknown}[];enumeratedAt:number}>();
 private view:View|null=null;
 constructor(public net:Net,public cfg:Config){
  this.connection=new Connection(cfg.solanaRpc,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:async (_url,options)=>{
   const body=JSON.parse(options?.body as string);if(body.params?.[1]&&['getMultipleAccounts','getAccountInfo'].includes(body.method))body.params[1].commitment='confirmed';
   let result:any;
   if(body.method==='getMultipleAccounts')result=await this.accounts(body.params[0],body.params[1]);
   else if(body.method==='getAccountInfo'){const r=await this.accounts([body.params[0]],body.params[1]);result={context:r.context,value:r.value[0]};}
   else result=await net.rpc(cfg.solanaRpc,body.method,body.params);
   return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{headers:{'content-type':'application/json'}});
  }});
 }
 /** Serves SDK account reads from the current quote snapshot; anything not prefetched is read now and its slot traced. */
 private async accounts(keys:string[],config:any){
  const view=this.view,value:any[]=new Array(keys.length),slots:number[]=[],missing:number[]=[];
  keys.forEach((k,i)=>{
   const fixed=this.immutable.get(k);if(fixed){value[i]=fixed;return;}
   view?.requested.add(k);const hit=view?.accounts.get(k);
   if(hit){value[i]=hit.value;slots.push(hit.slot);view!.trace.push(hit.slot);}else missing.push(i);
  });
  for(let i=0;i<missing.length;i+=CHUNK){
   const part=missing.slice(i,i+CHUNK),r=await this.net.rpc(this.cfg.solanaRpc,'getMultipleAccounts',[part.map(j=>keys[j]),{...config,encoding:'base64'}]);
   part.forEach((j,n)=>{value[j]=r.value[n];view?.accounts.set(keys[j],{value:r.value[n],slot:r.context.slot});this.remember(keys[j],r.value[n]);});slots.push(r.context.slot);
  }
  return {context:{slot:slots.length?Math.max(...slots):0},value};
 }
 private remember(key:string,value:any){
  if(value?.owner===TOKEN&&Buffer.from(value.data[0],'base64').length===MINT_SIZE){this.immutable.set(key,value);this.view?.requested.delete(key);}
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
 async quotes(p:Pool,sizes=this.cfg.sizes):Promise<Quote[]>{const r=(await this.quotesAll([p],sizes)).get(p.id)!;if(r instanceof Error)throw r;return r;}
 /**
  * Pools are snapshotted one after another (each snapshot is its own concurrent ≤10-account chunks, so its slot span
  * stays its own). Epoch and priority-fee reads start alongside; block times for every snapshot slot are read at the end.
  */
 async quotesAll(pools:Pool[],sizes=this.cfg.sizes):Promise<Map<string,Quote[]|Error>>{
  const startedAt=Date.now(),shared=Promise.all([this.connection.getEpochInfo('confirmed'),this.net.rpc(this.cfg.solanaRpc,'getRecentPrioritizationFees',[[]])]);shared.catch(()=>{});
  const snaps=new Map<string,Awaited<ReturnType<SolanaAdapter['snapshot']>>|Error>();
  for(const p of pools){try{snaps.set(p.id,await this.snapshot(p));}catch(e){snaps.set(p.id,e instanceof Error?e:new Error(String(e)));}}
  const out=new Map<string,Quote[]|Error>();let epoch:any,micro=0;
  try{const [e,fees]=await shared;epoch=e;const priority=(fees as any[]).map(x=>Number(x.prioritizationFee)).sort((a,b)=>a-b);micro=priority[Math.floor(priority.length*0.75)]??0;}
  catch(e){for(const p of pools)out.set(p.id,e instanceof Error?e:new Error(String(e)));return out;}
  const slots=[...new Set([...snaps.values()].flatMap(x=>x instanceof Error?[]:[x.slot??epoch.absoluteSlot]))];
  const times=new Map<number,number|Error>();
  await Promise.all(slots.map(async slot=>{try{times.set(slot,(await this.net.rpc(this.cfg.solanaRpc,'getBlockTime',[slot]))*1000);}catch(e){times.set(slot,e instanceof Error?e:new Error(String(e)));}}));
  for(const p of pools){
   const snap=snaps.get(p.id)!;if(snap instanceof Error){out.set(p.id,snap);continue;}
   const slot=snap.slot??epoch.absoluteSlot,blockTime=times.get(slot);
   if(blockTime instanceof Error){out.set(p.id,blockTime);continue;}if(!blockTime){out.set(p.id,new Error('slot 时间不可用'));continue;}
   out.set(p.id,this.compute(p,snap,sizes,epoch,micro,slot,blockTime,startedAt));
  }
  return out;
 }
 private async snapshot(p:Pool){
  if(this.view)throw new Error('Solana 报价快照不能并发');
  const traced:number[]=[];return this.net.traceSlots(traced,async()=>{
  // One snapshot per pool: every learned account in concurrent ≤10-account chunks, then the official SDK reads from it.
  const view:View={accounts:new Map(),requested:new Set(),trace:traced};this.view=view;
  try{
   const keys=this.learned.get(p.id)??[p.id,getPdaExBitmapAccount(new PublicKey(p.program),new PublicKey(p.id)).publicKey.toBase58()];
   await Promise.all(Array.from({length:Math.ceil(keys.length/CHUNK)},(_,i)=>keys.slice(i*CHUNK,i*CHUNK+CHUNK)).map(async chunk=>{
    const r=await this.net.rpc(this.cfg.solanaRpc,'getMultipleAccounts',[chunk,{encoding:'base64',commitment:'confirmed'}]);
    chunk.forEach((k,i)=>{view.accounts.set(k,{value:r.value[i],slot:r.context.slot});this.remember(k,r.value[i]);});
   }));
   const rpc=(await this.sdk.clmm.getRpcClmmPoolInfos({poolIds:[p.id]}))[p.id];
   if(rpc.programId.toBase58()!==p.program)throw new Error('池程序不匹配');
   const [mintA,mintB]=[rpc.mintA.toBase58(),rpc.mintB.toBase58()];
   if(mintA!==p.base.address&&mintB!==p.base.address)throw new Error('基础资产不匹配');
   const mintInfos=await fetchMultipleMintInfos({connection:this.connection,mints:[rpc.mintA,rpc.mintB]});
   for(const asset of [p.base,p.quote]){const m=mintInfos[asset.address];if(!m||(mintA!==asset.address&&mintB!==asset.address)||m.decimals!==asset.decimals)throw new Error('mint 或精度不匹配');}
   const {computeClmmPoolInfo,computePoolTickData}=await this.sdk.clmm.getComputeClmmPoolInfos({clmmPoolsRpcInfo:{[p.id]:rpc},mintInfos});
   if(!this.static.has(p.id)){const baseA=mintA===p.base.address;this.static.set(p.id,{vault:(baseA?rpc.vaultA:rpc.vaultB).toBase58(),mint:p.base.address});}
   this.learned.set(p.id,[...view.requested]);
   const slot=traced.length?Math.max(...traced):null,span=traced.length?slot!-Math.min(...traced):0;
   return {rpc,info:computeClmmPoolInfo[p.id],tickArrays:Object.values(computePoolTickData[p.id]??{}) as any[],slot,span};
  }finally{this.view=null;}
  });
 }
 private compute(p:Pool,snap:Awaited<ReturnType<SolanaAdapter['snapshot']>>,sizes:number[],epoch:any,micro:number,slot:number,blockTime:number,startedAt:number):Quote[]{
  const {rpc,info,tickArrays,span}=snap;
  const observedAt=Date.now();const baseA=p.base.address===rpc.mintA.toBase58();const spot=baseA?rpc.currentPrice:1/rpc.currentPrice;
  const gas=dec(5000).add(dec(micro).mul(300000).div(1e6)).div(1e9).toFixed();const quotes:Quote[]=[];
  for(const size of sizes){
   const amount=atoms(dec(size).div(p.market==='USDC/USDT'?1:p.initialPrice),p.base.decimals);
   const common={poolInfo:info,tickarrayBitmapExtension:info.exBitmapInfo,tickArrayCache:Object.fromEntries(tickArrays.map(t=>[t.address.toBase58(),t])),baseMint:new PublicKey(p.base.address),epochInfo:epoch,slippage:0,blockTimestamp:Math.floor(blockTime/1000)};
   try{
    const buy=PoolUtils.computeAmountIn({...common,amountOut:new BN(amount)});const sell=PoolUtils.computeAmountOut({...common,amountIn:new BN(amount),catchLiquidityInsufficient:false});
    if(!buy.allTrade||!sell.allTrade||buy.amountIn.amount.lten(0)||sell.amountOut.amount.lten(0))continue;
    const b=units(buy.amountIn.amount.toString(),p.quote.decimals),s=units(sell.amountOut.amount.toString(),p.quote.decimals),baseQty=units(amount,p.base.decimals);
    quotes.push({poolId:p.id,chain:'solana',market:p.market,size,baseAtoms:amount,baseQty,buyAtoms:buy.amountIn.amount.toString(),sellAtoms:sell.amountOut.amount.toString(),buy:b,sell:s,spot,gasBuy:gas,gasSell:gas,nativeUsd:null,feeRate:p.fee,priceImpactBps:Math.max(dec(b).div(baseQty).div(spot).sub(1).toNumber(),dec(1).sub(dec(s).div(baseQty).div(spot)).toNumber())*10000,startedAt,observedAt,block:String(slot),blockHash:'',blockTime,slotSpan:span,valid:span<=this.cfg.maxSolanaSlotSpan&&observedAt-blockTime<=this.cfg.maxBlockLagMs&&blockTime<=observedAt+1000,reason:span>this.cfg.maxSolanaSlotSpan?'状态跨 slot 范围过大':observedAt-blockTime>this.cfg.maxBlockLagMs?'slot 过期':undefined});
   }catch(e){this.net.record({type:'quote-depth-error',pool:p.id,size,error:e instanceof Error?e.stack:String(e)});}
  }return quotes;
 }
 /**
  * Background swap ingestion. Signatures newer than the cursor are enumerated page by page (newest first) and processed
  * oldest first; unprocessed signatures stay queued for the next pass. A window is complete only when the cursor existed,
  * enumeration reached it, and every transaction up to `through` was decoded.
  */
 async trades(p:Pool,deadline=Infinity,priority:Priority='background'):Promise<{trades:Trade[];coverage:Coverage|null;behind:number}>{
  const rpc=(m:string,params:unknown[])=>this.net.rpc(this.cfg.solanaRpc,m,params,priority);
  // Vault constants come from the first quote snapshot; reading them here would share the SDK connection with a quote in progress.
  const st=this.static.get(p.id);if(!st)return {trades:[],coverage:null,behind:0};
  const last=this.seen.get(p.id),state=this.pending.get(p.id)??{items:[],enumeratedAt:0},queue=state.items;let reason:string|undefined,complete=!!last;
  if(!last)reason='首次同步，窗口起点未知';
  if(!queue.length){
   const enumeratedAt=Date.now(),found:any[]=[];let before:string|undefined,reached=false;
   for(let page=0;page<(last?MAX_PAGES:1);page++){
    const rows:any[]=await rpc('getSignaturesForAddress',[p.id,{limit:PAGE,commitment:'confirmed',...(last?{until:last}:{}),...(before?{before}:{})}]);
    found.push(...rows);if(rows.length<PAGE){reached=true;break;}before=rows.at(-1).signature;
   }
   if(last&&!reached){complete=false;reason='签名分页未追平游标';}
   if(found[0])this.seen.set(p.id,found[0].signature);
   queue.push(...found.reverse().map(x=>({signature:x.signature,slot:x.slot,blockTime:x.blockTime,err:x.err})));
   state.enumeratedAt=enumeratedAt;this.pending.set(p.id,state);
  }
  const trades:Trade[]=[],enumeratedAt=state.enumeratedAt;
  while(queue.length&&Date.now()<deadline){
   const sig=queue[0];
   if(!sig.err){
    const r=await this.parse(p,st,sig.signature,rpc);
    if(r==='unknown'){complete=false;reason='交易解析缺失或版本不支持';}else if(r)trades.push(r);
   }
   queue.shift();
  }
  const previous=this.covered.get(p.id);
  // With signatures still queued, coverage ends strictly before the first unprocessed transaction's second.
  const through=queue.length?(queue[0].blockTime?queue[0].blockTime*1000-1:null):enumeratedAt-2000;
  if(through===null||(previous!==undefined&&through<=previous))return {trades,coverage:null,behind:queue.length};
  this.covered.set(p.id,through);
  if(previous===undefined){complete=false;reason??='首次同步，窗口起点未知';}
  return {trades,behind:queue.length,coverage:{poolId:p.id,from:previous??through-1000,through,complete,availableAt:Date.now(),...(complete?{}:{reason:reason??'成交窗口不完整'})}};
 }
 private async parse(p:Pool,st:{vault:string;mint:string},signature:string,rpc:(m:string,params:unknown[])=>Promise<any>):Promise<Trade|null|'unknown'>{
  // jsonParsed accountKeys list static and loaded keys in index order for legacy, v0 and v1 messages; token balances index into it.
  const tx=await rpc('getTransaction',[signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:1}]);
  if(!tx?.meta||!tx.blockTime||![undefined,'legacy',0,1].includes(tx.version))return 'unknown';
  if(!tx.meta.logMessages?.some((l:string)=>/Instruction: Swap/.test(l)))return null;
  const keys:string[]=(tx.transaction?.message?.accountKeys??[]).map((k:any)=>typeof k==='string'?k:k.pubkey);
  const ix=keys.indexOf(st.vault);if(ix<0)return null;
  const pre=tx.meta.preTokenBalances?.find((b:any)=>b.accountIndex===ix),post=tx.meta.postTokenBalances?.find((b:any)=>b.accountIndex===ix);
  if(!pre||!post||pre.mint!==st.mint||post.mint!==st.mint)return 'unknown';
  const delta=BigInt(post.uiTokenAmount.amount)-BigInt(pre.uiTokenAmount.amount);if(delta===0n)return null;
  return {id:signature+':'+p.id,poolId:p.id,actor:keys[0],direction:delta>0n?'sell':'buy',eventAt:tx.blockTime*1000,availableAt:Date.now(),block:String(tx.slot),hash:signature};
 }
}
