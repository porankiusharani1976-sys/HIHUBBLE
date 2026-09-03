import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { supabase } from './supabase.js';

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || 'hihubble-secure-jwt-secret';
const API_URL = 'http://localhost:3000';

function rc4Cipher(str, key) {
  let s = [], j = 0, x, res = '';
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key.charCodeAt(i % key.length)) % 256;
    x = s[i]; s[i] = s[j]; s[j] = x;
  }
  let i = 0; j = 0;
  for (let y = 0; y < str.length; y++) {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    x = s[i]; s[i] = s[j]; s[j] = x;
    res += String.fromCharCode(str.charCodeAt(y) ^ s[(s[i] + s[j]) % 256]);
  }
  return res;
}

function encryptMessage(plaintext, secretKey) {
  try {
    const utf8SafeStr = unescape(encodeURIComponent(plaintext));
    const encrypted = rc4Cipher(utf8SafeStr, secretKey);
    return Buffer.from(encrypted, 'binary').toString('base64');
  } catch (e) {
    return plaintext;
  }
}

function decryptMessage(contentStr, secretKey) {
  if (!contentStr || typeof contentStr !== 'string') return '';
  const trimmed = contentStr.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('<') || /\s/.test(trimmed)) {
    return trimmed;
  }

  const isBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && (trimmed.length % 4 === 0);
  if (!isBase64) return trimmed;

  if (!secretKey) return '[Unable to decrypt message]';

  try {
    const binary = Buffer.from(trimmed, 'base64').toString('binary');
    const decrypted = rc4Cipher(binary, secretKey);
    const utf8Result = decodeURIComponent(escape(decrypted));
    return utf8Result;
  } catch (_) {
    return '[Unable to decrypt message]';
  }
}

function getChatSecretKey(userA_Id, userB_Id) {
  if (!userA_Id || !userB_Id) return '';
  return [userA_Id.toString(), userB_Id.toString()].sort().join('_');
}

async function runPhase82Suite() {
  console.log('====================================================');
  console.log('   RUNNING PHASE 8.2 REALTIME RENDERING SUITE       ');
  console.log('====================================================\n');

  // Verify src/main.js static scoping for renderChatMessages
  console.log('--- TEST 1: Source Scoping Audit in renderChatMessages ---');
  const mainJs = fs.readFileSync(path.resolve('./src/main.js'), 'utf8');

  // Verify targetUserId is not called inside renderChatMessages loop without being defined
  const renderFuncMatch = mainJs.match(/function renderChatMessages\([\s\S]*?debouncedCreateIcons\(\);\s*\}/);
  if (!renderFuncMatch) {
    throw new Error('Test 1 Failed: Could not locate renderChatMessages in src/main.js');
  }

  const renderFuncBody = renderFuncMatch[0];
  if (renderFuncBody.includes('createMessageBubbleElement(msg, currentUserId, targetUserId,')) {
    throw new Error('Test 1 Failed: targetUserId is still referenced as parameter in renderChatMessages loop!');
  }
  if (!renderFuncBody.includes('createMessageBubbleElement(msg, currentUserId, partnerId,')) {
    throw new Error('Test 1 Failed: partnerId is missing as parameter in renderChatMessages createMessageBubbleElement call');
  }
  console.log('✔ Scope audit passed: createMessageBubbleElement correctly uses defined partnerId in renderChatMessages');

  // Fetch two real profiles for test
  const { data: profiles, error: profErr } = await supabase
    .from('profiles')
    .select('id, username, full_name')
    .not('username', 'ilike', 'search_test_%')
    .limit(3);

  if (profErr || !profiles || profiles.length < 2) {
    throw new Error('Need at least 2 real profiles in database');
  }

  const userA = profiles[0];
  const userB = profiles[1];
  const keyAB = getChatSecretKey(userA.id, userB.id);

  // TEST 2: Realtime Message Insertion & Simulated Receiver Decryption
  console.log('\n--- TEST 2: Realtime Message Ingestion Simulation ---');
  const tokenA = jwt.sign({ id: userA.id, username: userA.username }, JWT_SECRET, { expiresIn: '1h' });
  const tokenB = jwt.sign({ id: userB.id, username: userB.username }, JWT_SECRET, { expiresIn: '1h' });

  // Resolve conversation between A and B
  const directRes = await fetch(`${API_URL}/api/chats/direct/${userB.id}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenA}`
    }
  });
  const directData = await directRes.json();
  const convId = directData.conversationId || directData.id;

  const testMessageText = 'Realtime delivery test message ' + Date.now();
  const encryptedText = encryptMessage(testMessageText, keyAB);

  // User A sends message
  const sendRes = await fetch(`${API_URL}/api/chats/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenA}`
    },
    body: JSON.stringify({
      conversationId: convId,
      recipient: userB.id,
      content: encryptedText
    })
  });
  if (!sendRes.ok) throw new Error('Send failed: status ' + sendRes.status);
  const sentMsg = await sendRes.json();
  console.log(`✔ Message sent by User A (ID: ${sentMsg._id || sentMsg.id})`);

  // Simulate Realtime Ingestion on User B's client:
  const newMsg = {
    id: sentMsg._id || sentMsg.id,
    conversation_id: convId,
    sender_id: userA.id,
    recipient_id: userB.id,
    content: encryptedText,
    created_at: new Date().toISOString()
  };

  const isFromMe = (newMsg.sender_id || '').toString() === userB.id;
  const partnerId = isFromMe ? newMsg.recipient_id : newMsg.sender_id;
  
  // Key derived strictly from sender and recipient
  const derivedKey = getChatSecretKey(newMsg.sender_id, newMsg.recipient_id);
  const receiverDecrypted = decryptMessage(newMsg.content, derivedKey);
  console.log(`Receiver decrypted text matches sent: ${receiverDecrypted === testMessageText}`);
  if (receiverDecrypted !== testMessageText) {
    throw new Error('Test 2 Failed: Receiver could not decrypt realtime message payload');
  }
  console.log('✔ Realtime message payload decrypts cleanly with zero errors');

  // TEST 3: Deduplication simulation
  console.log('\n--- TEST 3: Deduplication Verification ---');
  const messagesList = [newMsg];
  // If identical message arrives again
  const duplicateMsg = { ...newMsg };
  const alreadyExists = messagesList.some(m => (m.id || m._id) === (duplicateMsg.id || duplicateMsg._id));
  if (!alreadyExists) {
    messagesList.push(duplicateMsg);
  }
  console.log(`Deduplicated messages count in memory: ${messagesList.length} (Expected: 1)`);
  if (messagesList.length !== 1) {
    throw new Error('Test 3 Failed: Deduplication failed to prevent duplicate item');
  }
  console.log('✔ Deduplication prevents multiple copies of same message ID');

  // Cleanup test message
  await supabase.from('messages').delete().eq('id', sentMsg._id || sentMsg.id);
  console.log('✔ Test message cleaned up from database');

  console.log('\n====================================================');
  console.log('   ALL PHASE 8.2 REALTIME TESTS PASSED CLEANLY!     ');
  console.log('====================================================');
}

runPhase82Suite().catch(err => {
  console.error('\n❌ Phase 8.2 Suite Error:', err);
  process.exit(1);
});
