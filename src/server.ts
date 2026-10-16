import Fastify from 'fastify';import staticFiles from '@fastify/static';import {resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {existsSync,readFileSync,realpathSync} from 'node:fs';import {gzipSync} from 'node:zlib';
import {Store} from './store.js';import {Collector} from './collector.js';import {research,markdown,type Research} from './core/research.js';import {validateConfig,defaults} from './config.js';import {retain} from './retention.js';
export function createServer(root=process.env.DDA_DATA_DIR??'data'){
 const app=Fastify({logger:false,bodyLimit:16384}),store=new Store(root),collector=new Collector(store);let cached:{key:string;r:Research}|undefined;let starting:Promise<unknown>|undefined;
 app.addHook('onRequest',async(req,reply)=>{
  const host=req.headers.host??'';if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))return reply.code(403).send({error:'仅允许本机访问'});
  if(req.method!=='GET'&&req.method!=='HEAD'){
   const origin=req.headers.origin;if(origin&&origin!==`http://${host}`)return reply.code(403).send({error:'跨站请求已拒绝'});
   if(req.headers['x-dda-local']!=='1')return reply.code(403).send({error:'缺少本地操作标记'});
  }
 });
 app.setErrorHandler((err,req,reply)=>reply.code(400).send({error:err instanceof Error?err.message:String(err)}));
 const get=(id:string)=>{const s=store.session(id),cs=store.cycles(id),key=id+':'+cs.length+':'+s.status;if(cached?.key===key)return cached.r;const r=research(s,cs);cached={key,r};return r;};
 app.get('/api/status',()=>({active:collector.active?.id??null,preparing:collector.preparing,stopping:collector.stopping,error:collector.lastError,sessions:store.sessions(),defaults:{durationMinutes:defaults.durationMinutes,extraSlippageBps:defaults.extraSlippageBps,pressureThreshold:defaults.pressureThreshold}}));
 app.post('/api/start',async(req,reply)=>{
  if(collector.active||collector.preparing)return reply.code(409).send({error:'已有会话运行'});
  const body=(req.body??{}) as Record<string,unknown>;const allowed=['durationMinutes','intervalMs','maxAgeMs','maxSkewMs','maxBlockLagMs','maxSolanaSlotSpan','maxImpactBps','extraSlippageBps','pressureThreshold','sizes','initialCapital','rebalance','failure'];
  if(Object.keys(body).some(k=>!allowed.includes(k)))throw new Error('包含不支持的配置');
  const config=validateConfig(body);collector.lastError=null;
  starting=collector.start(config).catch(e=>{collector.lastError=String(e.message??e);});return reply.code(202).send({status:'preparing'});
 });
 app.post('/api/stop',async()=>{collector.stop();return {status:'stopping'};});
 app.get<{Params:{id:string}}>('/api/sessions/:id',req=>{
  const r=get(req.params.id),ids=new Set(r.candidates.slice(-200).map(c=>c.id));
  return {...r,candidates:r.candidates.slice(-200),outcomes:r.outcomes.filter(o=>ids.has(o.candidateId)),ledgers:r.ledgers.map(l=>({...l,entries:l.entries.slice(-100)})),allLedgers:r.allLedgers.map(l=>({...l,entries:l.entries.slice(-100)})),dataset:[],candidateTotal:r.candidates.length};
 });
 app.post<{Params:{id:string}}>('/api/sessions/:id/replay',async req=>{const r=get(req.params.id);store.artifact('replay:'+r.session.id,r.session.id,r);return {digest:r.digest,cycles:r.quality.cycles};});
 app.get<{Params:{id:string};Querystring:{format?:string}}>('/api/sessions/:id/export',async(req,reply)=>{
  const r=get(req.params.id),format=req.query.format??'report';let body:string|Buffer,type:string,name:string;
  if(format==='report'){body=markdown(r);type='text/markdown; charset=utf-8';name='report.md';}
  else if(format==='snapshot'){body=gzipSync(JSON.stringify({session:r.session,cycles:store.cycles(r.session.id)}));type='application/gzip';name='snapshot.json.gz';}
  else if(format==='dataset'){body=JSON.stringify({version:r.version,gate:r.modelGate,rows:r.dataset});type='application/json';name='dataset.json';}
  else if(format==='raw'){const base=resolve(store.root,'raw',r.session.id+'.ndjson.gz'),arch=resolve(store.root,'snapshots',r.session.id+'.raw.ndjson.gz');body=readFileSync(existsSync(base)?base:arch);type='application/gzip';name='raw.ndjson.gz';}
  else if(format==='csv'){const rows=[['id','episode','at','market','size','baseQty','buy','sell','gross','network','slippage','netBeforeRebalance','net','baseline','dda','pressure','reasons'],...r.candidates.map(c=>[c.id,c.episode,c.at,c.market,c.size,c.baseQty,c.buy,c.sell,c.gross,c.network,c.slippage,c.netBeforeRebalance,c.net,c.baseline,c.dda,c.features.score,c.reasons.join('；')])];body='\uFEFF'+rows.map(row=>row.map(x=>'"'+String(x??'').replaceAll('"','""')+'"').join(',')).join('\n');type='text/csv; charset=utf-8';name='opportunities.csv';}
  else throw new Error('导出格式不支持');
  reply.header('Content-Disposition',`attachment; filename="dda-${r.session.id}-${name}"`).type(type);return body;
 });
 if(existsSync(resolve('dist/index.html'))){app.register(staticFiles,{root:resolve('dist')});app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'接口不存在'}):reply.sendFile('index.html'));}
 const cleanup=async()=>{collector.stop();await starting;await collector.done;store.close();};app.addHook('onClose',cleanup);
 return {app,store,collector,get};
}
if(process.argv[1]&&realpathSync(resolve(process.argv[1]))===fileURLToPath(import.meta.url)){
 const {app,store,collector}=createServer();retain(store);const port=Number(process.env.PORT??8787);await app.listen({host:'127.0.0.1',port});console.log(`DDA 本地面板 http://127.0.0.1:${port}`);
 for(const sig of ['SIGINT','SIGTERM'] as const)process.on(sig,()=>{collector.stop();void app.close();});
}
