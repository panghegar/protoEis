import {createHash,timingSafeEqual} from 'node:crypto';
import jwt from 'jsonwebtoken';
import type {Request,Response,NextFunction} from 'express';
import {prisma} from '../config/prisma.js';
export const secret=process.env.JWT_SECRET;
if(!secret || secret.length<32 || secret.startsWith('REPLACE_')) throw new Error('JWT_SECRET harus berupa nilai acak minimal 32 karakter.');
export const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function equal(a:string,b:string){return a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));}
export interface AuthRequest extends Request { userId?:string; workerId?:string }
export function requireUser(req:AuthRequest,res:Response,next:NextFunction){
  try{
    const value=jwt.verify((req.headers.authorization||'').replace(/^Bearer /,''),secret!,{algorithms:['HS256'],issuer:'eis-prototype',audience:'dashboard'}) as jwt.JwtPayload;
    if(typeof value.sub!=='string') throw new Error();
    req.userId=value.sub; next();
  }catch{res.status(401).json({error:'Sesi berakhir. Silakan masuk kembali.'});}
}
export async function requireWorker(req:AuthRequest,res:Response,next:NextFunction){
  const [id,key,...rest]=(req.headers.authorization||'').replace(/^Bearer /,'').split('.');
  if(!id || !key || rest.length){res.status(401).json({error:'Kredensial worker tidak valid.'});return;}
  const worker=await prisma.worker.findUnique({where:{id}});
  if(!worker || worker.disabled || !equal(worker.tokenHash,hash(key))){res.status(401).json({error:'Worker tidak diizinkan.'});return;}
  req.workerId=id; next();
}
