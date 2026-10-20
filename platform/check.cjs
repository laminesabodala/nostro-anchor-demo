'use strict';
const fs=require('node:fs');const path=require('node:path');
const r=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../.local-platform/runtime.json')));
(async()=>{
 const results=[];
 for(const [name,url,headers]of[
 ['discovery',`${r.publicUrl}/.well-known/stellar.toml`,{}],
 ['sep31',`${r.publicUrl}/sep31/info`,{}],
 ['challenge',`${r.publicUrl}/auth?account=${r.senderPublicKey}`,{}],
 ['privateWithoutKey',`${r.platformUrl}/transactions?sep=31`,{}],
 ['privateWithKey',`${r.platformUrl}/transactions?sep=31`,{'X-Api-Key':r.platformApiKey}]
 ]) {const response=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});const body=await response.text();results.push({name,status:response.status});if(name==='privateWithoutKey'){if(![401,403].includes(response.status))throw Error('Private API did not reject unauthenticated access');}else if(!response.ok)throw Error(`${name}: HTTP${response.status} ${body.slice(0,150)}`);}
 console.log(JSON.stringify({passed:true,checks:results},null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
