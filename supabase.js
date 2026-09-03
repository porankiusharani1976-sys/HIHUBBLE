import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const rawUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseUrl = rawUrl ? rawUrl.trim() : undefined;

const rawKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabaseKey = rawKey ? rawKey.trim().replace(/[\r\n\s]+/g, '') : undefined;

if (!supabaseUrl || !supabaseKey) {
  console.error('⚠️ WARNING: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing from environment variables.');
}

export const supabase = createClient(supabaseUrl, supabaseKey);
