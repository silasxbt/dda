import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {Store} from './store.js';
import {validateConfig} from './config.js';
import type {Session,Cycle} from './types.js';

export function snapshot(store:Store,id:string){return gzipSync(JSON.stringify({session:store.session(id),cycles:store.cycles(id)}));}
export function importSnapshot(store:Store,path:string){
 const raw=readFileSync(path),x=JSON.parse((raw[0]===31&&raw[1]===139?gunzipSync(raw):raw).toString()) as {session:Session;cycles:Cycle[]};
 if(!x.session?.id||!Number.isFinite(x.session.startedAt)||!Array.isArray(x.session.pools)||!Array.isArray(x.cycles))throw new Error('快照结构无效');
 validateConfig(x.session.config);
 const ids=new Set<string>(),indices=new Set<number>();
 for(const c of x.cycles){if(c.sessionId!==x.session.id||ids.has(c.id)||indices.has(c.index)||!Number.isInteger(c.index)||!Array.isArray(c.quotes)||!Array.isArray(c.coverage)||!Array.isArray(c.trades))throw new Error('周期身份、序号或结构无效');ids.add(c.id);indices.add(c.index);}
 if(store.sessions().some(s=>s.id===x.session.id))throw new Error('同名会话已存在，请使用空数据目录验证回放');
 if(x.session.status==='running'){x.session.status='interrupted';x.session.endedAt=x.cycles.at(-1)?.finishedAt??x.session.startedAt;}
 store.db.exec('BEGIN');
 try{store.saveSession(x.session);for(const c of x.cycles)store.addCycle(c);store.db.exec('COMMIT');}catch(e){store.db.exec('ROLLBACK');throw e;}
 return x.session.id;
}
