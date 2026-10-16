import {Decimal} from 'decimal.js';
Decimal.set({precision:60});
export const dec=(x:Decimal.Value)=>new Decimal(x);
export const atoms=(x:Decimal.Value,d:number,up=false)=>dec(x).mul(dec(10).pow(d)).toFixed(0,up?Decimal.ROUND_CEIL:Decimal.ROUND_FLOOR);
export const units=(x:string|bigint,d:number)=>dec(x.toString()).div(dec(10).pow(d)).toFixed();
export const finite=(x:number)=>Number.isFinite(x);
