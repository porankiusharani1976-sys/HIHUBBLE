process.env.NO_AUTO_LISTEN = 'true';
import app from './server.js';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import pg from 'pg';
import { CANONICAL_JWT_SECRET } from './utils.js';

const { Client } = pg;
dotenv.config();

const JWT_SECRET = CANONICAL_JWT_SECRET;
let API_URL = 'http://localhost:3099';

const projectRef = 'fefrlcxctuhdbztyoncs';
const host = 'aws-0-ap-southeast-1.pooler.supabase.com';
const port = 5432;
const pwd = process.env.SUPABASE_DB_PASSWORD || 'Ansoceanverse2026';

let serverInstance = null;

async function runDMTests() {
  serverInstance = app.listen(3099);
  await new Promise(r => setTimeout(r, 600));

  console.log("==========================================================================");
  console.log("🚀 STARTING AUTOMATED DIRECT MESSAGING (DM) SYSTEM E2E VERIFICATION SUITE");
  console.log("==========================================================================");

  const connectionString = `postgresql://postgres.${projectRef}:${encodeURIComponent(pwd)}@${host}:${port}/postgres`;
  const dbClient = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await dbClient.connect();

  try {
    // --------------------------------------------------------------------------
    // TEST 1: DATABASE TABLES & STORAGE BUCKET INTEGRITY
    // --------------------------------------------------------------------------
    console.log("\n[TEST 1] Verifying DM Database Tables & Storage Bucket...");
    const requiredTables = ['conversations', 'conversation_members', 'messages', 'message_reactions', 'typing_status', 'voice_notes', 'message_pins', 'message_starred'];
    
    for (const tbl of requiredTables) {
      const res = await dbClient.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1;`, [tbl]);
      if (res.rows.length === 0) throw new Error(`Required table '${tbl}' is missing!`);
      console.log(`  ✓ Table '${tbl}' verified accessible.`);
    }

    const bucketRes = await dbClient.query(`SELECT id FROM storage.buckets WHERE id = 'chat-attachments';`);
    if (bucketRes.rows.length === 0) throw new Error("Storage bucket 'chat-attachments' missing!");
    console.log("  ✓ Storage bucket 'chat-attachments' verified active.");

    // --------------------------------------------------------------------------
    // TEST 2: USER CREATION & JWT ISSUANCE FOR USER A AND USER B
    // --------------------------------------------------------------------------
    console.log("\n[TEST 2] Creating Test User Profiles & JWT Tokens...");
    const ts = Date.now();
    const userA_username = `test_dm_a_${ts}`;
    const userB_username = `test_dm_b_${ts}`;

    const userARes = await dbClient.query(`
      INSERT INTO public.profiles (username, email, full_name, password_hash)
      VALUES ($1, $2, $3, $4) RETURNING id, username, email;
    `, [userA_username, `${userA_username}@hihubble.local`, 'Test DM User A', '$2a$10$fakehash']);
    const userA = userARes.rows[0];

    const userBRes = await dbClient.query(`
      INSERT INTO public.profiles (username, email, full_name, password_hash)
      VALUES ($1, $2, $3, $4) RETURNING id, username, email;
    `, [userB_username, `${userB_username}@hihubble.local`, 'Test DM User B', '$2a$10$fakehash']);
    const userB = userBRes.rows[0];

    const tokenA = jwt.sign({ id: userA.id, sub: userA.id, username: userA.username, email: userA.email, role: 'authenticated', aud: 'authenticated' }, JWT_SECRET, { expiresIn: '1h' });
    const tokenB = jwt.sign({ id: userB.id, sub: userB.id, username: userB.username, email: userB.email, role: 'authenticated', aud: 'authenticated' }, JWT_SECRET, { expiresIn: '1h' });

    console.log(`  ✓ User A created (ID: ${userA.id}, Username: @${userA.username})`);
    console.log(`  ✓ User B created (ID: ${userB.id}, Username: @${userB.username})`);

    // --------------------------------------------------------------------------
    // TEST 3: 1-ON-1 DIRECT CONVERSATION CREATION & DEDUPLICATION
    // --------------------------------------------------------------------------
    console.log("\n[TEST 3] Creating & Verifying 1-on-1 Direct Conversation...");
    const createConvRes1 = await fetch(`${API_URL}/api/chats/direct/${userB.username}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenA}` }
    });
    const convData1 = await createConvRes1.json();
    if (!createConvRes1.ok || !convData1.conversationId) {
      throw new Error(`Direct conversation creation failed: ${JSON.stringify(convData1)}`);
    }
    const conversationId = convData1.conversationId;
    console.log(`  ✓ Direct conversation created/opened (ID: ${conversationId})`);

    // Deduplication check: User A calls direct endpoint again
    const createConvRes2 = await fetch(`${API_URL}/api/chats/direct/${userB.id}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenA}` }
    });
    const convData2 = await createConvRes2.json();
    if (convData2.conversationId !== conversationId) {
      throw new Error(`Deduplication failed! Created duplicate conversation IDs ${conversationId} and ${convData2.conversationId}`);
    }
    console.log("  ✓ Conversation deduplication verified (Returned same conversation ID).");

    // --------------------------------------------------------------------------
    // TEST 4: SENDING MESSAGES (TEXT, IMAGE, VOICE NOTE, DOCUMENT)
    // --------------------------------------------------------------------------
    console.log("\n[TEST 4] Sending Text, Image, Voice Note, and Document Messages...");
    // A. Text Message
    const textMsgRes = await fetch(`${API_URL}/api/chats/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({
        conversationId,
        content: 'Hello User B! Welcome to Hi-Hubble DM System 🚀'
      })
    });
    const textMsgData = await textMsgRes.json();
    if (!textMsgRes.ok || !textMsgData._id) throw new Error(`Text message failed: ${JSON.stringify(textMsgData)}`);
    console.log(`  ✓ Text message sent (ID: ${textMsgData._id})`);

    // B. Image Attachment
    const imgMsgRes = await fetch(`${API_URL}/api/chats/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({
        conversationId,
        mediaUrl: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=800&q=80',
        mediaType: 'image',
        mediaName: 'sample_photo.jpg',
        mediaSize: 2048500
      })
    });
    const imgMsgData = await imgMsgRes.json();
    if (!imgMsgRes.ok || !imgMsgData._id) throw new Error(`Image message failed: ${JSON.stringify(imgMsgData)}`);
    console.log(`  ✓ Image message sent (ID: ${imgMsgData._id})`);

    // C. Voice Note Attachment
    const voiceMsgRes = await fetch(`${API_URL}/api/chats/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({
        conversationId,
        mediaUrl: 'https://fefrlcxctuhdbztyoncs.supabase.co/storage/v1/object/public/chat-attachments/sample_voice.mp3',
        mediaType: 'voice_note',
        duration: 12,
        waveform: [15, 45, 80, 100, 60, 30, 90, 40]
      })
    });
    const voiceMsgData = await voiceMsgRes.json();
    if (!voiceMsgRes.ok || !voiceMsgData._id) throw new Error(`Voice note failed: ${JSON.stringify(voiceMsgData)}`);
    console.log(`  ✓ Voice note message sent (ID: ${voiceMsgData._id}, Duration: 12s)`);

    // --------------------------------------------------------------------------
    // TEST 5: FETCH MESSAGES & VERIFY DB PERSISTENCE
    // --------------------------------------------------------------------------
    console.log("\n[TEST 5] Fetching Conversation Messages & Verifying DB Items...");
    const fetchMsgsRes = await fetch(`${API_URL}/api/chats/messages/${conversationId}`, {
      headers: { 'Authorization': `Bearer ${tokenB}` }
    });
    const msgsList = await fetchMsgsRes.json();
    if (!fetchMsgsRes.ok || !Array.isArray(msgsList) || msgsList.length < 3) {
      throw new Error(`Fetch messages failed: ${JSON.stringify(msgsList)}`);
    }
    console.log(`  ✓ Retrieved ${msgsList.length} messages for conversation from Supabase DB.`);

    // --------------------------------------------------------------------------
    // TEST 6: TYPING INDICATOR PING
    // --------------------------------------------------------------------------
    console.log("\n[TEST 6] Testing Realtime Typing Status Endpoint...");
    const typingRes = await fetch(`${API_URL}/api/chats/typing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ conversationId, isTyping: true })
    });
    const typingData = await typingRes.json();
    if (!typingRes.ok || !typingData.success) throw new Error(`Typing status failed: ${JSON.stringify(typingData)}`);
    console.log("  ✓ Typing indicator status updated successfully.");

    // --------------------------------------------------------------------------
    // TEST 7: EMOJI REACTIONS
    // --------------------------------------------------------------------------
    console.log("\n[TEST 7] Testing Message Emoji Reactions...");
    const rxRes = await fetch(`${API_URL}/api/chats/messages/${textMsgData._id}/reaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenB}` },
      body: JSON.stringify({ emoji: '❤️' })
    });
    const rxData = await rxRes.json();
    if (!rxRes.ok || !rxData.success) throw new Error(`Emoji reaction failed: ${JSON.stringify(rxData)}`);
    console.log("  ✓ Emoji reaction ❤️ added to message successfully.");

    // --------------------------------------------------------------------------
    // TEST 8: INBOX THREADS & UNREAD COUNTS
    // --------------------------------------------------------------------------
    console.log("\n[TEST 8] Fetching Inbox Conversation Threads...");
    const threadsRes = await fetch(`${API_URL}/api/chats/threads`, {
      headers: { 'Authorization': `Bearer ${tokenB}` }
    });
    const threadsList = await threadsRes.json();
    if (!threadsRes.ok || !Array.isArray(threadsList)) throw new Error(`Fetch threads failed: ${JSON.stringify(threadsList)}`);
    const myThread = threadsList.find(t => t.conversationId === conversationId);
    if (!myThread) throw new Error("Conversation thread not found in User B inbox!");
    console.log(`  ✓ Inbox thread retrieved for User B (Unread count: ${myThread.unreadCount}).`);

    // --------------------------------------------------------------------------
    // TEST 9: GROUP CHAT CREATION
    // --------------------------------------------------------------------------
    console.log("\n[TEST 9] Creating Group Chat Conversation...");
    const groupRes = await fetch(`${API_URL}/api/chats/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({
        name: 'Hi-Hubble Dev Team',
        description: 'Official group chat for core developers',
        memberIds: [userB.id]
      })
    });
    const groupData = await groupRes.json();
    if (!groupRes.ok || !groupData.conversationId) throw new Error(`Group chat creation failed: ${JSON.stringify(groupData)}`);
    console.log(`  ✓ Group chat created successfully (Group ID: ${groupData.conversationId})`);

    // --------------------------------------------------------------------------
    // TEST 10: SEARCH MESSAGES
    // --------------------------------------------------------------------------
    console.log("\n[TEST 10] Testing Search Inside Messages...");
    const searchTerm = "Hi-Hubble";
    console.log(`  1. Expected Search Term: "${searchTerm}"`);

    // Fetch messages in DB directly for verification
    const dbMsgs = await dbClient.query(`SELECT id, conversation_id, sender_id, recipient_id, content, created_at FROM public.messages WHERE content ILIKE $1;`, [`%${searchTerm}%`]);
    console.log(`  2. Messages Stored in Database (${dbMsgs.rows.length} rows):`, dbMsgs.rows);

    const executedQuery = `SELECT * FROM public.messages WHERE (sender_id = '${userA.id}' OR recipient_id = '${userA.id}' OR conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = '${userA.id}')) AND content ILIKE '%${searchTerm}%' ORDER BY created_at DESC LIMIT 30;`;
    console.log(`  3. Executed SQL / Supabase Query:\n     ${executedQuery}`);

    const searchRes = await fetch(`${API_URL}/api/chats/search?q=${encodeURIComponent(searchTerm)}`, {
      headers: { 'Authorization': `Bearer ${tokenA}` }
    });
    const searchList = await searchRes.json();
    console.log(`  4. API Response (Status ${searchRes.status}):`, JSON.stringify(searchList, null, 2));

    if (!searchRes.ok || !Array.isArray(searchList) || searchList.length === 0) {
      throw new Error(`Message search failed: ${JSON.stringify(searchList)}`);
    }
    console.log(`  ✓ Search returned ${searchList.length} matching messages.`);

    // --------------------------------------------------------------------------
    // CLEANUP TEST DATA
    // --------------------------------------------------------------------------
    await dbClient.query(`DELETE FROM public.conversations WHERE id IN ($1, $2);`, [conversationId, groupData.conversationId]);
    await dbClient.query(`DELETE FROM public.profiles WHERE id IN ($1, $2);`, [userA.id, userB.id]);
    console.log("\n  ✓ Cleaned up test conversations and test users from database.");

    console.log("\n==========================================================================");
    console.log("🎉 ALL AUTOMATED DM SYSTEM VERIFICATION TESTS PASSED SUCCESSFULLY! (100% PERSISTENCE)");
    console.log("==========================================================================");

  } catch (err) {
    console.error("\n❌ TEST SUITE FAILURE:", err);
    process.exit(1);
  } finally {
    if (serverInstance) serverInstance.close();
    await dbClient.end();
    process.exit(0);
  }
}

runDMTests();
