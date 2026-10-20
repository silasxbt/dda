// Coverage diagnosis for one stored session (DDA-008 acceptance metrics).
// Usage: DDA_DATA_DIR=<dir> pnpm exec tsx scripts/coverage.ts <session-id> [output.json]
import {existsSync,readFileSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';import {gunzipSync} from 'node:zlib';
import {Store} from '../src/store.js';import {features} from '../src/core/engine.js';import {research,quantile} from '../src/core/research.js';
import type {Coverage} from '../src/types.js';

const id=process.argv[2];if(!id)throw new Error('需要会话 ID');
const store=new Store(process.env.DDA_DATA_DIR??'data');const s=store.session(id),cycles=store.cycles(id);store.close();
const enabled=s.pools.filter(p=>p.enabled),sizes=s.config.sizes.length,r=research(s,cycles);
// Per decision time (cycle end), is the past 30-second trade window complete for this pool, using only earlier coverage?
const known:Coverage[]=[];const windows=new Map<string,number>(enabled.map(p=>[p.id,0]));
for(const c of cycles){known.push(...c.coverage.filter(x=>x.availableAt!==undefined));for(const p of enabled)if(features([p.id],c.finishedAt,[],known,['buy'],s.config).available)windows.set(p.id,windows.get(p.id)!+1);known.push(...c.coverage.filter(x=>x.availableAt===undefined));}
const byPool=enabled.map(p=>{
 const qs=cycles.flatMap(c=>c.quotes.filter(q=>q.poolId===p.id)),cov=cycles.flatMap(c=>c.coverage.filter(x=>x.poolId===p.id)),reasons:Record<string,number>={};
 for(const q of qs)if(!q.valid)reasons['报价:'+(q.reason??'无效')]=(reasons['报价:'+(q.reason??'无效')]??0)+1;
 for(const x of cov)if(!x.complete){const k='成交:'+(x.reason??'不完整').slice(0,60);reasons[k]=(reasons[k]??0)+1;}
 for(const c of cycles)for(const e of c.errors)if(e.source.startsWith(p.id)){const k='错误:'+e.message.slice(0,60);reasons[k]=(reasons[k]??0)+1;}
 const spans=qs.filter(q=>q.chain==='solana').map(q=>q.slotSpan);
 return {pool:p.id,chain:p.chain,market:p.market,expectedQuotes:cycles.length*sizes,quotes:qs.length,valid:qs.filter(q=>q.valid).length,
  validShare:cycles.length?qs.filter(q=>q.valid).length/(cycles.length*sizes):null,medianQuoteMs:quantile(qs.map(q=>q.observedAt-q.startedAt),.5),
  slotSpanMedian:quantile(spans,.5),slotSpanP95:quantile(spans,.95),coverageWindows:cov.length,completeWindows:cov.filter(x=>x.complete).length,
  coveredSeconds:cov.filter(x=>x.complete).reduce((n,x)=>n+(x.through-x.from)/1000,0),
  ingestLagMedianMs:quantile(cov.filter(x=>x.availableAt!==undefined).map(x=>x.availableAt!-x.through),.5),
  complete30sWindowShare:cycles.length?windows.get(p.id)!/cycles.length:null,tradeRecords:cycles.reduce((n,c)=>n+c.trades.filter(t=>t.poolId===p.id).length,0),reasons};
});
// Requests from the compressed raw log (concatenated gzip members).
const raw=resolve(process.env.DDA_DATA_DIR??'data','raw',id+'.ndjson.gz');const requests:Record<string,{n:number;errors:number;rateLimited:number;timeouts:number;medianMs:number|null}>={};
if(existsSync(raw)){
 const rows=gunzipSync(readFileSync(raw)).toString().split('\n').filter(Boolean).map(x=>JSON.parse(x)).filter(x=>x.method);const ms:Record<string,number[]>={};
 for(const x of rows){const k=new URL(x.source).hostname.split('.')[0]+' '+x.method,e=String(x.error??(x.response?.error?JSON.stringify(x.response.error):''));const o=requests[k]??={n:0,errors:0,rateLimited:0,timeouts:0,medianMs:null};
  o.n++;if(e){o.errors++;if(/429|-32005|Rate limit/i.test(e)||x.status===429)o.rateLimited++;if(/timeout|aborted/i.test(e))o.timeouts++;}(ms[k]??=[]).push(x.end-x.start);}
 for(const k in requests)requests[k].medianMs=quantile(ms[k],.5);
}
const total=Object.values(requests).reduce((n,x)=>n+x.n,0);
const out={session:id,startedAt:new Date(s.startedAt).toISOString(),status:s.status,cycles:cycles.length,durationMinutes:r.quality.durationSeconds/60,
 intervalMedianMs:r.quality.intervalMedianMs,intervalP95Ms:r.quality.intervalP95Ms,gaps:r.quality.gaps,validQuoteShare:r.quality.coverage,
 competitionKnown:r.summary.competitionKnown,candidates:r.candidates.length,observed5:r.summary.observed5,observed15:r.summary.observed15,labelsExpected:r.candidates.length,
 requestsPerCycle:cycles.length?total/cycles.length:null,rateLimited:Object.values(requests).reduce((n,x)=>n+x.rateLimited,0),timeouts:Object.values(requests).reduce((n,x)=>n+x.timeouts,0),
 requests,byPool};
const text=JSON.stringify(out,null,1);if(process.argv[3])writeFileSync(process.argv[3],text);console.log(text);
