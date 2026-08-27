import { supabase } from './supabase.js';

async function checkRls() {
  const sql = `
    SELECT 
      tablename, 
      rowsecurity 
    FROM 
      pg_tables 
    WHERE 
      schemaname = 'public' 
      AND tablename IN ('profiles', 'posts', 'reels', 'saved_posts', 'saved_reels');
  `;

  try {
    const { data, error } = await supabase.rpc('exec_sql', { sql });
    if (error) {
      console.error("RPC Error:", error);
    } else {
      console.log("RLS Status (rowsecurity=true means enabled, false means disabled):", data);
    }
  } catch (err) {
    console.error("Exception:", err);
  }
}

checkRls();
