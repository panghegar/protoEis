import {Router} from 'express';
import {z} from 'zod';
import {prisma} from '../config/prisma.js';
import {audioStorage} from '../config/storage.js';
import {requireUser,requireWorker,equal,hash,type AuthRequest} from '../middleware/auth.js';
import {ApiError,expireJobs,ownedLease,progress} from '../services/jobs.js';
import {audioSchema,audioOf,audioDuration,isSimulation,CHUNK_BYTES,MAX_AUDIO_BYTES,AUDIO_QUOTA_BYTES,RETENTION_MS,cleanupAudio,partPath,partSize,publicBird,requireAudioStorage,requireLiveAudio} from '../services/bird.js';
import {birdWorkbook} from '../services/bird-xlsx.js';
const router=Router(),id=z.string().uuid(),lease=z.string().regex(/^[a-f0-9]{64}$/);
const leaseBody=z.object({lease}).strict();
const birdProgress=z.object({percent:z.number().min(0).max(100),phase:z.enum(['download','process','finish']),message:z.string().max(1000),processedSegments:z.number().int().min(0).max(2400).default(0),totalSegments:z.number().int().min(1).max(2400),simulation:z.boolean()}).strict();
const segment=z.object({ordinal:z.number().int().min(0).max(999999),startSeconds:z.number().nonnegative(),endSeconds:z.number().positive(),species:z.string().trim().min(1).max(300),confidence:z.number().min(0).max(1),windowIndex:z.number().int().min(0).max(2399).optional(),status:z.enum(['detected','unknown','no_detection']).optional(),commonName:z.string().max(300).optional(),globalConfidence:z.number().min(0).max(1).nullable().optional(),customConfidence:z.number().min(0).max(1).nullable().optional(),evidence:z.string().max(200).optional()}).strict();
async function owned(idValue:string,userId:string){const job=await prisma.job.findFirst({where:{id:idValue,ownerId:userId,kind:'bird'}});if(!job)throw new ApiError(404,'Identifikasi tidak ditemukan.');return job;}
async function workerJob(jobId:string,workerId:string,key:string){const job=await ownedLease(jobId,workerId,key);if(job.kind!=='bird'||job.status!=='running')throw new ApiError(409,'Tugas identifikasi tidak aktif.');return job;}

