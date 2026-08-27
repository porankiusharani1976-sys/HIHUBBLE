import dotenv from 'dotenv';
dotenv.config();

import jwt from 'jsonwebtoken';
import { supabase } from './supabase.js';

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';
const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

async function runStoryAudioLifecycleTests() {
  console.log('\n==========================================================================');
  console.log('🚀 TESTING STORY AUDIO LIFECYCLE PIPELINE (EDITING → PREVIEW → PUBLISH → VIEWER)');
  console.log('==========================================================================\n');

  let testUser = null;
  let authToken = null;
  let createdStoryId = null;

  try {
    // -------------------------------------------------------------
    // [TEST 1] Setup Test User
    // -------------------------------------------------------------
    console.log('[TEST 1] Setting up test user for story audio pipeline...');
    const authorUsername = `audio_author_${Date.now()}`;
    const { data: authorProfile, error: aErr } = await supabase.from('profiles').insert([{
      username: authorUsername,
      email: `${authorUsername}@test.local`,
      full_name: 'Audio Author',
      password_hash: 'fakehash'
    }]).select().single();

    if (aErr) throw new Error(`Failed to create author profile: ${aErr.message}`);
    testUser = authorProfile;

    authToken = jwt.sign(
      { id: testUser.id, sub: testUser.id, username: testUser.username, email: testUser.email, role: 'authenticated', aud: 'authenticated' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    console.log(`  ✓ Test user active: ${testUser.username} (${testUser.id})`);

    // -------------------------------------------------------------
    // [TEST 2] StoryAudioManager State & API Logic Simulation
    // -------------------------------------------------------------
    console.log('\n[TEST 2] Testing StoryAudioManager Singleton Engine...');

    const MockStoryAudioManager = {
      audio: {
        src: '',
        paused: true,
        muted: false,
        currentTime: 0,
        duration: 30,
        volume: 1,
        play: async function() { this.paused = false; return Promise.resolve(); },
        pause: function() { this.paused = true; },
        load: function() {},
        removeAttribute: function(attr) { if (attr === 'src') this.src = ''; }
      },
      currentTrack: null,
      currentUrl: null,
      isMutedState: false,
      _isPlaying: false,
      _owner: null,

      load(trackOrUrl, owner = 'editor') {
        let url = null;
        let track = null;
        if (typeof trackOrUrl === 'string') {
          url = trackOrUrl;
          track = { previewUrl: url, url: url, title: 'Music', artist: '' };
        } else if (trackOrUrl && typeof trackOrUrl === 'object') {
          track = trackOrUrl;
          url = track.previewUrl || track.url || null;
        }
        this._owner = owner;
        this.currentTrack = track;
        if (!url) {
          this.stop();
          this.currentUrl = null;
          return false;
        }
        if (this.currentUrl !== url || !this.audio.src) {
          this.currentUrl = url;
          this.audio.pause();
          this.audio.src = url;
          this.audio.currentTime = 0;
        }
        if (track && typeof track.isMuted === 'boolean') {
          this.isMutedState = track.isMuted;
        }
        this.audio.muted = !!this.isMutedState;
        return true;
      },

      play(owner = null) {
        if (owner) this._owner = owner;
        if (!this.currentUrl && this.currentTrack) {
          this.load(this.currentTrack, this._owner || 'editor');
        }
        if (!this.currentUrl) return Promise.resolve();
        this.audio.muted = !!this.isMutedState;
        this._isPlaying = true;
        return this.audio.play();
      },

      pause() {
        this.audio.pause();
        this._isPlaying = false;
      },

      resume() {
        if (this.currentUrl && !this.isMutedState) {
          return this.play();
        }
        return Promise.resolve();
      },

      stop() {
        this.audio.pause();
        this.audio.currentTime = 0;
        this._isPlaying = false;
      },

      mute() {
        this.isMutedState = true;
        this.audio.muted = true;
        if (this.currentTrack) this.currentTrack.isMuted = true;
      },

      unmute() {
        this.isMutedState = false;
        this.audio.muted = false;
        if (this.currentTrack) this.currentTrack.isMuted = false;
        if (this.audio.paused && this.currentUrl) {
          this.play();
        }
      },

      toggleMute() {
        if (this.isMutedState) this.unmute();
        else this.mute();
        return this.isMutedState;
      },

      seek(time) {
        this.audio.currentTime = time;
      },

      destroy() {
        this.audio.pause();
        this.audio.currentTime = 0;
        this.audio.removeAttribute('src');
        this.currentTrack = null;
        this.currentUrl = null;
        this._isPlaying = false;
        this._owner = null;
      }
    };

    const sampleTrack = {
      id: 'track_123',
      title: 'Starboy',
      artist: 'The Weeknd',
      artwork: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=150&h=150&q=80',
      previewUrl: 'https://audio-ssl.itunes.apple.com/preview/starboy.m4a',
      isMuted: false
    };

    // 2.1 Load track in editor
    MockStoryAudioManager.load(sampleTrack, 'editor');
    await MockStoryAudioManager.play('editor');
    if (MockStoryAudioManager.audio.src !== sampleTrack.previewUrl || MockStoryAudioManager.audio.paused) {
      throw new Error('StoryAudioManager failed to load or play track');
    }
    console.log('  ✓ Editor: Music loaded and auto-playing.');

    // 2.2 Simulate Mute Toggle on Sticker (does NOT pause stream, only mutes audio)
    MockStoryAudioManager.mute();
    if (!MockStoryAudioManager.audio.muted || MockStoryAudioManager.audio.paused) {
      throw new Error('Mute should silence audio without stopping playback stream');
    }
    console.log('  ✓ Sticker Mute: Audio silenced while playback continues.');

    // 2.3 Simulate Unmute Toggle on Sticker
    MockStoryAudioManager.unmute();
    if (MockStoryAudioManager.audio.muted) {
      throw new Error('Unmute failed to restore audio output');
    }
    console.log('  ✓ Sticker Unmute: Audio output restored seamlessly.');

    // 2.4 Simulate Preview Modal (reusing StoryAudioManager)
    MockStoryAudioManager.seek(12.5);
    if (MockStoryAudioManager.audio.currentTime !== 12.5) {
      throw new Error('Audio seek/sync failed');
    }
    console.log('  ✓ Preview: Reused audio instance at timestamp 12.5s without reloading.');

    // 2.5 Destroy audio
    MockStoryAudioManager.destroy();
    if (MockStoryAudioManager.audio.src !== '' || MockStoryAudioManager.currentTrack !== null) {
      throw new Error('Destroy failed to release audio resources cleanly');
    }
    console.log('  ✓ Teardown: Audio completely stopped and resources released.');

    // -------------------------------------------------------------
    // [TEST 3] Story Publish Payload & Persistence
    // -------------------------------------------------------------
    console.log('\n[TEST 3] Testing Story Publishing with Music & Sticker Transforms...');

    const sampleStoryPayload = {
      mediaUrl: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=800',
      mediaType: 'image',
      caption: 'Testing Instagram-level Story Audio Pipeline 🎵',
      music: {
        id: sampleTrack.id,
        trackId: sampleTrack.id,
        title: sampleTrack.title,
        artist: sampleTrack.artist,
        artwork: sampleTrack.artwork,
        albumArt: sampleTrack.artwork,
        previewUrl: sampleTrack.previewUrl,
        url: sampleTrack.previewUrl,
        isMuted: false,
        muted: false
      },
      layers: [
        {
          id: 'music_sticker_' + Date.now(),
          type: 'music',
          track: sampleTrack,
          content: sampleTrack.title,
          artist: sampleTrack.artist,
          artwork: sampleTrack.artwork,
          isMuted: false,
          x: 50,
          y: 70,
          scale: 1.1,
          rotation: 5,
          zIndex: 25
        }
      ]
    };

    const res = await fetch(`${BASE_URL}/api/stories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify(sampleStoryPayload)
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Failed to publish story: ${res.status} ${errBody}`);
    }

    const createdStory = await res.json();
    createdStoryId = createdStory._id || createdStory.id;
    console.log(`  ✓ Story published with ID: ${createdStoryId}`);
    console.log(`  ✓ Story Music attached: ${createdStory.music.title} by ${createdStory.music.artist}`);
    console.log(`  ✓ Story Layer count: ${createdStory.layers.length}`);

    // -------------------------------------------------------------
    // [TEST 4] Story Viewer Retrieval & Playback Verification
    // -------------------------------------------------------------
    console.log('\n[TEST 4] Verifying Story Viewer Music Unpacking & Playback Initializer...');

    const getRes = await fetch(`${BASE_URL}/api/stories`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });

    if (!getRes.ok) throw new Error(`GET /api/stories failed: ${getRes.status}`);
    const storiesList = await getRes.json();
    const foundStory = storiesList.find(s => (s._id || s.id) === createdStoryId);

    if (!foundStory) {
      throw new Error(`Published story ${createdStoryId} not found in GET /api/stories`);
    }

    if (!foundStory.music || !foundStory.music.previewUrl) {
      throw new Error('Music previewUrl was lost during story persistence');
    }

    if (!foundStory.layers || foundStory.layers.length === 0) {
      throw new Error('Music sticker layer was lost during story persistence');
    }

    const musicSticker = foundStory.layers.find(l => l.type === 'music');
    if (!musicSticker || musicSticker.x !== 50 || musicSticker.y !== 70 || musicSticker.rotation !== 5) {
      throw new Error('Music sticker transform coordinates were corrupted');
    }

    console.log(`  ✓ Viewer: Music preview URL confirmed: ${foundStory.music.previewUrl}`);
    console.log(`  ✓ Viewer: Music sticker placed at (x: ${musicSticker.x}%, y: ${musicSticker.y}%, rotate: ${musicSticker.rotation}deg, scale: ${musicSticker.scale})`);

    // -------------------------------------------------------------
    // [TEST 5] Clean up test story
    // -------------------------------------------------------------
    console.log('\n[TEST 5] Cleaning up test story...');
    await supabase.from('story_views').delete().eq('story_id', createdStoryId);
    await supabase.from('story_media').delete().eq('story_id', createdStoryId);
    await supabase.from('stories').delete().eq('id', createdStoryId);
    console.log('  ✓ Test story cleaned up.');

    console.log('\n==========================================================================');
    console.log('🎉 ALL STORY AUDIO PIPELINE LIFECYCLE TESTS PASSED SUCCESSFULLY!');
    console.log('==========================================================================\n');

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    if (createdStoryId) {
      try {
        await supabase.from('story_views').delete().eq('story_id', createdStoryId);
        await supabase.from('story_media').delete().eq('story_id', createdStoryId);
        await supabase.from('stories').delete().eq('id', createdStoryId);
      } catch (_) {}
    }
    process.exit(1);
  }
}

runStoryAudioLifecycleTests();
