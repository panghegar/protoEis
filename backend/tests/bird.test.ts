import 'dotenv/config';
import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const local=new URL(process.env.DATABASE_URL!);
if(!['127.0.0.1','localhost'].includes(local.hostname)||local.port!=='55439')throw new Error('Bird tests require isolated local PostgreSQL :55439.');
// Fixture only: no real Supabase credentials, bucket, uploads or deletions.
process.env.SUPABASE_URL='http://127.0.0.1:54321';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-key';
process.env.CRON_SECRET=randomUUID()+randomUUID();
const {default:app}=await import('../src/app.js');
const {prisma}=await import('../src/config/prisma.js');
const {audioStorage}=await import('../src/config/storage.js');
const {CHUNK_BYTES,cleanupAudio,partPath}=await import('../src/services/bird.js');
const exec=promisify(execFile);
const caps={cuda:false,gpu:null,vram_gb:null,torch:'fixture',python:'3.12',bird_audio_version:1};
function wav(bytes:number){const b=Buffer.alloc(bytes);const data=bytes-44;b.write('RIFF');b.writeUInt32LE(bytes-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(data,40);return b;}
test('WAV multipart, mixed queue, Python worker, XLSX, retention, isolation and cancellation',async()=>{
 const objects=new Map<string,Buffer>(),users:string[]=[];const temp=mkdtempSync(join(tmpdir(),'eis-bird-test-'));
 const fixture=createServer(async(req,res)=>{
  const key=decodeURIComponent((req.url||'').slice(7));
  if(!req.url?.startsWith('/parts/')){res.writeHead(404).end();return;}
  if(req.method==='PUT'){const body:Buffer[]=[];for await(const b of req)body.push(Buffer.from(b));objects.set(key,Buffer.concat(body));res.writeHead(200).end('{}');return;}
  const body=objects.get(key);if(!body){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Length':body.length});res.end(body);
 });
 await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));const storageBase='http://127.0.0.1:'+(fixture.address() as {port:number}).port;
 mock.method(audioStorage!,'createSignedUploadUrl',async(path:string)=>({data:{signedUrl:storageBase+'/parts/'+encodeURIComponent(path)},error:null}));
 mock.method(audioStorage!,'createSignedUrl',async(path:string)=>({data:{signedUrl:storageBase+'/parts/'+encodeURIComponent(path)},error:null}));
 mock.method(audioStorage!,'info',async(path:string)=>objects.has(path)?{data:{size:objects.get(path)!.length},error:null}:{data:null,error:{message:'missing'}});
 mock.method(audioStorage!,'remove',async(paths:string[])=>{paths.forEach(p=>objects.delete(p));return {data:[],error:null};});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const apiUrl='http://127.0.0.1:'+(server.address() as {port:number}).port+'/api';
 const post=(p:string,token:string,b:unknown)=>request(app).post('/api'+p).auth(token,{type:'bearer'}).send(b);
 const get=(p:string,token:string)=>request(app).get('/api'+p).auth(token,{type:'bearer'});
 try{
  async function login(){const email='bird-'+randomUUID()+'@prototype.local',password=randomUUID();const user=await prisma.user.create({data:{email,password:await bcrypt.hash(password,4),name:'Bird fixture'}});users.push(user.id);const r=await request(app).post('/api/auth/login').send({email,password});assert.equal(r.status,200);return r.body.token as string;}
  const token=await login(),foreign=await login();
  const worker=(await post('/workers',token,{name:'WAV fixture'})).body;
  const bytes=wav(CHUNK_BYTES+44+96000);const duration=(bytes.length-44)/96000;
  const audio={name:'rekaman.wav',size:bytes.length,wav:{channels:1,sampleRate:48000,bits:16,frames:(bytes.length-44)/2,duration},hashes:Array.from({length:Math.ceil(bytes.length/CHUNK_BYTES)},(_,i)=>createHash('sha256').update(bytes.subarray(i*CHUNK_BYTES,(i+1)*CHUNK_BYTES)).digest('hex'))};
  assert.equal((await post('/bird-jobs',token,{workerId:worker.id,audio})).status,409,'Old worker is rejected with an update instruction.');
  await post('/worker/heartbeat',worker.token,caps);
  assert.equal((await post('/bird-jobs',foreign,{workerId:worker.id,audio})).status,404);
  assert.equal((await post('/bird-jobs',token,{workerId:worker.id,audio:{...audio,hashes:[]}})).status,400);
  const train=(await post('/jobs',token,{workerId:worker.id,config:{epochs:1,batch_size:16,learning_rate:.001,seed:1,device:'cpu'}})).body;
  const created=await post('/bird-jobs',token,{workerId:worker.id,audio});assert.equal(created.status,201,JSON.stringify(created.body));const job=created.body;
  assert.equal(job.status,'uploading');assert.equal(job.leaseHash,undefined);assert.equal(job.audio.hashes,undefined);
  assert.equal((await post('/bird-jobs/'+job.id+'/upload-ticket',foreign,{index:0})).status,404);
  assert.equal((await post('/bird-jobs/'+job.id+'/upload-ticket',token,{index:999})).status,400);
  assert.equal((await post('/bird-jobs/'+job.id+'/finalize',token,{})).status,409,'Incomplete multipart upload cannot queue.');
  for(let i=0;i<audio.hashes.length;i++){const ticket=await post('/bird-jobs/'+job.id+'/upload-ticket',token,{index:i});assert.equal(ticket.status,200);await fetch(ticket.body.url,{method:'PUT',body:bytes.subarray(i*CHUNK_BYTES,(i+1)*CHUNK_BYTES)});assert.equal((await post('/bird-jobs/'+job.id+'/upload-ticket',token,{index:i})).body.uploaded,true,'Lost response can resume immutable uploaded part.');}
  assert.equal((await post('/bird-jobs/'+job.id+'/finalize',token,{})).status,200);
  const claimedTrain=(await post('/worker/claim',worker.token,{})).body.job;assert.equal(claimedTrain.id,train.id);
  assert.equal((await post('/worker/claim',worker.token,{})).body.job,null,'One worker cannot run training and audio simultaneously.');
  await post('/worker/jobs/'+train.id+'/complete',worker.token,{lease:claimedTrain.lease,status:'cancelled',progress:{}});
  await prisma.worker.update({where:{id:worker.id},data:{capabilities:{}}});
  assert.equal((await post('/worker/claim',worker.token,{})).body.job,null,'Legacy workers skip bird jobs.');await post('/worker/heartbeat',worker.token,caps);
  const claimed=(await post('/worker/claim',worker.token,{})).body.job;assert.equal(claimed.id,job.id);assert.equal(claimed.kind,'bird');
  assert.equal((await post('/worker/bird-jobs/'+job.id+'/download-ticket',worker.token,{lease:'0'.repeat(64),index:0})).status,409);
  assert.equal((await post('/worker/jobs/'+job.id+'/complete',worker.token,{lease:claimed.lease,status:'completed',progress:{}})).status,409);
  assert.equal((await post('/worker/bird-jobs/'+job.id+'/complete',worker.token,{lease:claimed.lease,status:'completed',message:'incomplete'})).status,409);
  writeFileSync(join(temp,'input.json'),JSON.stringify({apiUrl,token:worker.token,job:claimed,root:join(temp,'worker')}));
  const code="import sys,json,urllib.request\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom bird_worker import execute_bird\nc=json.loads(Path(sys.argv[2]).read_text())\nclass Client:\n def post(self,path,body):\n  req=urllib.request.Request(c['apiUrl']+path,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+c['token']},method='POST')\n  with urllib.request.urlopen(req,timeout=20) as r:return json.load(r)\nroot=Path(c['root']);root.mkdir()\nexecute_bird(Client(),c['job'],{'cuda':False,'gpu':None,'vram_gb':None,'torch':'fixture','python':'3.12','bird_audio_version':1},root,root/'worker.stop')\n";
  writeFileSync(join(temp,'run.py'),code);
  const python=process.env.PYTHON_EXECUTABLE || (process.platform==='win32' ? resolve('../worker/.venv/Scripts/python.exe') : 'python3');
  const output=await exec(python,[join(temp,'run.py'),resolve('../worker'),join(temp,'input.json')],{timeout:60000});assert.match(output.stdout,/completed/);
  const done=await prisma.job.findUniqueOrThrow({where:{id:job.id}});assert.equal(done.status,'completed');assert.equal((done.progress as {percent:number}).percent,100);
  const results=await get('/bird-jobs/'+job.id+'/segments',token);assert.equal(results.body.total,Math.ceil(duration/3));assert.equal(results.body.items[0].species,'Contoh spesies A');
  assert.equal((await get('/bird-jobs/'+job.id+'/segments',foreign)).status,404);
  const xlsx=await fetch(apiUrl+'/bird-jobs/'+job.id+'/xlsx',{headers:{Authorization:'Bearer '+token}});assert.equal(xlsx.status,200);assert.match(xlsx.headers.get('content-type')!,/spreadsheetml/);const xlsxBytes=Buffer.from(await xlsx.arrayBuffer());assert.equal(xlsxBytes.subarray(0,2).toString(),'PK');
  const xlsxPath=join(temp,'results.xlsx');writeFileSync(xlsxPath,xlsxBytes);
  const check=await exec(python,['-c',"import sys,zipfile,xml.etree.ElementTree as E\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n for n in z.namelist():\n  if n.endswith('.xml') or n.endswith('.rels'):E.fromstring(z.read(n))\n assert b'SIMULASI' in z.read('xl/worksheets/sheet1.xml')\n assert b'<f' not in z.read('xl/worksheets/sheet1.xml')\nprint('OOXML valid')",xlsxPath]);assert.match(check.stdout,/OOXML valid/);
  await prisma.job.update({where:{id:job.id},data:{audioExpiresAt:new Date(Date.now()-1000)}});
  assert.equal((await cleanupAudio(users[0],3)).deleted,1);assert.equal(objects.size,0,'Only source chunks are removed.');
  assert.equal((await get('/bird-jobs/'+job.id+'/xlsx',token)).status,200,'XLSX survives source retention.');
  assert.equal((await get('/bird-jobs/'+job.id+'/segments',token)).body.total,Math.ceil(duration/3));
  assert.equal((await post('/bird-jobs/'+job.id+'/upload-ticket',token,{index:0})).status,410);
  // Simulate a late signed upload; tombstone sweep deletes it on retry.
  objects.set(partPath(done,0),Buffer.from('late'));await cleanupAudio(users[0],3,new Date(Date.now()+61*60000));assert.equal(objects.size,0);
  const cancelled=(await post('/bird-jobs',token,{workerId:worker.id,audio})).body;
  assert.equal((await post('/jobs/'+cancelled.id+'/cancel',token,{})).status,200);
  assert.equal((await post('/bird-jobs/'+cancelled.id+'/finalize',token,{})).status,409);
  assert.equal((await post('/worker/claim',worker.token,{})).body.job,null);
  // Corrupted transfer must fail SHA-256 validation before any segment is accepted.
  const corrupt=(await post('/bird-jobs',token,{workerId:worker.id,audio})).body;
  for(let i=0;i<audio.hashes.length;i++)objects.set(partPath(corrupt,i),Buffer.from(bytes.subarray(i*CHUNK_BYTES,(i+1)*CHUNK_BYTES)));
  objects.get(partPath(corrupt,0))![50]=1;
  assert.equal((await post('/bird-jobs/'+corrupt.id+'/finalize',token,{})).status,200);
  const badClaim=(await post('/worker/claim',worker.token,{})).body.job;assert.equal(badClaim.id,corrupt.id);
  writeFileSync(join(temp,'input.json'),JSON.stringify({apiUrl,token:worker.token,job:badClaim,root:join(temp,'corrupt-worker')}));
  await exec(python,[join(temp,'run.py'),resolve('../worker'),join(temp,'input.json')],{timeout:60000});
  assert.equal((await prisma.job.findUniqueOrThrow({where:{id:corrupt.id}})).status,'failed');
  assert.equal(await prisma.birdSegment.count({where:{jobId:corrupt.id}}),0);
  // Running cancellation is enforced on completion even if the worker says completed.
  const running=await prisma.job.create({data:{ownerId:users[0],workerId:worker.id,kind:'bird',status:'queued',config:{mode:'simulation'},audio,audioExpiresAt:new Date(Date.now()+86400000)}});
  const runningClaim=(await post('/worker/claim',worker.token,{})).body.job;assert.equal(runningClaim.id,running.id);
  await post('/jobs/'+running.id+'/cancel',token,{});
  const cancelReply=await post('/worker/bird-jobs/'+running.id+'/progress',worker.token,{lease:runningClaim.lease,sequence:1,progress:{percent:5,phase:'download',message:'fixture',processedSegments:0,totalSegments:Math.ceil(duration/3),simulation:true}});
  assert.equal(cancelReply.body.cancelRequested,true);
  assert.equal((await post('/worker/bird-jobs/'+running.id+'/complete',worker.token,{lease:runningClaim.lease,status:'completed',message:'cancel race'})).body.status,'cancelled');
  assert.equal((await request(app).post('/api/internal/audio-cleanup')).status,401);
  assert.equal((await post('/internal/audio-cleanup',process.env.CRON_SECRET!,{})).status,200);
 }finally{
  await prisma.job.deleteMany({where:{ownerId:{in:users}}});await prisma.worker.deleteMany({where:{ownerId:{in:users}}});await prisma.user.deleteMany({where:{id:{in:users}}});await prisma.$disconnect();mock.restoreAll();
  server.closeAllConnections();fixture.closeAllConnections();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>fixture.close(()=>r()))]);
  assert.ok(resolve(temp).startsWith(resolve(tmpdir())+sep));rmSync(temp,{recursive:true,force:true});
 }
});
