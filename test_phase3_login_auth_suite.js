import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;
const connectionString = 'postgresql://postgres:Ansoceanverse2026@db.fefrlcxctuhdbztyoncs.supabase.co:5432/postgres';
const API_URL = 'http://localhost:3000';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';

async function runPhase3AuthSuite() {
  console.log('====================================================');
  console.log('   RUNNING PHASE 3 AUTHENTICATION VERIFICATION SUITE');
  console.log('====================================================\n');

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // Create a dedicated temporary test account for login verification
  const testUsername = `phase3_user_${Date.now()}`;
  const testEmail = `${testUsername}@hubbletest.com`;
  const testPassword = 'Password123!';
  const passwordHash = await bcrypt.hash(testPassword, 10);

  const insertRes = await client.query(`
    INSERT INTO public.profiles (id, username, email, full_name, password_hash, is_online)
    VALUES (gen_random_uuid(), $1, $2, 'Phase3 Test User', $3, false)
    RETURNING id, username, email, full_name;
  `, [testUsername, testEmail, passwordHash]);

  const testUser = insertRes.rows[0];
  console.log('✔ Test user created in database:', testUser.username, `(${testUser.id})`);

  try {
    // TEST 1: Missing Credentials
    console.log('\n--- TEST 1: Missing Credentials ---');
    const res1 = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    console.log('Status:', res1.status, '(Expected: 400)');
    const body1 = await res1.json();
    console.log('Body:', body1);
    if (res1.status !== 400) throw new Error(`TEST 1 Failed: Expected 400, got ${res1.status}`);

    // TEST 2: Non-existent Username
    console.log('\n--- TEST 2: Non-existent Username ---');
    const res2 = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'non_existent_hubber_9999', password: testPassword })
    });
    console.log('Status:', res2.status, '(Expected: 400)');
    const body2 = await res2.json();
    console.log('Body:', body2);
    if (res2.status !== 400 || !body2.error) throw new Error(`TEST 2 Failed: Expected 400 error`);

    // TEST 3: Incorrect Password
    console.log('\n--- TEST 3: Incorrect Password ---');
    const res3 = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testUsername, password: 'WrongPassword999!' })
    });
    console.log('Status:', res3.status, '(Expected: 400)');
    const body3 = await res3.json();
    console.log('Body:', body3);
    if (res3.status !== 400 || !body3.error) throw new Error(`TEST 3 Failed: Expected 400 error`);

    // TEST 4: Valid Login via Username
    console.log('\n--- TEST 4: Valid Login via Username ---');
    const res4 = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testUsername, password: testPassword })
    });
    console.log('Status:', res4.status, '(Expected: 200)');
    const body4 = await res4.json();
    console.log('Login Response:', { success: body4.success, message: body4.message, user: body4.user });
    if (res4.status !== 200 || !body4.success || !body4.token) throw new Error(`TEST 4 Failed: Expected 200 with token`);

    // Decode and verify JWT
    const decoded = jwt.verify(body4.token, JWT_SECRET);
    console.log('✔ JWT Verified. Decoded User ID:', decoded.id, 'Email:', decoded.email);
    if (decoded.id !== testUser.id) throw new Error('JWT payload ID does not match database user ID');

    // TEST 5: Valid Login via Email
    console.log('\n--- TEST 5: Valid Login via Email ---');
    const res5 = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testEmail, password: testPassword })
    });
    console.log('Status:', res5.status, '(Expected: 200)');
    const body5 = await res5.json();
    if (res5.status !== 200 || !body5.success) throw new Error(`TEST 5 Failed`);

    // TEST 6: Presence Heartbeat using issued JWT
    console.log('\n--- TEST 6: Presence Heartbeat using Issued Login JWT ---');
    const res6 = await fetch(`${API_URL}/api/presence/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${body4.token}`
      }
    });
    console.log('Status:', res6.status, '(Expected: 200)');
    const body6 = await res6.json();
    console.log('Heartbeat Body:', body6);
    if (res6.status !== 200 || !body6.success) throw new Error(`TEST 6 Failed`);

    // TEST 7: Online Users verification
    console.log('\n--- TEST 7: Online Users List with Logged-in User ---');
    const res7 = await fetch(`${API_URL}/api/online-users`, {
      headers: { 'Authorization': `Bearer ${body4.token}` }
    });
    console.log('Status:', res7.status, '(Expected: 200)');
    const body7 = await res7.json();
    console.log('Online user count:', body7.onlineCount);
    if (res7.status !== 200) throw new Error(`TEST 7 Failed`);

    // TEST 8: Logout Presence
    console.log('\n--- TEST 8: Logout Presence ---');
    const res8 = await fetch(`${API_URL}/api/users/logout-presence`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${body4.token}` }
    });
    console.log('Status:', res8.status, '(Expected: 200)');
    const body8 = await res8.json();
    console.log('Logout Body:', body8);
    if (res8.status !== 200 || body8.status !== 'offline') throw new Error(`TEST 8 Failed`);

    console.log('\n====================================================');
    console.log('   ALL 8 PHASE 3 AUTHENTICATION TESTS PASSED!       ');
    console.log('====================================================');
  } finally {
    // Cleanup test user
    await client.query(`DELETE FROM public.online_users WHERE user_id = $1;`, [testUser.id]);
    await client.query(`DELETE FROM public.login_history WHERE user_id = $1;`, [testUser.id]);
    await client.query(`DELETE FROM public.profiles WHERE id = $1;`, [testUser.id]);
    await client.end();
    console.log('\n✔ Test user cleanly removed from database.');
  }
}

runPhase3AuthSuite().catch((err) => {
  console.error('\n❌ Phase 3 Suite Error:', err);
  process.exit(1);
});
