import {dec} from '../math.js';
import type {Candidate,Config,Coverage,Cycle,Features,Outcome,Pool,Quote,Session,Trade} from '../types.js';

export function features(pools:string[],at:number,trades:Trade[],coverage:Coverage[],directions:('buy'|'sell')[],cfg:Config):Features {
 const blank=(reason:string):Features=>({available:false,count:0,swapsPerSecond:0,sameDirectionShare:0,repeatShare:0,concentration:0,score:null,reason});
 // Require a continuous, complete past window; no observations from after decision time.
 for(const poolId of pools){
  // Coverage counts only once it was known (availableAt); older sessions without the field keep cycle-order availability.
  const intervals=coverage.filter(c=>c.poolId===poolId&&c.through<=at&&c.through>=at-30000&&(c.availableAt===undefined||c.availableAt<=at)).sort((a,b)=>a.from-b.from);
  let end=at-30000;
  for(const c of intervals){if(!c.complete&&c.through>end)return blank(c.reason??'成交覆盖不完整');if(c.from>end+1000)break;end=Math.max(end,c.through);}
  if(end<at-cfg.maxAgeMs)return blank('决策前 30 秒成交窗口不完整');
 }
 const xs=trades.filter(t=>pools.includes(t.poolId)&&t.eventAt>at-30000&&t.eventAt<=at&&t.availableAt<=at);
 const actors=new Map<string,number>();let same=0;
 for(const t of xs){actors.set(t.actor,(actors.get(t.actor)??0)+1);if(t.direction===directions[pools.indexOf(t.poolId)])same++;}
 const count=xs.length,repeatShare=count?[...actors.values()].reduce((s,n)=>s+Math.max(0,n-1),0)/count:0;
 const concentration=count?[...actors.values()].reduce((s,n)=>s+(n/count)**2,0):0,sameDirectionShare=count?same/count:0;
 const score=.45*Math.min(count/30,1)+.25*sameDirectionShare+.15*repeatShare+.15*concentration;
 return {available:true,count,swapsPerSecond:count/30,sameDirectionShare,repeatShare,concentration,score};
}

export function candidate(s:Session,c:Cycle,b:Quote,a:Quote,pools:Map<string,Pool>,trades:Trade[],coverage:Coverage[]):Candidate {
 const cfg=s.config,at=Math.max(b.observedAt,a.observedAt),pb=pools.get(b.poolId)!,ps=pools.get(a.poolId)!;
 const crossChain=b.chain!==a.chain,reasons:string[]=[];
 if(!b.valid||!a.valid)reasons.push('报价无效或深度不足');
 if(!dec(b.baseQty).eq(a.baseQty))reasons.push('两腿基础资产数量不匹配');
 if(at-Math.min(b.observedAt,a.observedAt)>cfg.maxSkewMs)reasons.push('两侧报价时间偏差过大');
 if([b,a].some(q=>at-q.startedAt>cfg.maxAgeMs||at-q.blockTime>cfg.maxBlockLagMs||q.blockTime>at+1000))reasons.push('报价或区块过期');
 if([b,a].some(q=>!Number.isFinite(q.priceImpactBps)||q.priceImpactBps>cfg.maxImpactBps))reasons.push('手续费与价格冲击超过阈值');
 if(crossChain)reasons.push('跨链资产等价与兑付路径未验证，仅观察');
 else if(pb.base.id!==ps.base.id||pb.quote.id!==ps.quote.id)reasons.push('资产不匹配');
 const gross=dec(a.sell).sub(b.buy).toNumber();
 const network=b.nativeUsd===null||a.nativeUsd===null?null:dec(b.gasBuy).mul(b.nativeUsd).add(dec(a.gasSell).mul(a.nativeUsd)).toNumber();
 const slippage=dec(b.buy).add(a.sell).mul(cfg.extraSlippageBps).div(10000).toNumber();
 const rebalance=crossChain?(cfg.rebalance.costBps===null?null:dec(b.buy).mul(cfg.rebalance.costBps).div(10000).toNumber()):0;
 const pre=network===null?null:dec(gross).sub(network).sub(slippage).toNumber(),net=pre===null||rebalance===null?null:dec(pre).sub(rebalance).toNumber();
 if(network===null)reasons.push('原生币费用估值缺失');
 if(rebalance===null)reasons.push('再平衡成本未知');
 if(net===null||net<=0)reasons.push('完整成本后无正收益');
 const f=features([b.poolId,a.poolId],at,trades,coverage,['buy','sell'],cfg),baseline=reasons.length===0;
 return {id:`${c.id}:${b.poolId}:${a.poolId}:${b.size}`,episode:'',sessionId:s.id,cycleId:c.id,at,market:crossChain?'跨链 USDC/USDT':`${b.chain} ${b.market}`,crossChain,buyPool:b.poolId,sellPool:a.poolId,size:b.size,baseQty:b.baseQty,buy:b.buy,sell:a.sell,gross,network,slippage,rebalance,netBeforeRebalance:pre,net,breakEvenRebalanceBps:pre===null?null:dec(pre).div(b.buy).mul(10000).toNumber(),reasons,baseline,dda:baseline&&f.available&&f.score!<cfg.pressureThreshold,features:f,qBuy:b,qSell:a};
}

