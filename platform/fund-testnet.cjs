'use strict';
const fs=require('node:fs');const path=require('node:path');
const {Keypair,Horizon,TransactionBuilder,Operation,Asset,Networks}=require('@stellar/stellar-sdk');
const dir=path.resolve(__dirname,'../.local-platform');const runtime=JSON.parse(fs.readFileSync(path.join(dir,'runtime.json')));
if(runtime.networkPassphrase!==Networks.TESTNET)throw Error('Testnet only');
const server=new Horizon.Server('https://horizon-testnet.stellar.org');
(async()=>{
 for(const role of ['bank','sender']){
  const wallet=JSON.parse(fs.readFileSync(path.join(dir,`${role}.json`)));const kp=Keypair.fromSecret(wallet.secret);let account;
  try{account=await server.loadAccount(kp.publicKey());}catch(e){if(e.response?.status!==404)throw e;const r=await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(kp.publicKey())}`);if(!r.ok)throw Error(`Friendbot ${r.status}`);await r.json();account=await server.loadAccount(kp.publicKey());}
  if(!account.balances.some(b=>b.asset_code===runtime.assetCode&&b.asset_issuer===runtime.assetIssuer)){
   const tx=new TransactionBuilder(account,{fee:String(await server.fetchBaseFee()),networkPassphrase:Networks.TESTNET}).addOperation(Operation.changeTrust({asset:new Asset(runtime.assetCode,runtime.assetIssuer)})).setTimeout(120).build();tx.sign(kp);const result=await server.submitTransaction(tx);console.log(JSON.stringify({role,account:kp.publicKey(),trustlineTransaction:result.hash}));
  }
  const state=await server.loadAccount(kp.publicKey());console.log(JSON.stringify({role,account:kp.publicKey(),balances:state.balances.map(b=>({asset:b.asset_code||'XLM',balance:b.balance}))}));
 }
})().catch(e=>{console.error(e.response?.data||e.message);process.exitCode=1;});
