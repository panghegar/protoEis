import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Invoked only by the production deployment job. No secret value is logged,
// written into Git, returned to callers, or copied into frontend configuration.
export async function ensureCronSecret(env,{fetchImpl=fetch,newSecret=()=>randomBytes(32).toString('hex')}={}){
 const names=['VERCEL_TOKEN','VERCEL_ORG_ID','VERCEL_BACKEND_PROJECT_ID'];
 const missing=names.filter(name=>!env[name]?.trim());
 if(missing.length)throw new Error('Missing deployment configuration: '+missing.join(', '));
 const project=encodeURIComponent(env.VERCEL_BACKEND_PROJECT_ID.trim());
 const url=new URL('https://api.vercel.com/v10/projects/'+project+'/env');
 if(!env.VERCEL_ORG_ID.startsWith('user_'))url.searchParams.set('teamId',env.VERCEL_ORG_ID.trim());
 const headers={Authorization:'Bearer '+env.VERCEL_TOKEN,'Content-Type':'application/json'};
 let listed;
 try{listed=await fetchImpl(url,{headers,signal:AbortSignal.timeout(30000)});}
 catch{throw new Error('Could not reach Vercel to prepare CRON_SECRET.');}
 if(!listed.ok)throw new Error('Cannot inspect backend environment (HTTP '+listed.status+'). Check VERCEL_TOKEN/project access.');
 let data;
 try{data=await listed.json();}catch{throw new Error('Vercel returned an unreadable environment list.');}
 const entries=Array.isArray(data)?data:data.envs;
 if(!Array.isArray(entries))throw new Error('Vercel environment list has an unexpected shape. No variable was changed.');
 if(entries.some(item=>item.key==='CRON_SECRET'&&Array.isArray(item.target)&&item.target.includes('production'))){
  return {created:false,message:'Production CRON_SECRET already configured; existing value preserved.'};
 }
 const value=newSecret();
 if(typeof value!=='string'||!/^\w{64}$/.test(value))throw new Error('Cron secret generator returned an invalid value.');
 let created;
 try{created=await fetchImpl(url,{method:'POST',headers,signal:AbortSignal.timeout(30000),body:JSON.stringify({key:'CRON_SECRET',value,type:'encrypted',target:['production']})});}
 catch{throw new Error('Could not save CRON_SECRET on Vercel.');}
 // Never print provider response bodies: they may include environment values.
 if(!created.ok)throw new Error('Cannot create backend CRON_SECRET (HTTP '+created.status+'). No existing secret was overwritten.');
 return {created:true,message:'Production backend CRON_SECRET created securely; the next deployment will load it.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{console.log((await ensureCronSecret(process.env)).message);}
 catch(error){console.error(error.message);process.exitCode=1;}
}
