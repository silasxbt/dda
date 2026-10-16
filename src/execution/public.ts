import type {TestAdapter,TestChain,QuotePlan,Prepared,Scenario} from './types.js';import {BscExecution,type SetupSend} from './bsc.js';import {SolanaExecution} from './solana.js';import {safeError} from './engine.js';
export class PublicTestAdapter implements TestAdapter {
 mode='testnet' as const;
 constructor(public bsc:BscExecution,public solana:SolanaExecution){}
 async check(){return [await this.bsc.check(),await this.solana.check()];}
 async inspect(){const out:Record<string,unknown>={};for(const chain of ['bsc','solana']as const){try{const info=await this[chain].check();out[chain]={ok:true,info,market:this[chain].market(),balances:this[chain].wallets.exists()?await this[chain].balances():null};}catch(e){out[chain]={ok:false,error:safeError(e),market:this[chain].market()};}}return out;}
 async balances(){return {...await this.bsc.balances(),...await this.solana.balances()};}
 quote(chain:TestChain,side:'buy'|'sell',qty:string,_scenario:Scenario){return this[chain].quote(side,qty);}
 async preflight(plans:QuotePlan[]){for(const chain of ['bsc','solana']as const)await this[chain].preflight(plans.filter(p=>p.chain===chain));}
 prepare(p:QuotePlan){return this[p.chain].prepare(p);}
 broadcast(tx:Prepared){return this[tx.chain].broadcast(tx);}
 settlement(tx:Prepared){return this[tx.chain].settlement(tx);}
 async setup(send:SetupSend){const results:Record<string,unknown>={};for(const chain of ['bsc','solana']as const){try{results[chain]={ok:true,market:await this[chain].setup(send)};}catch(e){results[chain]={ok:false,error:safeError(e)};}}return results;}
}
