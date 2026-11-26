import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import 'dotenv/config';
const target=new URL(process.env.DATABASE_URL!);
if(!['127.0.0.1','localhost'].includes(target.hostname)||target.port!=='55439'||!(target.pathname==='/eis_ci'||target.pathname.startsWith('/eis_cleanup_test_')))throw new Error('Cleanup tests require isolated eis_ci/eis_cleanup_test_* on localhost:55439.');
process.env.SUPABASE_URL='http://127.0.0.1:54321';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';process.env.CRON_SECRET=randomUUID()+randomUUID();
const {prisma}=await import('../src/config/prisma.js');
const {audioStorage}=await import('../src/config/storage.js');
const {cleanupAudioSweep,partPath}=await import('../src/services/bird.js');
const {default:app}=await import('../src/app.js');

test('Monthly cleanup previews and processes multiple batches, protects fresh/running/locked records, retries failures and preserves results',async()=>{
 const objects=new Map<string,Buffer>(),deletedPaths:string[]=[];
 let failNext=false,ownerId='';const now=new Date(),expired=new Date(now.getTime()-3600000),fresh=new Date(now.getTime()+86400000);
 mock.method(audioStorage!,'remove',async(paths:string[])=>{
  assert.ok(paths.length<=875);
  if(failNext){failNext=false;return {data:null,error:{message:'fixture transient failure'}};}
  paths.forEach(p=>{objects.delete(p);deletedPaths.push(p);});return {data:[],error:null};
 });
 try{
  const user=await prisma.user.create({data:{email:randomUUID()+'@cleanup.local',password:'unused-fixture',name:'Cleanup test'}});ownerId=user.id;
  const worker=await prisma.worker.create({data:{ownerId,name:'Cleanup fixture',tokenHash:'fixture'}});
  const audio={name:'test.wav',size:1024,wav:{channels:1,sampleRate:16000,bits:16,frames:72000,duration:4.5},hashes:['a'.repeat(64)]};
  async function job(status='completed',expires=expired,extra:Record<string,unknown>={}){
   const j=await prisma.job.create({data:{ownerId,workerId:worker.id,kind:'bird',status,config:{mode:'simulation'},audio,audioExpiresAt:expires,...extra}});
   objects.set(partPath(j,0),Buffer.alloc(1024));return j;
  }
  const overdue=await Promise.all(Array.from({length:32},()=>job()));
  await prisma.birdSegment.create({data:{jobId:overdue[0].id,ordinal:0,startSeconds:0,endSeconds:3,species:'Saved result',confidence:.8}});
  const queued=await job('queued');
  const protectedJobs=[await job('running',expired,{leaseExpiresAt:fresh}),await job('uploading',fresh),await job('queued',fresh),await job('completed',fresh)];
  const oldDeletedAt=new Date(now.getTime()-10*86400000);
  const tombstone=await job('completed',expired,{audioDeletedAt:oldDeletedAt,audioCleanupCheckedAt:new Date(now.getTime()-2*3600000)});
  const preview=await cleanupAudioSweep({ownerId,now,dryRun:true});
  assert.equal(preview.scanned,34);assert.equal(preview.deleted,0);assert.equal(deletedPaths.length,0);
  assert.equal((await prisma.job.findUniqueOrThrow({where:{id:queued.id}})).status,'queued','Preview cannot expire a queued job.');
  const first=await cleanupAudioSweep({ownerId,now,maxJobs:10});
  assert.equal(first.scanned,10);assert.ok(first.remaining>0,'A bounded run must disclose remaining work.');
  const rest=await cleanupAudioSweep({ownerId,now});
  assert.equal(first.deleted+rest.deleted,33);assert.equal(rest.remaining,0);
  assert.equal((await prisma.job.findUniqueOrThrow({where:{id:queued.id}})).status,'failed');
  assert.equal(await prisma.birdSegment.count({where:{jobId:overdue[0].id}}),1,'Identification results survive audio deletion.');
  assert.equal((await prisma.job.findUniqueOrThrow({where:{id:tombstone.id}})).audioDeletedAt!.getTime(),oldDeletedAt.getTime(),'Auditing late uploads cannot extend a tombstone indefinitely.');
  for(const j of protectedJobs){assert.ok(objects.has(partPath(j,0)));assert.equal((await prisma.job.findUniqueOrThrow({where:{id:j.id}})).audioDeletedAt,null);}
  assert.equal(objects.size,protectedJobs.length);
  const retry=await Promise.all(Array.from({length:30},()=>job()));failNext=true;
  const failed=await cleanupAudioSweep({ownerId,now});
  assert.equal(failed.pending,25);assert.equal(failed.deleted,5);assert.equal(failed.remaining,25,'Failed batches remain eligible rather than reporting success.');
  assert.equal((await cleanupAudioSweep({ownerId,now})).deleted,25);
  for(const j of retry)assert.ok((await prisma.job.findUniqueOrThrow({where:{id:j.id}})).audioDeletedAt);
  const changing=await job();let signal!:()=>void,release!:()=>void;
  const locked=new Promise<void>(resolve=>signal=resolve),unblock=new Promise<void>(resolve=>release=resolve);
  const renewing=prisma.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "Job" WHERE id=${changing.id} FOR UPDATE`;
   await tx.job.update({where:{id:changing.id},data:{audioExpiresAt:fresh}});signal();await unblock;
  },{timeout:10000});
  await locked;
  try{const busy=await cleanupAudioSweep({ownerId,now});assert.equal(busy.scanned,0,'Locked records are not deleted from a stale read.');}
  finally{release();await renewing;}
  assert.ok(objects.has(partPath(changing,0)));
  assert.equal((await prisma.job.findUniqueOrThrow({where:{id:changing.id}})).audioDeletedAt,null);
  assert.equal((await request(app).get('/api/internal/audio-cleanup')).status,401);
  assert.equal((await request(app).get('/api/internal/audio-cleanup/monthly')).status,401);
  assert.equal((await request(app).get('/api/internal/audio-cleanup').auth('invalid',{type:'bearer'})).status,401);
  assert.equal((await request(app).get('/api/internal/audio-cleanup').auth(process.env.CRON_SECRET!,{type:'bearer'})).status,200);
  assert.equal((await request(app).delete('/api/internal/audio-cleanup')).status,405);
 }finally{
  if(ownerId){await prisma.job.deleteMany({where:{ownerId}});await prisma.worker.deleteMany({where:{ownerId}});await prisma.user.deleteMany({where:{id:ownerId}});}
  mock.restoreAll();await prisma.$disconnect();
 }
});
