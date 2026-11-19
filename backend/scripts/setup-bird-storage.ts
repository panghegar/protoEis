import 'dotenv/config';
import {createClient} from '@supabase/supabase-js';
const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
const name=process.env.SUPABASE_AUDIO_BUCKET||'bird-audio';
if(!url||!key)throw new Error('Isi SUPABASE_URL (HTTPS project URL) dan SUPABASE_SERVICE_ROLE_KEY pada environment backend.');
const parsed=new URL(url);
if(parsed.protocol!=='https:'||!parsed.hostname.endsWith('.supabase.co')||parsed.username||parsed.password)throw new Error('SUPABASE_URL harus berupa HTTPS project URL, bukan connection string PostgreSQL.');
const storage=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}).storage;
const settings={public:false,fileSizeLimit:20*1024*1024,allowedMimeTypes:['application/octet-stream']};
const existing=await storage.getBucket(name);
if(existing.data){if(existing.data.public)throw new Error('Bucket sudah publik. Gunakan nama bucket privat baru untuk audio.');const {error}=await storage.updateBucket(name,settings);if(error)throw new Error('Gagal mengatur batas bucket privat: '+error.message);}
else{const {error}=await storage.createBucket(name,settings);if(error)throw new Error('Gagal membuat bucket audio: '+error.message);}
console.log('Bucket audio privat siap: '+name+'. Tidak ada policy akses publik yang ditambahkan.');
