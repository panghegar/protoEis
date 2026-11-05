import {Router} from 'express';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {prisma} from '../config/prisma.js';
import {requireUser,hash,type AuthRequest} from '../middleware/auth.js';
import {ApiError,expireJobs} from '../services/jobs.js';
const router=Router();
router.post('/workers/:id/connection',requireUser,async(req:AuthRequest,res)=>{
 const workerId=z.string().uuid().parse(req.params.id);
 await expireJobs();
 const key=randomBytes(32).toString('hex');
 const worker=await prisma.$transaction(async tx=>{
   const rows=await tx.$queryRaw<{id:string}[]>`SELECT id FROM "Worker" WHERE id=${workerId} AND "ownerId"=${req.userId!} FOR UPDATE`;
   if(!rows.length)throw new ApiError(404,'Perangkat tidak ditemukan.');
   const current=await tx.worker.findUniqueOrThrow({where:{id:workerId}});
   if(current.disabled)throw new ApiError(409,'Akses perangkat sudah dicabut. Daftarkan perangkat baru.');
   if(await tx.job.findFirst({where:{workerId,status:'running'}}))throw new ApiError(409,'Hentikan training aktif sebelum membuat koneksi baru.');
   return tx.worker.update({where:{id:workerId},data:{tokenHash:hash(key),lastSeen:null}});
 });
 res.json({id:worker.id,name:worker.name,token:worker.id+'.'+key});
});
export default router;
