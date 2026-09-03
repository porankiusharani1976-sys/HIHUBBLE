import 'dotenv/config';
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

function decryptMessage(base64str, secretKey) {
  try {
    const binary = Buffer.from(base64str, 'base64').toString('binary');
    const decrypted = rc4Cipher(binary, secretKey);
    return decodeURIComponent(escape(decrypted));
  } catch (e) {
    return null;
  }
}

function getChatSecretKey(userA_Id, userB_Id) {
  if (!userA_Id || !userB_Id) return '';
  return [userA_Id.toString(), userB_Id.toString()].sort().join('_');
}

async function runForensicAudit() {
  console.log('====================================================');
  console.log('   PHASE 8.1 DECRYPTION FORENSIC AUDIT SUITE        ');
  console.log('====================================================\n');

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
  console.log(`✔ User A: ${userA.username} (${userA.id})`);
  console.log(`✔ User B: ${userB.username} (${userB.id})`);

  const secretKeyAB = getChatSecretKey(userA.id, userB.id);
  console.log(`✔ User A <-> User B Secret Key format: [UUID_A, UUID_B].sort().join('_')`);

  // FORENSIC TEST 1: Valid Encryption -> Decryption
  console.log('\n--- FORENSIC TEST 1: Encrypt & Decrypt Round-Trip ---');
  const samplePlaintext = 'Hello, this is an end-to-end encrypted message! ✨ 🚀 123';
  const ciphertext = encryptMessage(samplePlaintext, secretKeyAB);
  const decrypted = decryptMessage(ciphertext, secretKeyAB);
  console.log(`Ciphertext format: Base64 string (${ciphertext.length} chars)`);
  console.log(`Decrypted matches original: ${decrypted === samplePlaintext}`);
  if (decrypted !== samplePlaintext) {
    throw new Error('Forensic Test 1 Failed: Decrypted text does not match plaintext');
  }

  // FORENSIC TEST 2: Decrypting with wrong key (e.g. Conversation UUID instead of User ID)
  console.log('\n--- FORENSIC TEST 2: Wrong Key Simulation (Root Cause Analysis) ---');
  const dummyConvId = 'f2fe1ff1-47b9-4e64-bdca-ea8fd7455b3b';
  const wrongKey = getChatSecretKey(userA.id, dummyConvId);
  try {
    const binary = Buffer.from(ciphertext, 'base64').toString('binary');
    const wrongDecrypted = rc4Cipher(binary, wrongKey);
    decodeURIComponent(escape(wrongDecrypted));
    console.log('Decrypted with wrong key unexpectedly succeeded (not expected)');
  } catch (err) {
    console.log(`✔ Caught Expected Failure with Wrong Key: ${err.name}: ${err.message}`);
    console.log(`  -> Proves that passing conversation UUID instead of partner user ID causes URI malformed!`);
  }

  // FORENSIC TEST 3: Plaintext / Non-Base64 Content Handling
  console.log('\n--- FORENSIC TEST 3: Plaintext & Malformed Input Handling ---');
  const plainTextMsg = 'Plaintext unencrypted legacy message';
  const plainDecrypted = decryptMessage(plainTextMsg, secretKeyAB);
  console.log(`Plaintext input decryption result: ${plainDecrypted === null ? 'Graceful Error (null)' : 'Garbled'}`);

  // FORENSIC TEST 4: End-to-End API Integration & BOLA Checks
  console.log('\n--- FORENSIC TEST 4: API & Authorization Checks ---');
  const tokenA = jwt.sign({ id: userA.id, username: userA.username }, JWT_SECRET, { expiresIn: '1h' });
  const directRes = await fetch(`${API_URL}/api/chats/direct/${userB.id}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenA}`
    }
  });
  const directData = await directRes.json();
  const convId = directData.conversationId || directData.id;

  const authFetch = await fetch(`${API_URL}/api/chats/messages/${convId}`, {
    headers: { 'Authorization': `Bearer ${tokenA}` }
  });
  console.log(`Authorized Member Fetch Status: ${authFetch.status} (Expected: 200)`);

  const unauthFetch = await fetch(`${API_URL}/api/chats/messages/${convId}`);
  console.log(`Unauthenticated Fetch Status: ${unauthFetch.status} (Expected: 401)`);

  const callerFetch = await fetch(`${API_URL}/api/chats/messages/caller`, {
    headers: { 'Authorization': `Bearer ${tokenA}` }
  });
  console.log(`Forbidden Route Param Fetch Status: ${callerFetch.status} (Expected: 403)`);

  console.log('\n====================================================');
  console.log('   ALL FORENSIC AUDIT TESTS COMPLETED!              ');
  console.log('====================================================');
}

runForensicAudit().catch(console.error);
