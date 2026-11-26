import {z} from 'zod';
import {prisma} from '../config/prisma.js';
import {audioStorage} from '../config/storage.js';
import {ApiError} from './jobs.js';
import type {Job} from '../generated/prisma/client.js';

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

// Bounded and retryable. A scheduled caller is needed when there is no traffic.
// Re-delete tombstones for 48 h: an already issued signed upload can arrive late.
export async function cleanupAudio(ownerId?:string,limit=3,now=new Date()){
 if(!audioStorage)return {deleted:0,pending:0};
 const due=await prisma.job.findMany({where:{kind:'bird',...(ownerId?{ownerId}:{}),status:{not:'running'},audioExpiresAt:{lte:now},OR:[{audioDeletedAt:null},{audioDeletedAt:{gt:new Date(now.getTime()-48*3600000)},OR:[{audioCleanupCheckedAt:null},{audioCleanupCheckedAt:{lte:new Date(now.getTime()-3600000)}}]}]},orderBy:{audioCleanupCheckedAt:{sort:'asc',nulls:'first'}},take:limit});
 let deleted=0,pending=0;
 for(const job of due){
  const audio=audioOf(job);
  // Expire first so finalization cannot queue a job while deletion runs.
  await prisma.job.updateMany({where:{id:job.id,status:{in:['uploading','queued']}},data:{status:'failed',finishedAt:now,progress:{message:'Audio kedaluwarsa sebelum diproses. Unggah rekaman lagi.',simulation:isSimulation(job)}}});
  const fresh=await prisma.job.findUniqueOrThrow({where:{id:job.id}});
  if(fresh.status==='running')continue;
  const {error}=await audioStorage.remove(audio.hashes.map((_,i)=>partPath(job,i)));
  if(error){pending++;continue;}
  await prisma.job.update({where:{id:job.id},data:{audioDeletedAt:job.audioDeletedAt||now,audioCleanupCheckedAt:now}});
  if(!job.audioDeletedAt)deleted++;
 }
 return {deleted,pending};
}
