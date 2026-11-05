import {randomBytes} from 'node:crypto';
import {prisma} from '../config/prisma.js';
import {hash} from '../middleware/auth.js';
import type {Prisma,Job} from '../generated/prisma/client.js';
export const leaseMs=180000;
export class ApiError extends Error {constructor(public code:number,message:string){super(message);}}
export const publicJob=(job:Job)=>{const {leaseHash:_,...safe}=job;return safe;};
export async function expireJobs(){
  await prisma.job.updateMany({where:{status:'running',leaseExpiresAt:{lt:new Date()}},data:{status:'interrupted',finishedAt:new Date()}});
}
export async function claim(workerId:string){
  return prisma.$transaction(async tx=>{
    // Serialize claims per device, even across different serverless instances.
    await tx.$queryRaw`SELECT id FROM "Worker" WHERE id = ${workerId} FOR UPDATE`;
    const running=await tx.job.findFirst({where:{workerId,status:'running'}});
    if(running) return null;
    const rows=await tx.$queryRaw<Job[]>`SELECT * FROM "Job" WHERE "workerId"=${workerId} AND status='queued' ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED`;
    const queued=rows[0];
    if(!queued) return null;
    const lease=randomBytes(32).toString('hex');
    const job=await tx.job.update({where:{id:queued.id},data:{status:'running',leaseHash:hash(lease),leaseExpiresAt:new Date(Date.now()+leaseMs),startedAt:new Date()}});
    return {...publicJob(job),lease};
  });
}
export async function ownedLease(id:string,workerId:string,lease:string){
  const job=await prisma.job.findFirst({where:{id,workerId,leaseHash:hash(lease)}});
  if(!job) throw new ApiError(409,'Lease tidak valid atau pekerjaan bukan milik worker.');
  if(job.status==='running' && (!job.leaseExpiresAt || job.leaseExpiresAt.getTime()<=Date.now())) throw new ApiError(409,'Lease telah kedaluwarsa. Hasil tetap disimpan lokal.');
  return job;
}
export async function progress(id:string,workerId:string,lease:string,sequence:number,data:Prisma.InputJsonValue){
  const job=await ownedLease(id,workerId,lease);
  if(job.status!=='running') throw new ApiError(409,'Pekerjaan tidak aktif.');
  const result=await prisma.job.updateMany({where:{id,workerId,status:'running',leaseHash:hash(lease),leaseExpiresAt:{gt:new Date()},sequence:{lt:sequence}},data:{progress:data,sequence,leaseExpiresAt:new Date(Date.now()+leaseMs)}});
  if(!result.count){
    const fresh=await ownedLease(id,workerId,lease);
    if(fresh.status!=='running') throw new ApiError(409,'Pekerjaan tidak aktif.');
    // Duplicate/out-of-order heartbeat must never overwrite newer progress.
    return {cancelRequested:fresh.cancelRequested,accepted:false};
  }
  const fresh=await prisma.job.findUniqueOrThrow({where:{id}});
  return {cancelRequested:fresh.cancelRequested,accepted:true};
}
