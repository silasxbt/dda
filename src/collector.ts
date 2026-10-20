import {randomUUID} from 'node:crypto';import {resolve} from 'node:path';
import {Net,redact} from './net.js';import {BscAdapter} from './adapters/bsc.js';import {SolanaAdapter} from './adapters/solana.js';import {Store} from './store.js';import {validateConfig} from './config.js';
import type {Session,Config,Cycle,Pool,Quote,Trade,Coverage} from './types.js';
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
  const enabled=s.pools.filter(p=>p.enabled),bscPools=enabled.filter(p=>p.chain==='bsc'),solPools=enabled.filter(p=>p.chain==='solana');
  // Trade ingestion runs beside the quote loop at background priority, with persistent per-session cursors.
  // Results wait in a buffer and are stored with the next cycle; strategy code only sees them from later cycles on.
  const buffer={trades:[] as Trade[],coverage:[] as Coverage[],errors:[] as Cycle['errors']};let ingesting=true;
  const sleep=(ms:number)=>new Promise(r=>setTimeout(r,Math.max(0,ms)));
  const fail=(source:string,e:unknown)=>buffer.errors.push({source,message:redact(String(e))});
  const loops=[
   // One cursor per BSC market: quiet pools are not held back by busy ones, and both pools of a pair share a window.
   ...[...new Set(bscPools.map(p=>p.market))].map(async market=>{const group=bscPools.filter(p=>p.market===market);while(ingesting){const t0=Date.now();try{const r=await bsc.tradesAll(group,Date.now()+INGEST_PASS_MS,'background',market);buffer.trades.push(...r.trades);buffer.coverage.push(...r.coverage);if(r.behind<=0)await sleep(IDLE_MS-(Date.now()-t0));}catch(e){fail('bsc:'+market+':trades',e);await sleep(ERROR_MS);}}}),
   solPools.length?(async()=>{const behind=new Map<string,number>();for(let i=0;ingesting;i++){const p=solPools[i%solPools.length],t0=Date.now();try{const r=await sol.trades(p,Date.now()+INGEST_PASS_MS);behind.set(p.id,r.behind);buffer.trades.push(...r.trades);if(r.coverage)buffer.coverage.push(r.coverage);}catch(e){fail(p.id+':trades',e);await sleep(ERROR_MS);}
    if(i%solPools.length===solPools.length-1&&solPools.every(x=>!behind.get(x.id)))await sleep(IDLE_MS-(Date.now()-t0));}})():null
  ];
  try{
  while(!this.stopping&&Date.now()<deadline){
   net.beginCycle();const startedAt=Date.now();const c:Cycle={id:`${s.id}:${index}`,sessionId:s.id,index:index++,startedAt,finishedAt:0,quotes:[],trades:[],coverage:[],errors:[]};
   const settled=new Map<string,Quote[]>();
   const short=(p:Pool,qs:Quote[])=>{settled.set(p.id,qs);if(qs.length<s.config.sizes.length)c.errors.push({source:p.id,message:'部分报价档位缺失或深度不足'});};
   await Promise.allSettled([
    // BSC: one Multicall3 call for every pool and size at one block.
    (async()=>{if(!bscPools.length)return;try{const head=await bsc.head();const all=await bsc.quotesAll(bscPools,head);for(const p of bscPools)short(p,all.get(p.id)??[]);}catch(e){for(const p of bscPools)c.errors.push({source:p.id,message:redact(String(e))});}})(),
    // Solana: pools snapshotted in sequence; each snapshot's slot span is its own.
    (async()=>{if(!solPools.length)return;try{const all=await sol.quotesAll(solPools);for(const p of solPools){const r=all.get(p.id);if(r instanceof Error||!r)c.errors.push({source:p.id,message:redact(String(r))});else short(p,r);}}catch(e){for(const p of solPools)c.errors.push({source:p.id,message:redact(String(e))});}})()
   ]);
   for(const p of enabled)c.quotes.push(...settled.get(p.id)??[]);
   const native={bsc:c.quotes.find(q=>q.market==='WBNB/USDT'&&q.valid)?.spot??null,solana:c.quotes.find(q=>q.market==='SOL/USDC'&&q.valid)?.spot??null};c.quotes.forEach(q=>q.nativeUsd=native[q.chain]);
   c.trades=buffer.trades.splice(0);c.coverage=buffer.coverage.splice(0);c.errors.push(...buffer.errors.splice(0));
   c.finishedAt=Date.now();this.store.addCycle(c);
   if(index%12===0)console.log(JSON.stringify({session:s.id,cycles:index,quotes:c.quotes.length,trades:c.trades.length,errors:c.errors.length,elapsedSeconds:Math.round((c.finishedAt-s.startedAt)/1000)}));
   const wait=Math.min(s.config.intervalMs-(Date.now()-startedAt),deadline-Date.now());if(wait>0)await sleep(wait);
  }
  }finally{
   ingesting=false;await Promise.allSettled(loops);
   // Records that arrived after the last stored cycle could not inform any decision; the raw log keeps them.
   net.record({type:'ingestion-stopped',unstoredTrades:buffer.trades.length,unstoredCoverage:buffer.coverage.length});
  }
  s.status=this.stopping?'stopped':'completed';
 }
}
const INGEST_PASS_MS=3000,IDLE_MS=1000,ERROR_MS=2000;
