import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;
const connectionString = 'postgresql://postgres:Ansoceanverse2026@db.fefrlcxctuhdbztyoncs.supabase.co:5432/postgres';

async function checkBlobs() {
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const tables = ['posts', 'post_media', 'stories', 'reels', 'profiles'];
  for (const t of tables) {
    try {
      const res = await client.query(`SELECT count(*) FROM public.${t} WHERE CAST(to_jsonb(${t}.*) as text) ILIKE '%blob:%';`);
      console.log(`Table ${t} blob: matches =`, res.rows[0].count);
      if (parseInt(res.rows[0].count, 10) > 0) {
        const rows = await client.query(`SELECT id, CAST(to_jsonb(${t}.*) as text) as payload FROM public.${t} WHERE CAST(to_jsonb(${t}.*) as text) ILIKE '%blob:%' LIMIT 5;`);
        console.log(`Sample rows with blob: in ${t}:`, rows.rows);
      }
    } catch (e) {
      console.log(`Table ${t} check err:`, e.message);
    }
  }

  await client.end();
}

checkBlobs().catch(console.error);
