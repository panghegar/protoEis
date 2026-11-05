import {createClient} from '@supabase/supabase-js';
export const bucket=process.env.SUPABASE_BUCKET || 'training-artifacts';
export const storage=process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}).storage.from(bucket) : null;
