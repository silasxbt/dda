import {DatabaseSync} from 'node:sqlite';import {mkdirSync,chmodSync,existsSync,readFileSync,openSync,closeSync,writeFileSync,unlinkSync} from 'node:fs';import {resolve} from 'node:path';
import type {Cycle,Session} from './types.js';
export class Store {
 db:DatabaseSync;root:string;
 constructor(root='data'){
  this.root=resolve(root);mkdirSync(this.root,{recursive:true});this.db=new DatabaseSync(resolve(this.root,'dda.sqlite'));chmodSync(resolve(this.root,'dda.sqlite'),0o600);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,status TEXT NOT NULL,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cycles(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,sequence INTEGER NOT NULL,json TEXT NOT NULL,UNIQUE(session_id,sequence)); CREATE INDEX IF NOT EXISTS cycle_session ON cycles(session_id,sequence); CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,created_at INTEGER NOT NULL,json TEXT NOT NULL);`);
 }
 saveSession(s:Session){const config={...s.config,bscRpc:new URL(s.config.bscRpc).origin,solanaRpc:new URL(s.config.solanaRpc).origin};this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,json=excluded.json').run(s.id,s.startedAt,s.status,JSON.stringify({...s,config}));}
 sessions():Session[]{return (this.db.prepare('SELECT json FROM sessions ORDER BY started_at DESC').all() as {json:string}[]).map(x=>JSON.parse(x.json));}
 session(id:string):Session{const x=this.db.prepare('SELECT json FROM sessions WHERE id=?').get(id) as {json:string}|undefined;if(!x)throw new Error('会话不存在');return JSON.parse(x.json);}
 addCycle(c:Cycle){this.db.prepare('INSERT INTO cycles VALUES(?,?,?,?)').run(c.id,c.sessionId,c.index,JSON.stringify(c));}
 cycles(id:string):Cycle[]{return (this.db.prepare('SELECT json FROM cycles WHERE session_id=? ORDER BY sequence').all(id) as {json:string}[]).map(x=>JSON.parse(x.json));}
 artifact(id:string,sessionId:string,result:unknown){this.db.prepare('INSERT OR REPLACE INTO artifacts VALUES(?,?,?,?)').run(id,sessionId,Date.now(),JSON.stringify(result));}
 lock(){
  const path=resolve(this.root,'collector.lock');
  if(existsSync(path)){const pid=Number(readFileSync(path,'utf8'));let alive=false;try{process.kill(pid,0);alive=true}catch{}if(alive)throw new Error('已有采集进程运行');unlinkSync(path);}
  const fd=openSync(path,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);
  for(const s of this.sessions().filter(s=>s.status==='running')){s.status='interrupted';s.endedAt=Date.now();this.saveSession(s);}
  return ()=>{try{if(readFileSync(path,'utf8')===String(process.pid))unlinkSync(path)}catch{}};
 }
 close(){this.db.close();}
}
