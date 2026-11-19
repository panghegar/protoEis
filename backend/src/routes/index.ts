import {Router} from 'express';
import {randomBytes} from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import {z} from 'zod';
import {prisma} from '../config/prisma.js';
import {storage} from '../config/storage.js';
import {requireUser,requireWorker,hash,secret,type AuthRequest} from '../middleware/auth.js';
import {configSchema,progressSchema,heartbeatSchema} from '../validator/schemas.js';
import {ApiError,claim,expireJobs,ownedLease,progress,publicJob} from '../services/jobs.js';
import connectionRoutes from './connection.js';
import birdRoutes from './bird.js';
const router=Router();
router.use(connectionRoutes);
router.use(birdRoutes);
const id=z.string().uuid();
const lease=z.string().regex(/^[a-f0-9]{64}$/);
router.get('/health',(_req,res)=>res.json({ok:true,service:'EIS training control API'}));
router.post('/auth/login',async(req,res)=>{
  const body=z.object({email:z.email().max(254),password:z.string().min(1).max(200)}).parse(req.body);
  const user=await prisma.user.findUnique({where:{email:body.email.toLowerCase()}});
  if(user?.lockedUntil && user.lockedUntil>new Date()) throw new ApiError(429,'Terlalu banyak percobaan. Coba kembali setelah 15 menit.');
  if(!user || !await bcrypt.compare(body.password,user.password)){
    if(user){
      const updated=await prisma.user.update({where:{id:user.id},data:{failedLogins:{increment:1}}});
      if(updated.failedLogins>=8) await prisma.user.update({where:{id:user.id},data:{failedLogins:0,lockedUntil:new Date(Date.now()+900000)}});
    }
    throw new ApiError(401,'Email atau kata sandi tidak sesuai.');
  }
  await prisma.user.update({where:{id:user.id},data:{failedLogins:0,lockedUntil:null}});
  const token=jwt.sign({},secret!,{subject:user.id,algorithm:'HS256',expiresIn:'8h',issuer:'eis-prototype',audience:'dashboard'});
  res.json({token,user:{name:user.name,email:user.email}});
});
router.get('/workers',requireUser,async(req:AuthRequest,res)=>{
  const workers=await prisma.worker.findMany({where:{ownerId:req.userId},orderBy:{createdAt:'desc'},select:{id:true,name:true,disabled:true,capabilities:true,lastSeen:true,createdAt:true}});
  res.json(workers.map(w=>({...w,online:!w.disabled && !!w.lastSeen && Date.now()-w.lastSeen.getTime()<45000})));
});
router.post('/workers',requireUser,async(req:AuthRequest,res)=>{
  const {name}=z.object({name:z.string().trim().min(2).max(80)}).strict().parse(req.body);
  const key=randomBytes(32).toString('hex');
  const worker=await prisma.worker.create({data:{ownerId:req.userId!,name,tokenHash:hash(key)}});
  res.status(201).json({id:worker.id,name,token:worker.id+'.'+key});
});
router.post('/workers/:id/revoke',requireUser,async(req:AuthRequest,res)=>{
  const workerId=id.parse(req.params.id);
  const updated=await prisma.worker.updateMany({where:{id:workerId,ownerId:req.userId},data:{disabled:true}});
  if(!updated.count) throw new ApiError(404,'Perangkat tidak ditemukan.');
  await prisma.job.updateMany({where:{workerId,status:{in:['queued','uploading']}},data:{status:'cancelled',cancelRequested:true,finishedAt:new Date()}});
  await prisma.job.updateMany({where:{workerId,status:'running'},data:{status:'interrupted',cancelRequested:true,finishedAt:new Date()}});
  res.json({ok:true});
});
router.get('/jobs',requireUser,async(req:AuthRequest,res)=>{
  await expireJobs();
  res.json((await prisma.job.findMany({where:{ownerId:req.userId,kind:'training'},orderBy:{createdAt:'desc'},take:100})).map(publicJob));
});
router.post('/jobs',requireUser,async(req:AuthRequest,res)=>{
  const body=z.object({workerId:id,config:configSchema}).strict().parse(req.body);
  const worker=await prisma.worker.findFirst({where:{id:body.workerId,ownerId:req.userId,disabled:false}});
  if(!worker) throw new ApiError(404,'Perangkat tidak tersedia.');
  if(body.config.device==='cuda' && (worker.capabilities as {cuda?:boolean}).cuda===false) throw new ApiError(400,'Perangkat ini melaporkan CUDA tidak tersedia.');
  const job=await prisma.job.create({data:{ownerId:req.userId!,workerId:worker.id,config:body.config}});
  res.status(201).json(publicJob(job));
});
router.post('/jobs/:id/cancel',requireUser,async(req:AuthRequest,res)=>{
  const jobId=id.parse(req.params.id);
  await prisma.$transaction(async tx=>{
    const rows=await tx.$queryRaw<{id:string}[]>`SELECT id FROM "Job" WHERE id=${jobId} AND "ownerId"=${req.userId!} FOR UPDATE`;
    if(!rows.length) throw new ApiError(404,'Pekerjaan tidak ditemukan.');
    const job=await tx.job.findUniqueOrThrow({where:{id:jobId}});
    if(['queued','uploading'].includes(job.status)) await tx.job.update({where:{id:jobId},data:{status:'cancelled',cancelRequested:true,finishedAt:new Date(),...(job.kind==='bird'?{audioExpiresAt:new Date(Date.now()+86400000)}:{})}});
    if(job.status==='running') await tx.job.update({where:{id:jobId},data:{cancelRequested:true}});
  });
  res.json({ok:true});
});
router.get('/jobs/:id/report',requireUser,async(req:AuthRequest,res)=>{
  const job=await prisma.job.findFirst({where:{id:id.parse(req.params.id),ownerId:req.userId,kind:'training'}});
  if(!job) throw new ApiError(404,'Pekerjaan tidak ditemukan.');
  res.json({...publicJob(job),dataset:'sklearn digits; demonstrasi, bukan model EIS'});
});
router.get('/jobs/:id/download',requireUser,async(req:AuthRequest,res)=>{
  const job=await prisma.job.findFirst({where:{id:id.parse(req.params.id),ownerId:req.userId,kind:'training'}});
  if(!job) throw new ApiError(404,'Pekerjaan tidak ditemukan.');
  if(!storage || !job.artifactPath) throw new ApiError(404,'Model tersimpan di folder worker/runs pada laptop. Unggahan cloud belum tersedia.');
  const {data,error}=await storage.createSignedUrl(job.artifactPath,60,{download:true});
  if(error) throw new ApiError(502,'Gagal membuat tautan unduh model.');
  res.json({url:data.signedUrl});
});
router.post('/worker/heartbeat',requireWorker,async(req:AuthRequest,res)=>{
  const capabilities=heartbeatSchema.parse(req.body);
  await prisma.worker.update({where:{id:req.workerId},data:{lastSeen:new Date(),capabilities}});
  res.json({ok:true});
});
router.post('/worker/claim',requireWorker,async(req:AuthRequest,res)=>{
  await expireJobs();
  await prisma.worker.update({where:{id:req.workerId},data:{lastSeen:new Date()}});
  res.json({job:await claim(req.workerId!)});
});
router.post('/worker/jobs/:id/progress',requireWorker,async(req:AuthRequest,res)=>{
  const b=z.object({lease,sequence:z.number().int().positive(),progress:progressSchema}).strict().parse(req.body);
  const job=await ownedLease(id.parse(req.params.id),req.workerId!,b.lease);
  if(job.kind!=='training')throw new ApiError(409,'Gunakan endpoint identifikasi audio.');
  res.json(await progress(id.parse(req.params.id),req.workerId!,b.lease,b.sequence,b.progress));
});
router.post('/worker/jobs/:id/upload-ticket',requireWorker,async(req:AuthRequest,res)=>{
  const b=z.object({lease}).strict().parse(req.body);
  const job=await ownedLease(id.parse(req.params.id),req.workerId!,b.lease);
  if(job.kind!=='training'||job.status!=='running') throw new ApiError(409,'Pekerjaan training tidak aktif.');
  if(!storage){res.json({enabled:false});return;}
  const path=job.ownerId+'/'+job.id+'/hasil-training.zip';
  const {data,error}=await storage.createSignedUploadUrl(path,{upsert:true});
  if(error) throw new ApiError(502,'Gagal menyiapkan unggahan model.');
  res.json({enabled:true,url:data.signedUrl});
});
router.post('/worker/jobs/:id/complete',requireWorker,async(req:AuthRequest,res)=>{
  const b=z.object({lease,status:z.enum(['completed','cancelled','failed']),progress:progressSchema,artifactUploaded:z.boolean().default(false)}).strict().parse(req.body);
  const jobId=id.parse(req.params.id);
  const job=await ownedLease(jobId,req.workerId!,b.lease);
  if(job.kind!=='training')throw new ApiError(409,'Gunakan endpoint identifikasi audio.');
  if(['completed','cancelled','failed'].includes(job.status)){res.json({ok:true,status:job.status});return;}
  if(job.kind!=='training'||job.status!=='running') throw new ApiError(409,'Pekerjaan training tidak aktif.');
  let artifactPath:string|null=null;
  if(b.artifactUploaded){
    if(!storage) throw new ApiError(400,'Storage belum dikonfigurasi.');
    artifactPath=job.ownerId+'/'+job.id+'/hasil-training.zip';
    const {error}=await storage.info(artifactPath);
    if(error) throw new ApiError(400,'Berkas hasil belum tersedia di storage.');
  }
  // Lock completion against cancellation so whichever commits first defines the outcome.
  const status=await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "Job" WHERE id=${jobId} FOR UPDATE`;
    const fresh=await tx.job.findUniqueOrThrow({where:{id:jobId}});
    if(fresh.status!=='running' || !fresh.leaseExpiresAt || fresh.leaseExpiresAt<new Date()) throw new ApiError(409,'Lease tidak aktif.');
    const terminal=fresh.cancelRequested?'cancelled':b.status;
    const clean={...b.progress};
    if(terminal==='cancelled'){delete clean.test_accuracy;delete clean.examples;}
    await tx.job.update({where:{id:jobId},data:{status:terminal,progress:clean,artifactPath,finishedAt:new Date(),leaseExpiresAt:null}});
    return terminal;
  });
  res.json({ok:true,status});
});
export default router;
