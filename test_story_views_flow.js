import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();
process.env.NO_AUTO_LISTEN = 'true';
import app from './server.js';

let API_URL = process.env.PORT ? `http://localhost:${process.env.PORT}` : 'http://localhost:3000';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';

let activeServerInstance = null;

async function ensureServerRunning() {
  const portToUse = 3098;
  activeServerInstance = app.listen(portToUse);
  API_URL = `http://localhost:${portToUse}`;
  await new Promise(r => setTimeout(r, 600));
}

async function runTests() {
  console.log("==========================================================================");
  console.log("🚀 STARTING STORY VIEW / HIGHLIGHT-CIRCLE VERIFICATION SUITE");
  console.log("==========================================================================");

  await ensureServerRunning();

  let testUser = null;
  let testToken = null;
  const createdStoryIds = [];

  try {
    // --------------------------------------------------------------------------
    // STEP 1: AUTHENTICATION
    // --------------------------------------------------------------------------
    console.log("\n[TEST 1] Setting up test user and JWT token...");
    const testUsername = `story_test_${Date.now()}`;
    const testEmail = `${testUsername}@hihubble.local`;

    const { data: profile, error: profErr } = await supabase.from('profiles').insert([{
      username: testUsername,
      email: testEmail,
      full_name: 'Story Tester',
      password_hash: '$2a$10$w8.1Wd91...fakehash'
    }]).select().single();

    if (profErr || !profile) {
      throw new Error(`Failed to create test profile: ${profErr?.message}`);
    }

    testUser = profile;
    testToken = jwt.sign(
      { id: testUser.id, sub: testUser.id, username: testUser.username, email: testUser.email, role: 'authenticated', aud: 'authenticated' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    console.log(`  ✓ Created test user (ID: ${testUser.id})`);

    // --------------------------------------------------------------------------
    // STEP 2: CREATE 3 TEST STORIES (A, B, C)
    // --------------------------------------------------------------------------
    console.log("\n[TEST 2] Creating 3 Test Stories: Story A, Story B, Story C...");
    const storyNames = ['Story A', 'Story B', 'Story C'];
    for (const name of storyNames) {
      const res = await fetch(`${API_URL}/api/stories`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testToken}`
        },
        body: JSON.stringify({
          mediaUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=150&h=150&q=80',
          mediaType: 'image',
          caption: `${name} test caption`
        })
      });
      const data = await res.json();
      if (!res.ok || !data._id) {
        throw new Error(`Failed to create ${name}: ${JSON.stringify(data)}`);
      }
      createdStoryIds.push(data._id);
      console.log(`  ✓ Created ${name} with ID: ${data._id}`);
    }

    const [storyAId, storyBId, storyCId] = createdStoryIds;

    // --------------------------------------------------------------------------
    // STEP 3: VERIFY INITIAL UNVIEWED STATE
    // --------------------------------------------------------------------------
    console.log("\n[TEST 3] Verifying initial unviewed state via GET /api/stories...");
    const getRes1 = await fetch(`${API_URL}/api/stories`, {
      headers: { 'Authorization': `Bearer ${testToken}` }
    });
    const stories1 = await getRes1.json();
    const fetchedA = stories1.find(s => s._id === storyAId);
    const fetchedB = stories1.find(s => s._id === storyBId);
    const fetchedC = stories1.find(s => s._id === storyCId);

    if (fetchedA?.isViewed || fetchedB?.isViewed || fetchedC?.isViewed) {
      throw new Error(`Expected all stories to initially be unviewed, but got: A=${fetchedA?.isViewed}, B=${fetchedB?.isViewed}, C=${fetchedC?.isViewed}`);
    }
    console.log("  ✓ Stories A, B, and C are all unviewed (isViewed: false).");

    // --------------------------------------------------------------------------
    // STEP 4: RECORD VIEW FOR STORY A ONLY (Simulating Click A & Close)
    // --------------------------------------------------------------------------
    console.log("\n[TEST 4] Recording view for Story A (POST /api/stories/:id/view)...");
    const viewARes = await fetch(`${API_URL}/api/stories/${storyAId}/view`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${testToken}` }
    });
    const viewAData = await viewARes.json();
    if (!viewARes.ok || !viewAData.success) {
      throw new Error(`Failed to record view for Story A: ${JSON.stringify(viewAData)}`);
    }
    console.log("  ✓ Successfully recorded view for Story A.");

    const getRes2 = await fetch(`${API_URL}/api/stories`, {
      headers: { 'Authorization': `Bearer ${testToken}` }
    });
    const stories2 = await getRes2.json();
    const fetchedA2 = stories2.find(s => s._id === storyAId);
    const fetchedB2 = stories2.find(s => s._id === storyBId);
    const fetchedC2 = stories2.find(s => s._id === storyCId);

    if (!fetchedA2?.isViewed || fetchedB2?.isViewed || fetchedC2?.isViewed) {
      throw new Error(`Expected ONLY Story A to be viewed, but got: A=${fetchedA2?.isViewed}, B=${fetchedB2?.isViewed}, C=${fetchedC2?.isViewed}`);
    }
    console.log("  ✓ Verified: Story A is viewed (true), Story B is unviewed (false), Story C is unviewed (false).");

    // --------------------------------------------------------------------------
    // STEP 5: RECORD VIEWS FOR B AND C (Simulating Navigation A -> B -> C)
    // --------------------------------------------------------------------------
    console.log("\n[TEST 5] Simulating Next arrow navigation (A -> B -> C) and recording views...");
    const viewBRes = await fetch(`${API_URL}/api/stories/${storyBId}/view`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${testToken}` }
    });
    if (!viewBRes.ok) throw new Error("Failed to record view for Story B");

    const viewCRes = await fetch(`${API_URL}/api/stories/${storyCId}/view`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${testToken}` }
    });
    if (!viewCRes.ok) throw new Error("Failed to record view for Story C");

    const getRes3 = await fetch(`${API_URL}/api/stories`, {
      headers: { 'Authorization': `Bearer ${testToken}` }
    });
    const stories3 = await getRes3.json();
    const fetchedA3 = stories3.find(s => s._id === storyAId);
    const fetchedB3 = stories3.find(s => s._id === storyBId);
    const fetchedC3 = stories3.find(s => s._id === storyCId);

    if (!fetchedA3?.isViewed || !fetchedB3?.isViewed || !fetchedC3?.isViewed) {
      throw new Error(`Expected all A, B, C to be viewed, but got: A=${fetchedA3?.isViewed}, B=${fetchedB3?.isViewed}, C=${fetchedC3?.isViewed}`);
    }
    console.log("  ✓ Verified: All 3 stories (A, B, C) are now viewed (true).");

    // --------------------------------------------------------------------------
    // STEP 6: TEST IDEMPOTENCY & RE-VIEWING
    // --------------------------------------------------------------------------
    console.log("\n[TEST 6] Testing duplicate view recording (idempotency)...");
    const dupRes = await fetch(`${API_URL}/api/stories/${storyAId}/view`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${testToken}` }
    });
    const dupData = await dupRes.json();
    if (!dupRes.ok || !dupData.success) {
      throw new Error(`Duplicate view call failed: ${JSON.stringify(dupData)}`);
    }
    console.log("  ✓ Duplicate view recording completed safely with no database constraint errors.");

    // --------------------------------------------------------------------------
    // STEP 7: FRONTEND LOGIC SIMULATION
    // --------------------------------------------------------------------------
    console.log("\n[TEST 7] Testing Frontend State & Ring Class Simulation Logic...");

    // Simulated LocalStorage & State
    let mockLocalStorage = {};
    function getSeenStoriesSim() {
      try { return JSON.parse(mockLocalStorage['hihubble_seen_stories'] || '[]'); }
      catch (e) { return []; }
    }
    function markStorySeenSim(id) {
      if (!id) return;
      const seen = getSeenStoriesSim();
      if (!seen.includes(id)) {
        seen.push(id);
        mockLocalStorage['hihubble_seen_stories'] = JSON.stringify(seen);
      }
    }

    const testGroups = [
      { authorId: 'userA', name: 'User A', stories: [{ _id: 'storyA' }] },
      { authorId: 'userB', name: 'User B', stories: [{ _id: 'storyB' }] },
      { authorId: 'userC', name: 'User C', stories: [{ _id: 'storyC' }] }
    ];

    function evaluateRingClasses() {
      const seen = getSeenStoriesSim();
      return testGroups.map(group => ({
        name: group.name,
        isSeen: group.stories.every(s => seen.includes(s._id))
      }));
    }

    // Scenario 1: Initial state
    mockLocalStorage = {};
    let rings = evaluateRingClasses();
    if (rings.some(r => r.isSeen)) throw new Error("Expected all rings initially unviewed");
    console.log("  ✓ Frontend Scenario 0 (Initial): All story rings unviewed/highlighted.");

    // Scenario 2: User clicks Story A and closes immediately
    markStorySeenSim('storyA'); // loadStoryContent for Story A
    rings = evaluateRingClasses();
    if (!rings[0].isSeen || rings[1].isSeen || rings[2].isSeen) {
      throw new Error(`Scenario 1 failed: Expected only User A to be seen. Got: ${JSON.stringify(rings)}`);
    }
    console.log("  ✓ Frontend Scenario 1 (Click A & Close): Only User A ring is seen. Users B and C are unviewed.");

    // Scenario 3: User clicks Story A, navigates Next to B, navigates Next to C
    markStorySeenSim('storyB'); // Next arrow to B
    markStorySeenSim('storyC'); // Next arrow to C
    rings = evaluateRingClasses();
    if (!rings[0].isSeen || !rings[1].isSeen || !rings[2].isSeen) {
      throw new Error(`Scenario 2 failed: Expected all A, B, C to be seen. Got: ${JSON.stringify(rings)}`);
    }
    console.log("  ✓ Frontend Scenario 2 (Navigate A -> B -> C): All story rings (A, B, C) are seen/unhighlighted.");

    // Scenario 4: User clicks Story B directly, navigates Next to C
    mockLocalStorage = {};
    markStorySeenSim('storyB'); // Click B
    markStorySeenSim('storyC'); // Next to C
    rings = evaluateRingClasses();
    if (rings[0].isSeen || !rings[1].isSeen || !rings[2].isSeen) {
      throw new Error(`Scenario 3 failed: Expected B and C seen, A unviewed. Got: ${JSON.stringify(rings)}`);
    }
    console.log("  ✓ Frontend Scenario 3 (Click B -> Navigate C): B and C are seen, A remains unviewed.");

    // Scenario 5: User clicks Story C directly
    mockLocalStorage = {};
    markStorySeenSim('storyC'); // Click C
    rings = evaluateRingClasses();
    if (rings[0].isSeen || rings[1].isSeen || !rings[2].isSeen) {
      throw new Error(`Scenario 4 failed: Expected only C seen, A and B unviewed. Got: ${JSON.stringify(rings)}`);
    }
    console.log("  ✓ Frontend Scenario 4 (Click C directly): Only C is seen, A and B remain unviewed.");

    // --------------------------------------------------------------------------
    // STEP 8: OWN USER STORY RENDERING SIMULATION
    // --------------------------------------------------------------------------
    console.log("\n[TEST 8] Testing Logged-In User Own Story Rendering & Strip Behavior...");

    const currentLoggedInUserId = 'userA';

    function renderStoryRingsSim(groups) {
      const seen = getSeenStoriesSim();
      const renderedCards = [];
      let ownProfileIndicator = 'normal'; // 'unviewed_highlight' or 'normal'

      // Check own profile indicator
      const myGroup = groups.find(g => g.authorId === currentLoggedInUserId);
      if (myGroup && myGroup.stories && myGroup.stories.length > 0) {
        const mySeen = myGroup.stories.every(s => seen.includes(s._id));
        ownProfileIndicator = mySeen ? 'normal' : 'unviewed_highlight';
      }

      groups.forEach((group) => {
        if (!group.stories || group.stories.length === 0) return;
        const isSeen = group.stories.every(s => seen.includes(s._id));
        const isOwn = group.authorId === currentLoggedInUserId;

        // If own story has been viewed, it must NOT be rendered in the separate story strip
        if (isOwn && isSeen) return;

        renderedCards.push({
          authorId: group.authorId,
          name: group.name,
          isSeen: isSeen,
          isOwn: isOwn
        });
      });

      return { ownProfileIndicator, renderedCards };
    }

    // Step 8.1: Initial - User A has no stories, other users (B, C) have stories
    mockLocalStorage = {};
    let dynamicGroups = [
      { authorId: 'userB', name: 'User B', stories: [{ _id: 'storyB1' }] },
      { authorId: 'userC', name: 'User C', stories: [{ _id: 'storyC1' }] }
    ];
    let simResult = renderStoryRingsSim(dynamicGroups);
    if (simResult.ownProfileIndicator !== 'normal') throw new Error("Expected own profile to be normal when no own stories");
    if (simResult.renderedCards.length !== 2) throw new Error("Expected 2 other users in story strip");
    console.log("  ✓ Step 8.1: No own stories -> Own profile in normal state, story strip shows other users.");

    // Step 8.2: User A uploads Story A1 (unviewed)
    dynamicGroups.unshift({ authorId: 'userA', name: 'User A', stories: [{ _id: 'storyA1' }] });
    simResult = renderStoryRingsSim(dynamicGroups);
    if (simResult.ownProfileIndicator !== 'unviewed_highlight') throw new Error("Expected own profile to have unviewed highlight");
    console.log("  ✓ Step 8.2: Own Story A1 uploaded -> Own profile circle shows unviewed highlight indicator.");

    // Step 8.3: User A views Story A1 completely and closes viewer
    markStorySeenSim('storyA1');
    simResult = renderStoryRingsSim(dynamicGroups);
    if (simResult.ownProfileIndicator !== 'normal') throw new Error("Expected own profile to return to normal state");
    const ownCardPresent = simResult.renderedCards.some(c => c.authorId === 'userA');
    if (ownCardPresent) throw new Error("Viewed own story must NOT appear as a separate card in story strip");
    if (simResult.renderedCards.length !== 2) throw new Error("Expected 2 cards for other users");
    console.log("  ✓ Step 8.3: Viewed own story A1 -> Own profile returns to normal state, viewed own story is NOT in story strip.");

    // Step 8.4: User A uploads a new Story A2
    dynamicGroups[0].stories.push({ _id: 'storyA2' });
    simResult = renderStoryRingsSim(dynamicGroups);
    if (simResult.ownProfileIndicator !== 'unviewed_highlight') throw new Error("Expected own profile to show unviewed highlight again for Story A2");
    console.log("  ✓ Step 8.4: Upload new Story A2 -> Own profile circle shows unviewed highlight again.");

    // Step 8.5: User A views Story A2
    markStorySeenSim('storyA2');
    simResult = renderStoryRingsSim(dynamicGroups);
    if (simResult.ownProfileIndicator !== 'normal') throw new Error("Expected own profile to return to normal after A2 viewed");
    if (simResult.renderedCards.some(c => c.authorId === 'userA')) throw new Error("Viewed own story must NOT appear in story strip");
    console.log("  ✓ Step 8.5: Viewed Story A2 -> Highlight indicator removed again, no extra circle in story strip.");

    console.log("\n==========================================================================");
    console.log("🎉 ALL STORY VIEW & HIGHLIGHT-CIRCLE TESTS PASSED SUCCESSFULLY!");
    console.log("==========================================================================");

  } catch (err) {
    console.error("\n❌ TEST FAILURE:", err.message);
    process.exitCode = 1;
  } finally {
    // Cleanup created test stories and user
    for (const sId of createdStoryIds) {
      try {
        await supabase.from('stories').delete().eq('id', sId);
      } catch (_) {}
    }
    if (testUser?.id) {
      try {
        await supabase.from('profiles').delete().eq('id', testUser.id);
      } catch (_) {}
    }
    if (activeServerInstance) {
      activeServerInstance.close();
    }
    process.exit(process.exitCode || 0);
  }
}

runTests();
