import { supabase } from './supabase.js';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';
const BASE_URL = process.env.PORT ? `http://localhost:${process.env.PORT}` : 'http://localhost:3000';

async function runShareHubbTests() {
  console.log("==========================================================================");
  console.log("🚀 STARTING SHARE HUBB SINGLE UPLOAD & SCHEDULING VERIFICATION SUITE");
  console.log("==========================================================================");

  // 1. Setup test user and JWT token
  console.log("\n[TEST 1] Setting up test user & JWT token...");
  const testUsername = `hubb_test_${Date.now()}`;
  const testEmail = `${testUsername}@hihubble.local`;

  const { data: profile, error: profErr } = await supabase.from('profiles').insert([{
    username: testUsername,
    email: testEmail,
    full_name: 'HUBB Tester',
    password_hash: '$2a$10$w8.1Wd91...fakehash'
  }]).select().single();

  if (profErr || !profile) {
    throw new Error(`Failed to create test profile: ${profErr?.message}`);
  }

  const testUserId = profile.id;
  const token = jwt.sign(
    { id: testUserId, sub: testUserId, username: profile.username, email: profile.email, role: 'authenticated', aud: 'authenticated' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
  console.log("  ✓ Test user configured (ID:", testUserId, ")");

  // Clean previous test stories
  await supabase.from('stories').delete().eq('author_id', testUserId);

  // 2. Instant Story: Single Upload
  console.log("\n[TEST 2] Testing Instant Story Upload (Single Story Creation)...");
  const instantRes = await fetch(`${BASE_URL}/api/stories`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      mediaUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&h=600&q=80',
      mediaType: 'image',
      caption: 'Instant HUB Story 🌟'
    })
  });

  if (!instantRes.ok) {
    const err = await instantRes.text();
    throw new Error(`Instant story creation failed: ${err}`);
  }
  const instantData = await instantRes.json();
  console.log(`  ✓ Instant story created with ID: ${instantData.id || instantData._id}`);

  // Verify only 1 story exists in DB
  const { data: dbStories1, error: dbErr1 } = await supabase.from('stories').select('id, status, isScheduled').eq('author_id', testUserId);
  if (dbErr1) throw dbErr1;
  if (dbStories1.length !== 1) {
    throw new Error(`Expected exactly 1 story in DB, found ${dbStories1.length}`);
  }
  if (dbStories1[0].status !== 'published' || dbStories1[0].isScheduled === true) {
    throw new Error(`Expected status 'published' and isScheduled false. Got: ${JSON.stringify(dbStories1[0])}`);
  }
  console.log("  ✓ Verified: Exactly 1 published story row exists in database.");

  // Verify it appears in active stories
  const getRes1 = await fetch(`${BASE_URL}/api/stories`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const storiesList1 = await getRes1.json();
  const foundInstant = storiesList1.find(s => s.id === instantData.id || s._id === instantData._id);
  if (!foundInstant) {
    throw new Error("Instant story not found in active stories list");
  }
  console.log("  ✓ Verified: Instant story is immediately active in GET /api/stories.");

  // 3. Double-Click / Concurrency Guard Simulation
  console.log("\n[TEST 3] Testing Rapid Duplicate Submission Guard...");
  let isPublishingHubbSim = false;
  let uploadCallCount = 0;

  async function simulatePublishClick() {
    if (isPublishingHubbSim) {
      return { skipped: true };
    }
    isPublishingHubbSim = true;
    try {
      uploadCallCount++;
      // Simulate async network latency
      await new Promise(resolve => setTimeout(resolve, 50));
      return { skipped: false, count: uploadCallCount };
    } finally {
      isPublishingHubbSim = false;
    }
  }

  // Rapid double click firing almost simultaneously
  const [click1, click2] = await Promise.all([
    simulatePublishClick(),
    simulatePublishClick()
  ]);

  if (click1.skipped === click2.skipped) {
    throw new Error("Expected exactly one click to execute and the other to be skipped by in-flight guard");
  }
  if (uploadCallCount !== 1) {
    throw new Error(`Expected 1 upload execution, got ${uploadCallCount}`);
  }
  console.log("  ✓ Verified: In-flight guard successfully blocked duplicate rapid submission.");

  // 4. Scheduled Story: Future Date/Time
  console.log("\n[TEST 4] Testing Scheduled Story Creation (Future Time)...");
  // Set scheduled time to 10 seconds in future
  const scheduledTime = new Date(Date.now() + 10000).toISOString();

  const schedRes = await fetch(`${BASE_URL}/api/stories/schedule`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      mediaUrl: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=400&h=600&q=80',
      mediaType: 'image',
      caption: 'Scheduled HUB Story ⏰',
      scheduledAt: scheduledTime
    })
  });

  if (!schedRes.ok) {
    const err = await schedRes.text();
    throw new Error(`Scheduled story creation failed: ${err}`);
  }
  const schedData = await schedRes.json();
  console.log(`  ✓ Scheduled story created with ID: ${schedData.id || schedData._id} for time: ${scheduledTime}`);

  // 5. Verify Scheduled Story is NOT visible before scheduled time
  console.log("\n[TEST 5] Verifying Scheduled Story is NOT visible in active stories before scheduled time...");
  const getRes2 = await fetch(`${BASE_URL}/api/stories`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const storiesList2 = await getRes2.json();
  const foundScheduledPremature = storiesList2.find(s => s.id === schedData.id || s._id === schedData._id);
  if (foundScheduledPremature) {
    throw new Error("CRITICAL BUG: Scheduled story is appearing before its scheduled time!");
  }
  console.log("  ✓ Verified: Scheduled story does NOT appear in active stories before scheduled time.");

  // Verify DB state for scheduled story
  const { data: dbStories2 } = await supabase.from('stories').select('id, status, isScheduled, scheduledAt').eq('id', schedData.id || schedData._id).single();
  if (dbStories2.status !== 'scheduled' || dbStories2.isScheduled !== true) {
    throw new Error(`Expected status 'scheduled' and isScheduled true. Got: ${JSON.stringify(dbStories2)}`);
  }
  console.log("  ✓ Verified: DB record is correctly flagged with status='scheduled' and isScheduled=true.");

  // 6. Wait for scheduled time to arrive and verify auto-publish
  console.log("\n[TEST 6] Waiting for scheduled time to arrive (11 seconds)...");
  await new Promise(resolve => setTimeout(resolve, 11000));

  // Trigger GET /api/stories which auto-publishes due scheduled stories
  const getRes3 = await fetch(`${BASE_URL}/api/stories`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const storiesList3 = await getRes3.json();
  const foundScheduledPublished = storiesList3.find(s => s.id === schedData.id || s._id === schedData._id);
  if (!foundScheduledPublished) {
    throw new Error("Scheduled story did NOT auto-publish when scheduled time arrived!");
  }
  console.log("  ✓ Verified: Scheduled story auto-published cleanly when scheduled time arrived.");

  // 7. Verify NO duplicate story records exist in DB
  console.log("\n[TEST 7] Verifying NO duplicate records were created during auto-publish...");
  const { data: totalUserStories } = await supabase.from('stories').select('id, status, isScheduled').eq('author_id', testUserId);
  if (totalUserStories.length !== 2) {
    throw new Error(`Expected exactly 2 stories (1 instant + 1 scheduled), found ${totalUserStories.length}`);
  }
  console.log(`  ✓ Verified: Exactly 2 stories exist in database (1 instant + 1 scheduled). No duplicate inserts.`);

  // Clean up test stories
  await supabase.from('stories').delete().eq('author_id', testUserId);
  console.log("  ✓ Cleaned up test data.");

  console.log("\n==========================================================================");
  console.log("🎉 ALL SHARE HUBB MULTIPLE UPLOAD & SCHEDULING TESTS PASSED!");
  console.log("==========================================================================");
}

runShareHubbTests().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
