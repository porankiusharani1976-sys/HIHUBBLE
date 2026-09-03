import jwt from 'jsonwebtoken';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;
const connectionString = 'postgresql://postgres:Ansoceanverse2026@db.fefrlcxctuhdbztyoncs.supabase.co:5432/postgres';
const API_URL = 'http://localhost:3000';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';

async function testStep1() {
  console.log('====================================================');
  console.log('   RUNNING STEP 1 ONLINE USERS PAYLOAD VERIFICATION ');
  console.log('====================================================\n');

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const profileRes = await client.query(`SELECT id, username, email FROM public.profiles LIMIT 1;`);
  const testUser = profileRes.rows[0];
  console.log('✔ Authenticated User for test:', testUser.username, `(${testUser.id})`);

  const validToken = jwt.sign(
    { id: testUser.id, username: testUser.username, email: testUser.email },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const res = await fetch(`${API_URL}/api/online-users`, {
    headers: { 'Authorization': `Bearer ${validToken}` }
  });

  const rawText = await res.text();
  const byteSize = Buffer.byteLength(rawText, 'utf8');
  console.log('HTTP Status:', res.status, '(Expected: 200)');
  console.log('Response Payload Size:', byteSize, 'bytes', `(${(byteSize / 1024).toFixed(2)} KB)`);

  const data = JSON.parse(rawText);
  console.log('Online Count:', data.onlineCount);
  console.log('Active Users Returned:', data.users.length);
  console.log('Sample User Structure:', data.users[0]);

  if (byteSize > 5000) {
    throw new Error(`Step 1 Failed: Response size (${byteSize} bytes) is still larger than 5 KB!`);
  }

  console.log('\n✔ Step 1 Success: Payload successfully reduced from ~85 KB to', byteSize, 'bytes!');
  await client.end();
}

testStep1().catch(err => {
  console.error('\n❌ Step 1 Error:', err);
  process.exit(1);
});
