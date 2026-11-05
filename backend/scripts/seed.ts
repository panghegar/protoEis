import 'dotenv/config';
import bcrypt from 'bcrypt';
import {prisma} from '../src/config/prisma.js';
const email=process.env.SEED_ADMIN_EMAIL?.toLowerCase();
const password=process.env.SEED_ADMIN_PASSWORD;
if(!email || !password || password.length<12) throw new Error('Isi SEED_ADMIN_EMAIL dan SEED_ADMIN_PASSWORD minimal 12 karakter.');
await prisma.user.upsert({where:{email},update:{},create:{email,password:await bcrypt.hash(password,12),name:'Administrator Prototipe'}});
console.log('Akun prototipe siap; akun yang sudah ada tidak diubah.');
await prisma.$disconnect();
