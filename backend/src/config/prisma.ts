import 'dotenv/config';
import {PrismaClient} from '../generated/prisma/client.js';
import {PrismaPg} from '@prisma/adapter-pg';
const url=process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL wajib diisi.');
const adapter=new PrismaPg({connectionString:url,max:3,idleTimeoutMillis:10000,connectionTimeoutMillis:10000});
export const prisma=new PrismaClient({adapter});
