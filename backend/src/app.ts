import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {ZodError} from 'zod';
import routes from './routes/index.js';
import {ApiError} from './services/jobs.js';
const app=express();
app.disable('x-powered-by');
const origins=(process.env.FRONTEND_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
if(!origins.length) throw new Error('FRONTEND_ORIGINS wajib diisi.');
app.use((req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  const origin=req.headers.origin;
  if(origin && !origins.includes(origin)){res.status(403).json({error:'Origin tidak diizinkan.'});return;}
  next();
});
app.use(cors({origin:origins,methods:['GET','POST','OPTIONS'],allowedHeaders:['Content-Type','Authorization']}));
app.use(express.json({limit:'128kb'}));
app.use('/api',routes);
app.use((_req,res)=>res.status(404).json({error:'Endpoint tidak ditemukan.'}));
app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  if(err instanceof ZodError){res.status(400).json({error:'Input tidak valid.',details:err.issues.map(i=>({field:i.path.join('.'),message:i.message}))});return;}
  if(err instanceof ApiError){res.status(err.code).json({error:err.message});return;}
  if(err instanceof SyntaxError){res.status(400).json({error:'JSON tidak valid.'});return;}
  if((err as {status?:number})?.status===413){res.status(413).json({error:'Permintaan terlalu besar.'});return;}
  console.error('Request failed:',err instanceof Error?err.name:'UnknownError');
  res.status(500).json({error:'API gagal memproses permintaan. Periksa koneksi database dan log server.'});
});
export default app;
