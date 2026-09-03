import jwt from 'jsonwebtoken';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;
const connectionString = 'postgresql://postgres:Ansoceanverse2026@db.fefrlcxctuhdbztyoncs.supabase.co:5432/postgres';
const API_URL = 'http://localhost:3000';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';

// Minimal valid MP4 binary encoded as base64 data URI
const SAMPLE_VIDEO_BASE64 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAAhtZGF0AAAAAA==';
const SAMPLE_IMAGE_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function runPhase6VideoPublishSuite() {
  console.log('====================================================');
  console.log('   RUNNING PHASE 6 VIDEO POST PIPELINE SUITE        ');
  console.log('====================================================\n');

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const profileRes = await client.query(`SELECT id, username, email FROM public.profiles LIMIT 1;`);
  const testUser = profileRes.rows[0];
  console.log('✔ Authenticated User for test:', testUser.username, `(${testUser.id})`);

  const validToken = jwt.sign(
    { id: testUser.id, username: testUser.username, email: testUser.email },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  let createdPostIds = [];

  try {
    // TEST 1: Image Post Publishing
    console.log('\n--- TEST 1: Publish Image Post via POST /api/posts ---');
    const imgRes = await fetch(`${API_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        caption: 'Phase 6 Image Test',
        mediaUrl: SAMPLE_IMAGE_BASE64,
        mediaType: 'image'
      })
    });
    console.log('Image Post HTTP Status:', imgRes.status, '(Expected: 201)');
    const imgData = await imgRes.json();
    const imgPostId = imgData._id || imgData.id;
    const imgMediaUrl = imgData.mediaUrl || imgData.media?.[0]?.media_url;
    console.log('Image Post ID:', imgPostId);
    console.log('Image Media URL:', imgMediaUrl);

    if (imgRes.status !== 201 || !imgPostId) throw new Error('Test 1 Failed: Image post not created');
    createdPostIds.push(imgPostId);
    if (!imgMediaUrl?.startsWith('https://')) {
      throw new Error('Test 1 Failed: Image media URL is not durable HTTPS');
    }

    // TEST 2: Video Post Publishing
    console.log('\n--- TEST 2: Publish Video Post via POST /api/posts ---');
    const vidRes = await fetch(`${API_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        caption: 'Phase 6 Video Test #hubble #tech',
        mediaUrl: SAMPLE_VIDEO_BASE64,
        mediaType: 'video',
        mediaItems: [{ url: SAMPLE_VIDEO_BASE64, type: 'video' }]
      })
    });
    console.log('Video Post HTTP Status:', vidRes.status, '(Expected: 201)');
    const vidData = await vidRes.json();
    const vidPostId = vidData._id || vidData.id;
    const videoDurableUrl = vidData.mediaUrl || vidData.media?.[0]?.media_url;
    console.log('Video Post ID:', vidPostId);
    console.log('Video Durable Storage URL:', videoDurableUrl);

    if (vidRes.status !== 201 || !vidPostId) throw new Error('Test 2 Failed: Video post not created');
    createdPostIds.push(vidPostId);

    if (!videoDurableUrl || !videoDurableUrl.startsWith('https://')) {
      throw new Error(`Test 2 Failed: Video media URL is not durable HTTPS: ${videoDurableUrl}`);
    }
    if (!videoDurableUrl.includes('post-videos')) {
      throw new Error(`Test 2 Failed: Video was not uploaded to 'post-videos' bucket: ${videoDurableUrl}`);
    }
    if (videoDurableUrl.startsWith('blob:') || videoDurableUrl.startsWith('data:')) {
      throw new Error(`Test 2 Failed: Video URL is not persisted in Supabase Storage!`);
    }

    // TEST 3: Feed Query Verification (GET /api/posts)
    console.log('\n--- TEST 3: Feed Query Verification (GET /api/posts) ---');
    const feedRes = await fetch(`${API_URL}/api/posts`);
    const allPosts = await feedRes.json();
    const foundVidPost = allPosts.find(p => (p._id === vidPostId || p.id === vidPostId));
    if (!foundVidPost) throw new Error('Test 3 Failed: Video post was not returned in GET /api/posts');
    console.log('Found Video Post in Feed:');
    console.log('  - ID:', foundVidPost._id);
    console.log('  - Media Type:', foundVidPost.mediaType);
    console.log('  - Media URL:', foundVidPost.mediaUrl);
    if (foundVidPost.mediaType !== 'video') {
      throw new Error(`Test 3 Failed: mediaType expected 'video', got '${foundVidPost.mediaType}'`);
    }

    // TEST 4: Database Storage Verification
    console.log('\n--- TEST 4: Database Direct Verification ---');
    const dbPostRes = await client.query(`SELECT id, author_id, caption FROM public.posts WHERE id = $1;`, [vidPostId]);
    console.log('DB public.posts row:', dbPostRes.rows[0]);
    if (dbPostRes.rows.length === 0) throw new Error('Test 4 Failed: Post row not found in DB');

    const dbMediaRes = await client.query(`SELECT id, post_id, media_url, media_type FROM public.post_media WHERE post_id = $1;`, [vidPostId]);
    console.log('DB public.post_media row:', dbMediaRes.rows[0]);
    if (dbMediaRes.rows.length === 0) throw new Error('Test 4 Failed: Post media row not found in DB');
    if (dbMediaRes.rows[0].media_url.startsWith('blob:')) {
      throw new Error('Test 4 Failed: DB contains a blob URL!');
    }
    if (!dbMediaRes.rows[0].media_url.startsWith('https://')) {
      throw new Error('Test 4 Failed: DB media_url is not durable HTTPS');
    }

    // TEST 5: Rejection of Raw Blob URL
    console.log('\n--- TEST 5: Reject Raw Blob URL Submission ---');
    const blobRes = await fetch(`${API_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        caption: 'Should fail',
        mediaUrl: 'blob:http://localhost:5173/00000000-0000-0000-0000-000000000000',
        mediaType: 'video'
      })
    });
    console.log('Blob Submission Status:', blobRes.status, '(Expected: 400)');
    const blobErr = await blobRes.json();
    console.log('Blob Rejection Response:', blobErr);
    if (blobRes.status !== 400) throw new Error('Test 5 Failed: Expected 400 for blob URL');

    // TEST 6: Unauthenticated Publishing
    console.log('\n--- TEST 6: Unauthenticated Submission Guard ---');
    const unauthRes = await fetch(`${API_URL}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caption: 'Unauth test' })
    });
    console.log('Unauth Status:', unauthRes.status, '(Expected: 401)');
    if (unauthRes.status !== 401) throw new Error('Test 6 Failed: Expected 401');

    console.log('\n====================================================');
    console.log('   ALL PHASE 6 VIDEO POST TESTS PASSED CLEANLY!     ');
    console.log('====================================================');
  } finally {
    for (const pid of createdPostIds) {
      await client.query(`DELETE FROM public.post_media WHERE post_id = $1;`, [pid]);
      await client.query(`DELETE FROM public.posts WHERE id = $1;`, [pid]);
    }
    console.log('✔ Test post records cleaned up from database.');
    await client.end();
  }
}

runPhase6VideoPublishSuite().catch(err => {
  console.error('\n❌ Phase 6 Suite Error:', err);
  process.exit(1);
});
