import 'dotenv/config';
import {existsSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {prisma} from '../src/config/prisma.js';
const target=resolve('../worker/worker.json');
if(!existsSync(target)){
 const url=new URL(process.env.DATABASE_URL!);
 if(!['localhost','127.0.0.1'].includes(url.hostname)||url.port!=='55439') throw new Error('Setup otomatis hanya untuk database prototipe lokal.');
 const owner=await prisma.user.findUniqueOrThrow({where:{email:process.env.SEED_ADMIN_EMAIL}});
 const key=randomBytes(32).toString('hex');
 const worker=await prisma.worker.create({data:{ownerId:owner.id,name:'Laptop Lenovo · RTX 3050',tokenHash:createHash('sha256').update(key).digest('hex')}});
 writeFileSync(target,JSON.stringify({apiUrl:'http://127.0.0.1:3001/api',token:worker.id+'.'+key},null,2));
 console.log('Konfigurasi worker lokal dibuat. Token tidak ditampilkan.');
}else console.log('Konfigurasi worker sudah ada; tidak diubah.');
await prisma.$disconnect();
