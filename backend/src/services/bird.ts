import {z} from 'zod';
import {prisma} from '../config/prisma.js';
import {audioStorage} from '../config/storage.js';
import {ApiError} from './jobs.js';
import type {Prisma,Job} from '../generated/prisma/client.js';

export const CHUNK_BYTES=20*1024*1024;
export const MAX_AUDIO_BYTES=700*1024*1024;
export const AUDIO_QUOTA_BYTES=800*1024*1024;
export const RETENTION_MS=24*60*60*1000;
export const wavSchema=z.object({channels:z.number().int().min(1).max(2),sampleRate:z.number().int().min(8000).max(192000),bits:z.union([z.literal(8),z.literal(16),z.literal(24),z.literal(32)]),frames:z.number().int().positive(),duration:z.number().positive().max(7200)}).strict();
const baseAudioSchema=z.object({name:z.string().trim().min(1).max(180).regex(/\.(wav|mp3)$/i),size:z.number().int().positive().max(MAX_AUDIO_BYTES),wav:wavSchema.optional(),mp3:z.object({duration:z.number().positive().max(7200)}).strict().optional(),hashes:z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(35)}).strict().superRefine((a,ctx)=>{
 if(a.hashes.length!==Math.ceil(a.size/CHUNK_BYTES))ctx.addIssue({code:'custom',message:'Jumlah bagian audio tidak sesuai.'});
 if(a.wav&&Math.abs(a.wav.duration-a.wav.frames/a.wav.sampleRate)>.001)ctx.addIssue({code:'custom',message:'Durasi WAV tidak konsisten.'});
});
export const audioSchema=baseAudioSchema.superRefine((a,ctx)=>{
 const wav=/\.wav$/i.test(a.name);
 if(wav?(!a.wav||!!a.mp3):(!a.mp3||!!a.wav))ctx.addIssue({code:'custom',message:'Metadata harus sesuai format WAV/MP3.'});
});
export type AudioInput=z.infer<typeof audioSchema>;
export const audioDuration=(audio:AudioInput)=>audio.wav?.duration||audio.mp3!.duration;
export const isSimulation=(job:Job)=>(job.config as {mode?:string}).mode!=='inference';

export function audioOf(job:Job){return audioSchema.parse(job.audio);}
export function partSize(audio:AudioInput,index:number){return Math.min(CHUNK_BYTES,audio.size-index*CHUNK_BYTES);}
export function partPath(job:Pick<Job,'id'|'ownerId'>,index:number){return job.ownerId+'/'+job.id+'/part-'+String(index).padStart(3,'0')+'.bin';}
export function requireAudioStorage(){if(!audioStorage)throw new ApiError(503,'Storage audio belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY pada backend.');return audioStorage;}
export function requireLiveAudio(job:Job){if(job.audioDeletedAt||!job.audioExpiresAt||job.audioExpiresAt<=new Date())throw new ApiError(410,'Audio sudah kedaluwarsa; unggah rekaman lagi. Hasil lama tetap tersimpan.');}
export function publicBird(job:Job){const {leaseHash:_,audio,...safe}=job;return {...safe,audio:audio?{...audioOf(job),hashes:undefined}:null,simulation:isSimulation(job)};}

