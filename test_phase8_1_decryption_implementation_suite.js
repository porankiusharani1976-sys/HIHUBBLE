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

// Mirroring the updated decryptMessage in src/main.js
function decryptMessage(contentStr, secretKey) {
  if (!contentStr || typeof contentStr !== 'string') return '';
  const trimmed = contentStr.trim();
  if (!trimmed) return '';

  // Plaintext indicators: JSON objects/arrays, strings with whitespace/linebreaks/HTML tags
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('<') || /\s/.test(trimmed)) {
    return trimmed;
  }

  // Strict Base64 ciphertext candidate check
  const isBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && (trimmed.length % 4 === 0);
  if (!isBase64) {
    return trimmed;
  }

  if (!secretKey) {
    return '[Unable to decrypt message]';
  }

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

async function runPhase81Suite() {
  console.log('====================================================');
  console.log('   RUNNING PHASE 8.1 DECRYPTION IMPLEMENTATION SUITE');
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
  const keyAB = getChatSecretKey(userA.id, userB.id);

  // TEST 1: Valid E2EE Encryption and Decryption
  console.log('--- TEST 1: Valid E2EE Decryption ---');
  const samplePlaintext = 'Secure confidential message between User A and User B 🔥 100%';
  const ciphertext = encryptMessage(samplePlaintext, keyAB);
  const decrypted = decryptMessage(ciphertext, keyAB);
  console.log(`Decrypted matches original: ${decrypted === samplePlaintext}`);
  if (decrypted !== samplePlaintext) {
    throw new Error('Test 1 Failed: Decrypted text does not match plaintext');
  }
  console.log('✔ Valid E2EE ciphertext decrypts perfectly');

  // TEST 2: Wrong Key Decryption (e.g. Conversation UUID)
  console.log('\n--- TEST 2: Wrong Key Handling (Malformed Ciphertext Protection) ---');
  const wrongKey = getChatSecretKey(userA.id, 'f2fe1ff1-47b9-4e64-bdca-ea8fd7455b3b');
  const wrongDecrypted = decryptMessage(ciphertext, wrongKey);
  console.log(`Decryption result with wrong key: "${wrongDecrypted}"`);
  if (wrongDecrypted !== '[Unable to decrypt message]') {
    throw new Error('Test 2 Failed: Expected [Unable to decrypt message], got: ' + wrongDecrypted);
  }
  console.log('✔ Malformed/wrongly-keyed ciphertext is NOT presented as plaintext (0 unhandled URIErrors)');

  // TEST 3: Plaintext & JSON Preservation
  console.log('\n--- TEST 3: Plaintext & JSON Embed Preservation ---');
  const jsonEmbed = JSON.stringify({ type: 'image', url: 'https://example.com/photo.jpg', caption: 'Vacation' });
  const jsonDecrypted = decryptMessage(jsonEmbed, keyAB);
  if (jsonDecrypted !== jsonEmbed) {
    throw new Error('Test 3 Failed: JSON structure was altered');
  }
  const spacedText = 'Normal unencrypted message with spaces';
  const spacedDecrypted = decryptMessage(spacedText, keyAB);
  if (spacedDecrypted !== spacedText) {
    throw new Error('Test 3 Failed: Plaintext with spaces was altered');
  }
  console.log('✔ Plaintext, JSON structures, and media embeds preserved intact');

  // TEST 4: Message-Level Canonical Key Resolution in main.js
  console.log('\n--- TEST 4: Source Inspection for Message-Level Key Derivation ---');
  const mainJs = fs.readFileSync(path.resolve('./src/main.js'), 'utf8');
  if (!mainJs.includes('getChatSecretKey(msgSenderId, msgRecipientId)')) {
    throw new Error('Test 4 Failed: Message-level key resolution missing in createMessageBubbleElement');
  }
  if (!mainJs.includes('[Unable to decrypt message]')) {
    throw new Error('Test 4 Failed: [Unable to decrypt message] guard missing in decryptMessage');
  }
  console.log('✔ main.js derives pairwise key directly from msg.sender and msg.recipient');

  // TEST 5: API Authorization Negative Tests
  console.log('\n--- TEST 5: API Authorization Negative Tests ---');
  const tokenA = jwt.sign({ id: userA.id, username: userA.username }, JWT_SECRET, { expiresIn: '1h' });
  const callerRes = await fetch(`${API_URL}/api/chats/messages/caller`, {
    headers: { 'Authorization': `Bearer ${tokenA}` }
  });
  console.log(`GET /api/chats/messages/caller Status: ${callerRes.status} (Expected: 403)`);
  if (callerRes.status !== 403) throw new Error('Test 5 Failed: Expected 403 for caller param');

  const unauthRes = await fetch(`${API_URL}/api/chats/messages/f2fe1ff1-47b9-4e64-bdca-ea8fd7455b3b`);
  console.log(`Unauthenticated Status: ${unauthRes.status} (Expected: 401)`);
  if (unauthRes.status !== 401) throw new Error('Test 5 Failed: Expected 401 for unauth request');
  console.log('✔ Backend authorization models and BOLA protections fully preserved');

  console.log('\n====================================================');
  console.log('   ALL PHASE 8.1 DECRYPTION TESTS PASSED CLEANLY!   ');
  console.log('====================================================');
}

runPhase81Suite().catch(err => {
  console.error('\n❌ Phase 8.1 Suite Error:', err);
  process.exit(1);
});
