import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;
const connectionString = 'postgresql://postgres:Ansoceanverse2026@db.fefrlcxctuhdbztyoncs.supabase.co:5432/postgres';

async function createOtpTable() {
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    console.log('Connected to PostgreSQL successfully.');

    const ddl = `
      CREATE TABLE IF NOT EXISTS public.email_verification_otps (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email VARCHAR(255) NOT NULL,
        otp_hash VARCHAR(255) NOT NULL,
        type VARCHAR(50) DEFAULT 'signup',
        payload JSONB,
        attempts INT DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL,
        last_sent_at TIMESTAMPTZ DEFAULT NOW(),
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_email_verification_otps_email ON public.email_verification_otps(email);
      CREATE INDEX IF NOT EXISTS idx_email_verification_otps_expires ON public.email_verification_otps(expires_at);

      GRANT ALL ON public.email_verification_otps TO postgres, anon, authenticated, service_role;
    `;

    await client.query(ddl);
    console.log('✅ Table public.email_verification_otps created and granted permissions successfully!');
    await client.end();
  } catch (err) {
    console.error('Error creating OTP table:', err.message);
  }
}

createOtpTable();
