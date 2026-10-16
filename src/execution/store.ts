import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, chmodSync, openSync, closeSync, readFileSync, unlinkSync, lstatSync} from 'node:fs';
import {resolve, join} from 'node:path';
import type {Run, Operation} from './types.js';
export class ExecutionStore {
 db: DatabaseSync; root: string; private lockFd?: number;
 constructor(root: string, lock = false) {
  this.root = resolve(root); mkdirSync(this.root, {recursive:true, mode:0o700});
  if(lstatSync(this.root).isSymbolicLink())throw new Error('测试数据目录不能为符号链接');
  chmodSync(this.root, 0o700);
  if (lock) {
   const path = join(this.root,'execution.lock');
   try {const pid=Number(readFileSync(path,'utf8'));try{process.kill(pid,0);throw new Error('测试服务已运行');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}unlinkSync(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   this.lockFd=openSync(path,'wx',0o600);requireWrite(this.lockFd, String(process.pid));
  }
  this.db=new DatabaseSync(join(this.root,'execution.sqlite'));
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS setup_ops(key TEXT PRIMARY KEY, body TEXT NOT NULL);');
  chmodSync(join(this.root,'execution.sqlite'),0o600);
 }
 save(run: Run) {const prior=this.byKey(run.requestKey);if(prior?.stopRequested)run.stopRequested=true;run.updatedAt=Date.now();this.db.prepare('INSERT INTO runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(run.id,run.requestKey,JSON.stringify(run));}
 get(id: string): Run {const row=this.db.prepare('SELECT body FROM runs WHERE id=?').get(id) as {body:string}|undefined;if(!row)throw new Error('测试记录不存在');return JSON.parse(row.body);}
 byKey(key: string): Run|undefined {const row=this.db.prepare('SELECT body FROM runs WHERE request_key=?').get(key) as {body:string}|undefined;return row?JSON.parse(row.body):undefined;}
 runs(): Run[] {return (this.db.prepare('SELECT body FROM runs ORDER BY rowid DESC').all() as {body:string}[]).map(r=>JSON.parse(r.body));}
 getValue<T>(key:string): T|undefined {const row=this.db.prepare('SELECT body FROM kv WHERE key=?').get(key) as {body:string}|undefined;return row?JSON.parse(row.body):undefined;}
 setValue(key:string,value:unknown) {this.db.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key,JSON.stringify(value));}
 setupOp(key:string): Operation|undefined {const row=this.db.prepare('SELECT body FROM setup_ops WHERE key=?').get(key) as {body:string}|undefined;return row?JSON.parse(row.body):undefined;}
 saveSetup(op:Operation) {this.db.prepare('INSERT INTO setup_ops VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(op.key,JSON.stringify(op));}
 setupOperations():Operation[]{return (this.db.prepare('SELECT body FROM setup_ops ORDER BY rowid').all() as {body:string}[]).map(r=>JSON.parse(r.body));}
 close(){this.db.close();if(this.lockFd!==undefined){closeSync(this.lockFd);unlinkSync(join(this.root,'execution.lock'));this.lockFd=undefined;}}
}
import {writeSync} from 'node:fs';
function requireWrite(fd:number,s:string){writeSync(fd,s);}
// Never expose signed bytes or build internals through browser APIs/reports.
export function publicOperation(op:Operation) {return {key:op.key,kind:op.kind,chain:op.chain,state:op.state,txId:op.prepared.id,expires:op.prepared.expires,result:op.result,error:op.error};}
export function publicRun(run:Run) {return {...run,plans:run.plans.map(({detail,...p})=>p),operations:run.operations.map(publicOperation)};}
