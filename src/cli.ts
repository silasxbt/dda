import {Store} from './store.js';import {Collector} from './collector.js';import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {dirname} from 'node:path';import {snapshot,importSnapshot} from './snapshot.js';
const command=process.argv[2]??'probe',store=new Store(process.env.DDA_DATA_DIR??'data');
if(command==='probe'||command==='collect'){
 const collector=new Collector(store);for(const sig of ['SIGINT','SIGTERM'] as const)process.on(sig,()=>collector.stop());
 const minutes=Number(process.argv[3]??(command==='probe'?0.05:60));const fixed=process.env.DDA_FIXED_POOLS?JSON.parse(readFileSync(process.env.DDA_FIXED_POOLS,'utf8')):undefined;
 const session=await collector.start({durationMinutes:minutes},fixed);console.log(JSON.stringify({id:session.id,pools:session.pools.map(p=>({id:p.id,market:p.market,chain:p.chain,enabled:p.enabled,reason:p.reason})),capabilities:session.capabilities}));await collector.done;
 console.log(JSON.stringify({status:store.session(session.id).status,cycles:store.cycles(session.id).length,error:collector.lastError}));store.close();
}else if(command==='import'){
 const path=process.argv[3];if(!path)throw new Error('需要快照路径');console.log(JSON.stringify({id:importSnapshot(store,path)}));store.close();
}else if(command==='replay'||command==='report'||command==='snapshot'||command==='dataset'){
 const {research,markdown}=await import('./core/research.js');const id=process.argv[3]??store.sessions()[0]?.id;if(!id)throw new Error('暂无会话');const s=store.session(id);const r=research(s,store.cycles(id));
 if(command==='replay'){store.artifact('replay:'+id,id,r);console.log(JSON.stringify({id,digest:r.digest,cycles:r.quality.cycles,candidates:r.candidates.length}));}
 else{const path=process.argv[4]??'exports/'+(command==='snapshot'?'snapshot.json.gz':command==='dataset'?'dataset.json':'report.md');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,command==='snapshot'?snapshot(store,id):command==='dataset'?JSON.stringify({version:r.version,gate:r.modelGate,rows:r.dataset}):markdown(r));console.log(path);}store.close();
}else throw new Error('命令：probe | collect [分钟] | replay [会话] | report|snapshot|dataset [会话] [路径] | import 快照路径');