// Expired records are locked and made terminal before Storage I/O, preventing
// cancellation/finalization from renewing retention between selection and deletion.
function cleanupWhere(ownerId:string|undefined,now:Date,afterId='',auditDeleted=false):Prisma.JobWhereInput{
 return {kind:'bird',...(ownerId?{ownerId}:{}),id:{gt:afterId},status:{not:'running'},audioExpiresAt:{lte:now},
  OR:[{audioDeletedAt:null},{...(auditDeleted?{audioDeletedAt:{not:null}}:{audioDeletedAt:{gt:new Date(now.getTime()-48*3600000)}}),
   OR:[{audioCleanupCheckedAt:null},{audioCleanupCheckedAt:{lte:new Date(now.getTime()-3600000)}}]}]};
}
type Batch={deleted:number;pending:number;scanned:number;estimatedBytesReleased:number;eligibleBytes:number;lastId:string};
async function cleanupBatch(ownerId:string|undefined,limit:number,now:Date,afterId='',dryRun=false,auditDeleted=false):Promise<Batch>{
 const empty={deleted:0,pending:0,scanned:0,estimatedBytesReleased:0,eligibleBytes:0,lastId:afterId};
 if(!audioStorage)return empty;
 const rows=dryRun?await prisma.job.findMany({where:cleanupWhere(ownerId,now,afterId,auditDeleted),orderBy:{id:'asc'},take:limit}):await prisma.$transaction(async tx=>{
  const jobs=await tx.$queryRaw<Job[]>`SELECT * FROM "Job" WHERE kind='bird' AND status<>'running'
   AND "audioExpiresAt"<=${now} AND id>${afterId}
   AND (${ownerId??null}::text IS NULL OR "ownerId"=${ownerId??null})
   AND ("audioDeletedAt" IS NULL OR ((${auditDeleted} OR "audioDeletedAt">${new Date(now.getTime()-48*3600000)})
    AND ("audioCleanupCheckedAt" IS NULL OR "audioCleanupCheckedAt"<=${new Date(now.getTime()-3600000)})))
   ORDER BY id ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
  for(const simulation of [true,false]){
   const ids=jobs.filter(j=>['uploading','queued'].includes(j.status)&&isSimulation(j)===simulation).map(j=>j.id);
   if(ids.length)await tx.job.updateMany({where:{id:{in:ids}},data:{status:'failed',finishedAt:now,progress:{message:'Audio kedaluwarsa sebelum diproses. Unggah rekaman lagi.',simulation}}});
  }
  return jobs;
 });
 if(!rows.length)return empty;
 const valid:{job:Job;audio:AudioInput}[]=[];let pending=0;
 for(const job of rows){const parsed=audioSchema.safeParse(job.audio);if(parsed.success)valid.push({job,audio:parsed.data});else pending++;}
 const result={...empty,scanned:rows.length,pending,lastId:rows.at(-1)!.id,
  eligibleBytes:valid.filter(v=>!v.job.audioDeletedAt).reduce((n,v)=>n+v.audio.size,0)};
 if(dryRun||!valid.length)return result;
 // <=25 jobs x <=35 parts = <=875 paths per Storage request.
 const paths=valid.flatMap(({job,audio})=>audio.hashes.map((_,i)=>partPath(job,i)));
 try{
  const {error}=await audioStorage.remove(paths);
  if(error)return {...result,pending:pending+valid.length};
 }catch{return {...result,pending:pending+valid.length};}
 const fresh=valid.filter(v=>!v.job.audioDeletedAt),old=valid.filter(v=>!!v.job.audioDeletedAt);
 const updated=fresh.length?await prisma.job.updateMany({where:{id:{in:fresh.map(v=>v.job.id)},audioDeletedAt:null},data:{audioDeletedAt:now,audioCleanupCheckedAt:now}}):{count:0};
 if(old.length)await prisma.job.updateMany({where:{id:{in:old.map(v=>v.job.id)}},data:{audioCleanupCheckedAt:now}});
 return {...result,deleted:updated.count,estimatedBytesReleased:updated.count===fresh.length?fresh.reduce((n,v)=>n+v.audio.size,0):0};
}

// Small opportunistic cleanup for interactive requests; preserves the existing API.
export async function cleanupAudio(ownerId?:string,limit=3,now=new Date()){
 const {deleted,pending}=await cleanupBatch(ownerId,Math.min(25,Math.max(1,limit)),now);
 return {deleted,pending};
}

export async function cleanupAudioSweep({ownerId,now=new Date(),dryRun=false,maxJobs=10000,maxDurationMs=45000}: {ownerId?:string;now?:Date;dryRun?:boolean;maxJobs?:number;maxDurationMs?:number}={}){
 requireAudioStorage();
 const started=Date.now(),deadline=started+maxDurationMs;
 let scanned=0,deleted=0,pending=0,estimatedBytesReleased=0,eligibleBytes=0,lastId='',batches=0;
 while(scanned<maxJobs&&Date.now()<deadline){
  const limit=Math.min(25,maxJobs-scanned);
  const b=await cleanupBatch(ownerId,limit,now,lastId,dryRun,true);
  if(!b.scanned)break;
  scanned+=b.scanned;deleted+=b.deleted;pending+=b.pending;estimatedBytesReleased+=b.estimatedBytesReleased;eligibleBytes+=b.eligibleBytes;lastId=b.lastId;batches++;
  if(b.scanned<limit)break;
 }
 const remaining=await prisma.job.count({where:cleanupWhere(ownerId,now,dryRun?lastId:'',true)});
 return {dryRun,scanned,deleted,pending,remaining,batches,estimatedBytesReleased,eligibleBytes,durationMs:Date.now()-started,cutoff:now.toISOString()};
}
