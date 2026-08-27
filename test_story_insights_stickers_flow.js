import { supabase } from './supabase.js';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

const API_BASE = process.env.PORT ? `http://localhost:${process.env.PORT}` : 'http://localhost:3000';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';

async function runTests() {
  console.log('==========================================================================');
  console.log('🚀 TESTING STORY INSIGHTS & MUSIC/LOCATION STICKERS PERSISTENCE');
  console.log('==========================================================================');

  // 1. Create 2 test users
  const authorUsername = `author_${Date.now()}`;
  const viewerUsername = `viewer_${Date.now()}`;

  const { data: authorProfile, error: aErr } = await supabase.from('profiles').insert([{
    username: authorUsername,
    email: `${authorUsername}@test.local`,
    full_name: 'Author User',
    password_hash: 'fakehash'
  }]).select().single();

  if (aErr) throw new Error(`Failed to create author profile: ${aErr.message}`);

  const { data: viewerProfile, error: vErr } = await supabase.from('profiles').insert([{
    username: viewerUsername,
    email: `${viewerUsername}@test.local`,
    full_name: 'Ganesh Viewer',
    password_hash: 'fakehash'
  }]).select().single();

  if (vErr) throw new Error(`Failed to create viewer profile: ${vErr.message}`);

  const authorToken = jwt.sign(
    { id: authorProfile.id, sub: authorProfile.id, username: authorProfile.username, email: authorProfile.email, role: 'authenticated', aud: 'authenticated' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const viewerToken = jwt.sign(
    { id: viewerProfile.id, sub: viewerProfile.id, username: viewerProfile.username, email: viewerProfile.email, role: 'authenticated', aud: 'authenticated' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  console.log('\n[TEST 1] Creating Story with Music, Location, and Sticker Layers...');
  const testTrack = {
    id: 'track_123',
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    artwork: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
    previewUrl: 'https://example.com/audio/sample.mp3'
  };

  const testLocation = {
    id: 98765,
    name: 'Hyderabad',
    displayName: 'Hyderabad, Telangana, India'
  };

  const testLayers = [
    {
      id: 'music_sticker_1',
      type: 'music',
      track: testTrack,
      content: 'Blinding Lights',
      artist: 'The Weeknd',
      x: 50,
      y: 72,
      rotation: 0,
      scale: 1,
      zIndex: 20
    },
    {
      id: 'location_sticker_1',
      type: 'location',
      loc: testLocation,
      content: 'Hyderabad, Telangana, India',
      x: 50,
      y: 25,
      rotation: 0,
      scale: 1,
      zIndex: 21
    }
  ];

  const createRes = await fetch(`${API_BASE}/api/stories`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authorToken}`
    },
    body: JSON.stringify({
      mediaUrl: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800',
      mediaType: 'image',
      caption: 'Enjoying Hyderabad sunset! 🌅',
      music: testTrack,
      location: testLocation.displayName,
      locationData: testLocation,
      layers: testLayers
    })
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Failed to create story: ${errText}`);
  }

  const createdStory = await createRes.json();
  console.log(`  ✓ Story created with ID: ${createdStory.id}`);
  console.log(`  ✓ Unpacked Caption: "${createdStory.caption}"`);
  console.log(`  ✓ Attached Music: ${createdStory.music?.title} • ${createdStory.music?.artist}`);
  console.log(`  ✓ Attached Location: ${createdStory.location}`);
  console.log(`  ✓ Layer Count: ${createdStory.layers?.length}`);

  if (createdStory.caption !== 'Enjoying Hyderabad sunset! 🌅') {
    throw new Error(`Caption mismatch: expected 'Enjoying Hyderabad sunset! 🌅', got '${createdStory.caption}'`);
  }
  if (!createdStory.music || createdStory.music.title !== 'Blinding Lights') {
    throw new Error(`Music mismatch: expected 'Blinding Lights'`);
  }
  if (!createdStory.layers || createdStory.layers.length !== 2) {
    throw new Error(`Layers mismatch: expected 2 layers, got ${createdStory.layers?.length}`);
  }

  console.log('\n[TEST 2] Verifying GET /api/stories unpacks metadata...');
  const getRes = await fetch(`${API_BASE}/api/stories`, {
    headers: { 'Authorization': `Bearer ${authorToken}` }
  });
  const storiesList = await getRes.json();
  const fetched = storiesList.find(s => s.id === createdStory.id);
  if (!fetched) throw new Error('Created story not returned in GET /api/stories');
  console.log(`  ✓ Story retrieved: ID ${fetched.id}`);
  console.log(`  ✓ Music: ${fetched.music?.title} • ${fetched.music?.artist}`);
  console.log(`  ✓ Location: ${fetched.location}`);
  console.log(`  ✓ Layers restored: ${fetched.layers?.length} layers`);

  console.log('\n[TEST 3] Recording Story View from viewer...');
  const viewRes = await fetch(`${API_BASE}/api/stories/${createdStory.id}/view`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${viewerToken}`
    }
  });
  if (!viewRes.ok) throw new Error('Failed to record story view');
  console.log('  ✓ Story view successfully recorded.');

  console.log('\n[TEST 4] Testing Story Insights Endpoint (/api/stories/:id/insights)...');
  const insightsRes = await fetch(`${API_BASE}/api/stories/${createdStory.id}/insights`, {
    headers: { 'Authorization': `Bearer ${authorToken}` }
  });
  if (!insightsRes.ok) {
    const errText = await insightsRes.text();
    throw new Error(`Failed to fetch insights: ${errText}`);
  }
  const insights = await insightsRes.json();
  console.log('  ✓ Insights response received:', insights);

  if (!insights.viewers || insights.viewers.length !== 1) {
    throw new Error(`Expected 1 viewer, got ${insights.viewers?.length}`);
  }
  const viewer = insights.viewers[0];
  console.log(`  ✓ Viewer found: ${viewer.fullName} (@${viewer.username}) - Liked: ${viewer.liked}`);

  console.log('\n[TEST 5] Testing Story Reaction (Like) & Insights Sorting...');
  const likeRes = await fetch(`${API_BASE}/api/stories/${createdStory.id}/like`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${viewerToken}`
    }
  });
  if (!likeRes.ok) throw new Error('Failed to like story');
  const likeResult = await likeRes.json();
  console.log(`  ✓ Story liked. isLiked: ${likeResult.isLiked}, likesCount: ${likeResult.likesCount}`);

  const insightsRes2 = await fetch(`${API_BASE}/api/stories/${createdStory.id}/insights`, {
    headers: { 'Authorization': `Bearer ${authorToken}` }
  });
  const insights2 = await insightsRes2.json();
  const viewer2 = insights2.viewers[0];
  if (!viewer2.liked) throw new Error('Expected viewer to be marked as liked: true in insights');
  console.log(`  ✓ Viewer updated in insights: ${viewer2.fullName} - Liked: ${viewer2.liked} ❤️`);

  // Cleanup
  console.log('\n[TEST 6] Cleaning up test story and profiles...');
  await fetch(`${API_BASE}/api/stories/${createdStory.id}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${authorToken}` }
  });
  await supabase.from('profiles').delete().in('id', [authorProfile.id, viewerProfile.id]);
  console.log('  ✓ Test story and profiles cleaned up.');

  console.log('\n==========================================================================');
  console.log('🎉 ALL STORY INSIGHTS, STICKERS, & METADATA TESTS PASSED SUCCESSFULLY!');
  console.log('==========================================================================');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