export function findCandidates(s:Session,cycles:Cycle[]):Candidate[]{
 const pools=new Map(s.pools.map(p=>[p.id,p])),trades:Trade[]=[],coverage:Coverage[]=[],seen=new Set<string>(),events=new Map<string,{at:number;id:string;positive:boolean}>(),result:Candidate[]=[];
 for(const c of cycles){
  // Trades are eligible by their actual availability timestamp, even in the same cycle.
  for(const t of c.trades)if(!seen.has(t.id)){seen.add(t.id);trades.push(t);}
  // Coverage stamped with availableAt is usable within its own cycle once known; legacy records wait for the next cycle.
  coverage.push(...c.coverage.filter(x=>x.availableAt!==undefined));
  for(const b of c.quotes)for(const a of c.quotes){
   if(b.poolId===a.poolId||b.market!==a.market||b.size!==a.size||!pools.has(b.poolId)||!pools.has(a.poolId))continue;
   if(b.chain!==a.chain&&b.market!=='USDC/USDT')continue;
   const x=candidate(s,c,b,a,pools,trades,coverage),key=`${b.poolId}:${a.poolId}:${b.size}`,prev=events.get(key),positive=x.gross>0;
   const id=prev&&prev.positive===positive&&x.at-prev.at<=s.config.intervalMs*2+1000?prev.id:x.id;
   x.episode=id;events.set(key,{at:x.at,id,positive});result.push(x);
  }
  coverage.push(...c.coverage.filter(x=>x.availableAt===undefined));
 }
 return result;
}

export function outcomes(s:Session,cycles:Cycle[],candidates:Candidate[]):Outcome[]{
 const out:Outcome[]=[];
 const invalidated=cycles.flatMap(c=>c.coverage).filter(c=>c.invalidatedFrom!==undefined);
 const reorganized=(q:Quote)=>invalidated.some(c=>c.poolId===q.poolId&&q.blockTime>=c.invalidatedFrom!&&q.blockTime<=(c.invalidatedThrough??c.through));
 for(const x of candidates)for(const horizon of [5,15]){
  const target=x.at+horizon*1000,tolerance=s.config.intervalMs+1000;
  const c=cycles.find(c=>c.quotes.some(q=>q.observedAt>=target));
  const b=c?.quotes.find(q=>q.poolId===x.buyPool&&q.size===x.size),a=c?.quotes.find(q=>q.poolId===x.sellPool&&q.size===x.size);
  let reason:string|undefined;
  if([x.qBuy,x.qSell,...(b?[b]:[]),...(a?[a]:[])].some(reorganized))reason='后续发现链重组，涉及窗口标签作废';
  else if(!b||!a)reason='观察窗口结束或报价缺失';
  else if(Math.min(b.observedAt,a.observedAt)<target||Math.max(b.observedAt,a.observedAt)>target+tolerance)reason='目标窗口存在采样缺口';
  else if(!b.valid||!a.valid||!dec(b.baseQty).eq(x.baseQty)||!dec(a.baseQty).eq(x.baseQty)||Math.abs(b.observedAt-a.observedAt)>s.config.maxSkewMs)reason='后续报价无效、数量不符或不同步';
  else if([b,a].some(q=>q.observedAt-q.blockTime>s.config.maxBlockLagMs))reason='后续区块过期';
  if(reason){out.push({candidateId:x.id,horizon,status:'unknown',at:null,pnl:null,adverse:null,reason});continue;}
  const net=b!.nativeUsd===null||a!.nativeUsd===null?null:dec(a!.sell).sub(b!.buy).sub(dec(b!.gasBuy).mul(b!.nativeUsd)).sub(dec(a!.gasSell).mul(a!.nativeUsd)).sub(dec(a!.sell).add(b!.buy).mul(s.config.extraSlippageBps).div(10000)).toNumber();
  if(net===null){out.push({candidateId:x.id,horizon,status:'unknown',at:null,pnl:null,adverse:null,reason:'后续费用估值缺失'});continue;}
  out.push({candidateId:x.id,horizon,status:'observed',at:Math.max(b!.observedAt,a!.observedAt),pnl:net,adverse:net<0||net<(x.netBeforeRebalance??net),buy:b,sell:a});
 }return out;
}
