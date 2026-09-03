import jwt from 'jsonwebtoken';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;
const connectionString = 'postgresql://postgres:Ansoceanverse2026@db.fefrlcxctuhdbztyoncs.supabase.co:5432/postgres';
const API_URL = 'http://localhost:3000';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';

// Tiny 1x1 transparent PNG base64 for testing image uploads
const SAMPLE_IMAGE_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Tiny valid MP4 mock buffer for video upload testing (32 bytes header + padding to >1KB)
const SAMPLE_VIDEO_BASE64 = 'data:video/mp4;base64,' + Buffer.alloc(1200, 0xAA).toString('base64');

async function runPhase4StoragePublishingSuite() {
  console.log('====================================================');
  console.log('   RUNNING PHASE 4 STORAGE & PUBLISHING TEST SUITE  ');
  console.log('====================================================\n');

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // 1. Fetch real test profile
  const profileRes = await client.query(`SELECT id, username, email FROM public.profiles LIMIT 1;`);
  if (profileRes.rows.length === 0) throw new Error('No profile found in public.profiles');
  const testUser = profileRes.rows[0];
  console.log('✔ Authenticated User for tests:', testUser.username, `(${testUser.id})`);

  const validToken = jwt.sign(
    { id: testUser.id, username: testUser.username, email: testUser.email },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const createdPostIds = [];
  const createdStoryIds = [];
  const createdReelIds = [];

  try {
    // TEST 1: Post with Image (base64 upload to Supabase Storage)
    console.log('\n--- TEST 1: Post with Image (base64) ---');
    const res1 = await fetch(`${API_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        caption: 'Phase 4 Automated Verification Post',
        mediaUrl: SAMPLE_IMAGE_BASE64,
        mediaType: 'image'
      })
    });
    console.log('Status:', res1.status, '(Expected: 201)');
    const postData1 = await res1.json();
    console.log('Post ID:', postData1.id || postData1._id);
    if (res1.status !== 201 || !postData1) throw new Error(`TEST 1 Failed: Expected 201, got ${res1.status}`);

    const postId1 = postData1.id || postData1._id;
    createdPostIds.push(postId1);

    // Verify DB record
    const dbPost1 = await client.query(`SELECT * FROM public.posts WHERE id = $1;`, [postId1]);
    const dbMedia1 = await client.query(`SELECT * FROM public.post_media WHERE post_id = $1;`, [postId1]);
    console.log('Post DB Record:', dbPost1.rows[0]?.id);
    console.log('Post Media DB Record:', dbMedia1.rows[0]?.media_url);

    if (!dbMedia1.rows[0] || !dbMedia1.rows[0].media_url.startsWith('https://')) {
      throw new Error(`TEST 1 Failed: Media URL must be durable HTTPS URL, got ${dbMedia1.rows[0]?.media_url}`);
    }
    if (dbMedia1.rows[0].media_url.startsWith('blob:')) {
      throw new Error(`TEST 1 Failed: Blob URL persisted into database!`);
    }

    // TEST 2: Post with Blob URL (Must be strictly rejected)
    console.log('\n--- TEST 2: Post with Blob URL Rejection ---');
    const res2 = await fetch(`${API_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        caption: 'Invalid Blob Post',
        mediaUrl: 'blob:http://localhost:5173/00000000-0000-0000-0000-000000000000',
        mediaType: 'image'
      })
    });
    console.log('Status:', res2.status, '(Expected: 400)');
    const body2 = await res2.json();
    console.log('Response:', body2);
    if (res2.status !== 400 || !body2.error) throw new Error(`TEST 2 Failed: Expected 400 error`);

    // Verify no post created in DB with that caption
    const checkBlobPost = await client.query(`SELECT count(*) FROM public.posts WHERE caption = 'Invalid Blob Post';`);
    if (parseInt(checkBlobPost.rows[0].count, 10) > 0) throw new Error(`TEST 2 Failed: Post with blob URL was inserted!`);

    // TEST 3: Story with Image (base64)
    console.log('\n--- TEST 3: Story with Image (base64) ---');
    const res3 = await fetch(`${API_URL}/api/stories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        caption: 'Phase 4 Story Test',
        mediaUrl: SAMPLE_IMAGE_BASE64,
        mediaType: 'image'
      })
    });
    console.log('Status:', res3.status, '(Expected: 201)');
    const storyData3 = await res3.json();
    console.log('Story ID:', storyData3.id);
    if (res3.status !== 201 || !storyData3.id) throw new Error(`TEST 3 Failed`);
    createdStoryIds.push(storyData3.id);

    const dbStory3 = await client.query(`SELECT * FROM public.stories WHERE id = $1;`, [storyData3.id]);
    console.log('Story DB media_url:', dbStory3.rows[0]?.media_url);
    if (!dbStory3.rows[0]?.media_url?.startsWith('https://')) {
      throw new Error(`TEST 3 Failed: Story media_url must be durable HTTPS storage URL`);
    }

    // TEST 4: Story with Blob URL (Must be strictly rejected)
    console.log('\n--- TEST 4: Story with Blob URL Rejection ---');
    const res4 = await fetch(`${API_URL}/api/stories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        caption: 'Invalid Blob Story',
        mediaUrl: 'blob:http://localhost:5173/story-fake-blob-1234',
        mediaType: 'image'
      })
    });
    console.log('Status:', res4.status, '(Expected: 400)');
    const body4 = await res4.json();
    console.log('Response:', body4);
    if (res4.status !== 400 || !body4.error) throw new Error(`TEST 4 Failed`);

    // TEST 5: Reel Creation with Video (base64)
    console.log('\n--- TEST 5: Reel Creation with Video (base64) ---');
    const res5 = await fetch(`${API_URL}/api/reels`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        caption: 'Phase 4 Reel Test',
        videoUrl: SAMPLE_VIDEO_BASE64,
        durationSeconds: 15,
        audioTrackName: 'Original Audio'
      })
    });
    console.log('Status:', res5.status, '(Expected: 201)');
    const reelData5 = await res5.json();
    console.log('Reel ID:', reelData5.id);
    if (res5.status !== 201 || !reelData5.id) throw new Error(`TEST 5 Failed: Expected 201, got ${res5.status}`);
    createdReelIds.push(reelData5.id);

    const dbReel5 = await client.query(`SELECT * FROM public.reels WHERE id = $1;`, [reelData5.id]);
    console.log('Reel DB video_url:', dbReel5.rows[0]?.video_url);
    if (!dbReel5.rows[0]?.video_url?.startsWith('https://')) {
      throw new Error(`TEST 5 Failed: Reel video_url must be durable HTTPS storage URL`);
    }

    // TEST 6: Reel with Blob URL (Must be strictly rejected)
    console.log('\n--- TEST 6: Reel with Blob URL Rejection ---');
    const res6 = await fetch(`${API_URL}/api/reels`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        caption: 'Invalid Blob Reel',
        videoUrl: 'blob:http://localhost:5173/fake-reel-blob-9999',
        durationSeconds: 10
      })
    });
    console.log('Status:', res6.status, '(Expected: 400)');
    const body6 = await res6.json();
    console.log('Response:', body6);
    if (res6.status !== 400 || !body6.error) throw new Error(`TEST 6 Failed`);

    // TEST 7: Unauthenticated Publishing Attempt
    console.log('\n--- TEST 7: Unauthenticated Publishing Attempt ---');
    const res7 = await fetch(`${API_URL}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caption: 'Unauthenticated post attempt' })
    });
    console.log('Status:', res7.status, '(Expected: 401)');
    if (res7.status !== 401) throw new Error(`TEST 7 Failed: Expected 401, got ${res7.status}`);

    // TEST 8: Spoofed userId Ownership Guard
    console.log('\n--- TEST 8: Spoofed userId Ownership Guard ---');
    const spoofedUserId = '00000000-0000-4000-8000-000000000000';
    const res8 = await fetch(`${API_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        caption: 'Ownership Verification Post',
        userId: spoofedUserId, // Client attempts to spoof author
        mediaUrl: SAMPLE_IMAGE_BASE64,
        mediaType: 'image'
      })
    });
    console.log('Status:', res8.status, '(Expected: 201)');
    const postData8 = await res8.json();
    const postId8 = postData8.id || postData8._id;
    createdPostIds.push(postId8);

    const dbPost8 = await client.query(`SELECT author_id FROM public.posts WHERE id = $1;`, [postId8]);
    console.log('Actual author_id in DB:', dbPost8.rows[0]?.author_id, '(Expected matching JWT ID:', testUser.id, ')');
    if (dbPost8.rows[0]?.author_id !== testUser.id) {
      throw new Error(`TEST 8 Failed: Author ID was spoofed from body instead of req.user.id!`);
    }

    console.log('\n====================================================');
    console.log('   ALL 8 PHASE 4 STORAGE & PUBLISHING TESTS PASSED! ');
    console.log('====================================================');
  } finally {
    // Clean up created test items
    for (const pid of createdPostIds) {
      await client.query(`DELETE FROM public.post_media WHERE post_id = $1;`, [pid]);
      await client.query(`DELETE FROM public.posts WHERE id = $1;`, [pid]);
    }
    for (const sid of createdStoryIds) {
      await client.query(`DELETE FROM public.story_media WHERE story_id = $1;`, [sid]);
      await client.query(`DELETE FROM public.stories WHERE id = $1;`, [sid]);
    }
    for (const rid of createdReelIds) {
      await client.query(`DELETE FROM public.reels WHERE id = $1;`, [rid]);
    }
    await client.end();
    console.log('\n✔ Test post/story/reel records cleaned up.');
  }
}

runPhase4StoragePublishingSuite().catch((err) => {
  console.error('\n❌ Phase 4 Suite Error:', err);
  process.exit(1);
});
