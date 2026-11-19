import {createClient} from '@supabase/supabase-js';
export const bucket=process.env.SUPABASE_BUCKET || 'training-artifacts';
export const audioBucket=process.env.SUPABASE_AUDIO_BUCKET || 'bird-audio';
export const storageClient=process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
 ? createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}) : null;
export const storage=storageClient?.storage.from(bucket) || null;
export const audioStorage=storageClient?.storage.from(audioBucket) || null;
