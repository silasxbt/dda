import {existsSync, readFileSync, writeFileSync, chmodSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
import {Keypair} from '@solana/web3.js';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
export class TestWallets {
 private path: string;
 constructor(root:string){this.path=join(root,'test-wallets.json');}
 exists(){return existsSync(this.path);}
 create(){if(!this.exists()){const keys={version:1,bsc:generatePrivateKey(),solana:Array.from(Keypair.generate().secretKey),mints:[Array.from(Keypair.generate().secretKey),Array.from(Keypair.generate().secretKey)]};writeFileSync(this.path,JSON.stringify(keys),{flag:'wx',mode:0o600});}return this.addresses();}
 private load(){if(!this.exists())throw new Error('请先创建测试钱包');if(lstatSync(this.path).isSymbolicLink())throw new Error('钱包文件不能为符号链接');chmodSync(this.path,0o600);return JSON.parse(readFileSync(this.path,'utf8')) as {bsc:`0x${string}`;solana:number[];mints:number[][]};}
 bsc(){return privateKeyToAccount(this.load().bsc);}
 solana(){return Keypair.fromSecretKey(Uint8Array.from(this.load().solana));}
 mints(){return this.load().mints.map(k=>Keypair.fromSecretKey(Uint8Array.from(k)));}
 addresses(){return this.exists()?{bsc:this.bsc().address,solana:this.solana().publicKey.toBase58()}:null;}
}
