import {AsyncLocalStorage} from 'node:async_hooks';
import {appendFileSync,mkdirSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {dirname} from 'node:path';
export const redact=(s:string)=>s.replace(/https?:\/\/[^\s"']+/g, x=>{try{return new URL(x).origin+'/[redacted-path]'}catch{return '[endpoint]'}});
export class Net {
 raw:string; requests=0; failures=0; slots:number[]=[]; private lanes=new Map<string,{pending:number;background:number;waiters:{run:()=>void;background:boolean}[]}>(); private next=new Map<string,number>(); private backoff=new Map<string,number>();
 private slotContext=new AsyncLocalStorage<number[]>(); private accountMemo=new WeakMap<number[],Map<string,Promise<any>>>(); private cycleMemo:Map<string,Promise<any>>|null=null;
 beginCycle(){this.cycleMemo=new Map();}
 traceSlots<T>(slots:number[],fn:()=>Promise<T>){this.accountMemo.set(slots,new Map());return this.slotContext.run(slots,fn);}
 constructor(raw:string){this.raw=raw;mkdirSync(dirname(raw),{recursive:true});}
 record(record:unknown){appendFileSync(this.raw,gzipSync(JSON.stringify(record)+'\n'));}
 async json(url:string,body?:unknown,priority:'quote'|'background'='quote'):Promise<any>{
  // At most two concurrent requests per endpoint (DDA-011). Background trade ingestion may hold one of them; quotes are served first.
  if(Array.isArray(body))throw new Error('不支持批量 JSON-RPC');
  const source=new URL(url).origin,background=priority==='background';
  let lane=this.lanes.get(source);if(!lane)this.lanes.set(source,lane={pending:0,background:0,waiters:[]});
  // The releasing request hands its slot (and background count) directly to the next waiter of the same endpoint.
  if(lane.pending<2&&!(background&&lane.background>=1)){lane.pending++;if(background)lane.background++;}
  else await new Promise<void>(run=>lane.waiters.push({run,background}));
  const method=(body as any)?.method??'GET';
  try{
   if(!['GET','eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_call','eth_gasPrice','eth_getLogs','eth_getTransactionByHash','eth_getCode','getAccountInfo','getMultipleAccounts','getSlot','getEpochInfo','getBlockTime','getRecentPrioritizationFees','getSignaturesForAddress','getTransaction','getVersion'].includes(method))throw new Error('只读 RPC 白名单拒绝 '+method);
   for(let attempt=0;attempt<2;attempt++){
    const scheduled=Math.max(Date.now(),this.next.get(source)??0,this.backoff.get(source)??0),wait=scheduled-Date.now();this.next.set(source,scheduled+180);if(wait>30000)throw new Error('服务退避中');if(wait>0)await new Promise(r=>setTimeout(r,wait));
    if((this.backoff.get(source)??0)>Date.now())throw new Error('服务退避中');
    const start=Date.now();this.requests++;
    let r:Response;
    try{r=await fetch(url,{method:body?'POST':'GET',body:body?JSON.stringify(body):undefined,headers:{'content-type':'application/json'},signal:AbortSignal.timeout(8000)});}catch(e){this.record({start,end:Date.now(),source,method,error:redact(String(e))});throw e;}
    const text=await r.text();let data:any;try{data=JSON.parse(text)}catch{data={error:{message:`HTTP ${r.status}: ${text.slice(0,120)}`}}}
    // Endpoint paths and keys are never persisted. Request payloads contain only public chain state.
    this.record({start,end:Date.now(),source,method,request:body??{path:new URL(url).pathname,query:new URL(url).search},status:r.status,response:data});
    if(r.status===429){const raw=r.headers.get('retry-after');const seconds=raw?Number(raw):NaN;const until=raw&&!Number.isFinite(seconds)?Date.parse(raw):Date.now()+(Number.isFinite(seconds)?seconds:2)*1000;this.backoff.set(source,Number.isFinite(until)?Math.max(Date.now()+1000,until):Date.now()+2000);if(attempt===0)continue;}
    if(!r.ok||data.error){this.failures++;throw new Error(`${method}: ${redact(String(data.error?.message??`HTTP ${r.status}`)).slice(0,200)}`);}
    const slot=data.result?.context?.slot;if(slot!==undefined)this.slots.push(slot);
    return body?data.result:data;
   }throw new Error('请求限流');
  }finally{
   if(background)lane.background--;
   const i=lane.waiters.findIndex(w=>!w.background),j=i>=0?i:lane.background<1?lane.waiters.findIndex(w=>w.background):-1;
   if(j>=0){const w=lane.waiters.splice(j,1)[0];if(w.background)lane.background++;w.run();}else lane.pending--;
  }
 }
/** Test replays return results through the same slot tracing as real responses. */
 rpcResult<T>(result:T):T{const slot=(result as any)?.context?.slot;if(slot!==undefined){this.slots.push(slot);this.slotContext.getStore()?.push(slot);}return result;}
 async rpc(url:string,method:string,params:unknown[]=[],priority:'quote'|'background'='quote'):Promise<any>{
  const context=this.slotContext.getStore(),memo=['getAccountInfo','getMultipleAccounts'].includes(method)?(context?this.accountMemo.get(context):undefined):this.cycleMemo,eligible=['getEpochInfo','getRecentPrioritizationFees','getMultipleAccounts','getAccountInfo','getBlockTime','eth_gasPrice'].includes(method),key=JSON.stringify([url,method,params]);
  let pending=eligible?memo?.get(key):undefined;
  if(!pending){pending=this.json(url,{jsonrpc:'2.0',id:1,method,params},priority);if(eligible&&memo){memo.set(key,pending);pending.catch(()=>memo.delete(key));}}
  const result=await pending;const slot=result?.context?.slot;if(slot!==undefined)this.slotContext.getStore()?.push(slot);return result;
 }
}
