process.env.NO_AUTO_LISTEN = 'true';
import app from './server.js';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import dotenv from 'dotenv';
import { CANONICAL_JWT_SECRET } from './utils.js';
dotenv.config();

const { Client } = pg;
const connectionString = 'postgresql://postgres:Ansoceanverse2026@db.fefrlcxctuhdbztyoncs.supabase.co:5432/postgres';
const PORT = 3089;
const API_URL = `http://localhost:${PORT}`;
const JWT_SECRET = CANONICAL_JWT_SECRET;

async function runPresenceTestSuite() {
  const server = app.listen(PORT);
  await new Promise(r => setTimeout(r, 400));
  console.log('====================================================');
  console.log('   RUNNING PHASE 2 PRESENCE HEARTBEAT TEST SUITE    ');
  console.log('====================================================\n');

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // 1. Fetch a real profile from public.profiles
  const profileRes = await client.query(`SELECT id, username, email, full_name FROM public.profiles LIMIT 1;`);
  if (profileRes.rows.length === 0) {
    throw new Error('No profile found in public.profiles to run authenticated test');
  }
  const realProfile = profileRes.rows[0];
  console.log('✔ Real profile found for test:', realProfile.username, `(${realProfile.id})`);

  // Generate valid test JWT
  const validToken = jwt.sign(
    { id: realProfile.id, username: realProfile.username, email: realProfile.email },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // TEST 1: Missing Token
  console.log('\n--- TEST 1: Missing Token ---');
  const res1 = await fetch(`${API_URL}/api/presence/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  console.log('Status:', res1.status, '(Expected: 401)');
  const body1 = await res1.json();
  console.log('Body:', body1);
  if (res1.status !== 401) throw new Error(`TEST 1 Failed: Expected 401, got ${res1.status}`);

  // TEST 2: Invalid JWT Signature
  console.log('\n--- TEST 2: Invalid JWT Signature ---');
  const invalidSignatureToken = jwt.sign({ id: realProfile.id }, 'wrong-secret-key-12345');
  const res2 = await fetch(`${API_URL}/api/presence/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${invalidSignatureToken}`
    }
  });
  console.log('Status:', res2.status, '(Expected: 401)');
  const body2 = await res2.json();
  console.log('Body:', body2);
  if (res2.status !== 401) throw new Error(`TEST 2 Failed: Expected 401, got ${res2.status}`);

  // TEST 3: Non-UUID User Identity in Token
  console.log('\n--- TEST 3: Non-UUID User Identity in Token ---');
  const nonUuidToken = jwt.sign({ id: 'usr_guest_12345' }, JWT_SECRET);
  const res3 = await fetch(`${API_URL}/api/presence/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${nonUuidToken}`
    }
  });
  console.log('Status:', res3.status, '(Expected: 401)');
  const body3 = await res3.json();
  console.log('Body:', body3);
  if (res3.status !== 401) throw new Error(`TEST 3 Failed: Expected 401, got ${res3.status}`);

  // TEST 4: Valid UUID without Corresponding Profile
  console.log('\n--- TEST 4: Valid UUID without Corresponding Profile ---');
  const nonexistentUuidToken = jwt.sign({ id: '00000000-0000-0000-0000-000000000000' }, JWT_SECRET);
  const res4 = await fetch(`${API_URL}/api/presence/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${nonexistentUuidToken}`
    }
  });
  console.log('Status:', res4.status, '(Expected: 401)');
  const body4 = await res4.json();
  console.log('Body:', body4);
  if (res4.status !== 401) throw new Error(`TEST 4 Failed: Expected 401, got ${res4.status}`);

  // TEST 5: Valid Authenticated User Heartbeat
  console.log('\n--- TEST 5: Valid Authenticated User Heartbeat ---');
  const res5 = await fetch(`${API_URL}/api/presence/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${validToken}`
    },
    body: JSON.stringify({ socketId: 'test_socket_001' })
  });
  console.log('Status:', res5.status, '(Expected: 200)');
  const body5 = await res5.json();
  console.log('Body:', body5);
  if (res5.status !== 200 || !body5.success) throw new Error(`TEST 5 Failed: Expected 200 success, got ${res5.status}`);

  // TEST 6: Consecutive Heartbeats (Simulating 30s timer)
  console.log('\n--- TEST 6: Repeated Consecutive Heartbeats ---');
  for (let i = 1; i <= 3; i++) {
    const resRepeat = await fetch(`${API_URL}/api/presence/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({ socketId: `test_socket_00${i}` })
    });
    console.log(`Heartbeat #${i} Status:`, resRepeat.status, '(Expected: 200)');
    if (resRepeat.status !== 200) throw new Error(`TEST 6 Failed on iteration ${i}`);
  }

  // TEST 7: Presence Read (/api/online-users)
  console.log('\n--- TEST 7: Presence Read (/api/online-users) ---');
  const res7 = await fetch(`${API_URL}/api/online-users`, {
    headers: { 'Authorization': `Bearer ${validToken}` }
  });
  console.log('Status:', res7.status, '(Expected: 200)');
  const body7 = await res7.json();
  console.log('Online Users Payload:', body7);
  if (res7.status !== 200 || typeof body7.onlineCount !== 'number') throw new Error(`TEST 7 Failed`);

  // TEST 8: Logout Presence (/api/users/logout-presence)
  console.log('\n--- TEST 8: Logout Presence (/api/users/logout-presence) ---');
  const res8 = await fetch(`${API_URL}/api/users/logout-presence`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${validToken}` }
  });
  console.log('Status:', res8.status, '(Expected: 200)');
  const body8 = await res8.json();
  console.log('Logout Body:', body8);
  if (res8.status !== 200 || body8.status !== 'offline') throw new Error(`TEST 8 Failed`);

  // Verify DB state
  const dbCheck = await client.query(`SELECT user_id, status, last_seen FROM public.online_users WHERE user_id = $1;`, [realProfile.id]);
  console.log('\n✔ DB Row in online_users:', dbCheck.rows[0]);

  await client.end();
  server.close();
  console.log('\n====================================================');
  console.log('   ALL 8 PRESENCE HEARTBEAT TESTS PASSED CLEANLY!   ');
  console.log('====================================================');
}

runPresenceTestSuite().catch((err) => {
  console.error('\n❌ Test Suite Error:', err);
  process.exit(1);
});
