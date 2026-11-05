import 'dotenv/config';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import bcrypt from 'bcrypt';
import {randomUUID} from 'node:crypto';
import app from '../src/app.js';
import {prisma} from '../src/config/prisma.js';
const url=new URL(process.env.DATABASE_URL!);
if(!['localhost','127.0.0.1'].includes(url.hostname) || url.port!=='55439') throw new Error('Tes hanya di database lokal khusus prototipe, port 55439.');
test('Auth, isolasi pengguna, klaim atomik, fencing lease, urutan progres, pembatalan dan pencabutan',async()=>{
 const users:string[]=[];
 const cfg={epochs:10,batch_size:64,learning_rate:.001,seed:789,device:'auto'};
 try{
  const login=async()=>{
   const email='test-'+randomUUID()+'@prototype.local',password=randomUUID()+randomUUID();
   const user=await prisma.user.create({data:{email,password:await bcrypt.hash(password,4),name:'Test'}});
   users.push(user.id);
   const res=await request(app).post('/api/auth/login').send({email,password});
   assert.equal(res.status,200);return res.body.token as string;
  };
  const a=await login(),b=await login();
  const post=(path:string,token:string,body:unknown)=>request(app).post('/api'+path).auth(token,{type:'bearer'}).send(body);
  const get=(path:string,token:string)=>request(app).get('/api'+path).auth(token,{type:'bearer'});
  assert.equal((await request(app).get('/api/jobs')).status,401);
  assert.equal((await request(app).get('/api/jobs').set('Origin','https://untrusted.example')).status,403);
  const wa=(await post('/workers',a,{name:'Test device A'})).body;
  const wb=(await post('/workers',b,{name:'Test device B'})).body;
  assert.equal((await post('/jobs',b,{workerId:wa.id,config:cfg})).status,404);
  assert.equal((await post('/jobs',a,{workerId:wa.id,config:{...cfg,epochs:1.5}})).status,400);
  const j1=(await post('/jobs',a,{workerId:wa.id,config:cfg})).body;
  const j2=(await post('/jobs',a,{workerId:wa.id,config:cfg})).body;
  assert.equal((await get('/jobs/'+j1.id+'/report',b)).status,404);
  const claims=await Promise.all(Array.from({length:8},()=>post('/worker/claim',wa.token,{})));
  const claimed=claims.map(r=>r.body.job).filter(Boolean);
  assert.equal(claimed.length,1,'Delapan request bersamaan hanya boleh mengklaim satu job.');
  const j=claimed[0];assert.equal(j.id,j1.id);
  assert.equal((await post('/worker/jobs/'+j.id+'/progress',wb.token,{lease:j.lease,sequence:1,progress:{epoch:1}})).status,409);
  assert.equal((await post('/worker/jobs/'+j.id+'/progress',wa.token,{lease:'0'.repeat(64),sequence:1,progress:{epoch:1}})).status,409);
  assert.equal((await post('/worker/jobs/'+j.id+'/progress',wa.token,{lease:j.lease,sequence:2,progress:{epoch:2}})).status,200);
  const stale=await post('/worker/jobs/'+j.id+'/progress',wa.token,{lease:j.lease,sequence:1,progress:{epoch:1}});
  assert.equal(stale.body.accepted,false);
  assert.equal(((await get('/jobs/'+j.id+'/report',a)).body.progress).epoch,2);
  assert.equal((await post('/jobs/'+j.id+'/cancel',a,{})).status,200);
  const heartbeat=await post('/worker/jobs/'+j.id+'/progress',wa.token,{lease:j.lease,sequence:3,progress:{epoch:3}});
  assert.equal(heartbeat.body.cancelRequested,true);
  const completion=await post('/worker/jobs/'+j.id+'/complete',wa.token,{lease:j.lease,status:'completed',progress:{epoch:3,test_accuracy:.9}});
  assert.equal(completion.body.status,'cancelled');
  assert.equal((await post('/worker/jobs/'+j.id+'/complete',wa.token,{lease:j.lease,status:'completed',progress:{epoch:3}})).status,200,'Completion retry idempotent.');
  const report=(await get('/jobs/'+j.id+'/report',a)).body;
  assert.equal(report.progress.test_accuracy,undefined);
  assert.equal(report.leaseHash,undefined);
  const second=(await post('/worker/claim',wa.token,{})).body.job;
  assert.equal(second.id,j2.id);
  await prisma.job.update({where:{id:second.id},data:{leaseExpiresAt:new Date(Date.now()-1000)}});
  assert.equal((await post('/worker/jobs/'+second.id+'/complete',wa.token,{lease:second.lease,status:'completed',progress:{epoch:10}})).status,409);
  await get('/jobs',a);
  assert.equal((await prisma.job.findUniqueOrThrow({where:{id:second.id}})).status,'interrupted');
  const queued=(await post('/jobs',a,{workerId:wa.id,config:cfg})).body;
  await post('/jobs/'+queued.id+'/cancel',a,{});
  assert.equal((await post('/worker/claim',wa.token,{})).body.job,null,'Cancelled queued job cannot be claimed.');
  assert.equal((await get('/jobs/'+j.id+'/download',a)).status,404);
  assert.equal((await get('/workers',a)).body[0].tokenHash,undefined);
  await post('/workers/'+wa.id+'/revoke',a,{});
  assert.equal((await post('/worker/claim',wa.token,{})).status,401);
  // Cancel racing with claim must never resurrect a cancelled queued job.
  const wc=(await post('/workers',a,{name:'Race test'})).body;
  for(let n=0;n<5;n++){
   const item=(await post('/jobs',a,{workerId:wc.id,config:cfg})).body;
   const [,result]=await Promise.all([post('/jobs/'+item.id+'/cancel',a,{}),post('/worker/claim',wc.token,{})]);
   const current=await prisma.job.findUniqueOrThrow({where:{id:item.id}});
   assert.ok(current.cancelRequested);
   assert.ok(['running','cancelled'].includes(current.status));
   if(result.body.job) await post('/worker/jobs/'+item.id+'/complete',wc.token,{lease:result.body.job.lease,status:'cancelled',progress:{}});
  }

  assert.equal((await post('/workers/'+wc.id+'/connection',b,{})).status,404);
  const rotated=(await post('/workers/'+wc.id+'/connection',a,{})).body;
  assert.notEqual(rotated.token,wc.token);
  assert.equal((await post('/worker/claim',wc.token,{})).status,401);
  const rotateJob=(await post('/jobs',a,{workerId:wc.id,config:cfg})).body;
  const rotateClaim=(await post('/worker/claim',rotated.token,{})).body.job;
  assert.equal(rotateClaim.id,rotateJob.id);
  assert.equal((await post('/workers/'+wc.id+'/connection',a,{})).status,409);
  await post('/worker/jobs/'+rotateJob.id+'/complete',rotated.token,{lease:rotateClaim.lease,status:'cancelled',progress:{}});
 }finally{
  await prisma.job.deleteMany({where:{ownerId:{in:users}}});
  await prisma.worker.deleteMany({where:{ownerId:{in:users}}});
  await prisma.user.deleteMany({where:{id:{in:users}}});
  await prisma.$disconnect();
 }
});
