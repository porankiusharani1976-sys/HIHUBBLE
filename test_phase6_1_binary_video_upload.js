import jwt from 'jsonwebtoken';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;
const connectionString = 'postgresql://postgres:Ansoceanverse2026@db.fefrlcxctuhdbztyoncs.supabase.co:5432/postgres';
const API_URL = 'http://localhost:3000';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';

// Minimal valid MP4 binary buffer (zero Base64 in HTTP transmission)
const SAMPLE_MP4_BUFFER = Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAAhtZGF0AAAAAA==', 'base64');

async function runPhase61BinarySuite() {
  console.log('====================================================');
  console.log('   RUNNING PHASE 6.1 BINARY VIDEO UPLOAD SUITE      ');
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

  let uploadedStoragePath = null;
  let createdPostId = null;

  try {
    // TEST 1: Direct Binary Streaming Upload via POST /api/upload
    console.log('\n--- TEST 1: Direct Binary Video Upload (POST /api/upload) ---');
    const uploadRes = await fetch(`${API_URL}/api/upload?type=video&ext=mp4`, {
      method: 'POST',
      headers: {
        'Content-Type': 'video/mp4',
        'Authorization': `Bearer ${validToken}`
      },
      body: SAMPLE_MP4_BUFFER // Raw binary stream! No Base64 in request!
    });

    console.log('Upload HTTP Status:', uploadRes.status, '(Expected: 201)');
    const uploadData = await uploadRes.json();
    console.log('Upload Response:', uploadData);

    if (uploadRes.status !== 201 || !uploadData.url) {
      throw new Error(`Test 1 Failed: Binary upload failed with status ${uploadRes.status}`);
    }

    uploadedStoragePath = uploadData.storagePath;
    const durableVideoUrl = uploadData.url;

    if (!durableVideoUrl.startsWith('https://')) {
      throw new Error(`Test 1 Failed: Returned URL is not durable HTTPS: ${durableVideoUrl}`);
    }
    if (!durableVideoUrl.includes('post-videos')) {
      throw new Error(`Test 1 Failed: Upload did not store in 'post-videos' bucket: ${durableVideoUrl}`);
    }
    if (durableVideoUrl.startsWith('blob:') || durableVideoUrl.startsWith('data:')) {
      throw new Error(`Test 1 Failed: Upload returned temporary/local URL!`);
    }

    // TEST 2: Create Post with Durable URL
    console.log('\n--- TEST 2: Create Post with Durable Storage URL (POST /api/posts) ---');
    const postRes = await fetch(`${API_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        caption: 'Phase 6.1 Binary Upload Video Post',
        mediaUrl: durableVideoUrl,
        mediaType: 'video',
        mediaItems: [{ url: durableVideoUrl, type: 'video' }]
      })
    });

    console.log('Post HTTP Status:', postRes.status, '(Expected: 201)');
    const postData = await postRes.json();
    createdPostId = postData._id || postData.id;
    console.log('Created Post ID:', createdPostId);

    if (postRes.status !== 201 || !createdPostId) {
      throw new Error(`Test 2 Failed: Post creation failed with status ${postRes.status}`);
    }

    // TEST 3: Feed Query Verification
    console.log('\n--- TEST 3: Feed Query Verification (GET /api/posts) ---');
    const feedRes = await fetch(`${API_URL}/api/posts`);
    const allPosts = await feedRes.json();
    const foundPost = allPosts.find(p => (p._id === createdPostId || p.id === createdPostId));
    if (!foundPost) throw new Error('Test 3 Failed: Video post was not returned in GET /api/posts');

    console.log('Found Video Post in Feed:');
    console.log('  - ID:', foundPost._id);
    console.log('  - Media Type:', foundPost.mediaType);
    console.log('  - Media URL:', foundPost.mediaUrl);

    // TEST 4: Database Verification
    console.log('\n--- TEST 4: Database Storage Verification ---');
    const dbMedia = await client.query(`SELECT * FROM public.post_media WHERE post_id = $1;`, [createdPostId]);
    console.log('DB public.post_media row:', dbMedia.rows[0]);
    if (dbMedia.rows.length === 0) throw new Error('Test 4 Failed: No post_media row in DB');
    if (!dbMedia.rows[0].media_url.startsWith('https://')) {
      throw new Error('Test 4 Failed: DB media_url is not durable HTTPS');
    }

    // TEST 5: Unauthenticated Binary Upload Guard
    console.log('\n--- TEST 5: Unauthenticated Binary Upload Guard ---');
    const unauthUpload = await fetch(`${API_URL}/api/upload?type=video&ext=mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: SAMPLE_MP4_BUFFER
    });
    console.log('Unauth Status:', unauthUpload.status, '(Expected: 401)');
    if (unauthUpload.status !== 401) throw new Error('Test 5 Failed: Expected 401');

    // TEST 6: Empty Payload Rejection
    console.log('\n--- TEST 6: Empty Binary Payload Guard ---');
    const emptyUpload = await fetch(`${API_URL}/api/upload?type=video&ext=mp4`, {
      method: 'POST',
      headers: {
        'Content-Type': 'video/mp4',
        'Authorization': `Bearer ${validToken}`
      },
      body: Buffer.alloc(0)
    });
    console.log('Empty Upload Status:', emptyUpload.status, '(Expected: 400)');
    if (emptyUpload.status !== 400) throw new Error('Test 6 Failed: Expected 400');

    console.log('\n====================================================');
    console.log('   ALL PHASE 6.1 BINARY UPLOAD TESTS PASSED!        ');
    console.log('====================================================');
  } finally {
    if (createdPostId) {
      await client.query(`DELETE FROM public.post_media WHERE post_id = $1;`, [createdPostId]);
      await client.query(`DELETE FROM public.posts WHERE id = $1;`, [createdPostId]);
      console.log('✔ Test post records cleaned up from database.');
    }
    await client.end();
  }
}

runPhase61BinarySuite().catch(err => {
  console.error('\n❌ Phase 6.1 Suite Error:', err);
  process.exit(1);
});
