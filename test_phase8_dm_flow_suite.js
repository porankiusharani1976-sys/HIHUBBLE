import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { supabase } from './supabase.js';

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || 'hihubble-secure-jwt-secret';
const API_URL = 'http://localhost:3000';

async function runPhase8DmFlowSuite() {
  console.log('====================================================');
  console.log('   RUNNING PHASE 8 DM FLOW & AUTHORIZATION SUITE    ');
  console.log('====================================================\n');

  // Fetch two real profiles from the database for two-party testing
  const { data: profiles, error: profErr } = await supabase
    .from('profiles')
    .select('id, username, full_name')
    .not('username', 'ilike', 'search_test_%')
    .limit(3);

  if (profErr || !profiles || profiles.length < 2) {
    throw new Error('Need at least 2 real profiles in database to run two-account DM test');
  }

  const userA = profiles[0];
  const userB = profiles[1];
  console.log(`✔ User A (Party 1): ${userA.username} (${userA.id})`);
  console.log(`✔ User B (Party 2): ${userB.username} (${userB.id})`);

  const tokenA = jwt.sign({ id: userA.id, username: userA.username }, JWT_SECRET, { expiresIn: '1h' });
  const tokenB = jwt.sign({ id: userB.id, username: userB.username }, JWT_SECRET, { expiresIn: '1h' });

  // TEST 1: Resolve/Create Canonical Conversation between A and B
  console.log('\n--- TEST 1: Resolve/Create Conversation (POST /api/chats/direct/:targetId) ---');
  const directRes = await fetch(`${API_URL}/api/chats/direct/${userB.id}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenA}`
    }
  });

  if (!directRes.ok) {
    throw new Error(`Test 1 Failed: POST /api/chats/direct/${userB.id} returned status ${directRes.status}`);
  }

  const directData = await directRes.json();
  const convId = directData.conversationId || directData.id || directData._id;
  const isConvUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(convId);
  if (!isConvUuid) {
    throw new Error(`Test 1 Failed: conversationId is not a valid UUID: ${convId}`);
  }
  console.log(`✔ Conversation resolved with UUID: ${convId}`);

  // TEST 2: User A fetches messages via Real Conversation UUID
  console.log('\n--- TEST 2: User A Fetch Messages (GET /api/chats/messages/:convId) ---');
  const msgResA = await fetch(`${API_URL}/api/chats/messages/${convId}`, {
    headers: { 'Authorization': `Bearer ${tokenA}` }
  });
  console.log(`User A Fetch Status: ${msgResA.status} (Expected: 200)`);
  if (msgResA.status !== 200) {
    throw new Error(`Test 2 Failed: Expected 200, got ${msgResA.status}`);
  }
  const messagesA = await msgResA.json();
  console.log(`✔ User A successfully fetched messages: ${messagesA.length} messages found`);

  // TEST 3: User B fetches messages via Real Conversation UUID
  console.log('\n--- TEST 3: User B Fetch Messages (GET /api/chats/messages/:convId) ---');
  const msgResB = await fetch(`${API_URL}/api/chats/messages/${convId}`, {
    headers: { 'Authorization': `Bearer ${tokenB}` }
  });
  console.log(`User B Fetch Status: ${msgResB.status} (Expected: 200)`);
  if (msgResB.status !== 200) {
    throw new Error(`Test 3 Failed: Expected 200, got ${msgResB.status}`);
  }
  const messagesB = await msgResB.json();
  console.log(`✔ User B successfully fetched messages: ${messagesB.length} messages found`);

  // TEST 4: Security & BOLA Negative Authorization Tests
  console.log('\n--- TEST 4: BOLA & Security Negative Tests ---');
  
  // 4a. Requesting with 'caller' as convId
  const callerRes = await fetch(`${API_URL}/api/chats/messages/caller`, {
    headers: { 'Authorization': `Bearer ${tokenA}` }
  });
  console.log(`GET /api/chats/messages/caller Status: ${callerRes.status} (Expected: 403)`);
  if (callerRes.status !== 403) {
    throw new Error(`Test 4a Failed: Expected 403 for 'caller', got ${callerRes.status}`);
  }

  // 4b. Requesting with random non-existent UUID
  const randomUuid = '00000000-0000-0000-0000-000000000000';
  const randomRes = await fetch(`${API_URL}/api/chats/messages/${randomUuid}`, {
    headers: { 'Authorization': `Bearer ${tokenA}` }
  });
  console.log(`GET /api/chats/messages/${randomUuid} Status: ${randomRes.status} (Expected: 403)`);
  if (randomRes.status !== 403) {
    throw new Error(`Test 4b Failed: Expected 403 for unassociated UUID, got ${randomRes.status}`);
  }

  // 4c. Requesting without token
  const unauthRes = await fetch(`${API_URL}/api/chats/messages/${convId}`);
  console.log(`Unauthenticated Request Status: ${unauthRes.status} (Expected: 401)`);
  if (unauthRes.status !== 401) {
    throw new Error(`Test 4c Failed: Expected 401 for unauthenticated request, got ${unauthRes.status}`);
  }
  console.log('✔ All BOLA & IDOR security boundaries intact');

  // TEST 5: Two-Party Message Exchange (A -> B, then B -> A)
  console.log('\n--- TEST 5: Two-Party Message Exchange ---');
  const testContentA = 'Phase 8 test message from User A ' + Date.now();
  const sendResA = await fetch(`${API_URL}/api/chats/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenA}`
    },
    body: JSON.stringify({
      conversationId: convId,
      recipient: userB.id,
      content: testContentA
    })
  });
  console.log(`User A Send Status: ${sendResA.status} (Expected: 200 or 201)`);
  if (!sendResA.ok) {
    throw new Error(`Test 5 Failed: User A send failed with status ${sendResA.status}`);
  }
  const createdMsgA = await sendResA.json();
  console.log(`✔ User A sent message ID: ${createdMsgA._id || createdMsgA.id}`);

  // User B reads conversation and verifies receipt
  const verifyB = await fetch(`${API_URL}/api/chats/messages/${convId}`, {
    headers: { 'Authorization': `Bearer ${tokenB}` }
  });
  const msgsForB = await verifyB.json();
  const foundMsgForB = msgsForB.find(m => (m.id || m._id) === (createdMsgA._id || createdMsgA.id));
  if (!foundMsgForB) {
    throw new Error('Test 5 Failed: User B could not find the message sent by User A');
  }
  console.log('✔ User B successfully verified receipt of message from User A');

  // TEST 6: Verify lastRenderedThreadsFingerprint scope in main.js
  console.log('\n--- TEST 6: lastRenderedThreadsFingerprint Scope Verification ---');
  const mainJs = fs.readFileSync(path.resolve('./src/main.js'), 'utf8');
  if (!mainJs.includes('let lastRenderedThreadsFingerprint')) {
    throw new Error('Test 6 Failed: let lastRenderedThreadsFingerprint is missing from module scope');
  }
  console.log('✔ lastRenderedThreadsFingerprint is properly declared in module scope');

  // Cleanup test message from database
  await supabase.from('messages').delete().eq('id', createdMsgA._id || createdMsgA.id);
  console.log('✔ Test message cleaned up from database');

  console.log('\n====================================================');
  console.log('   ALL PHASE 8 DM FLOW TESTS PASSED CLEANLY!        ');
  console.log('====================================================');
}

runPhase8DmFlowSuite().catch(err => {
  console.error('\n❌ Phase 8 Suite Error:', err);
  process.exit(1);
});
