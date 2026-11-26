import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ensureCronSecret} from './ensure-cron-secret.mjs';
const env={VERCEL_TOKEN:'fixture-token-never-print',VERCEL_ORG_ID:'team_fixture',VERCEL_BACKEND_PROJECT_ID:'prj_fixture'};
const response=(body,ok=true,status=200)=>({ok,status,json:async()=>body});
test('existing production cron secret is preserved without rotation or reading its value',async()=>{
 let calls=0;
 const result=await ensureCronSecret(env,{fetchImpl:async(url,options)=>{
  calls++;assert.equal(new URL(url).hostname,'api.vercel.com');assert.equal(options.method,undefined);
  return response({envs:[{key:'CRON_SECRET',target:['production'],type:'sensitive'}]});
 },newSecret:()=>{throw Error('must not rotate');}});
 assert.equal(calls,1);assert.equal(result.created,false);
});
test('missing production secret is generated only on the backend production environment',async()=>{
 const calls=[];const value='a'.repeat(64);
 const result=await ensureCronSecret(env,{newSecret:()=>value,fetchImpl:async(url,options)=>{
  calls.push(options);
  if(calls.length===1)return response({envs:[{key:'CRON_SECRET',target:['preview']}]});
  const body=JSON.parse(options.body);assert.equal(body.value,value);assert.equal(body.type,'encrypted');assert.deepEqual(body.target,['production']);
  assert.ok(!new URL(url).searchParams.has('upsert'));return response({});
 }});
 assert.equal(result.created,true);assert.ok(!JSON.stringify(result).includes(value));assert.equal(calls.length,2);
});
test('missing configuration and provider failures never expose secret values',async()=>{
 await assert.rejects(()=>ensureCronSecret({VERCEL_TOKEN:env.VERCEL_TOKEN}),error=>!error.message.includes(env.VERCEL_TOKEN)&&/VERCEL_ORG_ID/.test(error.message));
 await assert.rejects(()=>ensureCronSecret(env,{fetchImpl:async()=>response({error:{value:'provider-secret'}},false,403)}),error=>/403/.test(error.message)&&!error.message.includes('provider-secret')&&!error.message.includes(env.VERCEL_TOKEN));
});
test('monthly cron targets the authenticated cleanup route for midnight WIB with the monthly date-checked endpoint',()=>{
 const config=JSON.parse(readFileSync(new URL('../backend/vercel.json',import.meta.url),'utf8'));
 assert.deepEqual(config.crons,[{path:'/api/internal/audio-cleanup/monthly',schedule:'0 17 28-31 * *'}]);
 assert.equal(config.functions['src/app.ts'].maxDuration,60);
});
