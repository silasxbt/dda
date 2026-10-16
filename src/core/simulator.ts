import {assets} from '../config.js';import {dec} from '../math.js';
import type {Candidate,Outcome,Session} from '../types.js';
export interface Entry {candidateId:string;at:number;status:string;reason?:string;pnl:number;exposure:number;fees:number;balances:Record<string,string>}
export interface Ledger {name:string;initial:Record<string,string>;balances:Record<string,string>;native:Record<string,string>;entries:Entry[];trades:number;turnover:number;capitalSeconds:number;realized:number;holdValue:number;endingValue:number;excess:number;inventoryRejects:number;unknown:number;scenario:string}
export function simulate(s:Session,candidates:Candidate[],outcomes:Outcome[],name:string,accept:(c:Candidate)=>boolean,finalMarks:Record<string,number>={}):Ledger {
 const initial:Record<string,string>={};
 for(const a of [assets.bscUSDC,assets.bscUSDT,assets.solUSDC,assets.solUSDT])initial[a.id]=dec(s.config.initialCapital).div(4).toFixed();
 for(const p of s.pools){initial[p.base.id]??='0';initial[p.quote.id]??='0';}
 const balances={...initial},native={bsc:String(s.config.feesNative.bsc),solana:String(s.config.feesNative.solana)},entries:Entry[]=[],seen=new Set<string>(),pool=new Map(s.pools.map(p=>[p.id,p]));
 const byId=new Map(outcomes.filter(o=>o.horizon===5).map(o=>[o.candidateId,o]));
 let trades=0,turnover=0,capitalSeconds=0,realized=0,inventoryRejects=0,unknown=0,busyUntil=0;
 for(const c of candidates){
  if(!accept(c)||seen.has(c.episode)||c.at<busyUntil)continue;seen.add(c.episode);
  const outcome=byId.get(c.id);if(!outcome||outcome.status!=='observed'||!outcome.buy||!outcome.sell){unknown++;continue;}
  const b=outcome.buy,a=outcome.sell,pb=pool.get(c.buyPool)!,ps=pool.get(c.sellPool)!;
  if(c.crossChain){entries.push({candidateId:c.id,at:c.at,status:'rejected',reason:'跨链兑付路径未验证',pnl:0,exposure:0,fees:0,balances:{...balances}});continue;}
  const buyCost=dec(b.buy).mul(dec(1).add(dec(s.config.extraSlippageBps).div(10000))),sellProceeds=dec(a.sell).mul(dec(1).sub(dec(s.config.extraSlippageBps).div(10000)));
  // Both legs reserve inventory before submission. Native fee balances are never tradable stock.
  if(dec(balances[pb.quote.id]??0).lt(buyCost)||dec(balances[ps.base.id]??0).lt(c.baseQty)||dec(native[b.chain]).lt(dec(b.gasBuy).add(a.gasSell))){
   inventoryRejects++;entries.push({candidateId:c.id,at:c.at,status:'rejected',reason:'预置库存或费用余额不足',pnl:0,exposure:0,fees:0,balances:{...balances}});continue;
  }
  const buyOK=!s.config.failure.buy,sellOK=!s.config.failure.sell;
  const change=(id:string,qty:ReturnType<typeof dec>)=>{balances[id]=dec(balances[id]??0).add(qty).toFixed();};
  if(buyOK){change(pb.quote.id,buyCost.neg());change(pb.base.id,dec(c.baseQty));}
  if(sellOK){change(ps.base.id,dec(c.baseQty).neg());change(ps.quote.id,sellProceeds);}
  // A failed attempt still pays its scenario fee. Gas estimates are conservative proxies.
  const gas=dec(b.gasBuy).add(a.gasSell);native[b.chain]=dec(native[b.chain]).sub(gas).toFixed();
  const fees=gas.mul(b.nativeUsd??0).toNumber();
  const pnl=buyOK&&sellOK?sellProceeds.sub(buyCost).sub(fees).toNumber():-fees;
  const exposure=buyOK===sellOK?0:dec(c.baseQty).mul(b.spot).mul(buyOK?1:-1).toNumber();
  trades++;turnover+=buyCost.toNumber();capitalSeconds=dec(capitalSeconds).add(buyCost.mul(dec(outcome.at!-c.at).div(1000))).toNumber();realized+=pnl;busyUntil=outcome.at!;
  entries.push({candidateId:c.id,at:outcome.at!,status:buyOK&&sellOK?'filled':'single-leg-scenario',pnl,exposure,fees,balances:{...balances}});
 }
 const marks:Record<string,number>={};for(const p of s.pools){marks[p.quote.id]=1;marks[p.base.id]=p.market==='USDC/USDT'?1:p.initialPrice;}
 // Stablecoin balances use a nominal $1 convention, explicitly not a redeemability claim.
 const value=(wallet:Record<string,string>)=>Object.entries(wallet).reduce((sum,[id,q])=>sum+dec(q).mul(marks[id]??1).toNumber(),0);
 Object.assign(marks,finalMarks);
 const holdValue=value(initial),endingValue=value(balances)-entries.reduce((sum,e)=>sum+e.fees,0);
 return {name,initial,balances,native,entries,trades,turnover,capitalSeconds,realized,holdValue,endingValue,excess:endingValue-holdValue,inventoryRejects,unknown,scenario:'五秒后非原子双腿模拟；稳定币名义 $1；原生币费用单列；控制组未分配基础币库存；失败开关为压力情景'};
}
