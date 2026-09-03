import jwt from 'jsonwebtoken';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;
const connectionString = 'postgresql://postgres:Ansoceanverse2026@db.fefrlcxctuhdbztyoncs.supabase.co:5432/postgres';
const API_URL = 'http://localhost:3000';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';

const SAMPLE_IMAGE_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function runPhase41ForensicSuite() {
  console.log('====================================================');
  console.log('   RUNNING PHASE 4.1 FORENSIC STORY & BLOB SUITE    ');
  console.log('====================================================\n');

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // 1. Fetch test profile
  const profileRes = await client.query(`SELECT id, username, email, full_name, profile_image_url FROM public.profiles LIMIT 1;`);
  if (profileRes.rows.length === 0) throw new Error('No profile found in public.profiles');
  const testUser = profileRes.rows[0];
  console.log('✔ Authenticated User for tests:', testUser.username, `(${testUser.id})`);

  const validToken = jwt.sign(
    { id: testUser.id, username: testUser.username, email: testUser.email },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  let createdStoryId = null;

  try {
    // 2. Publish a real Story
    console.log('\n--- STEP 1: Publish New Story via POST /api/stories ---');
    const res = await fetch(`${API_URL}/api/stories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        caption: 'Phase 4.1 Automated Forensic Story',
        mediaUrl: SAMPLE_IMAGE_BASE64,
        mediaType: 'image'
      })
    });

    console.log('HTTP Status:', res.status, '(Expected: 201)');
    const storyData = await res.json();
    console.log('Story ID:', storyData.id || storyData._id);
    console.log('Story Media URL:', storyData.mediaUrl);

    if (res.status !== 201 || !storyData.id) {
      throw new Error(`Step 1 Failed: Expected 201, got ${res.status}`);
    }
    createdStoryId = storyData.id;

    // Verify media URL is durable HTTPS
    if (!storyData.mediaUrl || !storyData.mediaUrl.startsWith('https://')) {
      throw new Error(`Step 1 Failed: mediaUrl is not durable HTTPS: ${storyData.mediaUrl}`);
    }
    if (storyData.mediaUrl.startsWith('blob:')) {
      throw new Error(`Step 1 Failed: mediaUrl is a blob URL!`);
    }

    // 3. Database Check
    console.log('\n--- STEP 2: Database Record Verification ---');
    const dbStory = await client.query(`SELECT * FROM public.stories WHERE id = $1;`, [createdStoryId]);
    console.log('DB stories row:', dbStory.rows[0]?.id, '| media_url:', dbStory.rows[0]?.media_url);
    if (dbStory.rows.length === 0) throw new Error('Step 2 Failed: Story not found in DB.');
    if (!dbStory.rows[0].media_url.startsWith('https://')) {
      throw new Error('Step 2 Failed: DB media_url is not durable HTTPS.');
    }

    const dbMedia = await client.query(`SELECT * FROM public.story_media WHERE story_id = $1;`, [createdStoryId]);
    console.log('DB story_media count:', dbMedia.rows.length, '| media_url:', dbMedia.rows[0]?.media_url);
    if (dbMedia.rows.length > 0 && !dbMedia.rows[0].media_url.startsWith('https://')) {
      throw new Error('Step 2 Failed: DB story_media media_url is not durable HTTPS.');
    }

    // 4. GET /api/stories Endpoint Verification (loadStories simulation)
    console.log('\n--- STEP 3: GET /api/stories Verification (loadStories) ---');
    const getRes = await fetch(`${API_URL}/api/stories`, {
      headers: { 'Authorization': `Bearer ${validToken}` }
    });
    console.log('GET /api/stories Status:', getRes.status, '(Expected: 200)');
    const allStories = await getRes.json();
    console.log('Total Active Stories Count:', allStories.length);

    const foundStory = allStories.find(s => s.id === createdStoryId || s._id === createdStoryId);
    if (!foundStory) {
      throw new Error(`Step 3 Failed: Created story ${createdStoryId} was NOT returned by GET /api/stories!`);
    }
    console.log('✔ Found Created Story in GET /api/stories:');
    console.log('  - ID:', foundStory.id || foundStory._id);
    console.log('  - Author ID:', foundStory.author?.id || foundStory.author?._id);
    console.log('  - Media URL:', foundStory.mediaUrl);
    console.log('  - Created At:', foundStory.createdAt);

    // 5. Check GET /api/posts for any residual blob URLs
    console.log('\n--- STEP 4: GET /api/posts Sanitization Check ---');
    const postsRes = await fetch(`${API_URL}/api/posts`);
    const allPosts = await postsRes.json();
    let blobUrlCount = 0;
    allPosts.forEach(p => {
      if (p.mediaUrl && p.mediaUrl.startsWith('blob:')) blobUrlCount++;
      (p.mediaItems || []).forEach(m => {
        if (m.url && m.url.startsWith('blob:')) blobUrlCount++;
      });
    });
    console.log('Total Posts Fetched:', allPosts.length);
    console.log('Blob URLs in Posts response:', blobUrlCount, '(Expected: 0)');
    if (blobUrlCount > 0) {
      throw new Error(`Step 4 Failed: GET /api/posts returned ${blobUrlCount} blob URLs!`);
    }

    console.log('\n====================================================');
    console.log('   ALL PHASE 4.1 FORENSIC CHECKS PASSED CLEANLY!    ');
    console.log('====================================================');
  } finally {
    if (createdStoryId) {
      await client.query(`DELETE FROM public.story_media WHERE story_id = $1;`, [createdStoryId]);
      await client.query(`DELETE FROM public.stories WHERE id = $1;`, [createdStoryId]);
      console.log('\n✔ Test story record cleaned up.');
    }
    await client.end();
  }
}

runPhase41ForensicSuite().catch(err => {
  console.error('\n❌ Phase 4.1 Suite Error:', err);
  process.exit(1);
});
