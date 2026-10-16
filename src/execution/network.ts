import {Connection} from '@solana/web3.js';
export const BSC_RPC = process.env.DDA_TEST_BSC_RPC ?? 'https://bsc-testnet-rpc.publicnode.com';
export const SOL_RPC = process.env.DDA_TEST_SOL_RPC ?? 'https://api.devnet.solana.com';
export const DEVNET_GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const BSC_ADDRESSES={factory:'0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',router:'0x1b81D678ffb9C0263b24A97847620C99d213eB14',position:'0x427bF5b37357632377eCbEC9de3626C71A5396c1',quoter:'0xbC203d7f83677c7ed3F7acEc959963E7F4ECC5C2'} as const;
export const SOL_CLMM='DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH';
export class TestTransport {
 private next=new Map<string,number>(); private backoff=new Map<string,number>(); private tail=Promise.resolve();
 constructor(public bscRpc=BSC_RPC,public solRpc=SOL_RPC){for(const u of [bscRpc,solRpc])if(new URL(u).protocol!=='https:')throw new Error('测试 RPC 必须使用 HTTPS');}
 async rpc(url:string,method:string,params:unknown[]=[]):Promise<any>{
  if(url!==this.bscRpc&&url!==this.solRpc)throw new Error('RPC 不在测试环境白名单');
  // SDK and viem use this bounded transport; no implicit retry of writes.
  let release!:()=>void;const prev=this.tail;this.tail=new Promise<void>(r=>release=r);await prev;
  try{const now=Date.now(),until=this.backoff.get(url)??0;if(until>now)throw new Error('公共测试 RPC 限流，请稍后重试');const delay=(this.next.get(url)??0)-now;if(delay>0)await new Promise(r=>setTimeout(r,delay));this.next.set(url,Date.now()+120);
   const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(12000)});
   if(r.status===429){const v=r.headers.get('retry-after'),secs=Number(v);const till=v&&!Number.isFinite(secs)?Date.parse(v):Date.now()+(v&&Number.isFinite(secs)?secs:10)*1000;this.backoff.set(url,Math.max(Date.now()+1000,Number.isFinite(till)?till:Date.now()+10000));throw new Error('公共测试 RPC 限流，请稍后重试');}
   if(!r.ok)throw new Error('测试 RPC HTTP '+r.status);const j=await r.json() as any;if(j.error)throw new Error('测试 RPC '+method+': '+String(j.error.message).slice(0,160));return j.result;
  }finally{release();}
 }
 async identity(chain:'bsc'|'solana'){const id=await this.rpc(chain==='bsc'?this.bscRpc:this.solRpc,chain==='bsc'?'eth_chainId':'getGenesisHash');if(chain==='bsc'?id!=='0x61':id!==DEVNET_GENESIS)throw new Error('网络身份不匹配，拒绝签名或提交');return id;}
 connection(){return new Connection(this.solRpc,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:async(_u,opts)=>{const body=JSON.parse(String(opts?.body));const result=await this.rpc(this.solRpc,body.method,body.params??[]);return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{headers:{'content-type':'application/json'}});}});}
}
