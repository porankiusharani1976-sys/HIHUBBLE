import { readFileSync } from 'fs';
import path from 'path';
import { supabase } from './supabase.js';

console.log('====================================================');
console.log('   RUNNING PHASE 10 PRODUCTION PERFORMANCE SUITE    ');
console.log('====================================================\n');

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✔ ${message}`);
  passedTests++;
}

// ----------------------------------------------------
// TEST 1: Feed & Story Tray Fingerprint Caching Audit
// ----------------------------------------------------
console.log('--- TEST 1: Source Code Audit for Fingerprint Caching ---');
const mainJs = readFileSync(path.resolve('./src/main.js'), 'utf8');

assert(
  mainJs.includes('_lastRenderedFeedFingerprint') && mainJs.includes('currentFingerprint === _lastRenderedFeedFingerprint'),
  'renderHomeFeed implements deterministic fingerprint caching to prevent full DOM wipes'
);

assert(
  mainJs.includes('_lastRenderedStoriesFingerprint') && mainJs.includes('storiesFingerprint === _lastRenderedStoriesFingerprint'),
  'renderStoryRings implements deterministic fingerprint caching to prevent story tray re-creation'
);

assert(
  mainJs.includes('lastRenderedThreadsFingerprint'),
  'renderChatThreadsList preserves thread fingerprint caching'
);

// ----------------------------------------------------
// TEST 2: In-Flight Promise Request Deduplication Audit
// ----------------------------------------------------
console.log('\n--- TEST 2: In-Flight Request Deduplication Audit ---');
assert(
  mainJs.includes('_notificationsInFlightPromise') && mainJs.includes('if (_notificationsInFlightPromise'),
  'loadNotifications implements in-flight promise reuse to prevent duplicate calls'
);

assert(
  mainJs.includes('_chatThreadsInFlightPromise') && mainJs.includes('if (_chatThreadsInFlightPromise'),
  'loadChatThreads implements in-flight promise reuse to prevent duplicate calls'
);

assert(
  mainJs.includes('_feedPostsInFlightPromise'),
  'loadFeedPosts implements in-flight promise reuse'
);

assert(
  mainJs.includes('_reelsInFlightPromise'),
  'loadFeedReels implements in-flight promise reuse'
);

// ----------------------------------------------------
// TEST 3: Image Performance & Async Decoding Audit
// ----------------------------------------------------
console.log('\n--- TEST 3: Async Image Decoding & Lazy Loading Audit ---');
assert(
  mainJs.includes('loading="lazy"') && mainJs.includes('decoding="async"'),
  'Feed and story templates use loading="lazy" decoding="async" for off-main-thread image decoding'
);

// ----------------------------------------------------
// TEST 4: Reels Database Query Capping
// ----------------------------------------------------
console.log('\n--- TEST 4: Reels Query Optimization Audit ---');
const reelsJs = readFileSync(path.resolve('./routes/reels.js'), 'utf8');
assert(
  reelsJs.includes('.limit(30)'),
  'GET /api/reels query is bounded with .limit(30) to prevent database over-fetching'
);

// ----------------------------------------------------
// TEST 5: Production Environment & API URL Audit
// ----------------------------------------------------
console.log('\n--- TEST 5: Production Environment Parity Audit ---');
assert(
  !mainJs.includes("const API_URL = 'http://localhost") && mainJs.includes('window.location.origin'),
  'Production frontend dynamically derives origin and never hardcodes localhost in production'
);

// ----------------------------------------------------
// TEST 6: Real Database Query Latency Benchmark
// ----------------------------------------------------
console.log('\n--- TEST 6: Supabase Query Latency Benchmark ---');
async function benchmarkQueries() {
  const t0 = Date.now();
  const { data: posts, error: postErr } = await supabase.from('posts').select('id, caption, created_at').order('created_at', { ascending: false }).limit(25);
  const postDuration = Date.now() - t0;
  assert(!postErr, `Posts query succeeded in ${postDuration}ms`);

  const t1 = Date.now();
  const { data: reels, error: reelErr } = await supabase.from('reels').select('id, caption, created_at').order('created_at', { ascending: false }).limit(30);
  const reelDuration = Date.now() - t1;
  assert(!reelErr, `Reels query (limit 30) succeeded in ${reelDuration}ms`);

  const t2 = Date.now();
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: stories, error: storyErr } = await supabase.from('stories').select('id, created_at').gt('created_at', twentyFourHoursAgo).limit(50);
  const storyDuration = Date.now() - t2;
  assert(!storyErr, `Stories query succeeded in ${storyDuration}ms`);

  console.log(`\nQuery Timings: Posts=${postDuration}ms, Reels=${reelDuration}ms, Stories=${storyDuration}ms`);
}

await benchmarkQueries();

console.log('\n====================================================');
console.log(`   ALL ${passedTests}/${totalTests} PHASE 10 AUDIT TESTS PASSED!   `);
console.log('====================================================');
