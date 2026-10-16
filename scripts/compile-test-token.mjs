import solc from 'solc';
import {readFileSync,writeFileSync} from 'node:fs';
const input={language:'Solidity',sources:{'TestToken.sol':{content:readFileSync('contracts/TestToken.sol','utf8')}},settings:{optimizer:{enabled:true,runs:200},evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
const out=JSON.parse(solc.compile(JSON.stringify(input)));if(out.errors?.some(e=>e.severity==='error'))throw new Error(JSON.stringify(out.errors));
const c=out.contracts['TestToken.sol'].TestToken;
writeFileSync('src/execution/token-artifact.json',JSON.stringify({compiler:solc.version(),evmVersion:'paris',abi:c.abi,bytecode:'0x'+c.evm.bytecode.object},null,2)+'\n');
console.log('TestToken compiled:',solc.version());
