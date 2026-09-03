import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import pg from 'pg';
import { supabase } from './supabase.js';
import app from './server.js';

dotenv.config();
process.env.NO_AUTO_LISTEN = 'true';

const { Client } = pg;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';
let API_URL = 'http://localhost:3099';

const projectRef = 'fefrlcxctuhdbztyoncs';
const host = 'aws-0-ap-southeast-1.pooler.supabase.com';
const port = 5432;
const pwd = process.env.SUPABASE_DB_PASSWORD || 'Ansoceanverse2026';

let serverInstance = null;

// RC4 Cipher matching client encryption
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
  const utf8SafeStr = unescape(encodeURIComponent(plaintext));
  const encrypted = rc4Cipher(utf8SafeStr, secretKey);
  return Buffer.from(encrypted, 'binary').toString('base64');
}

function decryptMessage(base64str, secretKey) {
  const binaryStr = Buffer.from(base64str, 'base64').toString('binary');
  const decrypted = rc4Cipher(binaryStr, secretKey);
  return decodeURIComponent(escape(decrypted));
}

function getChatSecretKey(userA_Id, userB_Id) {
  return [userA_Id.toString(), userB_Id.toString()].sort().join('_');
}

async function runHubbsReplyDMTestSuite() {
  console.log("==========================================================================");
  console.log("🚀 STARTING HUBBS REPLY → DM INTEGRATION VERIFICATION TEST SUITE");
  console.log("==========================================================================");

  serverInstance = app.listen(3099);
  await new Promise(r => setTimeout(r, 600));

  const ts = Date.now();
  const userA_name = `hubb_author_${ts}`;
  const userB_name = `hubb_replier_${ts}`;

  // 1. Create User A (Story Owner) and User B (Replier)
  console.log("\n[TEST 1] Creating User Profiles & Generating Auth Tokens...");
  const { data: userA, error: errA } = await supabase.from('profiles').insert([{
    username: userA_name,
    email: `${userA_name}@hihubble.local`,
    full_name: 'Alice Hubble',
    password_hash: '$2a$10$fakehash'
  }]).select().single();

  const { data: userB, error: errB } = await supabase.from('profiles').insert([{
    username: userB_name,
    email: `${userB_name}@hihubble.local`,
    full_name: 'Bob Replier',
    password_hash: '$2a$10$fakehash'
  }]).select().single();

  if (errA || errB || !userA || !userB) {
    throw new Error(`User creation failed: ${errA?.message || errB?.message}`);
  }

  const tokenA = jwt.sign(
    { id: userA.id, sub: userA.id, username: userA.username, email: userA.email, role: 'authenticated', aud: 'authenticated' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const tokenB = jwt.sign(
    { id: userB.id, sub: userB.id, username: userB.username, email: userB.email, role: 'authenticated', aud: 'authenticated' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  console.log(`  ✓ User A (Author) created (ID: ${userA.id}, @${userA.username})`);
  console.log(`  ✓ User B (Replier) created (ID: ${userB.id}, @${userB.username})`);

  let story = null;
  let createdConvId = null;

  try {
    // 2. User A creates a HUBB story
    console.log("\n[TEST 2] User A creates a HUBB story...");
    const storyRes = await fetch(`${API_URL}/api/stories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenA}`
      },
      body: JSON.stringify({
        mediaUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&h=600&q=80',
        mediaType: 'image',
        caption: 'Sunset in Santorini! 🌅'
      })
    });

    if (!storyRes.ok) throw new Error(`Story creation failed: ${await storyRes.text()}`);
    story = await storyRes.json();
    const storyId = story.id || story._id;
    console.log(`  ✓ HUBB story published successfully (Story ID: ${storyId})`);

    // 3. User B replies to User A's HUBB
    console.log("\n[TEST 3] User B submits a reply to User A's HUBB...");
    const secretKey = getChatSecretKey(userB.id, userA.id);
    const replyText = "Stunning view! Where exactly is this? 😍";

    const hubReplyPayload = {
      text: replyText,
      hubType: 'story',
      hubId: storyId,
      storyId: storyId,
      messageType: 'hubbs_reply',
      thumbnail: story.mediaUrl || story.img || '',
      isVideo: false,
      authorName: userA.full_name,
      authorAvatar: userA.profile_image_url || '',
      timestamp: story.createdAt || story.created_at || new Date().toISOString(),
      isReply: true
    };

    const encryptedPayload = encryptMessage(JSON.stringify(hubReplyPayload), secretKey);

    const sendReplyRes = await fetch(`${API_URL}/api/chats/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenB}`
      },
      body: JSON.stringify({
        recipient: userA.id,
        content: encryptedPayload,
        mediaUrl: `story_${storyId}`,
        mediaType: 'hub',
        mediaName: 'HUBB Reply',
        mediaSize: 'Story',
        isStoryReply: true
      })
    });

    if (!sendReplyRes.ok) {
      throw new Error(`Reply message sending failed: ${await sendReplyRes.text()}`);
    }

    const replyMsgData = await sendReplyRes.json();
    createdConvId = replyMsgData.conversationId;
    console.log(`  ✓ Reply sent into DM (Message ID: ${replyMsgData.id}, Conversation ID: ${createdConvId})`);

    if (!createdConvId) throw new Error("Expected conversationId in response!");
    if (replyMsgData.recipient !== userA.id) throw new Error(`Recipient mismatch: expected ${userA.id}, got ${replyMsgData.recipient}`);
    if (replyMsgData.sender !== userB.id) throw new Error(`Sender mismatch: expected ${userB.id}, got ${replyMsgData.sender}`);

    // 4. Verify Message in Database and Decryption
    console.log("\n[TEST 4] Verifying stored message record and metadata integrity...");
    const { data: dbMsg, error: dbMsgErr } = await supabase
      .from('messages')
      .select('*')
      .eq('id', replyMsgData.id)
      .single();

    if (dbMsgErr || !dbMsg) throw new Error(`Message not found in DB: ${dbMsgErr?.message}`);
    if (dbMsg.conversation_id !== createdConvId) throw new Error("DB conversation_id mismatch");
    if (dbMsg.media_url !== `story_${storyId}`) throw new Error(`DB media_url mismatch: expected story_${storyId}, got ${dbMsg.media_url}`);

    const decrypted = decryptMessage(dbMsg.content, secretKey);
    const parsedPayload = JSON.parse(decrypted);

    if (parsedPayload.text !== replyText) throw new Error(`Decrypted text mismatch: expected '${replyText}', got '${parsedPayload.text}'`);
    if (parsedPayload.hubType !== 'story') throw new Error(`hubType mismatch: ${parsedPayload.hubType}`);
    if (parsedPayload.messageType !== 'hubbs_reply') throw new Error(`messageType mismatch: ${parsedPayload.messageType}`);
    console.log(`  ✓ Message successfully decrypted and validated with full HUBBS metadata.`);

    // 5. Verify User A (Receiver) Inbox and Unread Count
    console.log("\n[TEST 5] Checking User A (Receiver) Inbox & Conversation Thread...");
    const threadsResA = await fetch(`${API_URL}/api/chats/threads`, {
      headers: { 'Authorization': `Bearer ${tokenA}` }
    });
    const threadsA = await threadsResA.json();

    const convThreadA = threadsA.find(t => t.conversationId === createdConvId || (t.user && t.user._id === userB.id));
    if (!convThreadA) throw new Error("Conversation thread not found in User A inbox!");
    if (convThreadA.unreadCount !== 1) throw new Error(`Expected unreadCount = 1 for User A, got ${convThreadA.unreadCount}`);
    console.log(`  ✓ User A inbox lists thread with unreadCount: ${convThreadA.unreadCount}`);

    // 6. Test Deduplication: User B sends a second reply to the same user
    console.log("\n[TEST 6] Testing conversation deduplication (second reply)...");
    const reply2Text = "Also, is the weather warm right now? ☀️";
    const hubReply2 = { ...hubReplyPayload, text: reply2Text };
    const encrypted2 = encryptMessage(JSON.stringify(hubReply2), secretKey);

    const sendReplyRes2 = await fetch(`${API_URL}/api/chats/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenB}`
      },
      body: JSON.stringify({
        recipient: userA.id,
        content: encrypted2,
        mediaUrl: `story_${storyId}`,
        mediaType: 'hub',
        mediaName: 'HUBB Reply',
        isStoryReply: true
      })
    });

    const reply2Data = await sendReplyRes2.json();
    if (reply2Data.conversationId !== createdConvId) {
      throw new Error(`Deduplication failed! Expected conversationId ${createdConvId}, but got ${reply2Data.conversationId}`);
    }
    console.log(`  ✓ Deduplication verified: Second reply reused conversation ID ${createdConvId}`);

    // 7. User A reads the conversation
    console.log("\n[TEST 7] User A opens/reads the conversation...");
    const readRes = await fetch(`${API_URL}/api/chats/messages/${createdConvId}`, {
      headers: { 'Authorization': `Bearer ${tokenA}` }
    });
    if (!readRes.ok) throw new Error(`Failed to fetch messages for User A: ${readRes.statusText}`);
    const messagesA = await readRes.json();

    if (!Array.isArray(messagesA) || messagesA.length < 2) {
      throw new Error(`Expected at least 2 messages for User A, got ${messagesA.length}`);
    }
    console.log(`  ✓ User A fetched ${messagesA.length} messages in conversation.`);

    // Verify unread count reset
    const threadsResA2 = await fetch(`${API_URL}/api/chats/threads`, {
      headers: { 'Authorization': `Bearer ${tokenA}` }
    });
    const threadsA2 = await threadsResA2.json();
    const convThreadA2 = threadsA2.find(t => t.conversationId === createdConvId);
    if (convThreadA2 && convThreadA2.unreadCount !== 0) {
      throw new Error(`Expected unreadCount = 0 after reading, got ${convThreadA2.unreadCount}`);
    }
    console.log("  ✓ User A unread count successfully marked as 0 after viewing messages.");

  } finally {
    // 8. Clean up test data
    console.log("\n[CLEANUP] Cleaning up test stories, conversations, and profiles...");
    if (story) {
      await supabase.from('stories').delete().eq('id', story.id || story._id);
    }
    if (createdConvId) {
      await supabase.from('messages').delete().eq('conversation_id', createdConvId);
      await supabase.from('conversation_members').delete().eq('conversation_id', createdConvId);
      await supabase.from('conversations').delete().eq('id', createdConvId);
    }
    await supabase.from('profiles').delete().eq('id', userA.id);
    await supabase.from('profiles').delete().eq('id', userB.id);
    console.log("  ✓ All test data cleaned up successfully.");

    if (serverInstance) {
      serverInstance.close();
    }
  }

  console.log("\n==========================================================================");
  console.log("🎉 ALL HUBBS REPLY → DM INTEGRATION TESTS PASSED PERFECTLY!");
  console.log("==========================================================================");
}

runHubbsReplyDMTestSuite().catch(err => {
  console.error("❌ Test suite failed:", err);
  if (serverInstance) serverInstance.close();
  process.exit(1);
});
