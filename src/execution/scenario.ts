import {createHash} from 'node:crypto';
import {ExecutionStore} from './store.js';
import {atoms,dec} from '../math.js';
import {balanceKey,decimals,spendKey,receiveKey,type TestAdapter,type Balances,type QuotePlan,type Prepared,type Settlement,type TestChain,type Scenario} from './types.js';
export class ScenarioAdapter implements TestAdapter {
 mode='scenario' as const;
 constructor(public store:ExecutionStore) {if(!store.getValue('scenario:balances')){const b:Balances={};for(const c of ['bsc','solana'] as const)for(const a of ['A','B','native'] as const)b[balanceKey(c,a)]=atoms(a==='native'?'1':'2500',decimals(c,a));store.setValue('scenario:balances',b);}}
 async check(){return {source:'synthetic',ready:true,network:'确定性场景，不发送链上交易'};}
 async balances(){return this.store.getValue<Balances>('scenario:balances')!;}
 async quote(chain:TestChain,side:'buy'|'sell',qty:string,scenario:Scenario):Promise<QuotePlan>{
  const price=side==='buy'?'0.98':scenario==='no-profit'?'0.97':'1.02',b=atoms(dec(qty).mul(price),decimals(chain,'B'));
  const a=atoms(qty,decimals(chain,'A'));
  return {chain,side,qty,spend:side==='buy'?b:a,receive:side==='buy'?a:b,maxSpend:side==='buy'?atoms(dec(qty).mul(price).mul('1.001'),decimals(chain,'B'),true):a,minReceive:side==='buy'?a:atoms(dec(qty).mul(price).mul('.999'),decimals(chain,'B')),feeReserve:atoms('.0001',decimals(chain,'native')),at:Date.now()-(scenario==='stale'?60000:0),detail:{source:'synthetic',scenario}};
 }
 async preflight(_plans:QuotePlan[],scenario:Scenario){if(scenario==='approval-fail')throw new Error('合成场景：授权不足');if(scenario==='account-fail')throw new Error('合成场景：关联代币账户缺失');if(scenario==='fee-shortage')throw new Error('合成场景：原生币费用余额不足');}
 async prepare(plan:QuotePlan,key:string,scenario:Scenario):Promise<Prepared>{const id='synthetic:'+createHash('sha256').update(key).digest('hex');return {id,chain:plan.chain,raw:JSON.stringify({plan,key,scenario}),meta:{source:'synthetic'}};}
 async broadcast(tx:Prepared){
  const saved=this.store.getValue<Settlement>(tx.id);if(saved)return;
  const {plan,scenario}=JSON.parse(tx.raw) as {plan:QuotePlan;scenario:Scenario};
  if(scenario==='disconnect')throw new Error('合成场景：提交结果未知，网络断开');
  if(scenario==='expired'||scenario==='reorg'){this.store.setValue(tx.id,{state:scenario==='expired'?'expired':'unknown',delta:{},reason:scenario});return;}
  const failed=scenario==='one-leg-fail'&&plan.side==='sell',fee=atoms('.00001',decimals(tx.chain,'native'));
  const delta:Balances={[balanceKey(tx.chain,'native')]:'-'+fee};
  if(!failed){delta[spendKey(plan)]='-'+plan.spend;delta[receiveKey(plan)]=plan.receive;}
  const balances=await this.balances();for(const [k,v] of Object.entries(delta)){balances[k]=(BigInt(balances[k]??'0')+BigInt(v)).toString();if(BigInt(balances[k])<0n)throw new Error('合成链余额不足');}
  this.store.db.exec('BEGIN IMMEDIATE');try{this.store.setValue('scenario:balances',balances);this.store.setValue(tx.id,{state:failed?'failed':'confirmed',delta,fee,block:'synthetic-final',reason:failed?'合成场景：卖腿执行失败':undefined});this.store.setValue('broadcast:'+tx.id,1);this.store.db.exec('COMMIT');}catch(e){this.store.db.exec('ROLLBACK');throw e;}
  if(scenario==='timeout-landed')throw new Error('合成场景：响应超时，但链上已成交');
 }
 async settlement(tx:Prepared):Promise<Settlement>{return this.store.getValue<Settlement>(tx.id)??{state:'unknown',delta:{},reason:'尚无可确认结果'};}
}
