import {randomUUID} from 'node:crypto';
import {atoms,dec,units} from '../math.js';
import {ExecutionStore,publicRun,publicOperation} from './store.js';
import {balanceKey,decimals,spendKey,type TestAdapter,type Run,type Mode,type Scenario,type Operation,type Balances,type QuotePlan} from './types.js';
export type Checkpoint=(stage:string,run:Run)=>void|Promise<void>;
const terminal = new Set(['completed','rejected','stopped','recovered']);
export class ExecutionEngine {
 busy=false; working?:Promise<unknown>; lastError?:string;
 constructor(public store:ExecutionStore,public adapters:Record<Mode,TestAdapter>,private checkpoint:Checkpoint=()=>{}){}
 private event(r:Run,message:string){r.events.push({at:Date.now(),message});this.store.save(r);}
 private assertIdle(){if(this.busy)throw new Error('另一项测试操作进行中');if(this.store.runs().some(r=>!terminal.has(r.status)))throw new Error('存在未完成交易或敞口，请先恢复对账／平仓');if(this.store.setupOperations().some(o=>!['confirmed','failed','expired','cancelled'].includes(o.state)))throw new Error('初始化交易未确认，请先恢复初始化');}
 launch(mode:Mode,scenario:Scenario,requestKey:string,qty='10'):Run {
  const prior=this.store.byKey(requestKey);if(prior){if(prior.mode!==mode||prior.scenario!==scenario||prior.qty!==qty)throw new Error('重复操作标识对应不同参数');return prior;}
  this.assertIdle();if(!dec(qty).isFinite()||!dec(qty).gt(0)||dec(qty).gt(100))throw new Error('测试数量须大于零且不超过 100');
  if(dec(qty).mul(1000000).isInteger()===false)throw new Error('测试数量最多六位小数，以匹配两链精度');
  if(mode==='testnet'&&!['success','one-leg-fail'].includes(scenario))throw new Error('该故障只允许在确定性场景运行');
  const r:Run={id:randomUUID(),requestKey,mode,scenario,createdAt:Date.now(),updatedAt:Date.now(),status:'preparing',qty,source:mode==='scenario'?'synthetic':'testnet-workflow',before:{},plans:[],reservations:{},operations:[],stopRequested:false,exposure:'0',followups:[],events:[]};this.store.save(r);
  this.busy=true;this.working=this.execute(r).catch(e=>{this.lastError=safeError(e);}).finally(()=>{this.busy=false;});return r;
 }
 async wait(){await this.working;}
 private async execute(r:Run){
  const a=this.adapters[r.mode];
  try {
   await a.check();r.before=await a.balances();
   r.plans=[await a.quote('bsc','buy',r.qty,r.scenario),await a.quote('solana','sell',r.qty,r.scenario)];
   if(r.plans.some(p=>p.qty!==r.qty))throw new Error('两腿基础数量不匹配');
   if(r.plans.some(p=>Date.now()-p.at>15000))return this.reject(r,'报价过期');
   const buy=r.plans[0],sell=r.plans[1],cost=units(buy.maxSpend,decimals('bsc','B')),proceeds=units(sell.minReceive,decimals('solana','B'));
   if(dec(proceeds).lte(cost))return this.reject(r,'保守报价价差不成立');
   // Only scenario fixtures test competitor gates. Public testnet workflow is explicitly not DDA evidence.
   if(r.scenario==='competition'||r.scenario==='competition-unknown')return this.reject(r,r.scenario==='competition'?'合成竞争压力超过阈值':'竞争数据不足');
   for(const p of r.plans){this.reserve(r,spendKey(p),p.maxSpend);this.reserve(r,balanceKey(p.chain,'native'),p.feeReserve);}
   if(r.scenario==='inventory')return this.reject(r,'合成场景：库存不足');
   for(const [k,v]of Object.entries(r.reservations))if(BigInt(r.before[k]??'0')<BigInt(v))return this.reject(r,'库存或费用余额不足：'+k);
   await a.preflight(r.plans,r.scenario);this.event(r,'预检查通过，库存已预留');await this.checkpoint('reserved',r);
   for(const p of r.plans){if(this.store.get(r.id).stopRequested)return this.stopBeforeSend(r);const key=`${r.id}:${p.side}`,prepared=await a.prepare(p,key,r.scenario);r.operations.push({key,kind:p.side,chain:p.chain,state:'signed',prepared,plan:p});this.event(r,`${p.chain} ${p.side} 已签名并持久化`);await this.checkpoint('signed:'+p.side,r);}
   r.status='running';this.store.save(r);
   for(const op of r.operations){
    if(this.store.get(r.id).stopRequested||Date.now()-op.plan!.at>15000){op.state='cancelled';op.error='停止或报价已过期，未提交';continue;}
    // Controlled public failure: first leg is a real swap, second is withheld, never falsely called an onchain revert.
    if(r.mode==='testnet'&&r.scenario==='one-leg-fail'&&op.kind==='sell'){op.state='cancelled';op.error='受控故障：主动不提交第二腿';this.store.save(r);continue;}
    op.state='submitting';this.store.save(r);await this.checkpoint('submitting:'+op.kind,r);
    try{await a.broadcast(op.prepared);op.state='submitted';}catch(e){op.state='unknown';op.error=safeError(e);}this.store.save(r);await this.checkpoint('submitted:'+op.kind,r);
   }
   await this.reconcileRun(r);await this.checkpoint('reconciled',r);
  }catch(e){
   r.reason=safeError(e);r.stopRequested=this.store.get(r.id).stopRequested;
   if(r.operations.length){r.status='pending';this.event(r,'已保存检查点；需恢复对账：'+r.reason);}
   else {r.status=r.stopRequested?'stopped':'rejected';r.reservations={};this.event(r,r.reason);}
  }
 }
 private reserve(r:Run,key:string,amount:string){if(!/^\d+$/.test(amount))throw new Error('预留数量必须为非负整数');r.reservations[key]=(BigInt(r.reservations[key]??'0')+BigInt(amount)).toString();}
 private async follow(r:Run){
  // Observe rejected candidates too; no sleeps or invented timestamps. Network gaps remain unknown.
  const elapsed=(Date.now()-r.createdAt)/1000;
  for(const seconds of [5,15])if(elapsed>=seconds&&!r.followups.some(f=>f.seconds===seconds)){
   if(elapsed>seconds+10){r.followups.push({seconds,status:'unknown',source:r.source});continue;}
   try{const a=this.adapters[r.mode],b=await a.quote('bsc','buy',r.qty,r.scenario),s=await a.quote('solana','sell',r.qty,r.scenario);r.followups.push({seconds,status:'observed',quoteNet:dec(units(s.receive,decimals(s.chain,'B'))).sub(units(b.spend,decimals(b.chain,'B'))).toFixed(),source:r.source});}catch{r.followups.push({seconds,status:'unknown',source:r.source});}
  }this.store.save(r);
 }
 async followups(){if(this.busy)return;this.busy=true;try{for(const r of this.store.runs().slice(0,100))await this.follow(r);}finally{this.busy=false;}}
 private reject(r:Run,reason:string){r.status='rejected';r.reason=reason;r.reservations={};this.event(r,reason);}
 private stopBeforeSend(r:Run){r.status='stopped';r.stopRequested=true;r.reservations={};for(const op of r.operations)op.state='cancelled';this.event(r,'提交前停止，预留已释放');}
 stop(id:string){const r=this.store.get(id);r.stopRequested=true;this.event(r,'已请求停止后续提交；已发送交易继续对账');return publicRun(r);}
 async recover(id:string){if(this.busy)throw new Error('正在执行，请稍后恢复');const saved=this.store.get(id);if(terminal.has(saved.status)&&this.store.runs().filter(r=>r.mode===saved.mode).findIndex(r=>r.id===id)>0)return publicRun(saved);this.busy=true;try{const r=this.store.get(id);if(!r.operations.length){if(!['rejected','stopped'].includes(r.status))this.stopBeforeSend(r);return publicRun(r);}await this.reconcileRun(r);return publicRun(r);}finally{this.busy=false;}}
 private async reconcileRun(r:Run){
  const a=this.adapters[r.mode];await a.check();
  for(const op of r.operations){
   if(op.state==='cancelled')continue;
   if(op.state==='signed'){op.state='cancelled';continue;} // Durable submitting precedes every network write.
   try{const s=await a.settlement(op.prepared);op.result=s;op.state=s.state;}catch(e){op.state='unknown';op.error=safeError(e);}this.store.save(r);
  }
  const unknown=r.operations.some(o=>['unknown','submitted','submitting'].includes(o.state));
  r.after=await a.balances();const expected:Balances={...r.before};let exposure=dec(0);
  for(const o of r.operations){if(o.result&&(o.result.state==='confirmed'||o.result.state==='failed')){for(const[k,v]of Object.entries(o.result.delta))expected[k]=(BigInt(expected[k]??'0')+BigInt(v)).toString();if(o.result.state==='confirmed'&&o.plan){const delta=o.result.delta[balanceKey(o.chain,'A')]??'0';exposure=exposure.add(units(delta,decimals(o.chain,'A')));}}}
  const ok=Object.keys({...expected,...r.after}).every(k=>(expected[k]??'0')===(r.after![k]??'0'));
  r.exposure=exposure.toFixed();r.reconciliation={ok,expected,actual:r.after};r.stopRequested=this.store.get(r.id).stopRequested;
  const swaps=r.operations.filter(o=>o.kind==='buy'||o.kind==='sell');
  if(unknown||!ok){r.status='pending';r.reason=unknown?'交易结果待确认，禁止重复提交':'链上余额与交易分录不一致，暂停';}
  else if(!exposure.isZero()){r.status='exposed';r.reason='存在未平基础资产敞口，请手动平仓';}
  else if(r.operations.some(o=>o.kind==='unwind'&&o.state==='confirmed')){r.status='recovered';r.reservations={};r.reason='手动平仓已确认并对账';}
  else if(swaps.length===2&&swaps.every(o=>o.state==='confirmed')){r.status='completed';r.reservations={};r.reason='双腿已确认并对账；不构成策略收益证明';}
  else {r.status='stopped';r.reservations={};r.reason='已终止，余额已对账';}
  this.event(r,r.reason);await this.follow(r);
 }
 async unwind(id:string){
  if(this.busy)throw new Error('另一项操作进行中');const r=this.store.get(id);if(r.status!=='exposed')throw new Error('仅可平仓已确认的单腿敞口');this.busy=true;
  try{
   const a=this.adapters[r.mode];await a.check();
   // Reverse each confirmed original leg only once; retry reconciles its persisted transaction first.
   for(const original of r.operations.filter(o=>['buy','sell'].includes(o.kind)&&o.state==='confirmed')){
    const previous=r.operations.filter(o=>o.key.startsWith(original.key+':unwind:'));if(previous.some(o=>!['failed','expired','cancelled'].includes(o.state)))continue;const key=original.key+':unwind:'+previous.length;
    const p=await a.quote(original.chain,original.kind==='buy'?'sell':'buy',original.plan!.qty,'success');
    const b=await a.balances();if(BigInt(b[spendKey(p)]??'0')<BigInt(p.maxSpend)||BigInt(b[balanceKey(p.chain,'native')]??'0')<BigInt(p.feeReserve))throw new Error('平仓库存或费用不足');
    await a.preflight([p],'success');const prepared=await a.prepare(p,key,'success');const op:Operation={key,kind:'unwind',chain:p.chain,state:'signed',prepared,plan:p};r.operations.push(op);this.store.save(r);
    op.state='submitting';this.store.save(r);try{await a.broadcast(prepared);op.state='submitted';}catch(e){op.state='unknown';op.error=safeError(e);}this.store.save(r);
   }
   await this.reconcileRun(r);return publicRun(r);
  }finally{this.busy=false;}
 }
 async setup(){if(this.busy||this.store.runs().some(r=>!terminal.has(r.status)))throw new Error('请先完成或恢复当前操作');this.busy=true;try{return await this.adapters.testnet.setup!(async(key,chain,build)=>{
  let op=this.store.setupOp(key);
  if(!op){op={key,chain,kind:'setup',state:'signed',prepared:await build()};this.store.saveSetup(op);}
  if(op.state==='signed'){op.state='submitting';this.store.saveSetup(op);try{await this.adapters.testnet.broadcast(op.prepared);op.state='submitted';}catch(e){op.state='unknown';op.error=safeError(e);}this.store.saveSetup(op);}
  let result=await this.adapters.testnet.settlement(op.prepared);for(let attempt=0;result.state==='unknown'&&attempt<8;attempt++){await new Promise(r=>setTimeout(r,2000));result=await this.adapters.testnet.settlement(op.prepared);}op.result=result;op.state=result.state;this.store.saveSetup(op);
  if(op.state!=='confirmed')throw new Error('初始化步骤 '+key+' '+op.state+'；请恢复确认，不能重复部署');
 });}finally{this.busy=false;}}
 async recoverSetup(){if(this.busy)throw new Error('另一项操作进行中');this.busy=true;try{for(const op of this.store.setupOperations()){if(['signed','cancelled'].includes(op.state))continue;const s=await this.adapters.testnet.settlement(op.prepared);op.result=s;op.state=s.state;this.store.saveSetup(op);}return this.store.setupOperations().map(publicOperation);}finally{this.busy=false;}}
}
export function safeError(e:unknown){return String(e instanceof Error?e.message:e).replace(/https?:\/\/[^\s"']+/g,'[RPC]').replace(/0x[a-fA-F0-9]{64,}/g,'[redacted]').replace(/\b[1-9A-HJ-NP-Za-km-z]{80,}\b/g,'[redacted]').slice(0,400);}
