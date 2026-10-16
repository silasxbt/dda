import {randomUUID} from 'node:crypto';import {resolve} from 'node:path';
import {Net,redact} from './net.js';import {BscAdapter} from './adapters/bsc.js';import {SolanaAdapter} from './adapters/solana.js';import {Store} from './store.js';import {validateConfig} from './config.js';
import type {Session,Config,Cycle,Pool} from './types.js';
export class Collector {
 active:Session|null=null; stopping=false; preparing=false; done:Promise<void>|null=null;lastError:string|null=null;
 constructor(public store:Store){}
 async start(input:Partial<Config>={},fixedPools?:Pool[]):Promise<Session>{
  if(this.active||this.preparing)throw new Error('已有会话或市场核验正在运行');const config=validateConfig(input);const unlock=this.store.lock();this.preparing=true;this.stopping=false;
  const id=randomUUID(),net=new Net(resolve(this.store.root,'raw',id+'.ndjson.gz'));const bsc=new BscAdapter(net,config),sol=new SolanaAdapter(net,config);const pools:Pool[]=[];const capabilities:Record<string,unknown>={};
  try{
   for(const adapter of [bsc,sol]){
    try{const found=fixedPools?fixedPools.filter(x=>x.chain===adapter.chain):await adapter.discover();if(adapter===sol&&!sol.sdk)await sol.init();pools.push(...found);capabilities[adapter.chain]={status:found.some(p=>p.enabled)?'available':'unavailable',pools:found.length};}catch(e){capabilities[adapter.chain]={status:'unavailable',error:redact(String(e))};}
   }
   // Freeze one base quantity per market for both pools, so opposite legs match exactly.
   const references=new Map<string,number>();for(const p of pools){const key=p.chain+':'+p.market;if(p.enabled&&!references.has(key))references.set(key,p.initialPrice);}for(const p of pools)p.initialPrice=references.get(p.chain+':'+p.market)??p.initialPrice;
   const session:Session={id,startedAt:Date.now(),endedAt:null,status:'running',config,pools,capabilities};this.active=session;this.preparing=false;this.store.saveSession(session);
   this.done=this.run(session,net,bsc,sol).catch(e=>{session.status='interrupted';this.lastError=redact(String(e));}).finally(()=>{session.endedAt=Date.now();this.store.saveSession(session);this.active=null;unlock();});return session;
  }catch(e){this.preparing=false;unlock();throw e;}
 }
 stop(){this.stopping=true;}
 private async run(s:Session,net:Net,bsc:BscAdapter,sol:SolanaAdapter){
  const deadline=s.startedAt+s.config.durationMinutes*60000;let index=0;
  while(!this.stopping&&Date.now()<deadline){
   net.beginCycle();const startedAt=Date.now();const c:Cycle={id:`${s.id}:${index}`,sessionId:s.id,index:index++,startedAt,finishedAt:0,quotes:[],trades:[],coverage:[],errors:[]};const enabled=s.pools.filter(p=>p.enabled);
   const head=enabled.some(p=>p.chain==='bsc')?await bsc.head().catch(e=>{c.errors.push({source:'bsc-head',message:redact(String(e))});return null}):null;
   // Quote phase precedes transaction ingestion; strategy features can only use already available records.
   const quote=async(p:Pool)=>{
    const qs=p.chain==='bsc'?(head?await bsc.quotes(p,head):[]):await sol.quotes(p);if(qs.length<s.config.sizes.length)c.errors.push({source:p.id,message:'部分报价档位缺失或深度不足'});return qs;
   };
   // Multi-account Solana reads must finish per pool before the next pool starts.
   // Interleaving four SDK snapshots increases each snapshot's slot span.
   const settled=new Map<string,PromiseSettledResult<Awaited<ReturnType<typeof quote>>>>();
   await Promise.allSettled([
    Promise.allSettled(enabled.filter(p=>p.chain==='bsc').map(async p=>{try{settled.set(p.id,{status:'fulfilled',value:await quote(p)});}catch(reason){settled.set(p.id,{status:'rejected',reason});}})),
    (async()=>{for(const p of enabled.filter(p=>p.chain==='solana')){try{settled.set(p.id,{status:'fulfilled',value:await quote(p)});}catch(reason){settled.set(p.id,{status:'rejected',reason});}}})()
   ]);
   const results=enabled.map(p=>settled.get(p.id)!);
   results.forEach((r,i)=>{if(r.status==='fulfilled')c.quotes.push(...r.value);else c.errors.push({source:enabled[i].id,message:redact(String(r.reason))});});
   const native={bsc:c.quotes.find(q=>q.market==='WBNB/USDT'&&q.valid)?.spot??null,solana:c.quotes.find(q=>q.market==='SOL/USDC'&&q.valid)?.spot??null};c.quotes.forEach(q=>q.nativeUsd=native[q.chain]);
   // Ingest bounded transaction batches; a truncated or unavailable window stays unknown.
   const tradeDeadline=Math.min(deadline,Date.now()+4000);
   const ordered=enabled.slice(index%enabled.length).concat(enabled.slice(0,index%enabled.length));
   for(const p of ordered){
    if(Date.now()>=tradeDeadline){c.coverage.push({poolId:p.id,from:startedAt,through:Date.now(),complete:false,reason:"成交读取预算耗尽"});continue;}
    if(this.stopping||Date.now()>=deadline)break;
    try{const t=p.chain==='bsc'?(head?await bsc.trades(p,head,tradeDeadline):null):await sol.trades(p,tradeDeadline);if(t){c.trades.push(...t.trades);c.coverage.push(t.coverage);}}
    catch(e){c.coverage.push({poolId:p.id,from:startedAt,through:Date.now(),complete:false,reason:redact(String(e))});c.errors.push({source:p.id+':trades',message:redact(String(e))});}
   }
   c.finishedAt=Date.now();this.store.addCycle(c);
   if(index%12===0)console.log(JSON.stringify({session:s.id,cycles:index,quotes:c.quotes.length,errors:c.errors.length,elapsedSeconds:Math.round((c.finishedAt-s.startedAt)/1000)}));
   const wait=Math.min(s.config.intervalMs-(Date.now()-startedAt),deadline-Date.now());if(wait>0)await new Promise(r=>setTimeout(r,wait));
  }s.status=this.stopping?'stopped':'completed';
 }
}
