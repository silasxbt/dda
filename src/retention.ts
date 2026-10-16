import {mkdirSync,existsSync,copyFileSync,writeFileSync,unlinkSync} from 'node:fs';import {resolve} from 'node:path';import {gzipSync} from 'node:zlib';import {Store} from './store.js';
export function retain(store:Store,now=Date.now()){
 const removed:string[]=[];mkdirSync(resolve(store.root,'snapshots'),{recursive:true});
 for(const s of store.sessions()){
  if(s.status==='running'||!s.endedAt||now-s.endedAt<30*86400000)continue;
  const raw=resolve(store.root,'raw',s.id+'.ndjson.gz');if(!existsSync(raw))continue;
  // Archive both replay inputs and raw provenance before removing an expired working copy.
  writeFileSync(resolve(store.root,'snapshots',s.id+'.json.gz'),gzipSync(JSON.stringify({session:s,cycles:store.cycles(s.id)})),{mode:0o600});
  copyFileSync(raw,resolve(store.root,'snapshots',s.id+'.raw.ndjson.gz'));unlinkSync(raw);removed.push(s.id);
 }return removed;
}
