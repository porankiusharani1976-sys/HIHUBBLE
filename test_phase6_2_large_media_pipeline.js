import jwt from 'jsonwebtoken';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;
const connectionString = 'postgresql://postgres:Ansoceanverse2026@db.fefrlcxctuhdbztyoncs.supabase.co:5432/postgres';
const API_URL = 'http://localhost:3000';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';

// Minimal valid MP4 binary buffer
const SAMPLE_MP4_BUFFER = Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAAhtZGF0AAAAAA==', 'base64');

async function runPhase62LargeMediaSuite() {
  console.log('====================================================');
  console.log('   RUNNING PHASE 6.2 LARGE MEDIA PIPELINE SUITE     ');
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

  let createdPostId = null;
  let storagePathToClean = null;

  try {
    // TEST 1: Request Signed Upload URL (POST /api/upload-url)
    console.log('\n--- TEST 1: Request Signed Upload Authorization (POST /api/upload-url) ---');
    const authRes = await fetch(`${API_URL}/api/upload-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        fileName: 'large_video_sample.mp4',
        fileType: 'video/mp4',
        ext: 'mp4',
        type: 'video'
      })
    });

    console.log('Signed Auth HTTP Status:', authRes.status, '(Expected: 200)');
    const authData = await authRes.json();
    console.log('Signed Auth Response:', {
      success: authData.success,
      bucket: authData.bucket,
      storagePath: authData.storagePath,
      publicUrl: authData.publicUrl,
      signedUrlPrefix: authData.signedUrl ? authData.signedUrl.substring(0, 60) + '...' : null
    });

    if (authRes.status !== 200 || !authData.signedUrl || !authData.publicUrl) {
      throw new Error(`Test 1 Failed: Signed URL generation failed`);
    }

    storagePathToClean = authData.storagePath;

    // TEST 2: Stream Binary File Directly to Supabase Storage CDN (PUT signedUrl)
    console.log('\n--- TEST 2: Direct Streaming Binary Upload to Signed URL (PUT signedUrl) ---');
    const uploadRes = await fetch(authData.signedUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4'
      },
      body: SAMPLE_MP4_BUFFER // Native binary stream direct to CDN
    });

    console.log('Direct Storage Upload Status:', uploadRes.status, '(Expected: 200)');
    if (uploadRes.status !== 200) {
      const errText = await uploadRes.text();
      throw new Error(`Test 2 Failed: Direct storage upload failed: ${uploadRes.status} ${errText}`);
    }

    // TEST 3: Create Post using Durable Public URL
    console.log('\n--- TEST 3: Create Post via POST /api/posts ---');
    const postRes = await fetch(`${API_URL}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        caption: 'Phase 6.2 Signed Large Video Post #speed #quality',
        mediaUrl: authData.publicUrl,
        mediaType: 'video',
        mediaItems: [{ url: authData.publicUrl, type: 'video' }]
      })
    });

    console.log('Post HTTP Status:', postRes.status, '(Expected: 201)');
    const postData = await postRes.json();
    createdPostId = postData._id || postData.id;
    console.log('Created Post ID:', createdPostId);

    if (postRes.status !== 201 || !createdPostId) {
      throw new Error(`Test 3 Failed: Post creation failed with status ${postRes.status}`);
    }

    // TEST 4: Feed Query Verification (GET /api/posts)
    console.log('\n--- TEST 4: Feed Query Verification (GET /api/posts) ---');
    const feedRes = await fetch(`${API_URL}/api/posts`);
    const allPosts = await feedRes.json();
    const foundPost = allPosts.find(p => (p._id === createdPostId || p.id === createdPostId));
    if (!foundPost) throw new Error('Test 4 Failed: Post not found in feed');
    console.log('Found Video Post in Feed:');
    console.log('  - ID:', foundPost._id);
    console.log('  - Media Type:', foundPost.mediaType);
    console.log('  - Media URL:', foundPost.mediaUrl);

    // TEST 5: Database Direct Verification
    console.log('\n--- TEST 5: Database Direct Verification ---');
    const dbMedia = await client.query(`SELECT * FROM public.post_media WHERE post_id = $1;`, [createdPostId]);
    console.log('DB public.post_media row:', dbMedia.rows[0]);
    if (dbMedia.rows.length === 0) throw new Error('Test 5 Failed: No post_media row in DB');
    if (!dbMedia.rows[0].media_url.startsWith('https://')) {
      throw new Error('Test 5 Failed: DB media_url is not durable HTTPS');
    }

    // TEST 6: Unauthenticated Signed URL Guard
    console.log('\n--- TEST 6: Unauthenticated Request Guard ---');
    const unauthRes = await fetch(`${API_URL}/api/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'hack.mp4', fileType: 'video/mp4' })
    });
    console.log('Unauth Status:', unauthRes.status, '(Expected: 401)');
    if (unauthRes.status !== 401) throw new Error('Test 6 Failed: Expected 401');

    console.log('\n====================================================');
    console.log('   ALL PHASE 6.2 LARGE MEDIA TESTS PASSED CLEANLY!  ');
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

runPhase62LargeMediaSuite().catch(err => {
  console.error('\n❌ Phase 6.2 Suite Error:', err);
  process.exit(1);
});
