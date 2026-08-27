import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Client } = pg;
const projectRef = 'fefrlcxctuhdbztyoncs';
const host = 'aws-0-ap-southeast-1.pooler.supabase.com';
const port = 5432;
const pwd = process.env.SUPABASE_DB_PASSWORD || 'Ansoceanverse2026';

const connectionString = `postgresql://postgres.${projectRef}:${encodeURIComponent(pwd)}@${host}:${port}/postgres`;

async function queryProfiles() {
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    const { rows } = await client.query("SELECT username, email FROM public.profiles LIMIT 10;");
    console.log("Profiles in DB:", rows);
  } catch (err) {
    console.error("Database connection/query error:", err);
  } finally {
    await client.end();
  }
}

queryProfiles();
