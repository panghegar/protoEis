import 'dotenv/config';
import {prisma} from '../src/config/prisma.js';
import {cleanupAudioSweep} from '../src/services/bird.js';
import {expireJobs} from '../src/services/jobs.js';
const args=process.argv.slice(2);
try{
 if(args.length!==1||!['--dry-run','--apply'].includes(args[0]))throw new Error('Gunakan --dry-run untuk pratinjau atau --apply untuk menghapus audio kedaluwarsa.');
 const dryRun=args[0]==='--dry-run';
 if(!dryRun)await expireJobs();
 const result=await cleanupAudioSweep({dryRun,maxDurationMs:300000});
 console.log(JSON.stringify(result));
 if(result.pending||result.remaining)process.exitCode=1;
}catch(error){
 // Provider errors can contain URLs; report a type, never raw credential-bearing messages.
 console.error('Audio cleanup failed ('+(error instanceof Error?error.name:'UnknownError')+'). Periksa koneksi database/Storage dan konfigurasi lokal.');
 process.exitCode=1;
}finally{await prisma.$disconnect();}
