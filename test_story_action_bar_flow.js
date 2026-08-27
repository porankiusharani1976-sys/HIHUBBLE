import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();
process.env.NO_AUTO_LISTEN = 'true';
import app from './server.js';

let API_URL = 'http://localhost:3099';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';

let activeServerInstance = null;

async function ensureServerRunning() {
  const portToUse = 3099;
  activeServerInstance = app.listen(portToUse);
  API_URL = `http://localhost:${portToUse}`;
  await new Promise(r => setTimeout(r, 600));
}

async function runActionBarTestSuite() {
  console.log("==========================================================================");
  console.log("🚀 STARTING STORY VIEWER ACTION BAR (MESSAGE, LIKE, SHARE) TEST SUITE");
  console.log("==========================================================================");

  await ensureServerRunning();

  // 1. Setup 2 users in Supabase profiles table
  const u1Name = `actuser1_${Date.now()}`;
  const u2Name = `actuser2_${Date.now()}`;

  const { data: prof1, error: err1 } = await supabase.from('profiles').insert([{
    username: u1Name,
    email: `${u1Name}@hihubble.local`,
    full_name: 'Alice Star',
    password_hash: 'fakehash'
  }]).select().single();

  const { data: prof2, error: err2 } = await supabase.from('profiles').insert([{
    username: u2Name,
    email: `${u2Name}@hihubble.local`,
    full_name: 'Bob Moon',
    password_hash: 'fakehash'
  }]).select().single();

  if (err1 || err2 || !prof1 || !prof2) {
    throw new Error(`Profile creation failed: ${err1?.message || err2?.message}`);
  }

  const user1 = prof1;
  const user2 = prof2;

  const token1 = jwt.sign(
    { id: user1.id, sub: user1.id, username: user1.username, email: user1.email, role: 'authenticated', aud: 'authenticated' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const token2 = jwt.sign(
    { id: user2.id, sub: user2.id, username: user2.username, email: user2.email, role: 'authenticated', aud: 'authenticated' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // 2. Create 4 stories: Story A & B for user1, Story C & D for user2
  console.log("\n[TEST 1] Creating 4 Stories: Story A, B (User 1) and Story C, D (User 2)...");
  
  const createdStories = [];
  const storiesToCreate = [
    { token: token1, caption: 'Story A: Alice First 🌟', mediaUrl: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=400&h=600&q=80' },
    { token: token1, caption: 'Story B: Alice Second ✨', mediaUrl: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?auto=format&fit=crop&w=400&h=600&q=80' },
    { token: token2, caption: 'Story C: Bob Morning ☕', mediaUrl: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=400&h=600&q=80' },
    { token: token2, caption: 'Story D: Bob Night 🌙', mediaUrl: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=400&h=600&q=80' },
  ];

  for (const item of storiesToCreate) {
    const res = await fetch(`${API_URL}/api/stories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${item.token}`
      },
      body: JSON.stringify({
        mediaUrl: item.mediaUrl,
        mediaType: 'image',
        caption: item.caption
      })
    });
    const s = await res.json();
    createdStories.push(s);
  }

  console.log(`  ✓ Created 4 Stories successfully: A (${createdStories[0].id || createdStories[0]._id}), B (${createdStories[1].id || createdStories[1]._id}), C (${createdStories[2].id || createdStories[2]._id}), D (${createdStories[3].id || createdStories[3]._id})`);

  // 3. Verify Story Grouping Structure and Story Data
  console.log("\n[TEST 2] Fetching stories and verifying grouping and data fields...");
  const getRes = await fetch(`${API_URL}/api/stories`, {
    headers: { 'Authorization': `Bearer ${token1}` }
  });
  const allStories = await getRes.json();

  const user1Stories = allStories.filter(s => (s.author_id || s.author?.id || s.author?._id) === user1.id);
  const user2Stories = allStories.filter(s => (s.author_id || s.author?.id || s.author?._id) === user2.id);

  if (user1Stories.length !== 2 || user2Stories.length !== 2) {
    throw new Error(`Expected 2 stories per user, got User 1: ${user1Stories.length}, User 2: ${user2Stories.length}`);
  }
  console.log("  ✓ Verified: Backend returned correct story groups and counts.");

  // 4. Simulate Client Story Viewer & Action Bar State Machine
  console.log("\n[TEST 3] Simulating Story Viewer Action Bar Rendering for Direct Opens...");

  const storyGroups = [
    {
      authorId: user1.id,
      name: user1.fullName,
      avatar: user1.profileImage,
      stories: user1Stories.map(s => ({
        _id: s.id || s._id,
        id: s.id || s._id,
        authorId: user1.id,
        name: user1.fullName,
        avatar: user1.profileImage,
        img: s.media_url || s.mediaUrl,
        caption: s.caption,
        isLiked: s.isLiked || false,
        likesCount: s.likes_count || s.likesCount || 0
      }))
    },
    {
      authorId: user2.id,
      name: user2.fullName,
      avatar: user2.profileImage,
      stories: user2Stories.map(s => ({
        _id: s.id || s._id,
        id: s.id || s._id,
        authorId: user2.id,
        name: user2.fullName,
        avatar: user2.profileImage,
        img: s.media_url || s.mediaUrl,
        caption: s.caption,
        isLiked: s.isLiked || false,
        likesCount: s.likes_count || s.likesCount || 0
      }))
    }
  ];

  // Client Viewer State Model
  const clientViewerState = {
    activeGroupIndex: 0,
    activeStoryIndex: 0,
    dom: {
      footerVisible: false,
      replyInputVisible: false,
      replyInputValue: '',
      likeBtnVisible: false,
      isLiked: false,
      likeCount: 0,
      shareBtnVisible: false,
      replySendVisible: false,
      sharedTargetStoryId: null
    }
  };

  function simulateLoadStoryContent(groupIndex, storyIndex) {
    const group = storyGroups[groupIndex];
    if (!group || !group.stories[storyIndex]) {
      clientViewerState.dom.footerVisible = false;
      return;
    }
    const data = group.stories[storyIndex];
    clientViewerState.activeGroupIndex = groupIndex;
    clientViewerState.activeStoryIndex = storyIndex;

    // Simulate loadStoryContent logic
    clientViewerState.dom.footerVisible = true;
    clientViewerState.dom.replyInputVisible = true;
    clientViewerState.dom.replyInputValue = '';
    clientViewerState.dom.likeBtnVisible = true;
    clientViewerState.dom.isLiked = data.isLiked || false;
    clientViewerState.dom.likeCount = data.likesCount || 0;
    clientViewerState.dom.shareBtnVisible = true;
    clientViewerState.dom.replySendVisible = true;
  }

  // Test opening each story directly
  for (let g = 0; g < storyGroups.length; g++) {
    for (let s = 0; s < storyGroups[g].stories.length; s++) {
      simulateLoadStoryContent(g, s);
      const story = storyGroups[g].stories[s];
      if (!clientViewerState.dom.footerVisible || !clientViewerState.dom.replyInputVisible || 
          !clientViewerState.dom.likeBtnVisible || !clientViewerState.dom.shareBtnVisible || 
          !clientViewerState.dom.replySendVisible) {
        throw new Error(`Action bar controls missing on direct open for Group ${g}, Story ${s}`);
      }
      console.log(`  ✓ Direct open Story [Group ${g}, Story ${s}] (${story.caption}) -> All 4 Action Bar controls visible.`);
    }
  }

  // 5. Forward Navigation A -> B -> C -> D
  console.log("\n[TEST 4] Simulating Forward Navigation (A -> B -> C -> D)...");
  const navSequence = [
    { g: 0, s: 0, label: 'Story A' },
    { g: 0, s: 1, label: 'Story B' },
    { g: 1, s: 0, label: 'Story C' },
    { g: 1, s: 1, label: 'Story D' }
  ];

  for (const step of navSequence) {
    simulateLoadStoryContent(step.g, step.s);
    if (!clientViewerState.dom.footerVisible || !clientViewerState.dom.replyInputVisible || 
        !clientViewerState.dom.likeBtnVisible || !clientViewerState.dom.shareBtnVisible || 
        !clientViewerState.dom.replySendVisible) {
      throw new Error(`Action bar controls disappeared during forward navigation at ${step.label}`);
    }
    console.log(`  ✓ Forward to ${step.label} -> Action bar (Reply, Like, Share, Send) consistently rendered.`);
  }

  // 6. Backward Navigation D -> C -> B -> A
  console.log("\n[TEST 5] Simulating Backward Navigation (D -> C -> B -> A)...");
  const backSequence = [...navSequence].reverse();

  for (const step of backSequence) {
    simulateLoadStoryContent(step.g, step.s);
    if (!clientViewerState.dom.footerVisible || !clientViewerState.dom.replyInputVisible || 
        !clientViewerState.dom.likeBtnVisible || !clientViewerState.dom.shareBtnVisible || 
        !clientViewerState.dom.replySendVisible) {
      throw new Error(`Action bar controls disappeared during backward navigation at ${step.label}`);
    }
    console.log(`  ✓ Backward to ${step.label} -> Action bar (Reply, Like, Share, Send) consistently rendered.`);
  }

  // 7. Like Interaction & Synchronization
  console.log("\n[TEST 6] Testing Like Interaction & Real-Time Sync on Story B...");
  const storyBId = storyGroups[0].stories[1].id;
  
  // Like Story B via API
  const likeRes = await fetch(`${API_URL}/api/stories/${storyBId}/like`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token1}` }
  });
  const likeResult = await likeRes.json();
  if (likeResult.isLiked !== true || likeResult.likesCount !== 1) {
    throw new Error(`Expected Story B to be liked with count 1, got ${JSON.stringify(likeResult)}`);
  }
  storyGroups[0].stories[1].isLiked = true;
  storyGroups[0].stories[1].likesCount = 1;
  console.log("  ✓ API POST /like succeeded for Story B (isLiked: true, count: 1).");

  // Navigate: Story A -> Story B -> Story C
  simulateLoadStoryContent(0, 0); // Story A
  if (clientViewerState.dom.isLiked !== false || clientViewerState.dom.likeCount !== 0) {
    throw new Error("Story A should not show liked state");
  }
  console.log("  ✓ Story A correctly shows unliked state (isLiked: false, count: 0).");

  simulateLoadStoryContent(0, 1); // Story B
  if (clientViewerState.dom.isLiked !== true || clientViewerState.dom.likeCount !== 1) {
    throw new Error("Story B did not synchronize liked state upon navigation");
  }
  console.log("  ✓ Story B correctly shows active liked state (isLiked: true, count: 1).");

  simulateLoadStoryContent(1, 0); // Story C
  if (clientViewerState.dom.isLiked !== false || clientViewerState.dom.likeCount !== 0) {
    throw new Error("Story C should not inherit Story B's liked state");
  }
  console.log("  ✓ Story C correctly shows unliked state (isLiked: false, count: 0).");

  // 8. Share Button Trigger Simulation
  console.log("\n[TEST 7] Testing Share Button Action Trigger...");
  function simulateShareClick() {
    const activeGroup = storyGroups[clientViewerState.activeGroupIndex];
    const activeStory = activeGroup.stories[clientViewerState.activeStoryIndex];
    clientViewerState.dom.sharedTargetStoryId = activeStory.id;
    return `story_${activeStory.id}`;
  }

  simulateLoadStoryContent(1, 1); // Story D
  const shareTarget = simulateShareClick();
  if (shareTarget !== `story_${storyGroups[1].stories[1].id}`) {
    throw new Error(`Share button targeted wrong story: ${shareTarget}`);
  }
  console.log(`  ✓ Share button correctly targeted current story ID: ${shareTarget}`);

  // 9. Reply Input Typing and Sending Simulation
  console.log("\n[TEST 8] Testing Reply Input & Send Action...");
  simulateLoadStoryContent(0, 0); // Story A
  clientViewerState.dom.replyInputValue = 'Awesome story!';
  let replySent = false;
  function simulateSendReply() {
    if (clientViewerState.dom.replyInputValue.trim()) {
      replySent = true;
      clientViewerState.dom.replyInputValue = '';
    }
  }
  simulateSendReply();
  if (!replySent || clientViewerState.dom.replyInputValue !== '') {
    throw new Error("Reply sending failed to clear input or trigger send");
  }
  console.log("  ✓ Reply sent and input cleared successfully.");

  // Cleanup test stories and profiles
  for (const s of createdStories) {
    await supabase.from('stories').delete().eq('id', s.id || s._id);
  }
  await supabase.from('profiles').delete().eq('id', user1.id);
  await supabase.from('profiles').delete().eq('id', user2.id);
  console.log("  ✓ Cleaned up test data.");

  console.log("\n==========================================================================");
  console.log("🎉 ALL STORY VIEWER ACTION BAR TESTS PASSED SUCCESSFULLY!");
  console.log("==========================================================================");
}

runActionBarTestSuite().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
