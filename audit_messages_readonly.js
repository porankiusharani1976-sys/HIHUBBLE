import 'dotenv/config';
import { supabase } from './supabase.js';

async function auditDatabaseMessages() {
  console.log('====================================================');
  console.log('   PHASE 8.1 READ-ONLY MESSAGE DECRYPTION AUDIT     ');
  console.log('====================================================\n');

  // Fetch the last 20 messages from the database
  const { data: messages, error } = await supabase
    .from('messages')
    .select('id, conversation_id, sender_id, recipient_id, content, media_url, media_type, is_read, created_at')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('Database query error:', error);
    return;
  }

  console.log(`Found ${messages.length} recent messages in database:\n`);

  let countEncrypted = 0;
  let countPlaintext = 0;
  let countJson = 0;
  let countCall = 0;
  let countMedia = 0;
  let countFailedDecryption = 0;

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

  function tryDecrypt(base64str, secretKey) {
    try {
      const decoded = atob(base64str);
      const decrypted = rc4Cipher(decoded, secretKey);
      const unescaped = decodeURIComponent(escape(decrypted));
      return { success: true, length: unescaped.length };
    } catch (e) {
      return { success: false, error: e.name + ': ' + e.message };
    }
  }

  function getChatSecretKey(userA_Id, userB_Id) {
    if (!userA_Id || !userB_Id) return '';
    return [userA_Id.toString(), userB_Id.toString()].sort().join('_');
  }

  messages.forEach((msg, idx) => {
    const rawContent = msg.content || '';
    const secretKey = getChatSecretKey(msg.sender_id, msg.recipient_id);
    const isBase64Pattern = /^[A-Za-z0-9+/=]+$/.test(rawContent) && (rawContent.length % 4 === 0);
    const decResult = rawContent ? tryDecrypt(rawContent, secretKey) : { success: true, length: 0 };

    let category = 'Unknown';
    if (!rawContent) {
      category = 'Empty / Media-Only';
      countMedia++;
    } else if (rawContent.startsWith('{') && rawContent.endsWith('}')) {
      category = 'Plaintext JSON (e.g. Call / System / Reply)';
      countJson++;
    } else if (decResult.success && isBase64Pattern) {
      category = 'Valid E2EE Ciphertext';
      countEncrypted++;
    } else {
      category = 'Plaintext / Unencrypted String';
      countPlaintext++;
      if (!decResult.success) {
        countFailedDecryption++;
      }
    }

    console.log(`[Msg #${idx + 1}] ID: ${msg.id}`);
    console.log(`  - Conv: ${msg.conversation_id}`);
    console.log(`  - Sender/Recipient present: ${!!msg.sender_id} / ${!!msg.recipient_id}`);
    console.log(`  - Media Type: ${msg.media_type || 'none'}`);
    console.log(`  - Content length: ${rawContent.length} chars`);
    console.log(`  - Base64 format match: ${isBase64Pattern}`);
    console.log(`  - Category: ${category}`);
    console.log(`  - Decryption with key: ${decResult.success ? 'SUCCESS' : 'FAILED (' + decResult.error + ')'}`);
    console.log('----------------------------------------------------');
  });

  console.log('\n=== SUMMARY OF RECENT MESSAGES ===');
  console.log(`Total messages audited: ${messages.length}`);
  console.log(`Valid E2EE encrypted messages: ${countEncrypted}`);
  console.log(`Plaintext JSON messages: ${countJson}`);
  console.log(`Plaintext / Legacy strings: ${countPlaintext}`);
  console.log(`Media-only / Empty content: ${countMedia}`);
  console.log(`Messages throwing URIError on decryptMessage(): ${countFailedDecryption}`);
}

auditDatabaseMessages().catch(console.error);
