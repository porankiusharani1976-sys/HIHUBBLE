import fs from 'fs';
import path from 'path';

async function runPhase7RealtimeSignalingSuite() {
  console.log('====================================================');
  console.log('   RUNNING PHASE 7 REALTIME & SIGNALING TEST SUITE  ');
  console.log('====================================================\n');

  const mainJs = fs.readFileSync(path.resolve('./src/main.js'), 'utf8');
  const audioSignalingJs = fs.readFileSync(path.resolve('./src/audio/audio.signaling.js'), 'utf8');
  const videoSignalingJs = fs.readFileSync(path.resolve('./src/video/video.signaling.js'), 'utf8');

  // TEST 1: Audio Signaling Channel Naming
  console.log('--- TEST 1: Audio Signaling Channel Naming ---');
  if (!audioSignalingJs.includes('user-audio-calls-signaling-${recipientUserId}') ||
      !audioSignalingJs.includes('user-audio-calls-signaling-${userId}')) {
    throw new Error('Test 1 Failed: audio.signaling.js does not use user-audio-calls-signaling');
  }
  if (audioSignalingJs.includes('`user-calls-signaling-')) {
    throw new Error('Test 1 Failed: Old colliding channel name found in audio.signaling.js');
  }
  console.log('✔ Audio Signaling uses isolated channel: user-audio-calls-signaling-${userId}');

  // TEST 2: Video Signaling Channel Naming
  console.log('\n--- TEST 2: Video Signaling Channel Naming ---');
  if (!videoSignalingJs.includes('user-video-calls-signaling-${recipientUserId}') ||
      !videoSignalingJs.includes('user-video-calls-signaling-${userId}')) {
    throw new Error('Test 2 Failed: video.signaling.js does not use user-video-calls-signaling');
  }
  if (videoSignalingJs.includes('`user-calls-signaling-')) {
    throw new Error('Test 2 Failed: Old colliding channel name found in video.signaling.js');
  }
  console.log('✔ Video Signaling uses isolated channel: user-video-calls-signaling-${userId}');

  // TEST 3: Feed Realtime Consolidation (0 duplicate public:feed_realtime)
  console.log('\n--- TEST 3: Consolidated Feed Realtime Subscriptions ---');
  if (mainJs.includes("channel('public:feed_realtime')")) {
    throw new Error('Test 3 Failed: Duplicate public:feed_realtime channel still present in main.js');
  }
  if (!mainJs.includes("channel('public:posts_realtime')")) {
    throw new Error('Test 3 Failed: public:posts_realtime missing in main.js');
  }
  if (!mainJs.includes("table: 'likes'")) {
    throw new Error('Test 3 Failed: likes table subscription missing in consolidated posts_realtime');
  }
  console.log('✔ Duplicate public:feed_realtime eliminated; unified under public:posts_realtime');

  // TEST 4: DM & Notifications Realtime Idempotency Guards
  console.log('\n--- TEST 4: DM & Notifications Lifecycle Idempotency ---');
  if (!mainJs.includes('dmState._subscribedUserId === currentUserId') ||
      !mainJs.includes('notificationsSubscribedUserId === currentUserId')) {
    throw new Error('Test 4 Failed: Idempotency guards missing in setupDMRealtime / setupNotificationsRealtime');
  }
  console.log('✔ Idempotency guards active: duplicate channel teardown/reconnect prevented for same user');

  console.log('\n====================================================');
  console.log('   ALL PHASE 7 REALTIME & SIGNALING TESTS PASSED!   ');
  console.log('====================================================');
}

runPhase7RealtimeSignalingSuite().catch(err => {
  console.error('\n❌ Phase 7 Suite Error:', err);
  process.exit(1);
});