router.get('/bird/config',requireUser,(_req,res)=>res.json({storageReady:!!audioStorage,chunkBytes:CHUNK_BYTES,maxBytes:MAX_AUDIO_BYTES,formats:['wav','mp3'],defaultMode:'inference'}));
router.get('/bird-jobs',requireUser,async(req:AuthRequest,res)=>{await expireJobs();await cleanupAudio(req.userId,2);const jobs=await prisma.job.findMany({where:{ownerId:req.userId,kind:'bird'},orderBy:{createdAt:'desc'},take:50});res.json(jobs.map(publicBird));});
router.post('/bird-jobs',requireUser,async(req:AuthRequest,res)=>{
 requireAudioStorage();const body=z.object({workerId:id,audio:audioSchema,mode:z.enum(['simulation','inference']).default('simulation')}).strict().parse(req.body);
 await cleanupAudio(req.userId,2);
 const job=await prisma.$transaction(async tx=>{
  // Shared, cross-user reservation budget. Does not replace provider quota monitoring.
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(47381920)`;
  const worker=await tx.worker.findFirst({where:{id:body.workerId,ownerId:req.userId,disabled:false}});
  if(!worker)throw new ApiError(404,'Perangkat tidak tersedia.');
  const caps=worker.capabilities as {bird_audio_version?:number;bird_model?:{id:string;name:string;temporary:true;pipeline:string;labelCount:number}|null};
  if(![1,2].includes(caps.bird_audio_version||0))throw new ApiError(409,'Perbarui dan jalankan worker paket terbaru.');
  if(body.mode==='inference'&&(caps.bird_audio_version!==2||!caps.bird_model))throw new ApiError(409,'Impor ZIP model dan siapkan model burung pada launcher, lalu jalankan kembali worker.');
  if(body.mode==='simulation'&&!body.audio.wav)throw new ApiError(400,'Simulasi lama hanya mendukung WAV.');
  const config=body.mode==='inference'?{mode:'inference',segmentSeconds:3,minConfidence:.25,customBoost:.35,model:caps.bird_model!}:{mode:'simulation',segmentSeconds:3};
  const reservations=await tx.job.findMany({where:{kind:'bird',audioDeletedAt:null},select:{audio:true}});
  const used=reservations.reduce((n,j)=>n+Number((j.audio as {size?:number})?.size||0),0);
  if(used+body.audio.size>AUDIO_QUOTA_BYTES)throw new ApiError(409,'Ruang audio sementara hampir penuh. Tunggu pembersihan audio lama atau hubungi pengelola.');
  return tx.job.create({data:{ownerId:req.userId!,workerId:worker.id,kind:'bird',status:'uploading',config,audio:body.audio,audioExpiresAt:new Date(Date.now()+RETENTION_MS),progress:{message:'Menunggu unggahan audio.',simulation:body.mode==='simulation'}}});
 });res.status(201).json(publicBird(job));
});
router.post('/bird-jobs/:id/upload-ticket',requireUser,async(req:AuthRequest,res)=>{
 const job=await owned(id.parse(req.params.id),req.userId!);const body=z.object({index:z.number().int().nonnegative()}).strict().parse(req.body);requireLiveAudio(job);
 if(job.status!=='uploading')throw new ApiError(409,'Unggahan sudah ditutup.');
 const audio=audioOf(job);if(body.index>=audio.hashes.length)throw new ApiError(400,'Bagian tidak tersedia.');
 const store=requireAudioStorage(),path=partPath(job,body.index),existing=await store.info(path);
 if(!existing.error&&existing.data){if(Number(existing.data.size)!==partSize(audio,body.index))throw new ApiError(409,'Bagian tersimpan memiliki ukuran berbeda; batalkan dan unggah ulang.');res.json({uploaded:true});return;}
 const {data,error}=await store.createSignedUploadUrl(path,{upsert:false});
 if(error)throw new ApiError(502,'Gagal menyiapkan unggahan audio.');
 res.json({url:data.signedUrl,expectedBytes:partSize(audio,body.index)});
});
router.post('/bird-jobs/:id/finalize',requireUser,async(req:AuthRequest,res)=>{
 const job=await owned(id.parse(req.params.id),req.userId!);requireLiveAudio(job);if(job.status==='queued'){res.json(publicBird(job));return;}
 if(job.status!=='uploading')throw new ApiError(409,'Unggahan tidak aktif.');
 const audio=audioOf(job),store=requireAudioStorage();
 for(let i=0;i<audio.hashes.length;i++){const {data,error}=await store.info(partPath(job,i));if(error||Number(data?.size)!==partSize(audio,i))throw new ApiError(409,'Bagian audio '+(i+1)+' belum lengkap atau ukurannya berbeda.');}
 const updated=await prisma.job.updateMany({where:{id:job.id,status:'uploading',audioExpiresAt:{gt:new Date()}},data:{status:'queued',progress:{message:'Unggahan lengkap. Menunggu worker.',simulation:isSimulation(job)}}});
 if(!updated.count)throw new ApiError(409,'Unggahan dibatalkan atau kedaluwarsa.');res.json(publicBird(await owned(job.id,req.userId!)));
});
router.get('/bird-jobs/:id/segments',requireUser,async(req:AuthRequest,res)=>{
 const job=await owned(id.parse(req.params.id),req.userId!);const offset=z.coerce.number().int().min(0).max(1000000).parse(req.query.offset||0);
 const [items,total]=await Promise.all([prisma.birdSegment.findMany({where:{jobId:job.id},orderBy:{ordinal:'asc'},skip:offset,take:100}),prisma.birdSegment.count({where:{jobId:job.id}})]);res.json({items,total,simulation:isSimulation(job)});
});
router.get('/bird-jobs/:id/xlsx',requireUser,async(req:AuthRequest,res)=>{
 const job=await owned(id.parse(req.params.id),req.userId!);if(job.status!=='completed')throw new ApiError(409,'XLSX tersedia setelah proses selesai.');
 const offset=z.coerce.number().int().min(0).max(999999).parse(req.query.offset||0);
 const rows=await prisma.birdSegment.findMany({where:{jobId:job.id},orderBy:{ordinal:'asc'},skip:offset,take:10000});
 res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="hasil-'+(isSimulation(job)?'simulasi-':'identifikasi-')+job.id.slice(0,8)+'.xlsx"');const workbook=birdWorkbook(audioOf(job).name,rows,job.id,isSimulation(job),job.config as Record<string,unknown>);if(workbook.length>4*1024*1024)throw new ApiError(413,'Bagian hasil terlalu besar untuk unduhan API. Hubungi pengelola.');res.send(workbook);
});
router.post('/worker/bird-jobs/:id/download-ticket',requireWorker,async(req:AuthRequest,res)=>{
 const body=z.object({lease,index:z.number().int().nonnegative()}).strict().parse(req.body);const job=await workerJob(id.parse(req.params.id),req.workerId!,body.lease);requireLiveAudio(job);
 const audio=audioOf(job);if(body.index>=audio.hashes.length)throw new ApiError(400,'Bagian tidak tersedia.');
 const remaining=Math.floor((job.audioExpiresAt!.getTime()-Date.now())/1000);
 const {data,error}=await requireAudioStorage().createSignedUrl(partPath(job,body.index),Math.min(60,remaining));
 if(error)throw new ApiError(502,'Audio tidak dapat diunduh.');res.json({url:data.signedUrl});
});
router.post('/worker/bird-jobs/:id/metadata',requireWorker,async(req:AuthRequest,res)=>{
 const b=z.object({lease,duration:z.number().positive().max(7200)}).strict().parse(req.body);
 const jobId=id.parse(req.params.id);
 await prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "Job" WHERE id=${jobId} FOR UPDATE`;
  const job=await tx.job.findFirst({where:{id:jobId,workerId:req.workerId,kind:'bird',status:'running',leaseHash:hash(b.lease),leaseExpiresAt:{gt:new Date()}}});
  if(!job)throw new ApiError(409,'Lease identifikasi tidak aktif.');
  const audio=audioOf(job);
  if(job.cancelRequested||await tx.birdSegment.count({where:{jobId}}))throw new ApiError(409,'Metadata tidak dapat diubah setelah hasil dikirim.');
  if(audio.wav&&Math.abs(audio.wav.duration-b.duration)>.001)throw new ApiError(400,'Durasi WAV berbeda dari manifest.');
  if(audio.mp3)await tx.job.update({where:{id:jobId},data:{audio:{...audio,mp3:{duration:b.duration}}}});
 });res.json({ok:true});
});
router.post('/worker/bird-jobs/:id/progress',requireWorker,async(req:AuthRequest,res)=>{const b=z.object({lease,sequence:z.number().int().positive(),progress:birdProgress}).strict().parse(req.body);const job=await workerJob(id.parse(req.params.id),req.workerId!,b.lease);if(b.progress.simulation!==isSimulation(job))throw new ApiError(400,'Mode progres berbeda dari pekerjaan.');res.json(await progress(req.params.id as string,req.workerId!,b.lease,b.sequence,b.progress));});
router.post('/worker/bird-jobs/:id/segments',requireWorker,async(req:AuthRequest,res)=>{
 const b=z.object({lease,segments:z.array(segment).min(1).max(50)}).strict().parse(req.body);const jobId=id.parse(req.params.id);
 await prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "Job" WHERE id=${jobId} FOR UPDATE`;
  const job=await tx.job.findFirst({where:{id:jobId,workerId:req.workerId,kind:'bird',status:'running',leaseHash:hash(b.lease),leaseExpiresAt:{gt:new Date()}}});
  if(!job)throw new ApiError(409,'Lease identifikasi tidak aktif.');if(job.cancelRequested)throw new ApiError(409,'Pembatalan sudah diminta.');
  const duration=audioDuration(audioOf(job)),simulation=isSimulation(job);
  for(const s of b.segments){
   const window=simulation?s.ordinal:s.windowIndex;
   if(window===undefined||Math.abs(s.startSeconds-window*3)>.001||Math.abs(s.endSeconds-Math.min(duration,(window+1)*3))>.001||s.startSeconds>=duration)throw new ApiError(400,'Rentang waktu hasil tidak sesuai.');
   if(simulation&&!['Contoh spesies A','Contoh spesies B','unknown'].includes(s.species))throw new ApiError(400,'Label simulasi tidak sesuai.');
   if(!simulation&&(!s.status||(s.status==='no_detection'&&(s.species!=='Tidak ada deteksi'||s.confidence!==0))||(s.status==='unknown'&&s.species.toLowerCase()!=='unknown')||(s.status==='detected'&&(s.species==='Tidak ada deteksi'||s.species.toLowerCase()==='unknown'))))throw new ApiError(400,'Status hasil tidak sesuai label.');
  }
  await tx.birdSegment.createMany({data:b.segments.map(s=>({...s,jobId})),skipDuplicates:true});
 });res.json({ok:true});
});
router.post('/worker/bird-jobs/:id/complete',requireWorker,async(req:AuthRequest,res)=>{
 const b=z.object({lease,status:z.enum(['completed','failed','cancelled']),message:z.string().max(1000),resultCount:z.number().int().positive().max(1000000).optional()}).strict().parse(req.body);const jobId=id.parse(req.params.id);
 const initial=await ownedLease(jobId,req.workerId!,b.lease);if(initial.kind!=='bird')throw new ApiError(409,'Jenis tugas berbeda.');
 if(['completed','failed','cancelled'].includes(initial.status)){res.json({status:initial.status});return;}
 const status=await prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "Job" WHERE id=${jobId} FOR UPDATE`;
  const job=await tx.job.findUniqueOrThrow({where:{id:jobId}});if(job.status!=='running'||!job.leaseExpiresAt||job.leaseExpiresAt<=new Date())throw new ApiError(409,'Lease identifikasi kedaluwarsa.');
  const terminal=job.cancelRequested?'cancelled':b.status;
  if(terminal==='completed'){
   const windows=Math.ceil(audioDuration(audioOf(job))/3),count=await tx.birdSegment.count({where:{jobId}});
   if(isSimulation(job)){if(count!==windows)throw new ApiError(409,'Hasil segmen belum lengkap.');}
   else{
    const coverage=await tx.$queryRaw<{windows:bigint;first:number;last:number;invalid:bigint}[]>`SELECT COUNT(DISTINCT "windowIndex") AS windows,MIN(ordinal) AS first,MAX(ordinal) AS last,COUNT(*) FILTER (WHERE "windowIndex" IS NULL) AS invalid FROM "BirdSegment" WHERE "jobId"=${jobId}`;
    const mixed=await tx.$queryRaw<{windowIndex:number}[]>`SELECT "windowIndex" FROM "BirdSegment" WHERE "jobId"=${jobId} GROUP BY "windowIndex" HAVING COUNT(*)>1 AND BOOL_OR(status='no_detection') LIMIT 1`;
    if(count!==b.resultCount||Number(coverage[0].windows)!==windows||coverage[0].first!==0||coverage[0].last!==count-1||Number(coverage[0].invalid)||mixed.length)throw new ApiError(409,'Hasil identifikasi belum lengkap atau status segmen bertentangan.');
   }
  }
  await tx.job.update({where:{id:jobId},data:{status:terminal,finishedAt:new Date(),leaseExpiresAt:null,audioExpiresAt:new Date(Date.now()+RETENTION_MS),progress:{...(job.progress as object),percent:terminal==='completed'?100:Number((job.progress as {percent?:number}).percent||0),simulation:isSimulation(job),message:b.message}}});return terminal;
 });res.json({status});
});
router.all('/internal/audio-cleanup',async(req,res)=>{
 if(!['GET','POST'].includes(req.method)){res.sendStatus(405);return;}
 const configured=process.env.CRON_SECRET,provided=(req.headers.authorization||'').replace(/^Bearer /,'');
 if(!configured||configured.length<32||!equal(provided,configured)){res.sendStatus(401);return;}
 await expireJobs();res.json(await cleanupAudio(undefined,10));
});
export default router;
