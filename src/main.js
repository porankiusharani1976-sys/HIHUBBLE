import React from 'react';
import ReactDOM from 'react-dom/client';
import { getDraftThumbnailInfo, renderThumbnailHTML } from './services/draft_thumbnail_service.js';
import CreatePost from './pages/CreatePost/CreatePost.jsx';
import { initVideoEditor } from './video_editor_controller.js';
import { Input, Output, BlobSource, BufferTarget, WebMOutputFormat, Mp4OutputFormat, Conversion, ALL_FORMATS } from 'mediabunny';
import './style.css'

window.reelsMuted = false; // Unmuted by default

// --- HUBBING REEL PLAYBACK CONTROLLER (CENTRALIZED SINGLETON STATE MACHINE) ---
class HubbingPlaybackController {
  constructor() {
    this.activeReelId = null;
    this.activeVideo = null;
    this.activeCard = null;
    this.activationId = 0;
    this.pendingPlayPromise = null;
    this.visibilityMap = new Map(); // card -> { video, reelId, ratio, entry }
    this.unloadTimers = new Map(); // reelId -> timerId
    this.settleTimer = null;
    this.isExploreActive = false;
    this.isUserMuted = window.reelsMuted !== false;
    this.perfInterval = null;
    this.scrollListenerBound = false;

    this.startPerfMonitoring();
    this.bindGlobalScrollListener();
  }

  bindGlobalScrollListener() {
    if (this.scrollListenerBound) return;
    const bindScroller = () => {
      const scroller = document.getElementById('explore-reels-container');
      if (scroller && !scroller._hubbingScrollBound) {
        scroller._hubbingScrollBound = true;
        this.scrollListenerBound = true;
        scroller.addEventListener('scroll', () => {
          if (!this.isExploreActive) return;
          this.scheduleSettleEvaluation(120);
        }, { passive: true });
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bindScroller);
    } else {
      bindScroller();
    }
  }

  startPerfMonitoring() {
    if (this.perfInterval) clearInterval(this.perfInterval);
    this.perfInterval = setInterval(() => {
      if (!this.isExploreActive) return;
      this.logPerfDiagnostics();
    }, 4000);
  }

  logPerfDiagnostics() {
    const scroller = document.querySelector('#explore-reels-container .reels-scroller');
    if (!scroller) return;
    const cards = scroller.querySelectorAll('.reel-card');
    const videos = scroller.querySelectorAll('.reel-video');
    let playingCount = 0;
    let loadedCount = 0;

    videos.forEach(v => {
      if (!v.paused && v.readyState >= 2) playingCount++;
      if (v.src && v.src.length > 0) loadedCount++;
    });

    let qualityInfo = '';
    if (this.activeVideo && typeof this.activeVideo.getVideoPlaybackQuality === 'function') {
      const q = this.activeVideo.getVideoPlaybackQuality();
      qualityInfo = ` droppedFrames=${q.droppedVideoFrames}/${q.totalVideoFrames}`;
    }

    let memoryInfo = '';
    if (window.performance && window.performance.memory) {
      const usedMb = Math.round(window.performance.memory.usedJSHeapSize / (1024 * 1024));
      memoryInfo = ` memUsed=${usedMb}MB`;
    }

    console.log(`[HUBBING PERF] activeReel=${this.activeReelId || 'none'} cards=${cards.length} videos=${videos.length} loaded=${loadedCount} playing=${playingCount}${qualityInfo}${memoryInfo}`);
  }

  onViewChange(viewName) {
    this.isExploreActive = (viewName === 'explore' || viewName === 'reels');
    console.log(`[HUBBING PLAYER] onViewChange: ${viewName}, isExploreActive=${this.isExploreActive}`);

    if (!this.isExploreActive) {
      this.deactivateCurrentReel('view_leave');
      this.pauseAllReelVideos();
    } else {
      this.bindGlobalScrollListener();
      this.scheduleSettleEvaluation(80);
    }
  }

  pauseAllReelVideos(exceptVideo = null) {
    document.querySelectorAll('.reel-video').forEach(v => {
      if (v !== exceptVideo) {
        try {
          if (!v.paused) {
            v.pause();
          }
          v.muted = true;
        } catch (_) { }
        const card = v.closest('.reel-card');
        const playOverlay = card?.querySelector('.reel-play-icon-overlay');
        if (playOverlay) {
          playOverlay.classList.add('paused-state');
        }
      }
    });
  }

  onVisibilityChange(entries) {
    entries.forEach(entry => {
      const target = entry.target;
      let card = null;
      let video = null;

      if (target.classList.contains('reel-card')) {
        card = target;
        video = card.querySelector('.reel-video');
      } else if (target.classList.contains('reel-video')) {
        video = target;
        card = video.closest('.reel-card');
      }

      if (!card || !video) return;
      const reelId = card.getAttribute('data-reel-id');
      if (!reelId) return;

      const ratio = entry.intersectionRatio;
      this.visibilityMap.set(card, { video, reelId, ratio, entry });

      // Controlled lazy activation
      if (ratio === 0) {
        this.scheduleUnload(reelId, video, card);
      } else if (ratio >= 0.15) {
        this.cancelUnload(reelId);
        if (!video.src && video.dataset.src) {
          video.src = video.dataset.src;
          video.preload = 'metadata';
        }
      }
    });

    if (this.isExploreActive) {
      this.scheduleSettleEvaluation(100);
    }
  }

  scheduleSettleEvaluation(delayMs = 120) {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.evaluateBestReel();
    }, delayMs);
  }

  evaluateBestReel() {
    if (!this.isExploreActive) return;

    const exploreContainer = document.getElementById('explore-reels-container');
    if (!exploreContainer || !exploreContainer.classList.contains('active')) {
      if (this.activeReelId) this.deactivateCurrentReel('explore_container_inactive');
      return;
    }

    const scroller = exploreContainer.querySelector('.reels-scroller');
    if (!scroller) return;

    const cards = Array.from(scroller.querySelectorAll('.reel-card'));
    if (cards.length === 0) {
      if (this.activeReelId) this.deactivateCurrentReel('no_cards');
      return;
    }

    const scrollerRect = exploreContainer.getBoundingClientRect();
    const scrollerTop = scrollerRect.top;
    const scrollerBottom = scrollerRect.bottom;
    const scrollerHeight = scrollerRect.height;
    const scrollerCenter = scrollerTop + scrollerHeight / 2;

    let bestCandidate = null;
    let minCenterDistance = Infinity;

    cards.forEach(card => {
      if (card.getAttribute('data-reel-failed') === 'true') return;
      if (!document.body.contains(card)) {
        this.visibilityMap.delete(card);
        return;
      }

      const rect = card.getBoundingClientRect();
      const cardHeight = rect.height || 640;

      // Calculate visible overlap in container viewport
      const visibleTop = Math.max(scrollerTop, rect.top);
      const visibleBottom = Math.min(scrollerBottom, rect.bottom);
      const visibleHeight = Math.max(0, visibleBottom - visibleTop);
      const visibleRatio = visibleHeight / cardHeight;

      // Calculate distance of card center from container center
      const cardCenter = rect.top + cardHeight / 2;
      const centerDistance = Math.abs(cardCenter - scrollerCenter);

      // Card must be at least 25% visible in viewport
      if (visibleRatio >= 0.25) {
        if (centerDistance < minCenterDistance) {
          minCenterDistance = centerDistance;
          const video = card.querySelector('.reel-video');
          const reelId = card.getAttribute('data-reel-id');
          if (video && reelId) {
            bestCandidate = { card, video, reelId, ratio: visibleRatio, centerDistance };
          }
        }
      }
    });

    if (bestCandidate) {
      if (this.activeReelId !== bestCandidate.reelId) {
        this.activateReel(bestCandidate.reelId, bestCandidate.video, bestCandidate.card, false);
      } else {
        // Active reel is still best, ensure it is playing if paused unintentionally
        if (this.activeVideo && this.activeVideo.paused && !this.activeVideo._userExplicitlyPaused) {
          this.safePlay(this.activeVideo, this.activationId, bestCandidate.reelId, bestCandidate.card);
        }
      }
    } else {
      // No reel sufficiently visible in viewport
      if (this.activeReelId) {
        this.deactivateCurrentReel('no_visible_reels');
      }
    }
  }

  scheduleUnload(reelId, video, card) {
    if (this.unloadTimers.has(reelId)) return;
    // Long hysteresis timeout (10s) to prevent tearing down decoders during normal scrolling
    const timerId = setTimeout(() => {
      this.unloadTimers.delete(reelId);
      if (this.activeReelId !== reelId && video && video.src) {
        // Only unload if card is truly far away (> 2 cards away from active)
        const scroller = document.querySelector('#explore-reels-container .reels-scroller');
        if (scroller && this.activeCard) {
          const cards = Array.from(scroller.querySelectorAll('.reel-card'));
          const activeIdx = cards.indexOf(this.activeCard);
          const thisIdx = cards.indexOf(card);
          if (activeIdx !== -1 && thisIdx !== -1 && Math.abs(activeIdx - thisIdx) <= 2) {
            // Keep neighbor alive
            return;
          }
        }
        try {
          if (!video.paused) video.pause();
          video.removeAttribute('src');
          video.load();
          console.log(`[HUBBING PLAYER] Unloaded far off-screen reel decoder resources: ${reelId}`);
        } catch (_) { }
      }
    }, 10000);
    this.unloadTimers.set(reelId, timerId);
  }

  cancelUnload(reelId) {
    if (this.unloadTimers.has(reelId)) {
      clearTimeout(this.unloadTimers.get(reelId));
      this.unloadTimers.delete(reelId);
    }
  }

  async activateReel(reelId, video, card = null, userForced = false) {
    if (!reelId || !video) return;
    if (!card) card = video.closest('.reel-card');

    this.activationId++;
    const currentActivationId = this.activationId;

    console.log(`[HUBBING PLAYER] activateReel: reelId=${reelId} (token #${currentActivationId}, forced=${userForced})`);

    // 1. Cancel unload timer for this reel
    this.cancelUnload(reelId);

    // 2. Pause and mute all other videos immediately (Single Active Video Lock)
    this.pauseAllReelVideos(video);

    // 3. Ensure target video src is assigned
    if (!video.src && video.dataset.src) {
      video.src = video.dataset.src;
    }
    video.preload = 'auto';

    // 4. Update audio settings (Strict audio policy)
    this.isUserMuted = window.reelsMuted !== false;
    video.muted = this.isUserMuted;
    video.volume = 1.0;

    // 5. Update state
    this.activeReelId = reelId;
    this.activeVideo = video;
    this.activeCard = card;
    if (video) video._userExplicitlyPaused = false;

    // 6. Update UI state across all cards
    this.syncAllAudioIcons();
    this.syncCardPlayOverlay(card, false);

    // 7. Preload adjacent neighbors (±1 and ±2)
    this.preloadAdjacentNeighbors(card);

    // 8. Safe play execution with race-condition prevention
    await this.safePlay(video, currentActivationId, reelId, card);
  }

  async safePlay(video, token, reelId, card) {
    if (!video || this.activationId !== token) return;

    try {
      const playPromise = video.play();
      if (playPromise !== undefined) {
        this.pendingPlayPromise = playPromise;
        await playPromise;
      }

      // Check if token changed while waiting for play()
      if (this.activationId !== token) {
        console.log(`[HUBBING PLAYER] Stale play token #${token} resolved (active is #${this.activationId}), pausing.`);
        try { video.pause(); } catch (_) { }
        return;
      }

      this.syncCardPlayOverlay(card, false);
      console.log(`[HUBBING PLAYER] Playing active reelId=${reelId} (token #${token}, muted=${video.muted}, currentTime=${video.currentTime.toFixed(2)})`);
    } catch (err) {
      if (this.activationId !== token) return;

      console.warn(`[HUBBING PLAYER] Play rejected for reelId=${reelId}:`, err.message);

      // If autoplay failed due to unmuted audio policy, retry with muted=true
      if (err.name === 'NotAllowedError' && !video.muted) {
        console.log('[HUBBING PLAYER] Autoplay blocked with sound, falling back to muted playback.');
        video.muted = true;
        window.reelsMuted = true;
        this.isUserMuted = true;
        this.syncAllAudioIcons();
        try {
          await video.play();
          if (this.activationId === token) {
            this.syncCardPlayOverlay(card, false);
          }
        } catch (_) {
          this.syncCardPlayOverlay(card, true);
        }
      } else {
        this.syncCardPlayOverlay(card, true);
      }
    } finally {
      if (this.activationId === token) {
        this.pendingPlayPromise = null;
      }
    }
  }

  deactivateCurrentReel(reason = 'manual') {
    console.log(`[HUBBING PLAYER] deactivateCurrentReel (reason: ${reason}, activeReelId=${this.activeReelId})`);
    this.activationId++;
    if (this.activeVideo) {
      try {
        if (!this.activeVideo.paused) {
          this.activeVideo.pause();
        }
        this.activeVideo.muted = true;
      } catch (_) { }
    }
    if (this.activeCard) {
      this.syncCardPlayOverlay(this.activeCard, true);
    }
    this.activeReelId = null;
    this.activeVideo = null;
    this.activeCard = null;
  }

  togglePlayPause(card) {
    if (!card) return;
    const video = card.querySelector('.reel-video');
    const reelId = card.getAttribute('data-reel-id');
    if (!video || !reelId) return;

    if (this.activeReelId === reelId && !video.paused) {
      video._userExplicitlyPaused = true;
      this.deactivateCurrentReel('user_tap_pause');
    } else {
      video._userExplicitlyPaused = false;
      this.activateReel(reelId, video, card, true);
    }
  }

  toggleAudio(card) {
    const nextMuted = (window.reelsMuted === false); // toggle: if false -> true, if true -> false
    window.reelsMuted = nextMuted;
    this.isUserMuted = nextMuted;

    console.log(`[HUBBING PLAYER] toggleAudio: global reelsMuted=${nextMuted}`);

    if (this.activeVideo) {
      this.activeVideo.muted = nextMuted;
      this.activeVideo.volume = 1.0;
    }

    this.syncAllAudioIcons();

    if (typeof safeShowToast === 'function') {
      safeShowToast(nextMuted ? 'Reel audio muted 🔇' : 'Reel audio unmuted 🔊');
    } else if (typeof window.showToast === 'function') {
      window.showToast(nextMuted ? 'Reel audio muted 🔇' : 'Reel audio unmuted 🔊');
    }
  }

  syncAllAudioIcons() {
    const isMuted = window.reelsMuted !== false;
    document.querySelectorAll('.reel-audio-toggle-btn i, .reel-audio-toggle-btn svg').forEach(icon => {
      icon.setAttribute('data-lucide', isMuted ? 'volume-x' : 'volume-2');
    });
    if (window.debouncedCreateIcons) window.debouncedCreateIcons();
  }

  syncCardPlayOverlay(card, isPaused) {
    if (!card) return;
    const playOverlay = card.querySelector('.reel-play-icon-overlay');
    if (playOverlay) {
      if (isPaused) {
        playOverlay.classList.add('paused-state');
      } else {
        playOverlay.classList.remove('paused-state');
      }
    }
  }

  preloadAdjacentNeighbors(currentCard) {
    if (!currentCard) return;
    const scroller = currentCard.closest('.reels-scroller');
    if (!scroller) return;

    const cards = Array.from(scroller.querySelectorAll('.reel-card'));
    const idx = cards.indexOf(currentCard);
    if (idx === -1) return;

    const neighbors = [
      cards[idx - 2],
      cards[idx - 1],
      cards[idx + 1],
      cards[idx + 2]
    ].filter(Boolean);

    neighbors.forEach(nCard => {
      const nVid = nCard.querySelector('.reel-video');
      if (nVid && !nVid.src && nVid.dataset.src) {
        nVid.src = nVid.dataset.src;
        nVid.preload = 'metadata';
        console.log(`[HUBBING PLAYER] Preloaded neighbor metadata: ${nCard.getAttribute('data-reel-id')}`);
      }
    });
  }
}

window.hubbingPlaybackController = new HubbingPlaybackController();

// --- POST MUSIC PLAYBACK CONTROLLER ---
const getPostMusicUrl = (post) => {
  if (!post || !post.caption) return null;
  const match = post.caption.match(/data-music-url="([^"]+)"/);
  return match ? match[1] : null;
};

function bindPostVideoAudioSync(card, video, audio) {
  if (video._syncBound) return;
  video._syncBound = true;

  video.addEventListener('play', () => {
    if (audio.paused) audio.play().catch(() => { });
  });
  video.addEventListener('pause', () => {
    if (!audio.paused) audio.pause();
  });
  video.addEventListener('seeking', () => {
    audio.currentTime = video.currentTime % (audio.duration || 1);
  });
  video.addEventListener('seeked', () => {
    audio.currentTime = video.currentTime % (audio.duration || 1);
  });
  video.addEventListener('timeupdate', () => {
    const target = video.currentTime % (audio.duration || 1);
    if (Math.abs(audio.currentTime - target) > 0.15) {
      audio.currentTime = target;
    }
  });
}

window.togglePostMusic = (btn, musicUrl, postId) => {
  const card = document.getElementById('post-' + postId);
  if (!card) return;

  if (!card._audio) {
    card._audio = new Audio(musicUrl);
    card._audio.loop = true;
    card._audio.volume = 0.5;
  }

  const audio = card._audio;
  const vinyl = card.querySelector('.music-vinyl-disc');
  const video = card.querySelector('.post-media-video');

  if (video) {
    bindPostVideoAudioSync(card, video, audio);
  }

  if (audio.paused) {
    // Stop all other playing audios
    document.querySelectorAll('.feed-card').forEach(otherCard => {
      if (otherCard !== card && otherCard._audio && !otherCard._audio.paused) {
        otherCard._audio.pause();
        const otherVinyl = otherCard.querySelector('.music-vinyl-disc');
        if (otherVinyl) otherVinyl.style.animationPlayState = 'paused';
        const otherBtn = otherCard.querySelector('.post-music-speaker-btn');
        if (otherBtn) {
          otherBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/></svg>
          `;
        }
      }
    });

    audio.play().catch(err => console.warn('Audio play error:', err.message));
    if (video && video.paused) {
      video.play().catch(err => console.warn('Video play error:', err.message));
    }
    if (vinyl) {
      vinyl.style.animationPlayState = 'running';
      vinyl.style.animation = 'spin 4s linear infinite';
    }
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
    `;
  } else {
    audio.pause();
    if (video && !video.paused) {
      video.pause();
    }
    if (vinyl) vinyl.style.animationPlayState = 'paused';
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/></svg>
    `;
  }
};

window.stopAllPostMusic = () => {
  document.querySelectorAll('.feed-card').forEach(card => {
    if (card._audio) {
      card._audio.pause();
      card._audio = null;
    }
  });
};

// =========================================================================
// SHARE HUBBS (STORIES) SINGLETON AUDIO CONTROLLER & LIFECYCLE ENGINE
// =========================================================================

window.StoryAudioManager = {
  audio: null,
  currentTrack: null,
  currentUrl: null,
  isMutedState: false,
  _userVolume: 1,
  _isPlaying: false,
  _owner: null, // 'editor' | 'preview' | 'viewer'

  init() {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.loop = true;
      this.audio.preload = 'auto';
      this.audio.crossOrigin = 'anonymous';

      this.audio.addEventListener('play', () => { this._isPlaying = true; });
      this.audio.addEventListener('pause', () => { this._isPlaying = false; });
      this.audio.addEventListener('ended', () => {
        if (this.audio && this.audio.loop) {
          this.audio.currentTime = 0;
          this.audio.play().catch(() => { });
        }
      });
      this.audio.addEventListener('error', (err) => {
        console.warn('[StoryAudioManager] Audio stream notice:', err);
        this._isPlaying = false;
      });
    }
    return this.audio;
  },

  load(trackOrUrl, owner = 'editor') {
    this.init();
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
      try {
        this.audio.pause();
        this.audio.src = url;
        this.audio.currentTime = 0;
        this.audio.load();
      } catch (e) {
        console.warn('[StoryAudioManager.load] Error setting src:', e);
      }
    }

    if (track && typeof track.isMuted === 'boolean') {
      this.isMutedState = track.isMuted;
    }
    this.audio.muted = !!this.isMutedState;
    return true;
  },

  play(owner = null) {
    this.init();
    if (owner) this._owner = owner;
    if (!this.currentUrl && this.currentTrack) {
      this.load(this.currentTrack, this._owner || 'editor');
    }
    if (!this.currentUrl) return Promise.resolve();

    this.audio.muted = !!this.isMutedState;
    return this.audio.play().catch(e => {
      console.debug('[StoryAudioManager.play] Autoplay notice:', e.message || e);
      if (e.name === 'NotAllowedError') {
        const unlockAudio = () => {
          window.removeEventListener('click', unlockAudio, true);
          window.removeEventListener('touchstart', unlockAudio, true);
          window.removeEventListener('pointerdown', unlockAudio, true);
          if (this.currentUrl && !this.isMutedState && this.audio) {
            this.audio.play().catch(() => { });
          }
        };
        window.addEventListener('click', unlockAudio, true);
        window.addEventListener('touchstart', unlockAudio, true);
        window.addEventListener('pointerdown', unlockAudio, true);
      }
    });
  },

  pause() {
    if (this.audio) {
      try {
        this.audio.pause();
      } catch (_) { }
    }
    this._isPlaying = false;
  },

  resume() {
    if (this.currentUrl && !this.isMutedState) {
      return this.play();
    }
    return Promise.resolve();
  },

  stop() {
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.currentTime = 0;
      } catch (_) { }
    }
    this._isPlaying = false;
  },

  mute() {
    this.isMutedState = true;
    if (this.audio) {
      this.audio.muted = true;
    }
    if (this.currentTrack) {
      this.currentTrack.isMuted = true;
    }
  },

  unmute() {
    this.isMutedState = false;
    if (this.audio) {
      this.audio.muted = false;
    }
    if (this.currentTrack) {
      this.currentTrack.isMuted = false;
    }
    if (this.audio && this.audio.paused && this.currentUrl) {
      this.play();
    }
  },

  toggleMute() {
    if (this.isMutedState) {
      this.unmute();
    } else {
      this.mute();
    }
    return this.isMutedState;
  },

  isMuted() {
    return !!this.isMutedState;
  },

  seek(time) {
    if (this.audio && typeof time === 'number' && isFinite(time)) {
      try {
        if (this.audio.duration && isFinite(this.audio.duration)) {
          this.audio.currentTime = time % this.audio.duration;
        } else {
          this.audio.currentTime = time;
        }
      } catch (_) { }
    }
  },

  sync(time) {
    if (this.audio && typeof time === 'number' && isFinite(time)) {
      const cur = this.audio.currentTime;
      if (Math.abs(cur - time) > 0.3) {
        this.seek(time);
      }
    }
  },

  setVolume(val) {
    const v = Math.max(0, Math.min(1, val));
    this._userVolume = v;
    if (this.audio) {
      this.audio.volume = v;
    }
  },

  getVolume() {
    return this.audio ? this.audio.volume : this._userVolume;
  },

  getCurrentTime() {
    return this.audio ? this.audio.currentTime : 0;
  },

  getDuration() {
    return (this.audio && isFinite(this.audio.duration)) ? this.audio.duration : 0;
  },

  isPlaying() {
    return !!(this.audio && !this.audio.paused && this._isPlaying);
  },

  getTrack() {
    return this.currentTrack;
  },

  destroy() {
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.currentTime = 0;
        this.audio.removeAttribute('src');
      } catch (_) { }
    }
    this.currentTrack = null;
    this.currentUrl = null;
    this._isPlaying = false;
    this._owner = null;
  }
};

// Comprehensive media & audio cleanup for Share HUBBs (Stories)
window.cleanupStoryMedia = function () {
  // 1. Pause, mute, unload, and remove all Story editor and review video instances
  const storyVideos = document.querySelectorAll(
    '#he-media-layer video, #review-slider-wrapper video, #review-before-container video, #review-after-container video, #ch-media-preview-container video, #view-create-hubbs video, #view-review-hubbs video, #he-canvas-modal video, .story-creator-preview video'
  );

  storyVideos.forEach(v => {
    try {
      v.pause();
      v.muted = true;
      v.autoplay = false;
      v.currentTime = 0;
      v.removeAttribute('src');
      v.load();
    } catch (_) { }
    if (v.parentNode && (v.closest('#review-before-container') || v.closest('#review-after-container') || v.closest('#he-media-layer'))) {
      try { v.remove(); } catch (_) { }
    }
  });

  // 2. Clear review containers DOM completely
  const beforeC = document.getElementById('review-before-container');
  const afterC = document.getElementById('review-after-container');
  if (beforeC) {
    Array.from(beforeC.children).forEach(c => {
      if (!c.style.position || !c.style.position.includes('absolute')) c.remove();
    });
  }
  if (afterC) {
    Array.from(afterC.children).forEach(c => {
      if (!c.style.position || !c.style.position.includes('absolute')) c.remove();
    });
  }

  // 3. Clear canvas media layer
  const mediaLayer = document.getElementById('he-media-layer');
  if (mediaLayer) mediaLayer.innerHTML = '';

  // 4. Destroy Story audio completely via StoryAudioManager
  if (window.StoryAudioManager) {
    window.StoryAudioManager.destroy();
  }
  if (window.HubbleEditor && window.HubbleEditor.GlobalAudio) {
    try {
      window.HubbleEditor.GlobalAudio.stop();
    } catch (_) { }
  }
};

// Relative time formatting helper with live granularity
window.formatRelativeTime = function (timestamp) {
  if (!timestamp) return 'Just now';
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 10) return 'Just now';
  if (diffSec < 60) return `${diffSec} sec ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return diffMin === 1 ? '1 min ago' : `${diffMin} mins ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  const d = new Date(timestamp);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// Global state tracking
window.currentDraftId = null;
window.currentDraftCreatedAt = null;
window.lastDraftSavedAt = null;

// Live timestamp ticker for active view and draft cards
window.updateLastSavedLabel = function () {
  const subtitleEl = document.getElementById('ch-save-draft-subtitle');
  const reviewTimeEl = document.getElementById('review-draft-time');
  const timeStr = window.lastDraftSavedAt ? window.formatRelativeTime(window.lastDraftSavedAt) : 'Just now';
  if (subtitleEl) {
    subtitleEl.innerText = `Last saved: ${timeStr}`;
  }
  if (reviewTimeEl) {
    reviewTimeEl.innerText = `Last saved: ${timeStr}`;
  }

  // Update live relative times on visible draft cards in sidebar and modal
  document.querySelectorAll('.ch-draft-time[data-timestamp]').forEach(el => {
    const ts = parseInt(el.dataset.timestamp, 10);
    if (!isNaN(ts)) {
      el.innerText = `Saved ${window.formatRelativeTime(ts)}`;
    }
  });
  document.querySelectorAll('.see-all-draft-time[data-timestamp]').forEach(el => {
    const ts = parseInt(el.dataset.timestamp, 10);
    if (!isNaN(ts)) {
      el.innerText = `Saved ${window.formatRelativeTime(ts)}`;
    }
  });
};

// =========================================================================
// SHARED SERVICES: MUSIC & LOCATION (REUSED ACROSS POSTING & STORIES)
// =========================================================================

window.HubbleMusicService = {
  previewAudio: null,
  playingUrl: null,
  searchCache: new Map(),

  async search(query) {
    const q = (query || '').trim();
    if (!q) return [];
    if (this.searchCache.has(q.toLowerCase())) {
      return this.searchCache.get(q.toLowerCase());
    }
    try {
      const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&limit=15&media=music`);
      if (res.ok) {
        const data = await res.json();
        const tracks = (data.results || []).map(item => ({
          id: String(item.trackId || Math.random()),
          title: item.trackName || 'Unknown Title',
          artist: item.artistName || 'Unknown Artist',
          previewUrl: item.previewUrl || '',
          url: item.previewUrl || '',
          artwork: item.artworkUrl100 || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=150&h=150&q=80'
        }));
        this.searchCache.set(q.toLowerCase(), tracks);
        return tracks;
      }
    } catch (err) {
      console.error('[HubbleMusicService Error]', err);
    }
    return [];
  },

  togglePreview(track, onStateChange) {
    if (!track || !track.previewUrl) return;
    if (this.playingUrl === track.previewUrl) {
      this.stopPreview();
      if (typeof onStateChange === 'function') onStateChange(null);
    } else {
      this.stopPreview();
      this.previewAudio = new Audio(track.previewUrl);
      this.playingUrl = track.previewUrl;
      this.previewAudio.play().catch(e => console.warn('[Preview Play Notice]', e));
      this.previewAudio.onended = () => {
        this.playingUrl = null;
        if (typeof onStateChange === 'function') onStateChange(null);
      };
      if (typeof onStateChange === 'function') onStateChange(track.previewUrl);
    }
  },

  stopPreview() {
    if (this.previewAudio) {
      try {
        this.previewAudio.pause();
        this.previewAudio.currentTime = 0;
        this.previewAudio = null;
      } catch (_) { }
    }
    this.playingUrl = null;
  }
};

window.HubbleLocationService = {
  searchCache: new Map(),

  async search(query) {
    const q = (query || '').trim();
    if (!q || q.length < 2) return [];
    if (this.searchCache.has(q.toLowerCase())) {
      return this.searchCache.get(q.toLowerCase());
    }
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=8&addressdetails=1`, {
        headers: { 'accept-language': 'en' }
      });
      if (res.ok) {
        const data = await res.json();
        const results = (data || []).map(item => {
          const addr = item.address || {};
          const mainName = item.name || addr.city || addr.town || addr.village || addr.suburb || item.display_name.split(',')[0] || 'Unknown Place';
          const subParts = [];
          if (addr.city && addr.city !== mainName) subParts.push(addr.city);
          if (addr.state) subParts.push(addr.state);
          if (addr.country) subParts.push(addr.country);
          const subText = subParts.length > 0 ? subParts.join(', ') : (item.display_name || '');
          return {
            id: String(item.place_id || Math.random()),
            name: mainName,
            displayName: mainName,
            subText: subText,
            fullAddress: item.display_name,
            lat: item.lat,
            lon: item.lon,
            type: item.type || 'place'
          };
        });
        this.searchCache.set(q.toLowerCase(), results);
        return results;
      }
    } catch (err) {
      console.error('[HubbleLocationService Error]', err);
    }
    return [];
  }
};

// =========================================================================
// SHARE HUBBS (STORIES) MUSIC & LOCATION PICKER CONTROLLER
// =========================================================================

let _storyMusicSearchTimeout = null;
let _storyLocationSearchTimeout = null;

// Render attached badges in Story Creator UI
window.renderAttachedStoryBadges = function () {
  const container = document.getElementById('ch-attached-badges-container');
  const musicBtn = document.getElementById('ch-tool-music-btn');
  const locBtn = document.getElementById('ch-tool-location-btn');

  const musicTrack = (window.HubbleEditor && window.HubbleEditor.state && window.HubbleEditor.state.musicTrack) || null;
  const selectedLocation = (window.HubbleEditor && window.HubbleEditor.state && window.HubbleEditor.state.selectedLocation) || null;

  if (musicBtn) {
    if (musicTrack) {
      musicBtn.classList.add('active');
      musicBtn.style.background = 'rgba(168, 85, 247, 0.25)';
      musicBtn.style.borderColor = 'var(--primary, #a855f7)';
      musicBtn.style.boxShadow = '0 0 12px rgba(168, 85, 247, 0.4)';
    } else {
      musicBtn.classList.remove('active');
      musicBtn.style.background = 'rgba(255, 255, 255, 0.05)';
      musicBtn.style.borderColor = 'rgba(255, 255, 255, 0.1)';
      musicBtn.style.boxShadow = 'none';
    }
  }

  if (locBtn) {
    if (selectedLocation) {
      locBtn.classList.add('active');
      locBtn.style.background = 'rgba(168, 85, 247, 0.25)';
      locBtn.style.borderColor = 'var(--primary, #a855f7)';
      locBtn.style.boxShadow = '0 0 12px rgba(168, 85, 247, 0.4)';
    } else {
      locBtn.classList.remove('active');
      locBtn.style.background = 'rgba(255, 255, 255, 0.05)';
      locBtn.style.borderColor = 'rgba(255, 255, 255, 0.1)';
      locBtn.style.boxShadow = 'none';
    }
  }

  if (!container) return;
  container.innerHTML = '';

  if (musicTrack) {
    const badge = document.createElement('div');
    badge.className = 'ch-attached-badge';
    badge.style.cssText = 'display: flex; align-items: center; justify-content: space-between; background: rgba(168, 85, 247, 0.12); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 12px; padding: 6px 12px; animation: fadeIn 0.2s ease-out;';
    badge.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
        <img src="${musicTrack.artwork || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=150&h=150&q=80'}" style="width: 22px; height: 22px; border-radius: 50%; object-fit: cover;" alt="Artwork" />
        <div style="min-width: 0;">
          <div style="font-size: 11px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">🎵 ${musicTrack.title}</div>
          <div style="font-size: 9px; color: rgba(255,255,255,0.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${musicTrack.artist}</div>
        </div>
      </div>
      <button type="button" onclick="window.removeStoryMusic();" style="background: none; border: none; color: rgba(255,255,255,0.6); cursor: pointer; font-size: 14px; padding: 0 4px; line-height: 1;" title="Remove Music">✕</button>
    `;
    container.appendChild(badge);
  }

  if (selectedLocation) {
    const locName = selectedLocation.displayName || selectedLocation.name || 'Selected Location';
    const locSub = selectedLocation.subText || '';
    const badge = document.createElement('div');
    badge.className = 'ch-attached-badge';
    badge.style.cssText = 'display: flex; align-items: center; justify-content: space-between; background: rgba(168, 85, 247, 0.12); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 12px; padding: 6px 12px; animation: fadeIn 0.2s ease-out;';
    badge.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
        <span style="display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: rgba(168,85,247,0.25); color: var(--primary, #a855f7); font-size: 11px;">📍</span>
        <div style="min-width: 0;">
          <div style="font-size: 11px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${locName}</div>
          ${locSub ? `<div style="font-size: 9px; color: rgba(255,255,255,0.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${locSub}</div>` : ''}
        </div>
      </div>
      <button type="button" onclick="window.removeStoryLocation();" style="background: none; border: none; color: rgba(255,255,255,0.6); cursor: pointer; font-size: 14px; padding: 0 4px; line-height: 1;" title="Remove Location">✕</button>
    `;
    container.appendChild(badge);
  }
};

// --- MUSIC PICKER IMPLEMENTATION ---
window.openStoryMusicPicker = function () {
  const modal = document.getElementById('ch-music-picker-modal');
  if (!modal) return;

  const currentTrack = (window.HubbleEditor && window.HubbleEditor.state && window.HubbleEditor.state.musicTrack) || null;
  const indicator = document.getElementById('ch-music-selected-indicator');
  const imgEl = document.getElementById('ch-music-selected-img');
  const titleEl = document.getElementById('ch-music-selected-title');
  const artistEl = document.getElementById('ch-music-selected-artist');

  if (currentTrack && indicator && imgEl && titleEl && artistEl) {
    imgEl.src = currentTrack.artwork || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=150&h=150&q=80';
    titleEl.textContent = currentTrack.title;
    artistEl.textContent = currentTrack.artist;
    indicator.style.display = 'flex';
  } else if (indicator) {
    indicator.style.display = 'none';
  }

  modal.style.display = 'flex';
  modal.style.opacity = '1';
  modal.style.visibility = 'visible';
  modal.style.pointerEvents = 'auto';
  modal.classList.add('active');

  const searchInput = document.getElementById('ch-music-search-input');
  if (searchInput) {
    if (!searchInput.value.trim()) {
      searchInput.value = 'Trending';
      window.searchStoryMusic('Trending');
    } else {
      window.searchStoryMusic(searchInput.value.trim());
    }
    setTimeout(() => searchInput.focus(), 50);
  }
};

window.closeStoryMusicPicker = function () {
  if (window.HubbleMusicService && window.HubbleMusicService.stopPreview) {
    window.HubbleMusicService.stopPreview();
  }
  const modal = document.getElementById('ch-music-picker-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
    modal.style.opacity = '0';
    modal.style.visibility = 'hidden';
    modal.style.pointerEvents = 'none';
  }
};

window.openMusicPicker = window.openStoryMusicPicker;
window.closeMusicPicker = window.closeStoryMusicPicker;

window.handleStoryMusicInput = function (query) {
  if (_storyMusicSearchTimeout) clearTimeout(_storyMusicSearchTimeout);
  _storyMusicSearchTimeout = setTimeout(() => {
    window.searchStoryMusic(query);
  }, 350);
};

window.setStoryMusicGenre = function (genre) {
  const input = document.getElementById('ch-music-search-input');
  if (input) input.value = genre;
  window.searchStoryMusic(genre);
};

window.searchStoryMusic = async function (query) {
  const resultsContainer = document.getElementById('ch-music-results-list');
  if (!resultsContainer) return;

  const q = (query || '').trim();
  if (!q) {
    resultsContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); font-size: 11px; padding: 20px;">Type a song or artist to search...</div>';
    return;
  }

  resultsContainer.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; padding: 24px; color: var(--text-muted); gap: 8px; font-size: 11px;"><div class="hubble-spinner" style="width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.1); border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite;"></div> Searching iTunes...</div>';

  const tracks = await window.HubbleMusicService.search(q);
  if (!tracks || tracks.length === 0) {
    resultsContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); font-size: 11px; padding: 20px;">No tracks found for "' + q.replace(/</g, '&lt;') + '". Try another search!</div>';
    return;
  }

  const currentSelectedId = (window.HubbleEditor && window.HubbleEditor.state && window.HubbleEditor.state.musicTrack && window.HubbleEditor.state.musicTrack.id) || null;

  resultsContainer.innerHTML = '';
  tracks.forEach(t => {
    const isSelected = String(currentSelectedId) === String(t.id);
    const item = document.createElement('div');
    item.style.cssText = `display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 12px; background: ${isSelected ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.04)'}; border: 1px solid ${isSelected ? 'rgba(168,85,247,0.4)' : 'rgba(255,255,255,0.08)'}; transition: all 0.2s; box-sizing: border-box;`;

    item.innerHTML = `
      <img src="${t.artwork}" style="width: 36px; height: 36px; border-radius: 8px; object-fit: cover; flex-shrink: 0;" alt="Cover" />
      <div style="flex: 1; min-width: 0; text-align: left;">
        <div style="font-size: 12px; font-weight: 700; color: var(--text-main, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${t.title}</div>
        <div style="font-size: 10px; color: var(--text-muted, rgba(255,255,255,0.6)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px;">${t.artist}</div>
      </div>
      <div style="display: flex; gap: 6px; align-items: center; flex-shrink: 0;">
        <button type="button" class="story-music-preview-btn" style="background: rgba(255,255,255,0.08); border: none; color: #fff; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 11px;">▶</button>
        <button type="button" class="story-music-select-btn" style="padding: 5px 12px; border-radius: 8px; background: ${isSelected ? 'var(--primary, #a855f7)' : 'linear-gradient(135deg, var(--primary, #a855f7) 0%, #7e22ce 100%)'}; color: white; border: none; font-size: 10px; font-weight: 700; cursor: pointer;">${isSelected ? 'Selected' : 'Select'}</button>
      </div>
    `;

    const previewBtn = item.querySelector('.story-music-preview-btn');
    previewBtn.onclick = (e) => {
      e.stopPropagation();
      window.HubbleMusicService.togglePreview(t, (activeUrl) => {
        document.querySelectorAll('.story-music-preview-btn').forEach(btn => btn.innerText = '▶');
        if (activeUrl === t.previewUrl) previewBtn.innerText = '⏸';
      });
    };

    const selectBtn = item.querySelector('.story-music-select-btn');
    selectBtn.onclick = (e) => {
      e.stopPropagation();
      window.selectStoryMusic(t);
    };

    item.onclick = () => window.selectStoryMusic(t);
    resultsContainer.appendChild(item);
  });
};

window.selectStoryMusic = function (track) {
  if (window.HubbleMusicService && window.HubbleMusicService.stopPreview) {
    window.HubbleMusicService.stopPreview();
  }

  if (window.StoryAudioManager) {
    window.StoryAudioManager.load(track, 'editor');
    if (!track.isMuted) {
      window.StoryAudioManager.play('editor');
    }
  }

  if (window.HubbleEditor) {
    window.HubbleEditor.state.musicTrack = track;
    if (!window.HubbleEditor.state.layers) window.HubbleEditor.state.layers = [];
    // Remove existing music layer if present
    window.HubbleEditor.state.layers = window.HubbleEditor.state.layers.filter(l => l.type !== 'music');
    // Add Instagram-style Music sticker layer
    window.HubbleEditor.state.layers.push({
      id: 'music_sticker_' + Date.now(),
      type: 'music',
      track: track,
      content: track.title,
      artist: track.artist,
      artwork: track.artwork,
      isMuted: !!track.isMuted,
      x: 50,
      y: 72,
      rotation: 0,
      scale: 1,
      zIndex: window.HubbleEditor.state.layers.length + 20,
      styles: {}
    });

    if (typeof window.HubbleEditor.updateRender === 'function') {
      window.HubbleEditor.updateRender();
    }
  }
  if (window.chUploads && window.chUploads.length > 0) {
    const idx = (window.HubbleEditor && window.HubbleEditor.activeMediaIndex) || 0;
    if (window.chUploads[idx]) {
      if (!window.chUploads[idx].editorState) window.chUploads[idx].editorState = {};
      window.chUploads[idx].editorState.musicTrack = track;
      window.chUploads[idx].editorState.layers = window.HubbleEditor ? JSON.parse(JSON.stringify(window.HubbleEditor.state.layers)) : [];
    }
  }
  window.closeStoryMusicPicker();
  window.renderAttachedStoryBadges();
  if (window.saveCurrentDraft) window.saveCurrentDraft(true);
  if (window.showToast) window.showToast(`Music attached: ${track.title} 🎵`);
};

window.removeStoryMusic = function () {
  if (window.StoryAudioManager) {
    window.StoryAudioManager.destroy();
  }
  if (window.HubbleEditor) {
    window.HubbleEditor.state.musicTrack = null;
    if (window.HubbleEditor.state.layers) {
      window.HubbleEditor.state.layers = window.HubbleEditor.state.layers.filter(l => l.type !== 'music');
    }
    if (typeof window.HubbleEditor.updateRender === 'function') {
      window.HubbleEditor.updateRender();
    }
  }
  if (window.chUploads && window.chUploads.length > 0) {
    const idx = (window.HubbleEditor && window.HubbleEditor.activeMediaIndex) || 0;
    if (window.chUploads[idx] && window.chUploads[idx].editorState) {
      window.chUploads[idx].editorState.musicTrack = null;
      if (window.chUploads[idx].editorState.layers) {
        window.chUploads[idx].editorState.layers = window.chUploads[idx].editorState.layers.filter(l => l.type !== 'music');
      }
    }
  }
  if (window.HubbleMusicService && window.HubbleMusicService.stopPreview) {
    window.HubbleMusicService.stopPreview();
  }
  const indicator = document.getElementById('ch-music-selected-indicator');
  if (indicator) indicator.style.display = 'none';
  window.renderAttachedStoryBadges();
  if (window.saveCurrentDraft) window.saveCurrentDraft(true);
  if (window.showToast) window.showToast('Music removed.');
};

// --- LOCATION PICKER IMPLEMENTATION ---
window.openStoryLocationPicker = function () {
  const modal = document.getElementById('ch-location-picker-modal');
  if (!modal) return;

  const currentLoc = (window.HubbleEditor && window.HubbleEditor.state && window.HubbleEditor.state.selectedLocation) || null;
  const indicator = document.getElementById('ch-location-selected-indicator');
  const titleEl = document.getElementById('ch-location-selected-title');
  const subEl = document.getElementById('ch-location-selected-sub');

  if (currentLoc && indicator && titleEl) {
    titleEl.textContent = currentLoc.displayName || currentLoc.name;
    if (subEl) subEl.textContent = currentLoc.subText || '';
    indicator.style.display = 'flex';
  } else if (indicator) {
    indicator.style.display = 'none';
  }

  modal.style.display = 'flex';
  modal.style.opacity = '1';
  modal.style.visibility = 'visible';
  modal.style.pointerEvents = 'auto';
  modal.classList.add('active');

  const searchInput = document.getElementById('ch-location-search-input');
  if (searchInput) {
    if (!searchInput.value.trim()) {
      searchInput.value = 'Hyderabad';
      window.searchStoryLocation('Hyderabad');
    } else {
      window.searchStoryLocation(searchInput.value.trim());
    }
    setTimeout(() => searchInput.focus(), 50);
  }
};

window.closeStoryLocationPicker = function () {
  const modal = document.getElementById('ch-location-picker-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
    modal.style.opacity = '0';
    modal.style.visibility = 'hidden';
    modal.style.pointerEvents = 'none';
  }
};

window.openLocationPicker = window.openStoryLocationPicker;
window.closeLocationPicker = window.closeStoryLocationPicker;

window.handleStoryLocationInput = function (query) {
  if (_storyLocationSearchTimeout) clearTimeout(_storyLocationSearchTimeout);
  _storyLocationSearchTimeout = setTimeout(() => {
    window.searchStoryLocation(query);
  }, 350);
};

window.setStoryLocationPreset = function (placeName) {
  const input = document.getElementById('ch-location-search-input');
  if (input) input.value = placeName;
  window.searchStoryLocation(placeName);
};

window.searchStoryLocation = async function (query) {
  const resultsContainer = document.getElementById('ch-location-results-list');
  if (!resultsContainer) return;

  const q = (query || '').trim();
  if (!q) {
    resultsContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); font-size: 11px; padding: 20px;">Type a location to search...</div>';
    return;
  }

  resultsContainer.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; padding: 24px; color: var(--text-muted); gap: 8px; font-size: 11px;"><div class="hubble-spinner" style="width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.1); border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite;"></div> Searching OpenStreetMap...</div>';

  const places = await window.HubbleLocationService.search(q);
  if (!places || places.length === 0) {
    resultsContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); font-size: 11px; padding: 20px;">No locations found for "' + q.replace(/</g, '&lt;') + '". Try another location!</div>';
    return;
  }

  const currentSelectedId = (window.HubbleEditor && window.HubbleEditor.state && window.HubbleEditor.state.selectedLocation && window.HubbleEditor.state.selectedLocation.id) || null;

  resultsContainer.innerHTML = '';
  places.forEach(p => {
    const isSelected = String(currentSelectedId) === String(p.id);
    const item = document.createElement('div');
    item.style.cssText = `display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 12px; background: ${isSelected ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.04)'}; border: 1px solid ${isSelected ? 'rgba(168,85,247,0.4)' : 'rgba(255,255,255,0.08)'}; cursor: pointer; transition: all 0.2s; box-sizing: border-box; text-align: left;`;

    item.innerHTML = `
      <div style="width: 30px; height: 30px; border-radius: 50%; background: rgba(168,85,247,0.2); color: var(--primary, #a855f7); display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 13px;">📍</div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: 12px; font-weight: 700; color: var(--text-main, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${p.displayName || p.name}</div>
        ${p.subText ? `<div style="font-size: 10px; color: var(--text-muted, rgba(255,255,255,0.6)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px;">${p.subText}</div>` : ''}
      </div>
      <button type="button" style="padding: 5px 12px; border-radius: 8px; background: ${isSelected ? 'var(--primary, #a855f7)' : 'linear-gradient(135deg, var(--primary, #a855f7) 0%, #7e22ce 100%)'}; color: white; border: none; font-size: 10px; font-weight: 700; cursor: pointer; flex-shrink: 0;">${isSelected ? 'Selected' : 'Select'}</button>
    `;

    item.onclick = () => window.selectStoryLocation(p);
    resultsContainer.appendChild(item);
  });
};

window.selectStoryLocation = function (loc) {
  if (window.HubbleEditor) {
    window.HubbleEditor.state.selectedLocation = loc;
    if (!window.HubbleEditor.state.layers) window.HubbleEditor.state.layers = [];
    // Remove existing location layer if present
    window.HubbleEditor.state.layers = window.HubbleEditor.state.layers.filter(l => l.type !== 'location');
    // Add Instagram-style Location sticker layer
    window.HubbleEditor.state.layers.push({
      id: 'location_sticker_' + Date.now(),
      type: 'location',
      loc: loc,
      content: loc.displayName || loc.name,
      x: 50,
      y: 25,
      rotation: 0,
      scale: 1,
      zIndex: window.HubbleEditor.state.layers.length + 20,
      styles: {}
    });
    if (typeof window.HubbleEditor.updateRender === 'function') {
      window.HubbleEditor.updateRender();
    }
  }
  if (window.chUploads && window.chUploads.length > 0) {
    const idx = (window.HubbleEditor && window.HubbleEditor.activeMediaIndex) || 0;
    if (window.chUploads[idx]) {
      if (!window.chUploads[idx].editorState) window.chUploads[idx].editorState = {};
      window.chUploads[idx].editorState.selectedLocation = loc;
      window.chUploads[idx].editorState.layers = window.HubbleEditor ? JSON.parse(JSON.stringify(window.HubbleEditor.state.layers)) : [];
    }
  }
  window.closeStoryLocationPicker();
  window.renderAttachedStoryBadges();
  if (window.saveCurrentDraft) window.saveCurrentDraft(true);
  if (window.showToast) window.showToast(`Location attached: ${loc.displayName || loc.name} 📍`);
};

window.removeStoryLocation = function () {
  if (window.HubbleEditor) {
    window.HubbleEditor.state.selectedLocation = null;
    if (window.HubbleEditor.state.layers) {
      window.HubbleEditor.state.layers = window.HubbleEditor.state.layers.filter(l => l.type !== 'location');
    }
    if (typeof window.HubbleEditor.updateRender === 'function') {
      window.HubbleEditor.updateRender();
    }
  }
  if (window.chUploads && window.chUploads.length > 0) {
    const idx = (window.HubbleEditor && window.HubbleEditor.activeMediaIndex) || 0;
    if (window.chUploads[idx] && window.chUploads[idx].editorState) {
      window.chUploads[idx].editorState.selectedLocation = null;
      if (window.chUploads[idx].editorState.layers) {
        window.chUploads[idx].editorState.layers = window.chUploads[idx].editorState.layers.filter(l => l.type !== 'location');
      }
    }
  }
  const indicator = document.getElementById('ch-location-selected-indicator');
  if (indicator) indicator.style.display = 'none';
  window.renderAttachedStoryBadges();
  if (window.saveCurrentDraft) window.saveCurrentDraft(true);
  if (window.showToast) window.showToast('Location removed.');
};

// --- INDEXEDDB DRAFTS WRAPPER ---
const DraftsDB = {
  dbName: 'HiHubbleDrafts',
  dbVersion: 1,
  storeName: 'drafts',
  _db: null,
  async init() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'id' });
        }
      };
      request.onsuccess = (e) => {
        this._db = e.target.result;
        resolve(this._db);
      };
      request.onerror = (e) => reject(e.target.error);
    });
  },
  async saveDraft(draft) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      draft.lastModified = Date.now();
      if (!draft.id) draft.id = 'draft_story_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      if (!draft.createdAt) draft.createdAt = Date.now();
      draft.type = 'story';
      const request = store.put(draft);
      request.onsuccess = () => resolve(draft);
      request.onerror = () => reject(request.error);
    });
  },
  async getDrafts() {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.getAll();
      request.onsuccess = () => {
        const results = (request.result || [])
          .filter(d => !d.type || d.type === 'story')
          .sort((a, b) => (b.lastModified || b.createdAt || 0) - (a.lastModified || a.createdAt || 0));
        resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  },
  async getDraftById(id) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  },
  async deleteDraft(id) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
};
window.DraftsDB = DraftsDB;

// Helper to generate a lightweight dataUrl thumbnail for persistent storage
async function generateDraftThumbnail(item) {
  if (!item) return '';
  if (item.type && item.type.startsWith('video/')) {
    return item.thumbUrl || '';
  }
  if (item.thumbUrl && item.thumbUrl.startsWith('data:')) {
    return item.thumbUrl;
  }
  try {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    let src = item.thumbUrl;
    if (!src && item.file) {
      src = URL.createObjectURL(item.file);
    }
    if (!src) return '';
    img.src = src;
    await new Promise((resolve) => {
      if (img.complete && img.naturalWidth) return resolve();
      img.onload = resolve;
      img.onerror = () => resolve();
    });
    if (!img.naturalWidth) return item.thumbUrl || '';
    const canvas = document.createElement('canvas');
    const maxSize = 160;
    let w = img.naturalWidth || 100;
    let h = img.naturalHeight || 100;
    if (w > h) {
      if (w > maxSize) { h = Math.round(h * (maxSize / w)); w = maxSize; }
    } else {
      if (h > maxSize) { w = Math.round(w * (maxSize / h)); h = maxSize; }
    }
    canvas.width = Math.max(30, w);
    canvas.height = Math.max(30, h);
    const ctx = canvas.getContext('2d');
    if (item.editorState && window.HubbleEditor && window.HubbleEditor.buildCSSFilterString) {
      ctx.filter = window.HubbleEditor.buildCSSFilterString(item.editorState.filter, item.editorState.adjustments || {});
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (_) {
    return item.thumbUrl || '';
  }
}

// --- SAVE DRAFT ACTION ---
window.saveCurrentDraft = async function (silent = false) {
  const captionEl = document.getElementById('ch-caption-input') || document.querySelector('.ch-caption-input');
  const captionVal = captionEl ? captionEl.value.trim() : '';

  if ((!window.chUploads || window.chUploads.length === 0) && !captionVal) {
    if (!silent) showToast('Please upload media or add a caption first.');
    return null;
  }

  // Ensure current active HubbleEditor state is synced to the active media item
  if (window.HubbleEditor && window.chUploads && window.chUploads[window.HubbleEditor.activeMediaIndex || 0]) {
    const activeMedia = window.chUploads[window.HubbleEditor.activeMediaIndex || 0];
    activeMedia.editorState = JSON.parse(JSON.stringify(window.HubbleEditor.state));
    activeMedia.isMuted = !!window.HubbleEditor.state.isMuted;
  }

  const primaryItem = window.chUploads && window.chUploads[0];
  let primaryThumb = '';
  if (primaryItem) {
    primaryThumb = await generateDraftThumbnail(primaryItem);
  }

  const mediaItemsToSave = await Promise.all((window.chUploads || []).map(async (m) => {
    let itemThumb = m.thumbUrl;
    if (m.type && !m.type.startsWith('video/')) {
      const generated = await generateDraftThumbnail(m);
      if (generated) itemThumb = generated;
    }
    const isItemMuted = !!(m.isMuted || (m.editorState && m.editorState.isMuted) || (window.HubbleEditor && window.HubbleEditor.state && window.HubbleEditor.state.isMuted));
    return {
      file: m.file, // Blob or File object stored directly in IndexedDB
      type: m.type || 'image/jpeg',
      thumbDataUrl: itemThumb,
      thumbUrl: itemThumb,
      duration: m.duration || 0,
      originalWidth: m.originalWidth || 1000,
      originalHeight: m.originalHeight || 1000,
      name: m.name || 'media',
      size: m.size || 0,
      isMuted: isItemMuted,
      editorState: m.editorState ? { ...JSON.parse(JSON.stringify(m.editorState)), isMuted: isItemMuted } : {
        filter: 'original', rotation: 0, zoom: 1, panX: 0, panY: 0,
        adjustments: { brightness: 100, contrast: 100, exposure: 100, highlights: 100, shadows: 100, temperature: 0, tint: 0, saturation: 100, vibrance: 100, sharpness: 0, blur: 0, opacity: 100 },
        crop: null, layers: [], isMuted: isItemMuted, musicTrack: null, selectedLocation: null
      }
    };
  }));

  const draftTitle = captionVal || (primaryItem ? (primaryItem.name || 'HUBB Draft') : 'Untitled HUBB');

  const draft = {
    id: window.currentDraftId || ('draft_story_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)),
    type: 'story',
    title: draftTitle,
    caption: captionVal,
    thumbDataUrl: primaryThumb,
    mediaThumbUrl: primaryThumb,
    mediaFile: primaryItem ? primaryItem.file : null,
    mediaType: primaryItem ? primaryItem.type : 'image',
    mediaItems: mediaItemsToSave,
    mediaCount: mediaItemsToSave.length,
    editorState: window.HubbleEditor ? JSON.parse(JSON.stringify(window.HubbleEditor.state)) : null,
    activeLayout: (window.HubbleEditor && window.HubbleEditor.activeLayout) || 'original',
    activeMediaIndex: (window.HubbleEditor && window.HubbleEditor.activeMediaIndex) || 0,
    scheduleEnabled: document.getElementById('ch-schedule-toggle')?.checked || false,
    scheduleDate: document.getElementById('ch-schedule-date')?.value || '',
    scheduleTime: document.getElementById('ch-schedule-time')?.value || '',
    createdAt: window.currentDraftCreatedAt || Date.now(),
    lastModified: Date.now()
  };

  window.currentDraftId = draft.id;
  window.currentDraftCreatedAt = draft.createdAt;
  window.lastDraftSavedAt = draft.lastModified;

  try {
    await DraftsDB.saveDraft(draft);
    if (!silent && !window._silentDraftSave) {
      showToast('Saved as draft! 📝');
    }
    window._silentDraftSave = false;
    window.updateLastSavedLabel();
    await window.renderDraftsList();
    if (document.getElementById('story-drafts-modal')?.classList.contains('active')) {
      const searchVal = document.getElementById('see-all-drafts-search')?.value || '';
      await window.renderSeeAllDrafts(searchVal);
    }
    window.dispatchEvent(new CustomEvent('hihubble_story_draft_change', { detail: { action: 'save', draftId: draft.id } }));
    return draft;
  } catch (err) {
    console.error('Failed to save draft:', err);
    if (!silent && !window._silentDraftSave) {
      showToast('Failed to save draft. Please try again.');
    }
    window._silentDraftSave = false;
    return null;
  }
};

window.renderDraftsList = async function () {
  const list = document.getElementById('ch-drafts-list');
  const countLabel = document.getElementById('drafts-count');
  const emptyState = document.getElementById('drafts-empty-state');
  const seeAllBtn = document.getElementById('see-all-drafts-btn');
  const hddList = document.getElementById('hdd-list');
  const hddEmptyState = document.getElementById('hdd-empty-state');

  const drafts = await DraftsDB.getDrafts();
  const totalCount = drafts.length;

  if (countLabel) countLabel.innerText = totalCount;
  const seeAllBadge = document.getElementById('see-all-drafts-count-badge');
  if (seeAllBadge) seeAllBadge.innerText = totalCount;

  // Clear sidebar list (except empty state)
  if (list) {
    Array.from(list.children).forEach(child => {
      if (child.id !== 'drafts-empty-state') child.remove();
    });
  }
  if (hddList) {
    Array.from(hddList.children).forEach(child => {
      if (child.id !== 'hdd-empty-state') child.remove();
    });
  }

  if (totalCount === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    if (hddEmptyState) hddEmptyState.style.display = 'flex';
    if (seeAllBtn) seeAllBtn.style.display = 'none';
  } else {
    if (emptyState) emptyState.style.display = 'none';
    if (hddEmptyState) hddEmptyState.style.display = 'none';
    if (seeAllBtn) seeAllBtn.style.display = 'block';

    // Render newest 4 drafts in sidebar
    drafts.slice(0, 4).forEach(d => {
      const timeStr = window.formatRelativeTime(d.lastModified || d.createdAt);
      const title = d.caption || d.title || 'Untitled HUBB';
      const thumbInfo = getDraftThumbnailInfo(d);
      const mediaCount = (d.mediaItems && d.mediaItems.length) || (d.mediaCount || 1);
      const isVideo = thumbInfo.isVideo;

      // Sidebar item in Create Hubbs view
      if (list) {
        const item = document.createElement('div');
        item.className = 'ch-draft-item';
        item.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background: rgba(255,255,255,0.03); padding: 10px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.06); cursor: pointer; transition: all 0.2s cubic-bezier(0.2, 0.8, 0.2, 1); box-sizing: border-box; width: 100%; max-width: 100%; min-width: 0; overflow: hidden;';
        item.onmouseover = () => { item.style.background = 'rgba(255,255,255,0.07)'; item.style.borderColor = 'rgba(168,85,247,0.3)'; item.style.transform = 'translateY(-1px)'; };
        item.onmouseout = () => { item.style.background = 'rgba(255,255,255,0.03)'; item.style.borderColor = 'rgba(255,255,255,0.06)'; item.style.transform = 'none'; };
        item.onclick = (e) => {
          if (e.target.closest('button')) return;
          window.loadDraft(d.id);
        };

        item.innerHTML = `
          <div style="display:flex; gap:10px; align-items:center; min-width:0; flex:1; overflow:hidden;">
            <div style="position:relative; width:44px; height:44px; flex-shrink:0; border-radius:10px; overflow:hidden; background:#111; border: 1px solid rgba(255,255,255,0.1);">
              ${renderThumbnailHTML(thumbInfo)}
              ${mediaCount > 1 ? `<div style="position:absolute; bottom:2px; right:2px; background:var(--primary); color:white; font-size:0.55rem; font-weight:700; padding:1px 4px; border-radius:6px; line-height:1.1;">${mediaCount}</div>` : ''}
              ${isVideo ? `<div style="position:absolute; top:2px; left:2px; background:rgba(0,0,0,0.6); color:white; font-size:0.5rem; padding:1px 3px; border-radius:4px;"><i data-lucide="video" style="width:8px; height:8px;"></i></div>` : ''}
            </div>
            <div class="ch-draft-info" style="min-width:0; flex:1; overflow:hidden;">
              <div class="ch-draft-title" style="font-weight:600; font-size:0.85rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--text-main); max-width:100%;">${title}</div>
              <div class="ch-draft-time" data-timestamp="${d.lastModified || d.createdAt}" style="color:var(--text-muted); font-size:0.75rem; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%;">Saved ${timeStr}</div>
            </div>
          </div>
          <div style="display:flex; gap:4px; flex-shrink:0; margin-left:6px;">
            <button title="Duplicate Draft" onclick="window.duplicateDraft('${d.id}', event)" style="background:transparent; border:none; color:var(--text-muted); padding:6px; border-radius:6px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:color 0.2s;" onmouseover="this.style.color='var(--text-main)'" onmouseout="this.style.color='var(--text-muted)'"><i data-lucide="copy" style="width:14px; height:14px;"></i></button>
            <button title="Delete Draft" onclick="window.deleteDraft('${d.id}', event)" style="background:transparent; border:none; color:#ef4444; padding:6px; border-radius:6px; cursor:pointer; opacity:0.8; display:flex; align-items:center; justify-content:center; transition:opacity 0.2s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.8'"><i data-lucide="trash-2" style="width:14px; height:14px;"></i></button>
          </div>
        `;
        list.appendChild(item);
      }

      // Home Dropdown Panel Item
      if (hddList) {
        const hItem = document.createElement('div');
        hItem.className = 'ch-draft-item';
        hItem.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background: rgba(255,255,255,0.03); padding: 10px; border-radius: 12px; margin-bottom: 8px; cursor: pointer; transition: all 0.2s ease; border: 1px solid transparent; box-sizing: border-box; width: 100%; max-width: 100%; min-width: 0; overflow: hidden;';
        hItem.onclick = (e) => {
          if (e.target.closest('button')) return;
          document.getElementById('home-drafts-panel')?.classList.remove('open');
          window.loadDraft(d.id);
        };
        hItem.onmouseover = () => { hItem.style.transform = 'translateY(-2px)'; hItem.style.background = 'rgba(255,255,255,0.08)'; hItem.style.borderColor = 'rgba(168, 85, 247, 0.3)'; };
        hItem.onmouseout = () => { hItem.style.transform = 'none'; hItem.style.background = 'rgba(255,255,255,0.03)'; hItem.style.borderColor = 'transparent'; };
        hItem.innerHTML = `
          <div style="display:flex; gap:12px; align-items:center; min-width:0; flex:1; overflow:hidden;">
            <div style="position: relative; width:48px; height:48px; flex-shrink:0; border-radius:10px; overflow:hidden;">
              <img src="${imgUrl}" style="width:100%; height:100%; object-fit:cover;" alt="Draft">
              ${mediaCount > 1 ? `<div style="position: absolute; bottom: 0; right: 0; background: var(--primary); color: white; font-size: 0.6rem; font-weight: bold; padding: 2px 5px; border-radius: 6px;">${mediaCount}</div>` : ''}
            </div>
            <div class="ch-draft-info" style="min-width:0; flex:1; overflow:hidden;">
              <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px;">
                <div class="ch-draft-title" style="font-weight:600; font-size:0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-main); max-width: 100%;">${title}</div>
                <span style="font-size: 0.6rem; background: rgba(255,255,255,0.1); color: var(--text-muted); padding: 2px 6px; border-radius: 4px; flex-shrink: 0;">HUBB</span>
              </div>
              <div class="ch-draft-time" data-timestamp="${d.lastModified || d.createdAt}" style="color:var(--text-muted); font-size:0.75rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">Saved ${timeStr}</div>
            </div>
          </div>
          <div style="display: flex; gap: 4px; flex-shrink: 0; margin-left: 6px;">
            <button onclick="window.deleteDraft('${d.id}', event)" style="background:transparent; border:none; color: #ef4444; padding:8px; cursor:pointer; opacity: 0.8; transition: transform 0.2s;"><i data-lucide="trash-2" style="width:16px; height:16px;"></i></button>
          </div>
        `;
        hddList.appendChild(hItem);
      }
    });
  }

  if (window.lucide) window.lucide.createIcons();
};

// --- HUBBS DRAFTS MULTI-SELECTION & BULK DELETION CONTROLLER ---
window.draftsSelectionMode = false;
window.selectedDraftIds = new Set();

window.enterDraftsSelectionMode = function () {
  window.draftsSelectionMode = true;
  window.selectedDraftIds.clear();

  const modal = document.getElementById('story-drafts-modal');
  if (modal) modal.classList.add('selection-mode');

  const normActions = document.getElementById('see-all-drafts-normal-actions');
  const selActions = document.getElementById('see-all-drafts-selection-actions');
  if (normActions) normActions.style.display = 'none';
  if (selActions) selActions.style.display = 'flex';

  window.updateDraftsSelectionUI();

  const searchVal = document.getElementById('see-all-drafts-search')?.value || '';
  window.renderSeeAllDrafts(searchVal);
};

window.exitDraftsSelectionMode = function () {
  window.draftsSelectionMode = false;
  window.selectedDraftIds.clear();

  const modal = document.getElementById('story-drafts-modal');
  if (modal) modal.classList.remove('selection-mode');

  const normActions = document.getElementById('see-all-drafts-normal-actions');
  const selActions = document.getElementById('see-all-drafts-selection-actions');
  if (normActions) normActions.style.display = 'flex';
  if (selActions) selActions.style.display = 'none';

  window.updateDraftsSelectionUI();

  const searchVal = document.getElementById('see-all-drafts-search')?.value || '';
  window.renderSeeAllDrafts(searchVal);
};

window.updateDraftsSelectionUI = function () {
  const count = window.selectedDraftIds.size;
  const countEl = document.getElementById('see-all-drafts-selected-count');
  if (countEl) countEl.innerText = count;

  const delBtn = document.getElementById('see-all-drafts-delete-selected-btn');
  if (delBtn) {
    if (count > 0) {
      delBtn.disabled = false;
      delBtn.style.opacity = '1';
      delBtn.style.cursor = 'pointer';
      delBtn.style.pointerEvents = 'auto';
    } else {
      delBtn.disabled = true;
      delBtn.style.opacity = '0.5';
      delBtn.style.cursor = 'not-allowed';
      delBtn.style.pointerEvents = 'none';
    }
  }
};

window.toggleDraftSelection = function (id) {
  if (!id) return;
  if (window.selectedDraftIds.has(id)) {
    window.selectedDraftIds.delete(id);
  } else {
    window.selectedDraftIds.add(id);
  }

  // Visual card update
  const card = document.querySelector(`.see-all-draft-card[data-draft-id="${id}"]`);
  if (card) {
    const isSelected = window.selectedDraftIds.has(id);
    card.classList.toggle('selected', isSelected);
    const chk = card.querySelector('.see-all-draft-checkbox');
    if (chk) chk.classList.toggle('checked', isSelected);
  }

  window.updateDraftsSelectionUI();
};

window.selectAllDrafts = function () {
  if (!window.draftsSelectionMode) {
    window.draftsSelectionMode = true;
    const modal = document.getElementById('story-drafts-modal');
    if (modal) modal.classList.add('selection-mode');
    const normActions = document.getElementById('see-all-drafts-normal-actions');
    const selActions = document.getElementById('see-all-drafts-selection-actions');
    if (normActions) normActions.style.display = 'none';
    if (selActions) selActions.style.display = 'flex';
  }

  const cards = document.querySelectorAll('#story-drafts-list .see-all-draft-card');
  cards.forEach(card => {
    const id = card.getAttribute('data-draft-id');
    if (id) {
      window.selectedDraftIds.add(id);
      card.classList.add('selected');
      const chk = card.querySelector('.see-all-draft-checkbox');
      if (chk) chk.classList.add('checked');
    }
  });

  window.updateDraftsSelectionUI();
};

window.closeDraftsConfirmDialog = function () {
  const dialog = document.getElementById('see-all-drafts-confirm-dialog');
  if (dialog) dialog.style.display = 'none';
};

window.promptDeleteSelectedDrafts = function () {
  const count = window.selectedDraftIds.size;
  if (count === 0) {
    showToast('No drafts selected.');
    return;
  }

  const dialog = document.getElementById('see-all-drafts-confirm-dialog');
  const titleEl = document.getElementById('see-all-drafts-confirm-title');
  const descEl = document.getElementById('see-all-drafts-confirm-desc');
  const confirmBtn = document.getElementById('see-all-drafts-confirm-delete-btn');

  if (titleEl) titleEl.innerText = `Delete ${count} Selected Draft${count > 1 ? 's' : ''}?`;
  if (descEl) descEl.innerText = `Are you sure you want to delete ${count} selected HUBB draft${count > 1 ? 's' : ''}? This action cannot be undone.`;
  if (confirmBtn) {
    confirmBtn.innerText = `Delete (${count})`;
    confirmBtn.onclick = window.executeDeleteSelectedDrafts;
  }

  if (dialog) dialog.style.display = 'flex';
};

window.executeDeleteSelectedDrafts = async function () {
  window.closeDraftsConfirmDialog();
  const idsToDelete = Array.from(window.selectedDraftIds);
  if (idsToDelete.length === 0) return;

  try {
    for (const id of idsToDelete) {
      await DraftsDB.deleteDraft(id);
      if (window.currentDraftId === id) {
        window.currentDraftId = null;
        window.currentDraftCreatedAt = null;
      }
    }

    const count = idsToDelete.length;
    showToast(`${count} draft${count > 1 ? 's' : ''} deleted! 🗑️`);
    window.selectedDraftIds.clear();
    window.exitDraftsSelectionMode();
    await window.renderDraftsList();
    const searchVal = document.getElementById('see-all-drafts-search')?.value || '';
    await window.renderSeeAllDrafts(searchVal);
    window.dispatchEvent(new CustomEvent('hihubble_story_draft_change', { detail: { action: 'delete_bulk', count } }));
  } catch (err) {
    console.error('Failed to delete selected drafts:', err);
    showToast('Error deleting selected drafts.');
  }
};

window.promptDeleteAllDrafts = async function () {
  const drafts = await DraftsDB.getDrafts();
  if (!drafts || drafts.length === 0) {
    showToast('No drafts to delete.');
    return;
  }

  const dialog = document.getElementById('see-all-drafts-confirm-dialog');
  const titleEl = document.getElementById('see-all-drafts-confirm-title');
  const descEl = document.getElementById('see-all-drafts-confirm-desc');
  const confirmBtn = document.getElementById('see-all-drafts-confirm-delete-btn');

  if (titleEl) titleEl.innerText = 'Delete All HUBB Drafts?';
  if (descEl) descEl.innerText = `Are you sure you want to permanently delete all ${drafts.length} HUBB drafts? This action cannot be undone.`;
  if (confirmBtn) {
    confirmBtn.innerText = `Delete All (${drafts.length})`;
    confirmBtn.onclick = window.executeDeleteAllDrafts;
  }

  if (dialog) dialog.style.display = 'flex';
};

window.executeDeleteAllDrafts = async function () {
  window.closeDraftsConfirmDialog();
  try {
    const drafts = await DraftsDB.getDrafts();
    for (const d of drafts) {
      await DraftsDB.deleteDraft(d.id);
    }
    window.currentDraftId = null;
    window.currentDraftCreatedAt = null;
    window.selectedDraftIds.clear();
    window.exitDraftsSelectionMode();
    showToast('All HUBB drafts deleted! 🗑️');
    await window.renderDraftsList();
    await window.renderSeeAllDrafts('');
    window.dispatchEvent(new CustomEvent('hihubble_story_draft_change', { detail: { action: 'delete_all' } }));
  } catch (err) {
    console.error('Failed to delete all drafts:', err);
    showToast('Error deleting all drafts.');
  }
};

window.renderSeeAllDrafts = async function (query = '') {
  const modalList = document.getElementById('story-drafts-list');
  const countBadge = document.getElementById('see-all-drafts-count-badge');
  const bottomBar = document.getElementById('see-all-drafts-bottom-bar');
  const searchBox = document.getElementById('see-all-drafts-search-container');
  if (!modalList) return;

  const drafts = await DraftsDB.getDrafts();
  const totalCount = drafts.length;
  if (countBadge) countBadge.innerText = totalCount;

  if (totalCount === 0) {
    if (bottomBar) bottomBar.style.display = 'none';
    if (searchBox) searchBox.style.display = 'none';
    window.draftsSelectionMode = false;
    window.selectedDraftIds.clear();
    const modal = document.getElementById('story-drafts-modal');
    if (modal) modal.classList.remove('selection-mode');

    modalList.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:54px 20px; text-align:center; color:var(--text-muted);">
        <div style="width:64px; height:64px; border-radius:50%; background:rgba(168,85,247,0.1); color:var(--primary); display:flex; align-items:center; justify-content:center; margin-bottom:16px;">
          <i data-lucide="folder" style="width:32px; height:32px;"></i>
        </div>
        <h4 style="margin:0 0 6px 0; color:var(--text-main); font-size:1.15rem; font-weight:700;">No HUBBs Drafts Yet</h4>
        <p style="margin:0; font-size:0.88rem; opacity:0.75; max-width:280px; line-height:1.4;">Saved HUBBs will appear here.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  if (bottomBar) bottomBar.style.display = 'flex';
  if (searchBox) searchBox.style.display = 'block';

  // Update Action Bar buttons
  const normActions = document.getElementById('see-all-drafts-normal-actions');
  const selActions = document.getElementById('see-all-drafts-selection-actions');
  if (window.draftsSelectionMode) {
    if (normActions) normActions.style.display = 'none';
    if (selActions) selActions.style.display = 'flex';
  } else {
    if (normActions) normActions.style.display = 'flex';
    if (selActions) selActions.style.display = 'none';
  }
  window.updateDraftsSelectionUI();

  const lowerQuery = (query || '').toLowerCase().trim();
  const filtered = drafts.filter(d => {
    if (!lowerQuery) return true;
    const title = (d.caption || d.title || '').toLowerCase();
    const dateStr = new Date(d.createdAt || d.lastModified || 0).toLocaleDateString().toLowerCase();
    return title.includes(lowerQuery) || dateStr.includes(lowerQuery);
  });

  modalList.innerHTML = '';

  if (filtered.length === 0) {
    modalList.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:48px 20px; text-align:center; color:var(--text-muted);">
        <i data-lucide="search" style="width:44px; height:44px; color:rgba(255,255,255,0.2); margin-bottom:12px;"></i>
        <h4 style="margin:0 0 6px 0; color:var(--text-main); font-size:1.05rem;">No matching drafts found</h4>
        <p style="margin:0; font-size:0.85rem; opacity:0.7;">Try searching for another keyword.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  filtered.forEach(d => {
    const isSelected = window.selectedDraftIds.has(d.id);
    const timeStr = window.formatRelativeTime(d.lastModified || d.createdAt);
    const createdStr = d.createdAt ? new Date(d.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unknown';
    const title = d.caption || d.title || 'Untitled HUBB';
    const thumbInfo = getDraftThumbnailInfo(d);
    const mediaCount = (d.mediaItems && d.mediaItems.length) || (d.mediaCount || 1);
    const isVideo = thumbInfo.isVideo;

    const card = document.createElement('div');
    card.className = `see-all-draft-card ${isSelected ? 'selected' : ''}`;
    card.setAttribute('data-draft-id', d.id);

    // Card click handler
    card.onclick = (e) => {
      if (window.draftsSelectionMode) {
        window.toggleDraftSelection(d.id);
      } else {
        if (e.target.closest('button') || e.target.closest('.see-all-draft-checkbox')) return;
        window.loadDraft(d.id);
      }
    };

    card.innerHTML = `
      <div class="see-all-draft-checkbox ${isSelected ? 'checked' : ''}" data-draft-id="${d.id}" onclick="event.stopPropagation(); window.toggleDraftSelection('${d.id}');">
        <i data-lucide="check"></i>
      </div>
      <div style="display:flex; gap:14px; align-items:center; min-width:0; flex:1; cursor:pointer;">
        <div style="position:relative; width:64px; height:64px; flex-shrink:0; border-radius:12px; overflow:hidden; background:#111; border: 1px solid rgba(255,255,255,0.12); box-shadow:0 4px 12px rgba(0,0,0,0.3);">
          ${renderThumbnailHTML(thumbInfo)}
          ${mediaCount > 1 ? `<div style="position:absolute; bottom:3px; right:3px; background:var(--primary); color:white; font-size:0.65rem; font-weight:700; padding:2px 5px; border-radius:6px; box-shadow:0 2px 6px rgba(0,0,0,0.4);">${mediaCount} items</div>` : ''}
          ${isVideo ? `<div style="position:absolute; top:3px; left:3px; background:rgba(0,0,0,0.7); color:white; font-size:0.6rem; padding:2px 4px; border-radius:4px; backdrop-filter:blur(4px);"><i data-lucide="video" style="width:10px; height:10px;"></i></div>` : ''}
        </div>
        <div style="min-width:0; flex:1;">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
            <h4 class="see-all-draft-card-title" style="margin:0; font-size:0.95rem; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${title}</h4>
            <span class="see-all-draft-card-badge" style="font-size:0.65rem; padding:2px 6px; border-radius:6px; font-weight:600; flex-shrink:0;">HUBB</span>
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:10px; font-size:0.75rem; color:var(--text-muted);">
            <span class="see-all-draft-time" data-timestamp="${d.lastModified || d.createdAt}"><i data-lucide="clock" style="width:12px; height:12px; display:inline; vertical-align:middle; margin-right:3px;"></i> Saved ${timeStr}</span>
            <span><i data-lucide="calendar" style="width:12px; height:12px; display:inline; vertical-align:middle; margin-right:3px;"></i> Created ${createdStr}</span>
          </div>
        </div>
      </div>
      <div class="see-all-draft-actions-group" style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
        <button class="see-all-draft-continue-btn" onclick="if(!window.draftsSelectionMode) { event.stopPropagation(); window.loadDraft('${d.id}'); }"><i data-lucide="edit-3" style="width:14px; height:14px;"></i> Continue Editing</button>
        <button class="see-all-draft-dup-btn" title="Duplicate Draft" onclick="if(!window.draftsSelectionMode) { window.duplicateDraft('${d.id}', event); }"><i data-lucide="copy" style="width:16px; height:16px;"></i></button>
        <button class="see-all-draft-del-btn" title="Delete Draft" onclick="if(!window.draftsSelectionMode) { window.deleteDraft('${d.id}', event); }"><i data-lucide="trash-2" style="width:16px; height:16px;"></i></button>
      </div>
    `;
    modalList.appendChild(card);
  });

  if (window.lucide) window.lucide.createIcons();
};

window.openSeeAllDrafts = function () {
  const modal = document.getElementById('story-drafts-modal');
  if (!modal) return;
  modal.classList.add('active');
  const searchInput = document.getElementById('see-all-drafts-search');
  if (searchInput) searchInput.value = '';
  window.draftsSelectionMode = false;
  window.selectedDraftIds.clear();
  window.renderSeeAllDrafts();
};

window.loadDraft = async function (id) {
  try {
    const d = await DraftsDB.getDraftById(id);
    if (!d) {
      showToast('Draft not found or already deleted.');
      return;
    }

    // 0. Clean up any previous playing video/audio
    if (typeof window.cleanupStoryMedia === 'function') {
      window.cleanupStoryMedia();
    }

    window.currentDraftId = d.id;
    window.currentDraftCreatedAt = d.createdAt || Date.now();
    window.lastDraftSavedAt = d.lastModified || Date.now();

    // 1. Rebuild window.chUploads with working object URLs and editorStates
    if (d.mediaItems && d.mediaItems.length > 0) {
      window.chUploads = d.mediaItems.map(m => {
        let objectUrl = '';
        if (m.file) {
          try { objectUrl = URL.createObjectURL(m.file); } catch (_) { objectUrl = m.thumbDataUrl || m.thumbUrl; }
        } else {
          objectUrl = m.thumbDataUrl || m.thumbUrl || '';
        }
        return {
          file: m.file,
          type: m.type || 'image/jpeg',
          thumbUrl: objectUrl || m.thumbDataUrl || m.thumbUrl,
          duration: m.duration || 0,
          originalWidth: m.originalWidth || 1000,
          originalHeight: m.originalHeight || 1000,
          name: m.name || 'media',
          size: m.size || 0,
          editorState: m.editorState ? JSON.parse(JSON.stringify(m.editorState)) : {
            filter: 'original', rotation: 0, zoom: 1, panX: 0, panY: 0,
            adjustments: { brightness: 100, contrast: 100, exposure: 100, highlights: 100, shadows: 100, temperature: 0, tint: 0, saturation: 100, vibrance: 100, sharpness: 0, blur: 0, opacity: 100 },
            crop: null, layers: [], isMuted: false, musicTrack: null, selectedLocation: null
          }
        };
      });
    } else if (d.mediaFile || d.mediaThumbUrl) {
      let objectUrl = '';
      if (d.mediaFile) {
        try { objectUrl = URL.createObjectURL(d.mediaFile); } catch (_) { objectUrl = d.thumbDataUrl || d.mediaThumbUrl; }
      } else {
        objectUrl = d.thumbDataUrl || d.mediaThumbUrl;
      }
      window.chUploads = [{
        file: d.mediaFile,
        type: d.mediaType || 'image/jpeg',
        thumbUrl: objectUrl,
        duration: 0,
        originalWidth: 1000,
        originalHeight: 1000,
        name: 'draft_media',
        size: 0,
        editorState: d.editorState ? JSON.parse(JSON.stringify(d.editorState)) : {
          filter: 'original', rotation: 0, zoom: 1, panX: 0, panY: 0,
          adjustments: { brightness: 100, contrast: 100, exposure: 100, highlights: 100, shadows: 100, temperature: 0, tint: 0, saturation: 100, vibrance: 100, sharpness: 0, blur: 0, opacity: 100 },
          crop: null, layers: [], isMuted: false, musicTrack: null, selectedLocation: null
        }
      }];
    } else {
      window.chUploads = [];
    }

    // 2. Restore HubbleEditor state
    if (window.HubbleEditor) {
      window.HubbleEditor.activeMediaIndex = d.activeMediaIndex || 0;
      const initialMedia = window.chUploads[window.HubbleEditor.activeMediaIndex] || window.chUploads[0];
      if (initialMedia && initialMedia.editorState) {
        window.HubbleEditor.state = JSON.parse(JSON.stringify(initialMedia.editorState));
      } else if (d.editorState) {
        window.HubbleEditor.state = JSON.parse(JSON.stringify(d.editorState));
      } else {
        window.HubbleEditor.state = {
          filter: 'original', rotation: 0, zoom: 1, panX: 0, panY: 0,
          adjustments: { brightness: 100, contrast: 100, exposure: 100, highlights: 100, shadows: 100, temperature: 0, tint: 0, saturation: 100, vibrance: 100, sharpness: 0, blur: 0, opacity: 100 },
          crop: null, layers: [], isMuted: false, musicTrack: null, selectedLocation: null
        };
      }
      window.HubbleEditor.history = [JSON.parse(JSON.stringify(window.HubbleEditor.state))];
      window.HubbleEditor.redoStack = [];
      window.HubbleEditor.activeSelectedLayerId = null;
    }

    // 3. Restore Caption
    const captionEl = document.getElementById('ch-caption-input') || document.querySelector('.ch-caption-input');
    if (captionEl) captionEl.value = d.caption || '';

    // 4. Restore Scheduling
    const schedToggle = document.getElementById('ch-schedule-toggle');
    if (schedToggle) {
      schedToggle.checked = d.scheduleEnabled === true;
      if (window.toggleScheduling) window.toggleScheduling(schedToggle.checked);
    }
    const schedDate = document.getElementById('ch-schedule-date');
    if (schedDate) schedDate.value = d.scheduleDate || '';
    const schedTime = document.getElementById('ch-schedule-time');
    if (schedTime) schedTime.value = d.scheduleTime || '';

    // 6. Switch view to editor
    if (window.switchView) window.switchView('create-hubbs');

    // 7. Close modals
    document.getElementById('story-drafts-modal')?.classList.remove('active');
    document.getElementById('home-drafts-panel')?.classList.remove('open');

    // 8. Render previews & layouts
    if (typeof window.renderMediaPreviews === 'function') {
      window.renderMediaPreviews();
    }
    if (window.HubbleEditor && window.HubbleEditor.setLayout) {
      window.HubbleEditor.setLayout(d.activeLayout || 'original');
    }
    if (window.HubbleEditor && window.HubbleEditor.updateRender) {
      window.HubbleEditor.updateRender();
    }

    // 9. Ensure video elements are paused and setup restored music track audio
    const canvasVideos = document.querySelectorAll('#he-media-layer video, #review-slider-wrapper video');
    canvasVideos.forEach(v => {
      v.pause();
      v.autoplay = false;
    });
    const restoredMusic = (window.HubbleEditor && window.HubbleEditor.state && window.HubbleEditor.state.musicTrack) || null;
    if (restoredMusic && (restoredMusic.previewUrl || restoredMusic.url) && window.StoryAudioManager) {
      window.StoryAudioManager.load(restoredMusic, 'editor');
      if (!restoredMusic.isMuted) {
        window.StoryAudioManager.play('editor');
      }
    } else if (window.StoryAudioManager) {
      window.StoryAudioManager.destroy();
    }

    // 10. Update attached badges (Music & Location)
    if (window.renderAttachedStoryBadges) {
      window.renderAttachedStoryBadges();
    }

    // 11. Update live timestamp
    window.updateLastSavedLabel();
    showToast('Draft restored! 📝');
  } catch (err) {
    console.error('Error loading draft:', err);
    showToast('Failed to load draft. Please try again.');
  }
};

window.deleteDraft = async function (id, e) {
  if (e) e.stopPropagation();
  try {
    await DraftsDB.deleteDraft(id);
    if (window.currentDraftId === id) {
      window.currentDraftId = null;
      window.currentDraftCreatedAt = null;
    }
    await window.renderDraftsList();
    if (document.getElementById('story-drafts-modal')?.classList.contains('active')) {
      const searchVal = document.getElementById('see-all-drafts-search')?.value || '';
      await window.renderSeeAllDrafts(searchVal);
    }
    window.dispatchEvent(new CustomEvent('hihubble_story_draft_change', { detail: { action: 'delete', draftId: id } }));
  } catch (err) {
    // quiet error handling
  }
};

window.duplicateDraft = async function (id, e) {
  if (e) e.stopPropagation();
  try {
    const d = await DraftsDB.getDraftById(id);
    if (!d) return;

    const clone = JSON.parse(JSON.stringify(d));
    clone.id = 'draft_story_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    clone.createdAt = Date.now();
    clone.lastModified = Date.now();
    clone.title = (clone.title || 'Draft') + ' (Copy)';
    if (clone.caption) clone.caption = clone.caption + ' (Copy)';

    // Preserve Blob/File reference if available
    if (d.mediaItems) {
      clone.mediaItems = d.mediaItems.map((m, idx) => ({
        ...clone.mediaItems[idx],
        file: m.file
      }));
    }
    clone.mediaFile = d.mediaFile;

    await DraftsDB.saveDraft(clone);
    showToast('Draft duplicated! 📋');
    await window.renderDraftsList();
    if (document.getElementById('story-drafts-modal')?.classList.contains('active')) {
      const searchVal = document.getElementById('see-all-drafts-search')?.value || '';
      await window.renderSeeAllDrafts(searchVal);
    }
    window.dispatchEvent(new CustomEvent('hihubble_story_draft_change', { detail: { action: 'duplicate', draftId: clone.id } }));
  } catch (err) {
    console.error('Failed to duplicate draft:', err);
    showToast('Error duplicating draft.');
  }
};

// --- AUTO SAVE DEBOUNCE ---
let autoSaveTimeout = null;
window.triggerAutoSave = function () {
  const activeHubbsView = document.getElementById('view-create-hubbs');
  const isActive = activeHubbsView && activeHubbsView.classList.contains('active');
  const hasUploads = window.chUploads && window.chUploads.length > 0;
  const captionEl = document.getElementById('ch-caption-input') || document.querySelector('.ch-caption-input');
  const hasCaption = captionEl && captionEl.value.trim().length > 0;

  if (isActive && (hasUploads || hasCaption)) {
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = setTimeout(() => {
      window._silentDraftSave = true;
      if (window.saveCurrentDraft) window.saveCurrentDraft(true);
    }, 2500);
  }
};

// Live ticker interval for relative timestamps (every 10s)
if (!window._hihubbleDraftTickerInterval) {
  window._hihubbleDraftTickerInterval = setInterval(() => {
    if (typeof window.updateLastSavedLabel === 'function') {
      window.updateLastSavedLabel();
    }
  }, 10000);
}

// Cross-tab and realtime event listeners
window.addEventListener('hihubble_story_draft_change', () => {
  if (typeof window.renderDraftsList === 'function') window.renderDraftsList();
  if (document.getElementById('story-drafts-modal')?.classList.contains('active')) {
    const searchVal = document.getElementById('see-all-drafts-search')?.value || '';
    if (typeof window.renderSeeAllDrafts === 'function') window.renderSeeAllDrafts(searchVal);
  }
});

// Run on init
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('input', (e) => {
    if (e.target.closest('#view-create-hubbs') || e.target.closest('#view-review-hubbs')) {
      window.triggerAutoSave();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.closest('#view-create-hubbs') || e.target.closest('#view-review-hubbs')) {
      window.triggerAutoSave();
    }
  });
  window.addEventListener('beforeunload', () => {
    const isCreateHubbsActive = (
      document.body?.getAttribute('data-active-view') === 'create-hubbs' ||
      document.body?.classList.contains('create-hubbs-view-active') ||
      document.getElementById('view-create-hubbs')?.classList.contains('active') ||
      (window.__hubbleAppState && window.__hubbleAppState.activeView === 'create-hubbs')
    );
    if (isCreateHubbsActive && window.chUploads && window.chUploads.length > 0) {
      window._silentDraftSave = true;
      if (window.saveCurrentDraft) window.saveCurrentDraft(true);
    }
  });

  setTimeout(() => {
    window.renderDraftsList();
  }, 400);

  // Setup Home Drafts Bubble Toggle
  const draftsBtn = document.getElementById('story-drafts-container');
  const draftsPanel = document.getElementById('home-drafts-panel');
  const closeBtn = document.getElementById('close-hdd-btn');
  if (draftsBtn && draftsPanel) {
    draftsBtn.addEventListener('click', (e) => {
      if (e.target.closest('#home-drafts-panel')) return;
      draftsPanel.classList.toggle('open');
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (draftsPanel) draftsPanel.classList.remove('open');
    });
  }
  document.addEventListener('click', (e) => {
    if (draftsBtn && !draftsBtn.contains(e.target)) {
      draftsPanel.classList.remove('open');
    }
  });
});

import './auth.css'
import { initAuth, updateAppUI, handleLogout, supabase } from './auth.js'
window.supabase = supabase;

import './audio/audio.css'
import { initiateAudioCall, endAudioCall, listenForIncomingAudioCalls } from './audio/audio.call.js'
import './video/video.css'
import { initiateVideoCall, endVideoCall, listenForIncomingVideoCalls } from './video/video.call.js'

// Calling Initialization Bridge
let callingSubscribedUserId = null;
window.ensureIncomingCallListeners = function () {
  try {
    const userStr = localStorage.getItem('invibe_user') || localStorage.getItem('invibeUser');
    if (!userStr) return;
    const u = JSON.parse(userStr);
    const userId = u ? (u.id || u._id || '').toString() : '';
    if (userId && callingSubscribedUserId !== userId) {
      console.debug('[Calling System] Actively subscribing listeners for user:', userId);
      callingSubscribedUserId = userId;
      listenForIncomingAudioCalls(userId);
      listenForIncomingVideoCalls(userId);
    }
  } catch (err) {
    console.error('[Calling Setup Error]:', err);
  }
};

// Run immediately and also set polling check to guarantee it registers even if auth is delayed
window.ensureIncomingCallListeners();
setInterval(() => {
  window.ensureIncomingCallListeners();
}, 2000);

document.addEventListener('DOMContentLoaded', () => {

  const isCapacitor = !!window.Capacitor;
  const API_URL = isCapacitor
    ? 'https://hihubble-five.vercel.app'
    : (
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname === '[::1]' ||
      window.location.hostname === '::1' ||
      window.location.hostname.startsWith('192.168.') ||
      window.location.hostname.startsWith('10.') ||
      window.location.hostname.startsWith('172.') ||
      window.location.hostname.endsWith('.local')
    ) ? `${window.location.protocol}//${window.location.hostname}:3000`
      : window.location.origin;

  window.API_URL = API_URL;

  try {
    const storedSaved = localStorage.getItem('invibe_saved_hubbs');
    window.savedHubbs = storedSaved ? JSON.parse(storedSaved) : [];
  } catch (err) {
    window.savedHubbs = [];
  }

  window.updateSavedBadgeCount = function () {
    const badge = document.querySelector('.saved-count-badge');
    if (badge) {
      badge.textContent = (window.savedHubbs || []).length;
    }
  };

  let _savedHubbsInFlightPromise = null;
  window.fetchSavedHubbs = async function (forceRefresh = false) {
    const token = window.getAuthToken ? window.getAuthToken() : localStorage.getItem('invibe_jwt_token');
    if (!token) return;

    if (!forceRefresh && window.savedHubbs && Array.isArray(window.savedHubbs) && !_savedHubbsInFlightPromise) {
      return window.savedHubbs;
    }

    if (_savedHubbsInFlightPromise) {
      return _savedHubbsInFlightPromise;
    }

    _savedHubbsInFlightPromise = (async () => {
      try {
        const [postsRes, reelsRes] = await Promise.all([
          fetch(`${API_URL}/api/posts/saved`, { headers: { 'Authorization': `Bearer ${token}` } }),
          fetch(`${API_URL}/api/reels/saved`, { headers: { 'Authorization': `Bearer ${token}` } })
        ]);

        let allSaved = [];
        if (postsRes.ok) {
          allSaved = allSaved.concat(await postsRes.json());
        }
        if (reelsRes.ok) {
          allSaved = allSaved.concat(await reelsRes.json());
        }
        window.savedHubbs = allSaved;
        window.updateSavedBadgeCount();
        return allSaved;
      } catch (e) {
        console.error("Failed to fetch saved hubbs:", e);
        return window.savedHubbs || [];
      } finally {
        _savedHubbsInFlightPromise = null;
      }
    })();

    return _savedHubbsInFlightPromise;
  };

  function getAuthToken() {
    let tok = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token') || localStorage.getItem('invibeToken') || localStorage.getItem('token');
    if (tok && tok !== 'null' && tok !== 'undefined' && tok.trim() !== '') {
      return tok.trim();
    }
    const cu = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
    const cuId = cu ? (cu.id || cu._id) : null;
    if (cuId && typeof cuId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cuId)) {
      return cuId.trim();
    }
    return null;
  }
  window.getAuthToken = getAuthToken;

  initAuth();
  updateAppUI();
  window.fetchSavedHubbs();
  window.addEventListener('auth-changed', () => {
    updateAppUI();
    window.fetchSavedHubbs();
  });

  function triggerAnimatedLogout() {
    if (document.getElementById('logout-animated-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'logout-animated-overlay';
    overlay.innerHTML = `
      <div class="logout-card-box">
        <div class="logout-icon-glow">
          <div class="logout-pulse-ring"></div>
          <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="logout-icon-svg"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
        </div>
        <h3 class="logout-title">Logging out...</h3>
        <p class="logout-subtitle">See you soon on Hi-Hubble ✨</p>
        <div class="logout-loader-bar"><div class="logout-loader-progress"></div></div>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add('active');
    });
    setTimeout(() => {
      overlay.classList.add('fade-out');
      setTimeout(() => {
        overlay.remove();
        handleLogout();
      }, 200);
    }, 600);
  }

  // Global Logout Handling (Applies to sidebar logout, mobile logout, profile logout)
  document.addEventListener('click', (e) => {
    const logoutBtn = e.target.closest('#logout-btn, .logout-btn, #profile-logout-btn, [data-action="logout"]');
    if (logoutBtn) {
      e.preventDefault();
      triggerAnimatedLogout();
    }
  });

  // Global Follow / Unfollow Button Handling
  document.addEventListener('click', async (e) => {
    const followBtn = e.target.closest('.btn-follow-user');
    if (followBtn) {
      e.preventDefault();
      e.stopPropagation();

      const targetId = followBtn.getAttribute('data-user-id');
      const targetUsername = followBtn.getAttribute('data-username') || 'user';
      const token = localStorage.getItem('invibe_jwt_token');

      if (!token) {
        showToast('Please log in to follow users! 🔐');
        return;
      }

      const followingList = JSON.parse(localStorage.getItem('invibe_following_users') || '[]');
      const pendingList = JSON.parse(localStorage.getItem('invibe_pending_users') || '[]');
      const isCurrentlyFollowing = followingList.includes(targetId);
      const isCurrentlyPending = pendingList.includes(targetId);

      followBtn.disabled = true;

      try {
        const endpoint = (isCurrentlyFollowing || isCurrentlyPending) ? `/api/users/${targetId}/unfollow` : `/api/users/${targetId}/follow`;
        const res = await fetch(`${API_URL}${endpoint}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (res.ok) {
          const resData = await res.json();
          if (resData.status === 'pending') {
            if (!pendingList.includes(targetId)) pendingList.push(targetId);
            localStorage.setItem('invibe_pending_users', JSON.stringify(pendingList));
            showToast(resData.message || `Follow request sent to @${targetUsername}. ⏳`);

            document.querySelectorAll(`.btn-follow-user[data-user-id="${targetId}"]`).forEach(btn => {
              btn.className = 'btn-follow-user pending';
              btn.style.background = 'rgba(234, 179, 8, 0.2)';
              btn.style.color = '#eab308';
              btn.textContent = 'Requested';
            });
          } else if (resData.status === 'following' || resData.isFollowing) {
            if (!followingList.includes(targetId)) followingList.push(targetId);
            const pIdx = pendingList.indexOf(targetId);
            if (pIdx > -1) pendingList.splice(pIdx, 1);

            localStorage.setItem('invibe_following_users', JSON.stringify(followingList));
            localStorage.setItem('invibe_pending_users', JSON.stringify(pendingList));
            showToast(resData.message || `Now following @${targetUsername}! 🎉`);

            document.querySelectorAll(`.btn-follow-user[data-user-id="${targetId}"]`).forEach(btn => {
              btn.className = 'btn-follow-user following';
              btn.style.background = 'rgba(255,255,255,0.1)';
              btn.style.color = '#ffffff';
              btn.textContent = 'Following';
            });
          } else {
            // Unfollowed
            const fIdx = followingList.indexOf(targetId);
            if (fIdx > -1) followingList.splice(fIdx, 1);
            const pIdx = pendingList.indexOf(targetId);
            if (pIdx > -1) pendingList.splice(pIdx, 1);

            localStorage.setItem('invibe_following_users', JSON.stringify(followingList));
            localStorage.setItem('invibe_pending_users', JSON.stringify(pendingList));
            showToast(resData.message || `Unfollowed @${targetUsername}`);

            document.querySelectorAll(`.btn-follow-user[data-user-id="${targetId}"]`).forEach(btn => {
              btn.className = 'btn-follow-user';
              btn.style.background = 'var(--primary, #a855f7)';
              btn.style.color = '#ffffff';
              btn.textContent = '+ Follow';
            });
          }

          if (typeof updateAppUI === 'function') updateAppUI();
        }
      } catch (err) {
        console.error("Follow action error:", err);
      } finally {
        followBtn.disabled = false;
      }
    }
  });

  // Initialize Lucide Icons (Debounced for performance)
  let iconRenderQueued = false;
  const debouncedCreateIcons = () => {
    if (!window.lucide || iconRenderQueued) return;
    iconRenderQueued = true;
    requestAnimationFrame(() => {
      if (window.lucide) window.lucide.createIcons();
      iconRenderQueued = false;
    });
  };
  window.debouncedCreateIcons = debouncedCreateIcons;

  debouncedCreateIcons();

  // --- CENTRAL THEME MANAGEMENT & PERSISTENCE ---
  function getStoredTheme() {
    try {
      const raw = localStorage.getItem('hihubble_theme') || localStorage.getItem('invibe_theme');
      if (typeof raw === 'string') {
        const clean = raw.trim().toLowerCase();
        if (clean === 'light' || clean === 'dark') {
          return clean;
        }
      }
    } catch (e) { }
    return 'dark'; // default theme
  }

  function applyTheme(theme, save = true) {
    const validTheme = (theme === 'light') ? 'light' : 'dark';
    state.theme = validTheme;

    if (validTheme === 'light') {
      document.documentElement.classList.remove('dark-theme');
      document.documentElement.classList.add('light-theme');
      if (document.body) {
        document.body.classList.remove('dark-theme');
        document.body.classList.add('light-theme');
      }
    } else {
      document.documentElement.classList.remove('light-theme');
      document.documentElement.classList.add('dark-theme');
      if (document.body) {
        document.body.classList.remove('light-theme');
        document.body.classList.add('dark-theme');
      }
    }

    if (save) {
      try {
        localStorage.setItem('hihubble_theme', validTheme);
      } catch (e) { }
    }

    const appearanceToggle = document.getElementById('appearance-toggle-checkbox');
    if (appearanceToggle) {
      appearanceToggle.checked = (validTheme === 'light');
    }
  }
  window.applyAppTheme = applyTheme;
  window.getAppTheme = getStoredTheme;

  // --- STATE SYSTEM ---
  const state = {
    theme: window.__INITIAL_THEME__ || getStoredTheme(),
    activeView: 'home',
    viewingProfileUserId: null,
    currentChatThread: null,
    chatMode: 'chat', // chat, watch, call, game, media
    callTimerInterval: null,
    callSeconds: 1455, // starts at 00:24:15
    isLiked: {
      post1: false,
      post2: false
    },
    likesCount: {
      post1: 12400,
      post2: 8200
    },
    storyGroups: [],
    activeGroupIndex: 0,
    activeStoryIndex: 0,
    activeMediaIndex: 0,
    storyProgressInterval: null,
    storyProgressPercent: 0,
    isStoryPaused: false,
    isStoryViewsOpen: false,
    isLudoRolling: false
  };
  window.__hubbleAppState = state;

  // Ensure DOM is immediately in sync with state theme
  applyTheme(state.theme, false);

  // Safe Universal User ID extraction helper
  function getUserIdentifier(userOrAuthor) {
    if (!userOrAuthor) return null;
    if (typeof userOrAuthor === 'string') {
      const clean = userOrAuthor.trim();
      return clean.length > 0 ? clean : null;
    }
    if (typeof userOrAuthor === 'object') {
      return userOrAuthor.id || userOrAuthor._id || userOrAuthor.userId || userOrAuthor.authorId || userOrAuthor.username || null;
    }
    return null;
  }
  window.getUserIdentifier = getUserIdentifier;

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  window.escapeHtml = escapeHtml;

  // --- STICKY HEADER progressive BLUR ---
  const header = document.getElementById('main-header');
  let tickingScroll = false;
  window.addEventListener('scroll', () => {
    if (!tickingScroll) {
      window.requestAnimationFrame(() => {
        if (window.scrollY > 20) {
          header.classList.add('scrolled');
        } else {
          header.classList.remove('scrolled');
        }
        tickingScroll = false;
      });
      tickingScroll = true;
    }
  });

  // --- THEME TOGGLE CONTROLLER ---
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
      const newTheme = (currentTheme === 'light') ? 'dark' : 'light';
      applyTheme(newTheme, true);
      showToast(newTheme === 'light' ? 'Switched to Light Mode ☀️' : 'Switched to Dark Mode 🌙');
    });
  }

  // --- TOAST HELPER ---
  const toast = document.getElementById('toast-notif');
  function showToast(message) {
    if (toast) {
      toast.textContent = message;
      toast.classList.add('active');
      setTimeout(() => {
        toast.classList.remove('active');
      }, 2500);
    } else {
      console.log('[TOAST NOTIFICATION]', message);
    }
  }
  window.showToast = showToast;

  // --- VIEW SWITCHING MANAGER (SPACIOUS CONGESTION FIX) ---
  const viewPanels = document.querySelectorAll('.view-panel');
  const sidebarNavItems = document.querySelectorAll('.nav-item');
  const radialNavItems = document.querySelectorAll('.radial-item-bubble');
  const mobileNavItems = document.querySelectorAll('.mobile-nav-btn');
  const appContainer = document.querySelector('.chats-layout-grid');

  let createPostRoot = null;
  function mountCreatePost() {
    const container = document.getElementById('view-create-post');
    if (!container) return;
    if (!createPostRoot) {
      createPostRoot = ReactDOM.createRoot(container);
    }
    createPostRoot.render(
      React.createElement(CreatePost, {
        onNavigateBack: (shouldRefresh) => {
          switchView('home');
          if (shouldRefresh && typeof window.loadFeedPosts === 'function') {
            window.loadFeedPosts();
          }
        }
      })
    );
  }

  function getCanonicalActiveNavSection() {
    // 1. Notifications panel open
    const notifPanel = document.getElementById('notifications-panel');
    if (notifPanel && (notifPanel.style.display === 'flex' || notifPanel.style.display === 'block' || notifPanel.classList.contains('active'))) {
      return 'notifications';
    }

    // 2. Modals / overlays mapped to specific sections
    const reelModal = document.getElementById('explore-create-modal');
    if (reelModal && (reelModal.classList.contains('active') || reelModal.style.display === 'block' || reelModal.style.display === 'flex')) {
      return 'explore';
    }

    const storyModal = document.getElementById('story-viewer-modal');
    if (storyModal && (storyModal.classList.contains('active') || storyModal.style.display === 'flex' || storyModal.style.display === 'block')) {
      if (state.activeView === 'explore' || state.activeView === 'reels' || document.body.classList.contains('explore-view-active')) {
        return 'explore';
      }
      return 'home';
    }

    // 3. Current activeView in application state
    const cur = (state.activeView || '').toLowerCase();

    // Hubbing / Reels & nested child screens (Story creation, HUBB creation, Review HUBB)
    if (cur === 'explore' || cur === 'reels' || cur === 'create-hubbs' || cur === 'review-hubbs') {
      return 'explore';
    }

    // Messages / Chat Inbox / Personal DM
    if (cur === 'chats' || cur === 'chat' || cur === 'messages') {
      return 'chats';
    }

    // Home / Feed / Create Post
    if (cur === 'home' || cur === 'feed' || cur === 'create-post') {
      return 'home';
    }

    // Search Section
    if (cur === 'search') {
      return 'search';
    }

    // Profile & Settings
    if (cur === 'profile' || cur === 'profile-settings' || cur === 'settings') {
      return 'profile';
    }

    if (cur === 'notifications') {
      return 'notifications';
    }

    // 4. Check active DOM view-panel as fallback
    const activePanel = document.querySelector('.view-panel.active');
    if (activePanel) {
      const panelId = activePanel.id;
      if (panelId === 'view-explore' || panelId === 'view-create-hubbs' || panelId === 'view-review-hubbs') {
        return 'explore';
      }
      if (panelId === 'view-chats') {
        return 'chats';
      }
      if (panelId === 'view-home' || panelId === 'view-create-post') {
        return 'home';
      }
      if (panelId === 'view-search') {
        return 'search';
      }
      if (panelId === 'view-profile' || panelId === 'view-profile-settings' || panelId === 'view-settings') {
        return 'profile';
      }
    }

    // 5. Check URL hash / pathname as secondary fallback
    try {
      const hash = (window.location.hash || '').toLowerCase();
      const pathname = (window.location.pathname || '').toLowerCase();
      if (hash.includes('explore') || hash.includes('reels') || hash.includes('hubbing') || pathname.includes('hubbing') || pathname.includes('reels')) {
        return 'explore';
      }
      if (hash.includes('chat') || hash.includes('message') || pathname.includes('messages') || pathname.includes('chats')) {
        return 'chats';
      }
      if (hash.includes('search') || pathname.includes('search')) {
        return 'search';
      }
      if (hash.includes('profile') || hash.includes('settings') || pathname.includes('profile')) {
        return 'profile';
      }
      if (hash.includes('notification') || pathname.includes('notification')) {
        return 'notifications';
      }
    } catch (_) { }

    return 'home';
  }

  function updateHubbleActiveState() {
    const activeSection = getCanonicalActiveNavSection();

    // 1. Update each radial item bubble
    const radialBubbles = document.querySelectorAll('#radial-menu-wrapper .radial-item-bubble');
    let activeBubbleEl = null;

    radialBubbles.forEach(bubble => {
      let target = bubble.getAttribute('data-target-view');
      if (!target) {
        if (bubble.id === 'nav-notifications-btn' || bubble.querySelector('i[data-lucide="bell"]')) {
          target = 'notifications';
        } else if (bubble.id === 'radial-search-btn' || bubble.querySelector('i[data-lucide="search"]')) {
          target = 'search';
        }
      }

      const isMatch = (target === activeSection) ||
                      (activeSection === 'chats' && (target === 'messages' || target === 'chat')) ||
                      (activeSection === 'explore' && (target === 'reels' || target === 'hubbing')) ||
                      (activeSection === 'home' && (target === 'feed'));

      if (isMatch) {
        bubble.classList.add('active-bubble');
        activeBubbleEl = bubble;
      } else {
        bubble.classList.remove('active-bubble');
      }
    });

    // 2. Position dynamic radial glow indicator if present
    const activeGlow = document.getElementById('radial-active-glow');
    if (activeGlow) {
      if (activeBubbleEl && navContainer && navContainer.classList.contains('open')) {
        activeGlow.style.opacity = '1';

        const isVertical = navContainer.classList.contains('orient-vertical-down') ||
                           navContainer.classList.contains('orient-vertical-up') ||
                           navContainer.classList.contains('orient-compact-grid');

        if (isVertical) {
          activeGlow.style.left = '50%';
          activeGlow.style.transform = 'translate(-50%, -50%)';
          activeGlow.style.top = (activeBubbleEl.offsetTop + (activeBubbleEl.offsetHeight / 2)) + 'px';
        } else {
          activeGlow.style.top = '50%';
          activeGlow.style.transform = 'translateY(-50%)';
          activeGlow.style.left = (activeBubbleEl.offsetLeft + (activeBubbleEl.offsetWidth / 2) - 20) + 'px';
        }
      } else {
        activeGlow.style.opacity = '0';
      }
    }
  }

  window.getCanonicalActiveNavSection = getCanonicalActiveNavSection;
  window.updateHubbleActiveState = updateHubbleActiveState;

  function switchView(viewName, userId) {
    if (!viewName) return;

    if (viewName === 'notifications') {
      toggleNotificationsPanel();
      return;
    }

    if (typeof window.stopAllPostMusic === 'function') {
      window.stopAllPostMusic();
    }

    // Stop all Story / Share HUBBs audio and video if leaving stories
    if (viewName !== 'create-hubbs' && viewName !== 'review-hubbs') {
      if (typeof window.cleanupStoryMedia === 'function') {
        window.cleanupStoryMedia();
      }
    } else if (viewName === 'create-hubbs') {
      // If returning back from review to create-hubbs, halt review slider videos
      const reviewVideos = document.querySelectorAll('#review-slider-wrapper video, #review-before-container video, #review-after-container video');
      reviewVideos.forEach(v => {
        try {
          v.pause();
          v.muted = true;
          v.currentTime = 0;
          v.removeAttribute('src');
          v.load();
        } catch (_) { }
        try { v.remove(); } catch (_) { }
      });
      if (window.StoryAudioManager && window.HubbleEditor && window.HubbleEditor.state && window.HubbleEditor.state.musicTrack) {
        if (!window.HubbleEditor.state.musicTrack.isMuted) {
          window.StoryAudioManager.play('editor');
        }
      }
    }

    if (viewName === 'create-post') {
      document.body.classList.add('create-post-view-active');
      mountCreatePost();
    } else {
      document.body.classList.remove('create-post-view-active');
    }

    if (viewName === 'create-hubbs') {
      document.body.classList.add('create-hubbs-view-active');
    } else {
      document.body.classList.remove('create-hubbs-view-active');
    }

    if (viewName === 'review-hubbs') {
      document.body.classList.add('review-hubbs-view-active');
    } else {
      document.body.classList.remove('review-hubbs-view-active');
    }

    if (state.activeView === 'create-hubbs' && viewName !== 'create-hubbs' && viewName !== 'review-hubbs' && window.chUploads && window.chUploads.length > 0) {
      window._silentDraftSave = true;
      if (window.saveCurrentDraft) window.saveCurrentDraft();
    }

    state.activeView = viewName;
    document.body.setAttribute('data-active-view', viewName);

    if (viewName === 'home') {
      document.body.classList.add('home-view-active');
    } else {
      document.body.classList.remove('home-view-active');
    }

    if (viewName === 'explore' || viewName === 'reels') {
      document.body.classList.add('explore-view-active');
    } else {
      document.body.classList.remove('explore-view-active');
    }

    if (viewName === 'profile' || viewName === 'profile-settings') {
      document.body.classList.add('profile-view-active');
    } else {
      document.body.classList.remove('profile-view-active');
    }

    if (viewName === 'profile') {
      const resolvedTarget = getUserIdentifier(userId);
      const currentUserStr = localStorage.getItem('invibeUser');
      let targetId = resolvedTarget;
      if (!targetId && currentUserStr) {
        try {
          const currentUser = JSON.parse(currentUserStr);
          targetId = currentUser.id || currentUser._id || currentUser.username;
        } catch (_) { }
      }
      loadUserProfile(targetId || 'me');
    }

    // Maintain unified 3-column layout frame across all views
    if (viewName === 'chats' || viewName === 'chat' || viewName === 'messages') {
      document.body.classList.add('chats-view-active');
      const emptyState = document.getElementById('chat-empty-state');
      const chatHeader = document.getElementById('chat-window-header');
      const chatViewport = document.querySelector('.chat-dynamic-viewport');
      const chatFooter = document.getElementById('chat-global-footer');

      if (userId) {
        selectConversation(userId);
        loadChatThreads(false);
      } else {
        // General entry to Messages: ALWAYS start in the idle "Select a conversation" state
        state.currentChatThread = null;
        dmState.activeConversationId = null;
        const grid = document.querySelector('.chats-layout-grid');
        if (grid) grid.classList.remove('chatting');
        document.body.classList.remove('chat-active-mobile');
        if (chatThreadsList) {
          chatThreadsList.querySelectorAll('.thread-item').forEach(t => t.classList.remove('active'));
        }
        if (emptyState) emptyState.style.display = 'flex';
        if (chatHeader) chatHeader.style.display = 'none';
        if (chatViewport) chatViewport.style.display = 'none';
        if (chatFooter) chatFooter.style.display = 'none';
        loadChatThreads(false);
      }
    } else {
      document.body.classList.remove('chats-view-active');
    }

    if (viewName === 'search' && typeof initSearchView === 'function') {
      initSearchView();
    }
    if ((viewName === 'reels' || viewName === 'explore') && typeof loadFeedReels === 'function') {
      loadFeedReels();
    }

    // Update active view panels dynamically
    const currentViewPanels = document.querySelectorAll('.view-panel');
    currentViewPanels.forEach(panel => {
      if (panel.id === `view-${viewName}`) {
        panel.classList.add('active');
      } else {
        panel.classList.remove('active');
      }
    });

    // Update active sidebar nav items
    sidebarNavItems.forEach(nav => {
      const target = nav.getAttribute('data-target-view');
      if (target === viewName) {
        nav.classList.add('active');
      } else {
        nav.classList.remove('active');
      }
    });

    // Update active radial sub-bubbles
    updateHubbleActiveState();

    // Update active mobile bottom nav items
    mobileNavItems.forEach(nav => {
      const target = nav.getAttribute('data-target-view');
      if (target === viewName) {
        nav.classList.add('active');
      } else {
        nav.classList.remove('active');
      }
    });

    // Notify Hubbing Playback Controller of view change
    if (window.hubbingPlaybackController) {
      window.hubbingPlaybackController.onViewChange(viewName);
    }

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Close radial menu after selection
    closeRadialMenu();
  }

  window.switchView = switchView;

  window.navigateToPost = function (postId, hubType = 'post') {
    if (!postId) return;

    // Close active chats
    const grid = document.querySelector('.chats-layout-grid');
    if (grid) grid.classList.remove('chatting');
    document.body.classList.remove('chat-active-mobile');

    if (hubType === 'story') {
      switchView('home');

      const tryOpenStory = () => {
        let foundGroupIdx = -1;
        let foundStoryIdx = -1;

        if (state.storyGroups) {
          state.storyGroups.forEach((group, gIdx) => {
            (group.stories || []).forEach((story, sIdx) => {
              const sId = story._id || story.id;
              if (sId && sId.toString() === postId.toString()) {
                foundGroupIdx = gIdx;
                foundStoryIdx = sIdx;
              }
            });
          });
        }

        if (foundGroupIdx !== -1 && foundStoryIdx !== -1) {
          openStoryViewer(foundGroupIdx, foundStoryIdx);
          return true;
        }
        return false;
      };

      setTimeout(() => {
        if (!tryOpenStory()) {
          if (typeof loadStories === 'function') {
            loadStories().then(() => {
              if (!tryOpenStory()) {
                if (typeof showToast === 'function') {
                  showToast('This HUBB has expired or is no longer available.');
                }
              }
            });
          } else {
            if (typeof showToast === 'function') {
              showToast('This HUBB has expired or is no longer available.');
            }
          }
        }
      }, 150);

    } else if (hubType === 'reel') {
      switchView('explore');

      const targetReelId = (postId || '').toString();

      const tryScrollReel = () => {
        const scroller = document.getElementById('explore-reels-container');
        const reelEl = document.querySelector(`.reel-card[data-reel-id="${targetReelId}"]`) || 
                       document.querySelector(`.reel-card[data-reel-id="${postId}"]`);
        if (reelEl) {
          reelEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

          // Play the video via central controller
          const video = reelEl.querySelector('.reel-video');
          if (video && window.hubbingPlaybackController) {
            window.hubbingPlaybackController.activateReel(targetReelId, video, reelEl, true);
          }
          return true;
        }
        return false;
      };

      if (!tryScrollReel()) {
        setTimeout(() => {
          if (!tryScrollReel()) {
            if (typeof loadFeedReels === 'function') {
              loadFeedReels().then(() => {
                setTimeout(tryScrollReel, 100);
                setTimeout(tryScrollReel, 400);
              });
            }
          }
        }, 120);
      }

    } else {
      // Switch view to home (feed)
      switchView('home');

      const tryScroll = () => {
        const postEl = document.getElementById(`post-${postId}`);
        if (postEl) {
          postEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

          // Glow effect
          postEl.style.transition = 'box-shadow 0.4s ease, border-color 0.4s ease, transform 0.4s ease';
          postEl.style.boxShadow = '0 0 25px rgba(168, 85, 247, 0.7)';
          postEl.style.borderColor = 'var(--primary, #a855f7)';
          postEl.style.transform = 'scale(1.01)';

          setTimeout(() => {
            postEl.style.boxShadow = '';
            postEl.style.borderColor = '';
            postEl.style.transform = '';
          }, 2000);
          return true;
        }
        return false;
      };

      setTimeout(() => {
        if (!tryScroll()) {
          if (typeof loadFeedPosts === 'function') {
            loadFeedPosts().then(() => {
              setTimeout(tryScroll, 400);
            });
          }
        }
      }, 150);
    }
  };

  // Bind view selectors
  sidebarNavItems.forEach(item => {
    item.addEventListener('click', () => {
      const target = item.getAttribute('data-target-view');
      if (target) switchView(target);
    });
  });

  radialNavItems.forEach(bubble => {
    bubble.addEventListener('click', (e) => {
      if (!navContainer || !navContainer.classList.contains('open')) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const target = bubble.getAttribute('data-target-view');
      if (target === 'notifications' || bubble.id === 'nav-notifications-btn') {
        e.preventDefault();
        e.stopPropagation();
        closeRadialMenu();
        toggleNotificationsPanel();
        return;
      }
      if (target) {
        switchView(target);
      }
    });
  });

  mobileNavItems.forEach(item => {
    item.addEventListener('click', () => {
      const target = item.getAttribute('data-target-view');
      if (target) switchView(target);
    });
  });

  // Logo button returns Home
  document.getElementById('logo-button').addEventListener('click', () => {
    switchView('home');
  });

  // Profile avatar returns Profile
  const headerProfileAvatar = document.getElementById('header-profile-avatar');
  if (headerProfileAvatar) {
    headerProfileAvatar.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      switchView('profile');
    });
  }

  // Profile settings gear button navigation
  const profileSettingsBtn = document.getElementById('profile-settings-btn');
  if (profileSettingsBtn) {
    profileSettingsBtn.addEventListener('click', () => {
      switchView('profile-settings');
    });
  }

  // Profile settings back button navigation
  const profileSettingsBackBtn = document.getElementById('profile-settings-back-btn');
  if (profileSettingsBackBtn) {
    profileSettingsBackBtn.addEventListener('click', () => {
      switchView('profile');
    });
  }

  // Messages badge shortcut
  document.getElementById('messages-shortcut-btn').addEventListener('click', () => {
    switchView('chats');
  });


  // --- FLOATING RADIAL NAVIGATION MENU & TOUCH DRAG SYSTEM (SIGNATURE INTERACTION) ---
  const navContainer = document.getElementById('floating-bubble-nav');
  const mainBubble = document.getElementById('main-navigation-bubble');
  const blurOverlay = document.getElementById('radial-menu-blur-overlay');

  let isDragging = false;
  let dragTouchOffsetX = 0;
  let dragTouchOffsetY = 0;
  let dragPointerStartX = 0;
  let dragPointerStartY = 0;
  let currentTargetX = 0;
  let currentTargetY = 0;
  let wasOpenOnDragStart = false;
  let lastTouchTime = 0;
  let activePointerId = null;

  function getBubbleSize() {
    const isMobile = window.innerWidth <= 768;
    return isMobile ? 68 : 80;
  }

  function getViewportPad() {
    return 8;
  }

  function getViewportBounds() {
    const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth;
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const bSize = getBubbleSize();
    const pad = getViewportPad();

    return {
      minX: pad,
      maxX: Math.max(pad, vw - bSize - pad),
      minY: pad,
      maxY: Math.max(pad, vh - bSize - pad),
      width: vw,
      height: vh,
      bubbleSize: bSize
    };
  }

  function applyHubblePosition(x, y) {
    const bounds = getViewportBounds();
    const safeX = Math.min(Math.max(x, bounds.minX), bounds.maxX);
    const safeY = Math.min(Math.max(y, bounds.minY), bounds.maxY);

    navContainer.style.setProperty('left', `${safeX}px`, 'important');
    navContainer.style.setProperty('top', `${safeY}px`, 'important');
    navContainer.style.setProperty('right', 'auto', 'important');
    navContainer.style.setProperty('bottom', 'auto', 'important');
    navContainer.style.setProperty('margin', '0', 'important');
    navContainer.style.setProperty('position', 'fixed', 'important');
    navContainer.style.setProperty('z-index', '999999', 'important');
    navContainer.style.transform = 'none';
  }

  // Restore saved Hubble position for current session if available
  try {
    const savedX = sessionStorage.getItem('hi_hubble_pos_x');
    const savedY = sessionStorage.getItem('hi_hubble_pos_y');
    if (savedX !== null && savedY !== null) {
      const posX = parseFloat(savedX);
      const posY = parseFloat(savedY);
      if (!isNaN(posX) && !isNaN(posY)) {
        applyHubblePosition(posX, posY);
      }
    }
  } catch (err) {
    // SessionStorage access may fail in sandboxed iframes
  }

  // Prevent default native image/element drag
  mainBubble.addEventListener('dragstart', (e) => e.preventDefault());

  // Unified Pointer & Touch Event Listeners on mainBubble
  if (window.PointerEvent) {
    mainBubble.addEventListener('pointerdown', dragStart, { passive: false });
  } else {
    mainBubble.addEventListener('mousedown', dragStart);
    mainBubble.addEventListener('touchstart', dragStart, { passive: false });
  }

  function getEventCoords(e) {
    if (e.touches && e.touches.length > 0) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    if (e.changedTouches && e.changedTouches.length > 0) {
      return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
  }

  function dragStart(e) {
    if (e.type === 'touchstart') {
      lastTouchTime = Date.now();
    } else if (e.type === 'mousedown') {
      if (Date.now() - lastTouchTime < 600) {
        return;
      }
      e.preventDefault();
    }

    // Set pointer capture if supported so finger stream is never lost
    if (e.pointerId && mainBubble.setPointerCapture) {
      try {
        mainBubble.setPointerCapture(e.pointerId);
        activePointerId = e.pointerId;
      } catch (err) {}
    }

    wasOpenOnDragStart = navContainer.classList.contains('open');
    isDragging = false;

    const coords = getEventCoords(e);
    dragPointerStartX = coords.x;
    dragPointerStartY = coords.y;

    const rect = navContainer.getBoundingClientRect();
    dragTouchOffsetX = coords.x - rect.left;
    dragTouchOffsetY = coords.y - rect.top;
    currentTargetX = rect.left;
    currentTargetY = rect.top;

    if (window.PointerEvent) {
      document.addEventListener('pointermove', dragMove, { passive: false });
      document.addEventListener('pointerup', dragEnd);
      document.addEventListener('pointercancel', dragEnd);
    } else {
      document.addEventListener('mousemove', dragMove, { passive: false });
      document.addEventListener('mouseup', dragEnd);
      document.addEventListener('touchmove', dragMove, { passive: false });
      document.addEventListener('touchend', dragEnd);
      document.addEventListener('touchcancel', dragEnd);
    }
  }

  function dragMove(e) {
    const coords = getEventCoords(e);
    const deltaX = coords.x - dragPointerStartX;
    const deltaY = coords.y - dragPointerStartY;
    const moveDistance = Math.hypot(deltaX, deltaY);

    // 5px threshold to separate simple taps from real dragging
    if (!isDragging && moveDistance > 5) {
      isDragging = true;
      navContainer.style.transition = 'none';
      navContainer.classList.add('dragging');

      if (wasOpenOnDragStart) {
        closeRadialMenu();
      }
    }

    if (isDragging) {
      if (e.cancelable) {
        e.preventDefault();
      }

      const bounds = getViewportBounds();
      const rawX = coords.x - dragTouchOffsetX;
      const rawY = coords.y - dragTouchOffsetY;

      // Strictly clamp within viewport boundaries
      currentTargetX = Math.min(Math.max(rawX, bounds.minX), bounds.maxX);
      currentTargetY = Math.min(Math.max(rawY, bounds.minY), bounds.maxY);

      // Immediately apply clamped position on every frame
      applyHubblePosition(currentTargetX, currentTargetY);
    }
  }

  function dragEnd(e) {
    if (window.PointerEvent) {
      document.removeEventListener('pointermove', dragMove);
      document.removeEventListener('pointerup', dragEnd);
      document.removeEventListener('pointercancel', dragEnd);
      if (activePointerId && mainBubble.releasePointerCapture) {
        try {
          mainBubble.releasePointerCapture(activePointerId);
        } catch (err) {}
        activePointerId = null;
      }
    } else {
      document.removeEventListener('mousemove', dragMove);
      document.removeEventListener('mouseup', dragEnd);
      document.removeEventListener('touchmove', dragMove);
      document.removeEventListener('touchend', dragEnd);
      document.removeEventListener('touchcancel', dragEnd);
    }

    navContainer.classList.remove('dragging');
    navContainer.style.transition = 'none';

    if (isDragging) {
      // Final commit of clamped coordinates
      applyHubblePosition(currentTargetX, currentTargetY);

      try {
        sessionStorage.setItem('hi_hubble_pos_x', currentTargetX);
        sessionStorage.setItem('hi_hubble_pos_y', currentTargetY);
      } catch (err) {}

      isDragging = false;
    } else {
      // Pure tap directly on the floating navigation bubble itself
      triggerHubbleAnimation();
      if (wasOpenOnDragStart) {
        closeRadialMenu();
      } else {
        openRadialMenu();
      }
    }
  }

  function clampBubblePosition() {
    const rect = navContainer.getBoundingClientRect();
    applyHubblePosition(rect.left, rect.top);
  }

  // Handle window resizing / orientation changes
  window.addEventListener('resize', () => {
    if (navContainer.style.left && navContainer.style.left !== '50%') {
      clampBubblePosition();
    }
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (navContainer.style.left && navContainer.style.left !== '50%') {
        clampBubblePosition();
      }
    });
  }

  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      if (navContainer.style.left && navContainer.style.left !== '50%') {
        clampBubblePosition();
      }
    }, 100);
  });

  function triggerHubbleAnimation() {
    if (!mainBubble) return;
    const logoIcon = mainBubble.querySelector('.orb-logo-icon');
    const bubbleOrb = mainBubble.querySelector('.bubble-orb-glowing');
    if (logoIcon) {
      logoIcon.classList.remove('hubble-spin');
      void logoIcon.offsetWidth; // Force reflow for smooth re-triggering on rapid taps
      logoIcon.classList.add('hubble-spin');
      const onSpinEnd = () => {
        logoIcon.classList.remove('hubble-spin');
      };
      logoIcon.addEventListener('animationend', onSpinEnd, { once: true });
    }
    if (bubbleOrb) {
      bubbleOrb.classList.remove('hubble-pulse');
      void bubbleOrb.offsetWidth;
      bubbleOrb.classList.add('hubble-pulse');
      const onPulseEnd = () => {
        bubbleOrb.classList.remove('hubble-pulse');
      };
      bubbleOrb.addEventListener('animationend', onPulseEnd, { once: true });
    }
  }

  function toggleRadialMenu() {
    triggerHubbleAnimation();
    const isOpen = navContainer.classList.contains('open');
    if (isOpen) {
      closeRadialMenu();
    } else {
      openRadialMenu();
    }
  }

  function openRadialMenu() {
    const rect = navContainer.getBoundingClientRect();
    const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth;
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const pad = 12;

    const hubbleCenterX = rect.left + rect.width / 2;
    const hubbleCenterY = rect.top + rect.height / 2;

    // Available space from Hubble edges & center
    const spaceLeft = rect.left - pad;
    const spaceRight = vw - rect.right - pad;
    const spaceTop = rect.top - pad;
    const spaceBottom = vh - rect.bottom - pad;
    const spaceCenterLeft = hubbleCenterX - pad;
    const spaceCenterRight = vw - hubbleCenterX - pad;

    // Required dimensions for each orientation variant:
    const isMobile = vw <= 768;
    const horizHalfWidth = isMobile ? 145 : 190;
    const canFitHorizontal = (spaceCenterLeft >= horizHalfWidth) && (spaceCenterRight >= horizHalfWidth);

    const vertHeight = isMobile ? 210 : 260;
    const canFitVerticalDown = spaceBottom >= vertHeight;
    const canFitVerticalUp = spaceTop >= vertHeight;

    // Reset previous orientation state classes
    navContainer.classList.remove(
      'orient-vertical-down',
      'orient-vertical-up',
      'orient-compact-grid',
      'align-left',
      'align-right',
      'align-top',
      'align-bottom',
      'expand-downwards'
    );

    // Intelligently select best orientation based on available space:
    if (canFitHorizontal) {
      // CASE 1: Standard Horizontal Dock (Center / Bottom Center / Top Center)
      if (hubbleCenterY < vh / 2) {
        navContainer.classList.add('expand-downwards');
      }
    } else if (canFitVerticalDown || canFitVerticalUp) {
      // CASE 2 / 6 / 7 / 8 / 9: Corners & Edges -> Vertical Column
      const preferDown = spaceBottom >= spaceTop;

      if (preferDown && canFitVerticalDown) {
        navContainer.classList.add('orient-vertical-down');
      } else if (canFitVerticalUp) {
        navContainer.classList.add('orient-vertical-up');
      } else {
        navContainer.classList.add(preferDown ? 'orient-vertical-down' : 'orient-vertical-up');
      }

      // Horizontal alignment relative to Hubble:
      if (spaceLeft < 70) {
        navContainer.classList.add('align-left');
      } else if (spaceRight < 70) {
        navContainer.classList.add('align-right');
      }
    } else {
      // CASE 3: Tight Dual-Axis Space (e.g. Landscape Mobile) -> Compact Grid
      navContainer.classList.add('orient-compact-grid');
      if (spaceTop > spaceBottom) {
        navContainer.classList.add('align-bottom');
      } else {
        navContainer.classList.add('align-top');
      }
      if (spaceLeft < spaceRight) {
        navContainer.classList.add('align-left');
      } else {
        navContainer.classList.add('align-right');
      }
    }

    navContainer.classList.add('open');
    blurOverlay.classList.add('active'); // Localized circular blur active

    // Enable accessibility and pointer events for menu items
    setRadialMenuA11y(true);

    // Dynamically derive and synchronize active option to current screen/view
    updateHubbleActiveState();
    requestAnimationFrame(() => updateHubbleActiveState());
  }

  function setRadialMenuA11y(isOpen) {
    const wrapper = document.getElementById('radial-menu-wrapper');
    if (wrapper) {
      wrapper.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    }
    const radialButtons = document.querySelectorAll('#radial-menu-wrapper .radial-btn, #radial-menu-wrapper button');
    radialButtons.forEach(btn => {
      if (isOpen) {
        btn.tabIndex = 0;
        btn.setAttribute('aria-hidden', 'false');
        btn.removeAttribute('disabled');
        btn.style.pointerEvents = 'auto';
      } else {
        btn.tabIndex = -1;
        btn.setAttribute('aria-hidden', 'true');
        btn.setAttribute('disabled', 'true');
        btn.style.pointerEvents = 'none';
        if (document.activeElement === btn) {
          btn.blur();
        }
      }
    });
    const radialBubbles = document.querySelectorAll('#radial-menu-wrapper .radial-item-bubble');
    radialBubbles.forEach(b => {
      b.style.pointerEvents = isOpen ? 'auto' : 'none';
    });
  }

  function closeRadialMenu() {
    navContainer.classList.remove('open');
    blurOverlay.classList.remove('active');
    const activeGlow = document.getElementById('radial-active-glow');
    if (activeGlow) activeGlow.style.opacity = '0';

    // Disable accessibility and pointer events for menu items
    setRadialMenuA11y(false);
  }

  // Ensure closed accessibility state on initial load
  setRadialMenuA11y(false);

  // Synchronize Hubble active state on browser back/forward and URL hash navigation
  window.addEventListener('popstate', () => {
    updateHubbleActiveState();
  });
  window.addEventListener('hashchange', () => {
    updateHubbleActiveState();
  });

  // Close radial menu when clicking backdrop overlay
  blurOverlay.addEventListener('click', closeRadialMenu);

  // Close radial menu on Escape key press
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeRadialMenu();
    }
  });

  // Search bubble opens dedicated search view
  const radialSearchBtn = document.getElementById('radial-search-btn');
  if (radialSearchBtn) {
    radialSearchBtn.addEventListener('click', (e) => {
      if (!navContainer || !navContainer.classList.contains('open')) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      closeRadialMenu();
      switchView('search');
      const searchInput = document.getElementById('search-view-input');
      if (searchInput) {
        setTimeout(() => {
          searchInput.focus();
        }, 80);
      }
      showToast('Search page opened 🔍');
    });
  }

  // Logout bubble triggers security logout
  const radialLogoutBtn = document.getElementById('radial-logout-btn');
  if (radialLogoutBtn) {
    radialLogoutBtn.addEventListener('click', (e) => {
      if (!navContainer || !navContainer.classList.contains('open')) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      closeRadialMenu();
      const mainLogoutBtn = document.getElementById('logout-btn');
      if (mainLogoutBtn) {
        mainLogoutBtn.click();
      }
    });
  }


  // --- STORIES SECTION SCROLL DRAG MOMENTUM ---
  const storiesScroll = document.getElementById('stories-scroll');
  let isDown = false;
  let startX;
  let scrollLeft;

  if (storiesScroll) {
    storiesScroll.addEventListener('mousedown', (e) => {
      isDown = true;
      startX = e.pageX - storiesScroll.offsetLeft;
      scrollLeft = storiesScroll.scrollLeft;
    });

    storiesScroll.addEventListener('mouseleave', () => {
      isDown = false;
    });

    storiesScroll.addEventListener('mouseup', () => {
      isDown = false;
    });

    let storiesTicking = false;
    storiesScroll.addEventListener('mousemove', (e) => {
      if (!isDown) return;
      e.preventDefault();
      if (!storiesTicking) {
        storiesTicking = true;
        const x = e.pageX - storiesScroll.offsetLeft;
        const walk = (x - startX) * 2.5;
        window.requestAnimationFrame(() => {
          storiesScroll.scrollLeft = scrollLeft - walk;
          storiesTicking = false;
        });
      }
    });
  }

  // --- LIKE INTERACTION & PARTICLE SYSTEMS ---
  const likeActionItems = document.querySelectorAll('.like-btn-action');
  const mediaContainers = document.querySelectorAll('.post-media-container');

  function triggerHeartExplosion(x, y, container) {
    const particleCount = 15;
    const colors = ['#6C3BFF', '#8A5CFF', '#a855f7', '#c084fc', '#e9d5ff', '#ff3b30'];

    for (let i = 0; i < particleCount; i++) {
      const particle = document.createElement('div');
      particle.className = 'explosion-particle';
      particle.innerHTML = i === 0 ? '<i data-lucide="heart" style="fill: var(--primary); stroke: var(--primary);"></i>' : '💜';

      const angle = Math.random() * Math.PI * 2;
      const distance = i === 0 ? 0 : 50 + Math.random() * 120;
      const randomX = Math.cos(angle) * distance;
      const randomY = Math.sin(angle) * distance - 40;

      particle.style.setProperty('--x', `${randomX}px`);
      particle.style.setProperty('--y', `${randomY}px`);
      particle.style.left = `${x}px`;
      particle.style.top = `${y}px`;

      particle.style.color = colors[Math.floor(Math.random() * colors.length)];
      particle.style.fontSize = i === 0 ? '100px' : `${40 + Math.random() * 40}px`;

      container.appendChild(particle);
      if (i === 0 && window.lucide) { window.lucide.createIcons(); }

      setTimeout(() => {
        particle.remove();
      }, 800);
    }
  }

  function toggleLike(postId, buttonWrapper, clickX, clickY, container) {
    const postStateKey = `post${postId}`;
    const isCurrentlyLiked = state.isLiked[postStateKey];

    const countSpan = buttonWrapper.querySelector('.action-count');
    const heartBtn = buttonWrapper.querySelector('.action-circle-btn');

    if (!isCurrentlyLiked) {
      state.isLiked[postStateKey] = true;
      state.likesCount[postStateKey]++;
      buttonWrapper.classList.add('liked');

      if (countSpan) {
        countSpan.textContent = formatCount(state.likesCount[postStateKey]);
      }

      if (clickX !== null && clickY !== null && container) {
        triggerHeartExplosion(clickX, clickY, container);
      } else if (container) {
        const rect = container.getBoundingClientRect();
        triggerHeartExplosion(rect.width / 2, rect.height / 2, container);
      }
      showToast('Liked post! 💜');
    } else {
      state.isLiked[postStateKey] = false;
      state.likesCount[postStateKey]--;
      buttonWrapper.classList.remove('liked');

      if (countSpan) {
        countSpan.textContent = formatCount(state.likesCount[postStateKey]);
      }
    }
  }

  function formatCount(num) {
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num;
  }

  // Disabled old hardcoded static feed post likes. Dynamic likes are loaded in loadFeedPosts()

  // --- POST 2 VIDEO PLAYBACK ---
  const videoPost = document.getElementById('post-2');
  if (videoPost) {
    const video = videoPost.querySelector('.post-media-video');
    const playOverlay = videoPost.querySelector('.video-play-overlay');
    const playIcon = playOverlay.querySelector('i');

    playOverlay.addEventListener('click', (e) => {
      e.stopPropagation();
      video.play();
      playOverlay.style.display = 'none';
      debouncedCreateIcons();
    });

    video.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!video.paused) {
        video.pause();
        playIcon.setAttribute('data-lucide', 'play');
        playOverlay.style.display = 'flex';
        playOverlay.style.background = 'rgba(0,0,0,0.25)';
        playOverlay.style.opacity = '1';
        debouncedCreateIcons();
      }
    });
  }


  // --- EXPLORE & REELS TAB AND INTERACTIONS ---
  const exTabPills = document.querySelectorAll('.ex-tab-pill');
  const exploreReelsContainer = document.getElementById('explore-reels-container');
  const explorePostsContainer = document.getElementById('explore-posts-container');

  exTabPills.forEach(pill => {
    pill.addEventListener('click', () => {
      exTabPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');

      const tabName = pill.getAttribute('data-ex-tab');
      if (tabName === 'reels') {
        exploreReelsContainer.classList.add('active');
        explorePostsContainer.classList.remove('active');
        if (window.hubbingPlaybackController) {
          window.hubbingPlaybackController.onViewChange('explore');
        }
        if (typeof loadFeedReels === 'function') {
          loadFeedReels().then(() => {
            if (window.hubbingPlaybackController) {
              window.hubbingPlaybackController.scheduleSettleEvaluation(80);
            }
          }).catch(() => { });
        }
      } else {
        exploreReelsContainer.classList.remove('active');
        explorePostsContainer.classList.add('active');
        if (window.hubbingPlaybackController) {
          window.hubbingPlaybackController.deactivateCurrentReel('tab_switch');
        }
      }
    });
  });
  // Disabled old hardcoded reels video playback/gestures loop. Replaced with wireReelInteractions() on load.

  // --- GLOBAL FEED ACTIONS DELEGATION ---
  document.addEventListener('click', async (e) => {
    // Post Options (...)
    const optionsBtn = e.target.closest('.post-options-btn');
    if (optionsBtn) {
      e.preventDefault();
      e.stopPropagation();

      const postId = optionsBtn.getAttribute('data-post-id');
      const authorId = optionsBtn.getAttribute('data-author-id');
      const currentUserStr = localStorage.getItem('invibe_user') || localStorage.getItem('invibeUser');
      const currentUser = currentUserStr ? JSON.parse(currentUserStr) : null;
      const currentUserId = currentUser ? (currentUser.id || currentUser._id || currentUser.user_id || currentUser.userId) : null;

      const isAlreadyOpen = optionsBtn.parentElement.querySelector('.post-options-dropdown');
      document.querySelectorAll('.post-options-dropdown').forEach(d => d.remove());
      if (isAlreadyOpen) return;

      const isAuthor = !authorId || !currentUserId || String(authorId) === String(currentUserId) || (authorId === 'usr_unknown');

      const dropdown = document.createElement('div');
      dropdown.className = 'post-options-dropdown';

      let optionsHTML = '';
      if (isAuthor) {
        optionsHTML += `
          <button type="button" class="delete-post-action" data-post-id="${postId}">
            <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i> Delete Post
          </button>
        `;
      }
      optionsHTML += `
        <button type="button" class="option-item-action copy-post-link-action" data-post-id="${postId}">
          <i data-lucide="link" style="width: 14px; height: 14px;"></i> Copy Link
        </button>
      `;

      dropdown.innerHTML = optionsHTML;
      optionsBtn.parentElement.style.position = 'relative';
      optionsBtn.parentElement.appendChild(dropdown);
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    // Copy Post Link action
    const copyLinkBtn = e.target.closest('.copy-post-link-action');
    if (copyLinkBtn) {
      e.preventDefault();
      e.stopPropagation();
      const postId = copyLinkBtn.getAttribute('data-post-id');
      const postUrl = `${window.location.origin}/#post-${postId}`;
      navigator.clipboard.writeText(postUrl);
      const toast = document.getElementById('toast-notif');
      if (toast) {
        toast.textContent = 'Post link copied to clipboard!';
        toast.classList.add('active');
        setTimeout(() => toast.classList.remove('active'), 3000);
      }
      document.querySelectorAll('.post-options-dropdown').forEach(d => d.remove());
      return;
    }

    // Delete Post Action
    const deleteBtn = e.target.closest('.delete-post-action');
    if (deleteBtn) {
      e.preventDefault();
      e.stopPropagation();
      const postId = deleteBtn.getAttribute('data-post-id');

      if (confirm('Are you sure you want to delete this post? This cannot be undone.')) {
        try {
          const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibeToken') || localStorage.getItem('token');
          const res = await fetch(`${API_URL}/api/posts/${postId}`, {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            }
          });
          const data = await res.json();
          if (res.ok && (data.success || res.status === 200)) {
            const card = document.getElementById(`post-${postId}`) || deleteBtn.closest('.feed-card') || deleteBtn.closest('article');
            if (card) {
              card.style.transition = 'all 0.3s ease';
              card.style.opacity = '0';
              card.style.transform = 'scale(0.95)';
              setTimeout(() => card.remove(), 300);
            }

            const toast = document.getElementById('toast-notif');
            if (toast) {
              toast.textContent = 'Post deleted successfully!';
              toast.classList.add('active');
              setTimeout(() => toast.classList.remove('active'), 3000);
            }
          } else {
            alert(data.error || 'Failed to delete post.');
          }
        } catch (err) {
          console.error('Error deleting post:', err);
          alert('Error deleting post: ' + err.message);
        }
      }
      document.querySelectorAll('.post-options-dropdown').forEach(d => d.remove());
      return;
    }


    // Close dropdowns if clicking elsewhere
    if (!e.target.closest('.post-options-dropdown')) {
      document.querySelectorAll('.post-options-dropdown').forEach(d => d.remove());
    }

    // Post comment button click
    const commentPostBtn = e.target.closest('.comment-post-btn');
    if (commentPostBtn) {
      e.preventDefault();
      e.stopPropagation();
      const pid = commentPostBtn.getAttribute('data-post-id');
      const input = document.getElementById(`comment-input-${pid}`);
      if (input) {
        const text = input.value.trim();
        if (text) {
          await submitComment(pid, text, input);
        }
      }
    }

    // Like button
    const likeBtn = e.target.closest('.like-btn-action');
    if (likeBtn) {
      e.preventDefault();
      e.stopPropagation();
      const pid = likeBtn.getAttribute('data-post-id') || likeBtn.closest('[data-post-id]')?.getAttribute('data-post-id') || '1';
      await togglePostLike(pid, likeBtn);
    }

    // Bookmark / Save button
    const bookmarkBtn = e.target.closest('.bookmark-btn, .bookmark-btn-action');
    if (bookmarkBtn) {
      e.preventDefault();
      e.stopPropagation();

      // Some templates use the inner button, some use the wrapper. Find the wrapper and the icon.
      const btnEl = bookmarkBtn.classList.contains('bookmark-btn') ? bookmarkBtn : (bookmarkBtn.querySelector('.bookmark-btn') || bookmarkBtn);
      const icon = btnEl.querySelector('i, svg') || bookmarkBtn.querySelector('i, svg');

      const mediaContainer = bookmarkBtn.closest('.feed-card, .reel-card, .post-media-container') || bookmarkBtn.closest('article, .post-media-container');
      const cardEl = bookmarkBtn.closest('.feed-card, .reel-card') || bookmarkBtn.closest('article') || mediaContainer;
      let mediaData = null;
      if (mediaContainer) {
        const id = bookmarkBtn.getAttribute('data-post-id') || bookmarkBtn.getAttribute('data-reel-id') || (cardEl ? (cardEl.getAttribute('data-post-id') || cardEl.getAttribute('data-reel-id') || cardEl.id.replace('post-', '')) : null) || Math.random().toString();
        const img = mediaContainer.querySelector('.post-media-img') || mediaContainer.querySelector('img:not(.author-avatar)');
        const video = mediaContainer.querySelector('.post-media-video') || mediaContainer.querySelector('video');
        const captionEl = cardEl ? cardEl.querySelector('.post-caption') : null;
        const captionText = captionEl ? captionEl.textContent : '';
        const authorNameEl = cardEl ? (cardEl.querySelector('.author-name') || cardEl.querySelector('.author-username')) : null;
        const authorName = authorNameEl ? authorNameEl.textContent.trim().replace(/^@/, '') : 'Hubber';

        if (img) mediaData = { id, type: 'image', url: img.src };
        else if (video) mediaData = { id, type: 'video', url: video.src };
        else mediaData = { id, type: 'text', text: captionText, author: authorName };
      }

      const isReel = bookmarkBtn.hasAttribute('data-reel-id') || (cardEl && cardEl.hasAttribute('data-reel-id')) || (cardEl && cardEl.classList.contains('reel-card'));
      const endpoint = isReel ? `/api/reels/${mediaData.id}/save` : `/api/posts/${mediaData.id}/save`;

      const token = window.getAuthToken ? window.getAuthToken() : localStorage.getItem('invibe_jwt_token');
      if (!token) {
        showToast('Please login to save');
        return;
      }

      try {
        const res = await fetch(`${API_URL}${endpoint}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Failed to save');
        const data = await res.json();

        if (data.isSaved) {
          btnEl.classList.add('saved');
          if (icon) { icon.style.fill = '#FBBF24'; icon.style.stroke = '#FBBF24'; }
          if (mediaData && !window.savedHubbs.find(s => s.id === mediaData.id)) {
            window.savedHubbs.push(mediaData);
          }
          showToast('Saved to collection ⭐');
        } else {
          btnEl.classList.remove('saved');
          if (icon) { icon.style.fill = 'none'; icon.style.stroke = ''; }
          if (mediaData) {
            window.savedHubbs = window.savedHubbs.filter(s => s.id !== mediaData.id);
          }
          showToast('Removed from Saved');
        }

        if (typeof window.updateSavedBadgeCount === 'function') {
          window.updateSavedBadgeCount();
        }

        const savedGrid = document.getElementById('profile-saved-grid');
        if (savedGrid && savedGrid.classList.contains('active')) {
          if (typeof window.fetchSavedHubbs === 'function') {
            await window.fetchSavedHubbs();
          }
          renderSavedHubbs();
        }
      } catch (err) {
        console.error(err);
        showToast(err.message);
      }
    }
  });


  // --- PREMIUM STORY AUTO-PLAY VIEWER SYSTEM ---
  const storyViewer = document.getElementById('story-viewer-modal');
  const storyViewerClose = document.getElementById('story-viewer-close');
  const storyViewerDelete = document.getElementById('story-viewer-delete');
  const storyViewerAvatar = document.getElementById('story-viewer-avatar');
  const storyViewerName = document.getElementById('story-viewer-name');
  const storyViewerTime = document.getElementById('story-viewer-time');
  const storyViewerImg = document.getElementById('story-viewer-img');
  const storyProgressBars = document.getElementById('story-progress-bars');
  const storyContentBox = document.getElementById('story-viewer-content-box');

  const storyPrev = document.getElementById('story-prev-btn');
  const storyNext = document.getElementById('story-next-btn');

  function openStoryViewer(groupIndex, storyIndex = 0, mediaIndex = 0) {
    if (!state.storyGroups[groupIndex]) return;
    state.activeGroupIndex = groupIndex;
    state.activeStoryIndex = storyIndex;
    state.activeMediaIndex = mediaIndex;
    if (storyViewer) {
      storyViewer.style.display = 'flex';
      storyViewer.classList.add('active');
    }
    loadStoryContent(groupIndex, storyIndex, mediaIndex);
  }

  async function deleteCurrentStory() {
    const group = state.storyGroups[state.activeGroupIndex];
    if (!group) return;
    const storyData = group.stories[state.activeStoryIndex];
    if (!storyData) return;
    const token = localStorage.getItem('invibe_jwt_token');
    if (!token) return;

    try {
      const res = await fetch(`${API_URL}/api/stories/${storyData._id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to delete story');
      showToast('HUBB deleted successfully!');
      closeStoryViewer();
      loadStories();
    } catch (err) {
      console.error(err);
      showToast('Failed to delete HUBB.');
    }
  }

  // Story Header Ticker (Rotating Timestamp, Music, Location)
  let _storyHeaderTickerTimer = null;
  function startStoryHeaderTicker(items) {
    stopStoryHeaderTicker();
    if (!items || items.length <= 1) return;

    let currentIndex = 0;
    _storyHeaderTickerTimer = setInterval(() => {
      const prevItem = items[currentIndex];
      currentIndex = (currentIndex + 1) % items.length;
      const nextItem = items[currentIndex];

      if (prevItem) {
        prevItem.style.opacity = '0';
        prevItem.style.transform = 'translateY(-6px)';
        setTimeout(() => {
          if (prevItem.style.opacity === '0') {
            prevItem.style.display = 'none';
            prevItem.style.transform = 'translateY(6px)';
          }
        }, 350);
      }
      if (nextItem) {
        nextItem.style.display = 'inline-flex';
        nextItem.style.transform = 'translateY(6px)';
        requestAnimationFrame(() => {
          nextItem.style.opacity = '1';
          nextItem.style.transform = 'translateY(0)';
        });
      }
    }, 2800);
  }

  function stopStoryHeaderTicker() {
    if (_storyHeaderTickerTimer) {
      clearInterval(_storyHeaderTickerTimer);
      _storyHeaderTickerTimer = null;
    }
  }

  function formatViewerRelativeTime(timestamp) {
    if (!timestamp) return 'Just now';
    const diff = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
    if (isNaN(diff) || diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function loadStoryContent(groupIndex, storyIndex, mediaIndex = 0) {
    console.log(`[STAGE 3: loadStoryContent()] Init | Group: ${groupIndex}, Story: ${storyIndex}, Media: ${mediaIndex}`);

    // Close views panel if open
    const storyViewsPanel = document.getElementById('story-views-panel');
    if (storyViewsPanel) storyViewsPanel.classList.remove('active');
    state.isStoryViewsOpen = false;

    const group = state.storyGroups[groupIndex];
    if (!group || !group.stories[storyIndex]) {
      closeStoryViewer();
      return;
    }
    const data = group.stories[storyIndex];

    const mediaList = (data.mediaItems && data.mediaItems.length > 0) ? data.mediaItems : [{ mediaUrl: data.img, mediaType: data.mediaType || 'image' }];
    if (mediaIndex >= mediaList.length) mediaIndex = mediaList.length - 1;
    if (mediaIndex < 0) mediaIndex = 0;
    state.activeMediaIndex = mediaIndex;
    const currentMediaItem = mediaList[mediaIndex];

    // Immediately mark currently displayed story as viewed
    if (data && (data._id || data.id)) {
      markStorySeen(data._id || data.id);
    }

    if (storyViewerAvatar) storyViewerAvatar.src = data.avatar;
    if (storyViewerName) storyViewerName.textContent = data.name;
    if (storyViewerTime) {
      storyViewerTime.textContent = formatStoryTime(data.createdAt || data.created_at || data.time);
      storyViewerTime.style.display = 'inline-flex';
      storyViewerTime.style.opacity = '1';
      storyViewerTime.style.transform = 'translateY(0)';
    }

    // Render Location Badge in Story Viewer
    const locBadge = document.getElementById('story-viewer-location-badge');
    const locText = document.getElementById('story-viewer-location-text');
    const locVal = data.location || (data.locationData && (data.locationData.displayName || data.locationData.name)) || (data.selectedLocation && (data.selectedLocation.displayName || data.selectedLocation.name)) || (currentMediaItem.editorState && currentMediaItem.editorState.selectedLocation && (currentMediaItem.editorState.selectedLocation.displayName || currentMediaItem.editorState.selectedLocation.name));
    if (locBadge && locText) {
      if (locVal) {
        locText.textContent = typeof locVal === 'string' ? locVal : (locVal.displayName || locVal.name || 'Location');
        locBadge.style.display = 'none';
        locBadge.style.opacity = '0';
      } else {
        locBadge.style.display = 'none';
      }
    }

    // Render Music Badge in Story Viewer
    const musicBadge = document.getElementById('story-viewer-music-badge');
    const musicText = document.getElementById('story-viewer-music-text');
    const musicVal = data.music || data.musicTrack || (currentMediaItem.editorState && currentMediaItem.editorState.musicTrack);
    if (musicBadge && musicText) {
      if (musicVal && (musicVal.title || typeof musicVal === 'string')) {
        const titleStr = typeof musicVal === 'string' ? musicVal : `${musicVal.title}${musicVal.artist ? ' • ' + musicVal.artist : ''}`;
        musicText.textContent = titleStr;
        musicBadge.style.display = 'none';
        musicBadge.style.opacity = '0';
      } else {
        musicBadge.style.display = 'none';
      }
    }

    // Setup rotating header ticker
    stopStoryHeaderTicker();
    const tickerItems = [];
    if (storyViewerTime) tickerItems.push(storyViewerTime);
    if (musicVal && musicBadge) tickerItems.push(musicBadge);
    if (locVal && locBadge) tickerItems.push(locBadge);
    if (tickerItems.length > 1) {
      startStoryHeaderTicker(tickerItems);
    }

    if (window.lucide) window.lucide.createIcons();

    const srcUrl = currentMediaItem.mediaUrl || currentMediaItem.media_url || data.img;
    const typeStr = currentMediaItem.mediaType || currentMediaItem.media_type || data.mediaType || 'image';

    if (storyViewerImg) {
      storyViewerImg.src = srcUrl;
      storyViewerImg.style.display = 'block';
    }

    const captionEl = document.getElementById('story-viewer-caption-text');
    if (captionEl) {
      captionEl.textContent = data.caption || '';
      const capContainer = document.getElementById('story-viewer-caption-container');
      if (capContainer) capContainer.style.display = (data.caption && data.caption.trim()) ? 'block' : 'none';
    }

    const mediaContainer = document.getElementById('story-viewer-media-container');
    const isVideo = typeStr.includes('video') || (typeof srcUrl === 'string' && (srcUrl.endsWith('.mp4') || srcUrl.startsWith('data:video') || srcUrl.includes('/video/') || srcUrl.includes('format=mp4')));
    if (mediaContainer && srcUrl) {
      if (isVideo) {
        mediaContainer.innerHTML = '';
        const video = document.createElement('video');
        video.src = srcUrl;
        video.autoplay = true;
        video.playsInline = true;
        video.style.cssText = 'max-width:100%; max-height:100%; object-fit:contain; border-radius:12px;';
        mediaContainer.appendChild(video);
      } else {
        mediaContainer.innerHTML = `<img src="${srcUrl}" id="story-viewer-img" alt="Story content" style="max-width:100%; max-height:100%; object-fit:contain; border-radius:12px;">`;
      }
    }

    // Render interactive stickers overlay onto Story Viewer
    let stickersContainer = document.getElementById('story-viewer-stickers-container');
    if (!stickersContainer) {
      stickersContainer = document.createElement('div');
      stickersContainer.id = 'story-viewer-stickers-container';
      stickersContainer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 10; overflow: hidden;';
      if (storyContentBox) storyContentBox.appendChild(stickersContainer);
    }
    stickersContainer.innerHTML = '';

    const storyLayers = data.layers || (currentMediaItem.editorState && currentMediaItem.editorState.layers) || [];
    let hasMusicSticker = false;
    let hasLocationSticker = false;

    if (storyLayers && storyLayers.length > 0) {
      storyLayers.forEach(layer => {
        const el = document.createElement('div');
        el.style.cssText = `position: absolute; left: ${layer.x}%; top: ${layer.y}%; transform: translate(-50%, -50%) rotate(${layer.rotation || 0}deg) scale(${layer.scale || 1}); z-index: ${layer.zIndex || 10}; pointer-events: none;`;

        if (layer.type === 'music') {
          hasMusicSticker = true;
          const track = layer.track || data.music || data.musicTrack || (currentMediaItem.editorState && currentMediaItem.editorState.musicTrack) || {};
          const artwork = track.artwork || layer.artwork || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=150&h=150&q=80';
          const title = track.title || layer.content || 'Music';
          const artist = track.artist || layer.artist || '';

          el.innerHTML = `
            <div class="story-music-sticker-card" style="display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: rgba(20, 20, 25, 0.85); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.2); border-radius: 24px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); color: white; min-width: 140px; max-width: 260px; user-select: none;">
              <div style="position: relative; width: 32px; height: 32px; flex-shrink: 0;">
                <img src="${artwork}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 1.5px solid rgba(255,255,255,0.4); animation: rotateDisc 8s linear infinite;" alt="Artwork" />
                <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.3); border-radius: 50%;">
                  <span style="font-size: 11px;">🎵</span>
                </div>
              </div>
              <div style="display: flex; flex-direction: column; min-width: 0; text-align: left;">
                <span style="font-size: 12px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2;">${title}</span>
                <span style="font-size: 10px; color: rgba(255,255,255,0.7); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px;">${artist}</span>
              </div>
            </div>
          `;
        } else if (layer.type === 'location') {
          hasLocationSticker = true;
          const loc = layer.loc || data.locationData || data.selectedLocation || {};
          const locName = typeof loc === 'string' ? loc : (loc.displayName || loc.name || layer.content || 'Location');

          el.innerHTML = `
            <div class="story-location-sticker-card" style="display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; background: linear-gradient(135deg, rgba(168,85,247,0.85) 0%, rgba(126,34,206,0.9) 100%); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.25); border-radius: 20px; box-shadow: 0 6px 20px rgba(168,85,247,0.35); color: white; user-select: none;">
              <span style="font-size: 13px;">📍</span>
              <span style="font-size: 12px; font-weight: 700; color: #fff; white-space: nowrap; text-shadow: 0 1px 2px rgba(0,0,0,0.3);">${locName}</span>
            </div>
          `;
        } else if (layer.type === 'text') {
          el.innerHTML = `<div style="color: ${layer.styles?.color || layer.color || 'white'}; font-family: ${layer.styles?.font || layer.fontFamily || 'inherit'}; font-size: ${layer.styles?.size || layer.fontSize || 24}px; font-weight: ${(layer.styles?.bold || layer.bold) ? 'bold' : 'normal'}; font-style: ${(layer.styles?.italic || layer.italic) ? 'italic' : 'normal'}; text-shadow: 0 2px 10px rgba(0,0,0,0.6); text-align: center; white-space: pre-wrap;">${layer.content || layer.text || ''}</div>`;
        } else if (layer.type === 'sticker') {
          el.innerHTML = `<div style="font-size: ${layer.styles?.size || 80}px; pointer-events: none;">${layer.content || layer.emoji || ''}</div>`;
        }
        stickersContainer.appendChild(el);
      });
    }

    // Default stickers fallback if metadata exists but wasn't in layers
    if (!hasMusicSticker && musicVal && (musicVal.title || typeof musicVal === 'string')) {
      const track = typeof musicVal === 'string' ? { title: musicVal, artist: '' } : musicVal;
      const el = document.createElement('div');
      el.style.cssText = `position: absolute; left: 50%; top: 72%; transform: translate(-50%, -50%); z-index: 10; pointer-events: none;`;
      el.innerHTML = `
        <div class="story-music-sticker-card" style="display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: rgba(20, 20, 25, 0.85); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.2); border-radius: 24px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); color: white; min-width: 140px; max-width: 260px; user-select: none;">
          <div style="position: relative; width: 32px; height: 32px; flex-shrink: 0;">
            <img src="${track.artwork || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=150&h=150&q=80'}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 1.5px solid rgba(255,255,255,0.4); animation: rotateDisc 8s linear infinite;" alt="Artwork" />
            <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.3); border-radius: 50%;">
              <span style="font-size: 11px;">🎵</span>
            </div>
          </div>
          <div style="display: flex; flex-direction: column; min-width: 0; text-align: left;">
            <span style="font-size: 12px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2;">${track.title}</span>
            <span style="font-size: 10px; color: rgba(255,255,255,0.7); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px;">${track.artist || ''}</span>
          </div>
        </div>
      `;
      stickersContainer.appendChild(el);
    }

    if (!hasLocationSticker && locVal) {
      const locName = typeof locVal === 'string' ? locVal : (locVal.displayName || locVal.name || 'Location');
      const el = document.createElement('div');
      el.style.cssText = `position: absolute; left: 50%; top: 25%; transform: translate(-50%, -50%); z-index: 10; pointer-events: none;`;
      el.innerHTML = `
        <div class="story-location-sticker-card" style="display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; background: linear-gradient(135deg, rgba(168,85,247,0.85) 0%, rgba(126,34,206,0.9) 100%); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.25); border-radius: 20px; box-shadow: 0 6px 20px rgba(168,85,247,0.35); color: white; user-select: none;">
          <span style="font-size: 13px;">📍</span>
          <span style="font-size: 12px; font-weight: 700; color: #fff; white-space: nowrap; text-shadow: 0 1px 2px rgba(0,0,0,0.3);">${locName}</span>
        </div>
      `;
      stickersContainer.appendChild(el);
    }

    // Story Viewer Background Music Playback via Singleton StoryAudioManager
    if (window.StoryAudioManager) {
      window.StoryAudioManager.destroy();
    }
    const isMusicMuted = !!(musicVal && (musicVal.isMuted || musicVal.muted));
    const audioUrl = (musicVal && (musicVal.previewUrl || musicVal.url)) || null;
    if (audioUrl && window.StoryAudioManager) {
      window.StoryAudioManager.load(musicVal, 'viewer');
      if (!isMusicMuted) {
        window.StoryAudioManager.play('viewer');
      }
    }

    const currentUser = getCurrentUser();
    const currentUserId = currentUser ? (currentUser.id || currentUser._id) : null;
    if (data.authorId === currentUserId) {
      storyViewerDelete.style.display = 'block';
    } else {
      storyViewerDelete.style.display = 'none';
    }

    console.log(`[STAGE 5: renderStoryViewer / loadStoryContent()] Group: ${groupIndex}, Story: ${storyIndex} | StoryId: ${data._id} | isLiked: ${data.isLiked} | likesCount: ${data.likesCount} | time: ${formatStoryTime(data.createdAt || data.created_at)}`);

    const storyFooter = document.querySelector('.story-viewer-footer');
    if (storyFooter) storyFooter.style.display = 'flex';

    const storyReplyContainer = document.getElementById('story-reply-input-container');
    if (storyReplyContainer) storyReplyContainer.style.display = 'flex';

    const storyReplyInput = document.getElementById('story-reply-input');
    const storyLikeBtn = document.getElementById('story-like-btn');
    const storyShareBtn = document.getElementById('story-share-btn');
    const storyReplySend = document.getElementById('story-reply-send');
    const storyEmojiPopover = document.getElementById('story-emoji-popover');
    const storyLikeCount = document.getElementById('story-like-count');
    const storyInsightsBtn = document.getElementById('story-insights-trigger-btn');
    const storyInsightsViews = document.getElementById('story-insights-views');
    const storyInsightsLikes = document.getElementById('story-insights-likes');

    if (storyEmojiPopover) storyEmojiPopover.classList.remove('active');

    if (storyReplyInput) {
      storyReplyInput.style.display = 'block';
      storyReplyInput.value = '';
      storyReplyInput.disabled = false;
    }
    if (storyLikeBtn) storyLikeBtn.style.display = 'flex';
    if (storyReplySend) {
      storyReplySend.style.display = 'flex';
      storyReplySend.disabled = true;
      storyReplySend.innerHTML = '<i data-lucide="send"></i>';
    }

    if (data.authorId === currentUserId) {
      if (storyInsightsBtn) {
        storyInsightsBtn.style.display = 'flex';
        if (storyInsightsViews) storyInsightsViews.textContent = data.viewsCount || 0;
      }
    } else {
      if (storyInsightsBtn) storyInsightsBtn.style.display = 'none';
    }

    if (storyShareBtn) storyShareBtn.style.display = 'flex';
    if (storyLikeCount) storyLikeCount.textContent = data.likesCount || 0;

    updateStoryLikeUI(data.isLiked || false, data.likesCount || 0);

    // Refresh icons inside action bar
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }

    storyProgressBars.innerHTML = '';
    for (let i = 0; i < group.stories.length; i++) {
      const barWrapper = document.createElement('div');
      barWrapper.className = 'story-progress-bar-wrapper';
      const barFill = document.createElement('div');
      barFill.className = 'story-progress-bar-fill';

      if (i < storyIndex) {
        barFill.style.width = '100%';
      } else if (i > storyIndex) {
        barFill.style.width = '0%';
      }

      barWrapper.appendChild(barFill);
      storyProgressBars.appendChild(barWrapper);
    }

    state.isStoryPaused = false;
    startStoryTimer(isVideo);
  }

  function advanceNextStory() {
    stopStoryTimer();
    if (window.StoryAudioManager) {
      window.StoryAudioManager.destroy();
    }
    state.storyProgressPercent = 0;
    const group = state.storyGroups?.[state.activeGroupIndex];
    if (!group) {
      closeStoryViewer();
      return;
    }
    const currentStory = group.stories?.[state.activeStoryIndex];
    const mediaLen = (currentStory && currentStory.mediaItems && currentStory.mediaItems.length > 0) ? currentStory.mediaItems.length : 1;

    if (state.activeMediaIndex < mediaLen - 1) {
      openStoryViewer(state.activeGroupIndex, state.activeStoryIndex, state.activeMediaIndex + 1);
    } else if (state.activeStoryIndex < group.stories.length - 1) {
      openStoryViewer(state.activeGroupIndex, state.activeStoryIndex + 1, 0);
    } else if (state.activeGroupIndex < state.storyGroups.length - 1) {
      openStoryViewer(state.activeGroupIndex + 1, 0, 0);
    } else {
      closeStoryViewer();
    }
  }

  function advancePrevStory() {
    stopStoryTimer();
    if (window.StoryAudioManager) {
      window.StoryAudioManager.destroy();
    }
    state.storyProgressPercent = 0;
    const group = state.storyGroups?.[state.activeGroupIndex];
    if (!group) return;

    if (state.activeMediaIndex > 0) {
      openStoryViewer(state.activeGroupIndex, state.activeStoryIndex, state.activeMediaIndex - 1);
    } else if (state.activeStoryIndex > 0) {
      const prevStory = group.stories[state.activeStoryIndex - 1];
      const prevMediaLen = (prevStory.mediaItems && prevStory.mediaItems.length > 0) ? prevStory.mediaItems.length : 1;
      openStoryViewer(state.activeGroupIndex, state.activeStoryIndex - 1, prevMediaLen - 1);
    } else if (state.activeGroupIndex > 0) {
      const prevGroup = state.storyGroups[state.activeGroupIndex - 1];
      const prevStory = prevGroup.stories[prevGroup.stories.length - 1];
      const prevMediaLen = (prevStory.mediaItems && prevStory.mediaItems.length > 0) ? prevStory.mediaItems.length : 1;
      openStoryViewer(state.activeGroupIndex - 1, prevGroup.stories.length - 1, prevMediaLen - 1);
    }
  }

  function startStoryTimer(isVideo = false) {
    stopStoryTimer();

    const activeFill = storyProgressBars.children[state.activeStoryIndex]?.querySelector('.story-progress-bar-fill');
    if (activeFill) activeFill.style.width = '0%';
    state.storyProgressPercent = 0;

    let tickCount = 0;

    if (isVideo) {
      const mediaContainer = document.getElementById('story-viewer-media-container');
      const video = mediaContainer ? mediaContainer.querySelector('video') : null;

      if (video) {
        let hasEnded = false;

        const onTimeUpdate = () => {
          if (hasEnded) return;
          if (video.duration && !isNaN(video.duration) && isFinite(video.duration) && video.duration > 0) {
            const pct = Math.min(100, (video.currentTime / video.duration) * 100);
            state.storyProgressPercent = pct;
            if (activeFill) activeFill.style.width = `${pct}%`;
          }
        };

        const onEnded = () => {
          if (hasEnded) return;
          hasEnded = true;
          if (activeFill) activeFill.style.width = '100%';
          advanceNextStory();
        };

        const onError = () => {
          console.warn('[Story Viewer] Video failed to load/play, advancing');
          if (!hasEnded) {
            hasEnded = true;
            advanceNextStory();
          }
        };

        video.addEventListener('timeupdate', onTimeUpdate);
        video.addEventListener('ended', onEnded);
        video.addEventListener('error', onError);

        state._storyVideoCleanup = () => {
          try {
            video.removeEventListener('timeupdate', onTimeUpdate);
            video.removeEventListener('ended', onEnded);
            video.removeEventListener('error', onError);
            video.pause();
            video.removeAttribute('src');
            video.load();
          } catch (_) { }
        };

        const playPromise = video.play();
        if (playPromise !== undefined) {
          playPromise.catch(err => {
            console.warn('[Story Viewer Video Autoplay notice]:', err.message);
          });
        }
      }

      // Live ticker for 24-hour expiry check and relative timestamp updates
      state.storyProgressInterval = setInterval(() => {
        if (state.isStoryPaused || state.isStoryViewsOpen) return;
        tickCount++;
        if (tickCount % 50 === 0) {
          const group = state.storyGroups?.[state.activeGroupIndex];
          const data = group?.stories?.[state.activeStoryIndex];
          if (data && storyViewerTime) {
            storyViewerTime.textContent = formatStoryTime(data.createdAt || data.created_at || data.time);
            const createdMs = new Date(data.createdAt || data.created_at).getTime();
            if (!isNaN(createdMs) && (Date.now() - createdMs >= 24 * 60 * 60 * 1000)) {
              if (typeof purgeExpiredStories === 'function') {
                purgeExpiredStories();
              }
            }
          }
        }
      }, 20);

    } else {
      // Standard image timer (5 seconds)
      state.storyProgressInterval = setInterval(() => {
        if (state.isStoryPaused || state.isStoryViewsOpen) return;
        state.storyProgressPercent += 0.4;
        if (activeFill) activeFill.style.width = `${state.storyProgressPercent}%`;

        tickCount++;
        if (tickCount % 50 === 0) {
          const group = state.storyGroups?.[state.activeGroupIndex];
          const data = group?.stories?.[state.activeStoryIndex];
          if (data && storyViewerTime) {
            storyViewerTime.textContent = formatStoryTime(data.createdAt || data.created_at || data.time);
            const createdMs = new Date(data.createdAt || data.created_at).getTime();
            if (!isNaN(createdMs) && (Date.now() - createdMs >= 24 * 60 * 60 * 1000)) {
              if (typeof purgeExpiredStories === 'function') {
                purgeExpiredStories();
              }
              return;
            }
          }
        }

        if (state.storyProgressPercent >= 100) {
          advanceNextStory();
        }
      }, 20);
    }
  }

  function stopStoryTimer() {
    if (state.storyProgressInterval) {
      clearInterval(state.storyProgressInterval);
      state.storyProgressInterval = null;
    }
    if (typeof state._storyVideoCleanup === 'function') {
      state._storyVideoCleanup();
      state._storyVideoCleanup = null;
    }
    stopStoryHeaderTicker();
  }

  function closeStoryViewer() {
    stopStoryTimer();
    if (window.StoryAudioManager) {
      window.StoryAudioManager.destroy();
    }
    state.storyProgressPercent = 0;
    state.isStoryViewsOpen = false;
    const mediaContainer = document.getElementById('story-viewer-media-container');
    if (mediaContainer) {
      const v = mediaContainer.querySelector('video');
      if (v) {
        try {
          v.pause();
          v.removeAttribute('src');
          v.load();
        } catch (_) { }
      }
      mediaContainer.innerHTML = '';
    }
    const stickersContainer = document.getElementById('story-viewer-stickers-container');
    if (stickersContainer) stickersContainer.innerHTML = '';

    const storyViewsPanel = document.getElementById('story-views-panel');
    if (storyViewsPanel) {
      storyViewsPanel.classList.remove('active');
      storyViewsPanel.style.transform = '';
    }

    const storyEmojiPopover = document.getElementById('story-emoji-popover');
    if (storyEmojiPopover) {
      storyEmojiPopover.classList.remove('active');
    }

    if (storyViewer) {
      storyViewer.classList.remove('active');
      storyViewer.style.display = 'none';
    }
    if (typeof updateStoryRingsUI === 'function') {
      updateStoryRingsUI();
    }
  }

  // Tap to Pause implementation
  const pauseStory = () => {
    state.isStoryPaused = true;
    const mediaContainer = document.getElementById('story-viewer-media-container');
    const video = mediaContainer ? mediaContainer.querySelector('video') : null;
    if (video && !video.paused) {
      video.pause();
    }
    if (window.StoryAudioManager) {
      window.StoryAudioManager.pause();
    }
  };
  const resumeStory = () => {
    state.isStoryPaused = false;
    const mediaContainer = document.getElementById('story-viewer-media-container');
    const video = mediaContainer ? mediaContainer.querySelector('video') : null;
    if (video && video.paused && !state.isStoryViewsOpen) {
      video.play().catch(() => { });
    }
    if (window.StoryAudioManager && !state.isStoryViewsOpen) {
      window.StoryAudioManager.resume();
    }
  };
  if (storyContentBox) {
    storyContentBox.addEventListener('mousedown', pauseStory);
    storyContentBox.addEventListener('mouseup', resumeStory);
    storyContentBox.addEventListener('mouseleave', resumeStory);
    storyContentBox.addEventListener('touchstart', pauseStory);
    storyContentBox.addEventListener('touchend', resumeStory);
  }

  if (storyViewerClose) storyViewerClose.addEventListener('click', closeStoryViewer);
  if (storyViewerDelete) storyViewerDelete.addEventListener('click', deleteCurrentStory);

  if (storyViewerAvatar) {
    storyViewerAvatar.style.cursor = 'pointer';
    storyViewerAvatar.addEventListener('click', () => {
      const group = state.storyGroups?.[state.activeGroupIndex];
      const data = group?.stories?.[state.activeStoryIndex];
      const authorId = getUserIdentifier(data?.author) || data?.authorId || getUserIdentifier(group?.user);
      if (authorId) {
        closeStoryViewer();
        switchView('profile', authorId);
      }
    });
  }

  if (storyViewerName) {
    storyViewerName.style.cursor = 'pointer';
    storyViewerName.addEventListener('click', () => {
      const group = state.storyGroups?.[state.activeGroupIndex];
      const data = group?.stories?.[state.activeStoryIndex];
      const authorId = getUserIdentifier(data?.author) || data?.authorId || getUserIdentifier(group?.user);
      if (authorId) {
        closeStoryViewer();
        switchView('profile', authorId);
      }
    });
  }

  if (storyPrev) {
    storyPrev.addEventListener('click', (e) => {
      e.stopPropagation();
      advancePrevStory();
    });
  }
  if (storyNext) {
    storyNext.addEventListener('click', (e) => {
      e.stopPropagation();
      advanceNextStory();
    });
  }

  // --- HUBBS (STORIES) REPLY & EMOJI SYSTEM ---
  const emojiLibrary = {
    All: ['😊', '😂', '😍', '👍', '🔥', '🎉', '❤️', '👏', '😮', '😢', '🙌', '🚀', '🕶️', '☕', '✨', '💯', '🥳', '🤩', '😎', '💪', '🌟', '💖', '🙏', '😇'],
    Smileys: ['😊', '😂', '😍', '😄', '😅', '😆', '😇', '😉', '😌', '🥹', '😎', '🤩', '😏', '😮', '😢', '😭', '😤', '🤯', '😴', '😋'],
    People: ['👋', '👍', '👏', '🙌', '🙏', '🤝', '💪', '🫶', '🧑‍💻', '👨‍💻', '👩‍💻', '🧠', '🤗', '🫵', '🫰', '🤟', '🤘', '👀', '🫠', '🤙'],
    Animals: ['🐶', '🐱', '🐭', '🐹', '🦊', '🐻', '🐼', '🐸', '🐵', '🐔', '🦄', '🦋', '🐙', '🐬', '🦁', '🐢', '🐳', '🦒', '🐟', '🐨'],
    Food: ['🍕', '🍔', '🍟', '🍣', '🍜', '🍩', '🍪', '🍓', '🍇', '🥑', '🥗', '🍉', '🍍', '🍰', '🍹', '☕', '🍵', '🥐', '🍌', '🍗'],
    Activities: ['⚽', '🏀', '🏈', '⚡', '🎾', '🎮', '🎨', '🎵', '🎸', '🎧', '🎬', '🎉', '🎊', '🎁', '🎯', '🏆', '🔥', '🚀', '💃', '🧘'],
    Travel: ['✈️', '🚗', '🚆', '🚲', '🏖️', '🏕️', '🌍', '⛵', '🚢', '🚁', '🗺️', '🏔️', '🌊', '🌞', '🧭', '🛫', '🛴', '🚉', '🛏️', '🏙️'],
    Objects: ['💡', '📱', '💻', '⌨️', '🖱️', '🎧', '📷', '📚', '🧰', '💼', '🪄', '🎀', '🪴', '🧴', '🪞', '🧺', '💎', '🔑', '🧩', '🛍️']
  };

  const storyReplyInput = document.getElementById('story-reply-input');
  const storyReplySend = document.getElementById('story-reply-send');
  const storyEmojiBtn = document.getElementById('story-emoji-btn');
  const storyEmojiPopover = document.getElementById('story-emoji-popover');
  const storyEmojiGrid = document.getElementById('story-emoji-picker-grid');
  const storyEmojiSearchInput = storyEmojiPopover?.querySelector('.emoji-picker-search');
  const storyEmojiCategoryButtons = storyEmojiPopover?.querySelectorAll('.emoji-category-btn');

  let isSendingStoryReply = false;

  async function handleSendStoryReply() {
    if (isSendingStoryReply) return;

    if (!storyReplyInput) return;
    const replyText = storyReplyInput.value.trim();
    if (!replyText) {
      if (storyReplySend) storyReplySend.disabled = true;
      return;
    }

    const group = state.storyGroups?.[state.activeGroupIndex];
    const storyData = group?.stories?.[state.activeStoryIndex];
    if (!group || !storyData) {
      showToast('HUBB information unavailable.');
      return;
    }

    const currentUser = getCurrentUser();
    const token = getAuthToken();
    if (!currentUser || !token) {
      showToast('Please log in to reply to HUBBS.');
      return;
    }

    const currentUserId = (currentUser.id || currentUser._id || '').toString();
    const rawAuthorId = getUserIdentifier(storyData.author) || storyData.authorId || getUserIdentifier(group.user);
    const authorId = rawAuthorId ? rawAuthorId.toString() : null;
    const storyId = (storyData._id || storyData.id || '').toString();

    if (!authorId || !storyId) {
      showToast('Story owner could not be determined.');
      return;
    }

    if (authorId === currentUserId) {
      showToast('You cannot reply to your own HUBB.');
      return;
    }

    isSendingStoryReply = true;
    storyReplyInput.disabled = true;
    if (storyReplySend) {
      storyReplySend.disabled = true;
      storyReplySend.innerHTML = '<i data-lucide="loader" class="animate-spin" style="width: 14px; height: 14px;"></i>';
      if (window.lucide && typeof window.lucide.createIcons === 'function') {
        window.lucide.createIcons();
      }
    }

    try {
      const secretKey = getChatSecretKey(currentUserId, authorId);
      const isVideo = (storyData.mediaType === 'video') || (storyData.img && typeof storyData.img === 'string' && (storyData.img.endsWith('.mp4') || storyData.img.includes('/video/')));

      const hubReplyPayload = {
        text: replyText,
        hubType: 'story',
        hubId: storyId,
        storyId: storyId,
        messageType: 'hubbs_reply',
        thumbnail: storyData.img || storyData.mediaUrl || '',
        isVideo: !!isVideo,
        authorName: storyData.name || group.user?.fullName || group.user?.username || 'Hubber',
        authorAvatar: storyData.avatar || group.user?.profileImage || '',
        timestamp: storyData.createdAt || storyData.created_at || new Date().toISOString(),
        isReply: true
      };

      const encryptedText = encryptMessage(JSON.stringify(hubReplyPayload), secretKey);

      const res = await fetch(`${API_URL}/api/chats/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          recipient: authorId,
          content: encryptedText,
          mediaUrl: `story_${storyId}`,
          mediaType: 'hub',
          mediaName: 'HUBB Reply',
          mediaSize: 'Story',
          isStoryReply: true
        })
      });

      if (!res.ok) {
        let errData = {};
        try { errData = await res.json(); } catch (_) {}
        throw new Error(errData.error || `HTTP ${res.status}: Failed to send reply`);
      }

      const createdMsg = await res.json();

      showToast('HUBB reply sent! 💬');
      storyReplyInput.value = '';

      if (storyEmojiPopover) {
        storyEmojiPopover.classList.remove('active');
      }

      // Append to in-memory active conversation
      if (typeof appendSingleMessage === 'function') {
        appendSingleMessage(authorId, createdMsg);
      }

      // Update sidebar thread preview in-place
      if (typeof updateThreadLastMessageInPlace === 'function') {
        updateThreadLastMessageInPlace(authorId, createdMsg);
      }

      // Refresh threads list so conversation ordering and list update immediately
      if (typeof loadChatThreads === 'function') {
        loadChatThreads(false);
      }

      // Close story viewer upon successful reply
      closeStoryViewer();

    } catch (err) {
      console.error('HUBB reply error:', err);
      showToast('Failed to send reply: ' + (err.message || 'Please try again.'));
      // Keep typed message intact for retry
    } finally {
      isSendingStoryReply = false;
      if (storyReplyInput) {
        storyReplyInput.disabled = false;
        storyReplyInput.focus();
      }
      if (storyReplySend) {
        storyReplySend.innerHTML = '<i data-lucide="send"></i>';
        storyReplySend.disabled = !storyReplyInput || !storyReplyInput.value.trim();
        if (window.lucide && typeof window.lucide.createIcons === 'function') {
          window.lucide.createIcons();
        }
      }
    }
  }

  function renderStoryEmojiGrid(category = 'All', search = '') {
    if (!storyEmojiGrid) return;

    const normalized = search.trim().toLowerCase();
    const allEmojis = emojiLibrary[category] || emojiLibrary.All;
    const filtered = allEmojis.filter(emoji => {
      if (!normalized) return true;
      return emoji.toLowerCase().includes(normalized) || emoji.includes(search.trim());
    });

    storyEmojiGrid.innerHTML = '';
    filtered.forEach(emoji => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-select-btn';
      btn.textContent = emoji;
      btn.setAttribute('title', emoji);
      storyEmojiGrid.appendChild(btn);
    });
  }

  if (storyReplyInput) {
    storyReplyInput.addEventListener('input', () => {
      const hasContent = !!storyReplyInput.value.trim();
      if (storyReplySend) {
        storyReplySend.disabled = !hasContent;
      }
    });

    storyReplyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const txt = storyReplyInput.value.trim();
        if (txt) {
          handleSendStoryReply();
        }
      }
    });

    storyReplyInput.addEventListener('focus', () => {
      pauseStory();
    });
  }

  if (storyReplySend) {
    storyReplySend.addEventListener('click', (e) => {
      e.stopPropagation();
      handleSendStoryReply();
    });
  }

  if (storyEmojiBtn && storyEmojiPopover) {
    storyEmojiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isActive = storyEmojiPopover.classList.toggle('active');
      if (isActive) {
        pauseStory();
        renderStoryEmojiGrid();
      }
    });
  }

  if (storyEmojiCategoryButtons) {
    storyEmojiCategoryButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const category = btn.getAttribute('data-emoji-category');
        storyEmojiCategoryButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderStoryEmojiGrid(category, storyEmojiSearchInput?.value || '');
      });
    });
  }

  if (storyEmojiSearchInput) {
    storyEmojiSearchInput.addEventListener('input', (e) => {
      e.stopPropagation();
      const activeCategory = storyEmojiPopover?.querySelector('.emoji-category-btn.active')?.getAttribute('data-emoji-category') || 'All';
      renderStoryEmojiGrid(activeCategory, storyEmojiSearchInput.value);
    });
    storyEmojiSearchInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });
  }

  if (storyEmojiPopover && storyReplyInput) {
    storyEmojiPopover.addEventListener('click', (e) => {
      const selectBtn = e.target.closest('.emoji-select-btn');
      if (selectBtn) {
        e.stopPropagation();
        const emoji = selectBtn.textContent.trim();
        const startPos = storyReplyInput.selectionStart ?? storyReplyInput.value.length;
        const endPos = storyReplyInput.selectionEnd ?? storyReplyInput.value.length;
        const textVal = storyReplyInput.value;
        storyReplyInput.value = textVal.substring(0, startPos) + emoji + textVal.substring(endPos);
        storyReplyInput.focus();
        const newCursorPos = startPos + emoji.length;
        storyReplyInput.setSelectionRange(newCursorPos, newCursorPos);

        if (storyReplySend) {
          storyReplySend.disabled = !storyReplyInput.value.trim();
        }
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (storyEmojiPopover && storyEmojiPopover.classList.contains('active')) {
      if (!storyEmojiPopover.contains(e.target) && (!storyEmojiBtn || !storyEmojiBtn.contains(e.target))) {
        storyEmojiPopover.classList.remove('active');
      }
    }
  });

  // Story Share Button Handler
  const storyShareBtn = document.getElementById('story-share-btn');
  if (storyShareBtn) {
    storyShareBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pauseStory();
      const group = state.storyGroups[state.activeGroupIndex];
      const storyData = group?.stories[state.activeStoryIndex];
      if (storyData && (storyData._id || storyData.id)) {
        const storyId = storyData._id || storyData.id;
        if (typeof openShare === 'function') {
          openShare('story_' + storyId);
        } else if (typeof window.openShareModal === 'function') {
          window.openShareModal({
            title: storyData.name || 'HUBB on Hi-Hubble',
            text: storyData.caption || 'Check out this HUBB on Hi-Hubble!',
            url: window.location.origin + '?story=' + storyId
          });
        } else if (navigator.share) {
          navigator.share({
            title: storyData.name || 'HUBB on Hi-Hubble',
            text: storyData.caption || 'Check out this HUBB on Hi-Hubble!',
            url: window.location.origin + '?story=' + storyId
          }).catch(() => { });
        } else {
          showToast('Share link copied to clipboard! 🔗');
        }
      }
    });
  }

  // --- HUB (STORY) LIKE SYSTEM ---
  const storyLikeBtn = document.getElementById('story-like-btn');
  const storyLikeCount = document.getElementById('story-like-count');
  let isLikingStory = false;

  async function likeCurrentStory() {
    const token = localStorage.getItem('invibe_jwt_token');
    if (!token) return;

    const group = state.storyGroups[state.activeGroupIndex];
    const storyData = group?.stories[state.activeStoryIndex];
    if (!storyData || !storyData._id || isLikingStory) return;

    isLikingStory = true;

    // Optimistic UI update
    const previousIsLiked = storyData.isLiked;
    const previousLikesCount = storyData.likesCount || 0;

    storyData.isLiked = !previousIsLiked;
    storyData.likesCount = previousIsLiked ? Math.max(0, previousLikesCount - 1) : previousLikesCount + 1;
    updateStoryLikeUI(storyData.isLiked, storyData.likesCount);

    const currentUser = getCurrentUser();
    const currentUserId = currentUser ? (currentUser.id || currentUser._id) : null;
    console.log(`[STAGE 1: HEART CLICK / likeCurrentStory()] StoryId: ${storyData._id} | CurrentUserId: ${currentUserId} | Prev isLiked: ${previousIsLiked} | Prev likesCount: ${previousLikesCount}`);

    try {
      const res = await fetch(`${API_URL}/api/stories/${storyData._id}/like`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to like story');
      const result = await res.json();

      console.log(`[STAGE 2: API POST /like RESULT] StoryId: ${storyData._id} | isLiked: ${result.isLiked} | likesCount: ${result.likesCount} | likes:`, result.likes);

      // Sync with backend response
      storyData.isLiked = result.isLiked;
      storyData.likesCount = result.likesCount !== undefined ? result.likesCount : storyData.likesCount;
      if (result.likes) storyData.likes = result.likes;

      console.log(`[STAGE 3: SYNCED STORY OBJECT]`, { id: storyData._id, isLiked: storyData.isLiked, likesCount: storyData.likesCount });

      updateStoryLikeUI(storyData.isLiked, storyData.likesCount);
      showToast(result.isLiked ? 'Liked this Hub! ❤️' : 'Unliked this Hub');
    } catch (err) {
      console.error('Error liking story:', err);
      // Rollback optimistic update
      storyData.isLiked = previousIsLiked;
      storyData.likesCount = previousLikesCount;
      updateStoryLikeUI(previousIsLiked, previousLikesCount);
      showToast('Failed to like Hub');
    } finally {
      isLikingStory = false;
    }
  }

  function updateStoryLikeUI(isLiked, count) {
    console.log(`[STAGE 6: Like count UI Updated] isLiked: ${isLiked} | count: ${count}`);
    if (storyLikeBtn) {
      storyLikeBtn.classList.toggle('liked', isLiked);
    }
    if (storyLikeCount) {
      storyLikeCount.textContent = count;
    }
  }

  if (storyLikeBtn) {
    storyLikeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      likeCurrentStory();
    });
  }

  // Story Insights Modal Click Handler
  const storyInsightsTrigger = document.getElementById('story-insights-trigger-btn');
  const storyViewsPanel = document.getElementById('story-views-panel');
  const storyInsightsList = document.getElementById('story-insights-list');
  const storyInsightsViewsPanelText = document.getElementById('story-insights-views-panel');
  const storyViewsCloseBtn = document.getElementById('story-views-close-btn');

  function closeStoryViewsPanel() {
    if (!storyViewsPanel) return;
    storyViewsPanel.classList.remove('active');
    storyViewsPanel.style.transform = '';
    state.isStoryViewsOpen = false;
    const mediaContainer = document.getElementById('story-viewer-media-container');
    if (mediaContainer) {
      const video = mediaContainer.querySelector('video');
      if (video && video.dataset.wasPlaying === 'true') {
        video.play().catch(e => console.warn(e));
        video.dataset.wasPlaying = 'false';
      }
    }
    if (window.StoryAudioManager && !state.isStoryPaused) {
      window.StoryAudioManager.resume();
    }
  }

  // Close panel on drag handle click or close button
  const storyViewsDragHandle = document.querySelector('.story-views-drag-handle');
  if (storyViewsDragHandle) {
    storyViewsDragHandle.addEventListener('click', closeStoryViewsPanel);
  }
  if (storyViewsCloseBtn) {
    storyViewsCloseBtn.addEventListener('click', closeStoryViewsPanel);
  }

  // Draggable gesture on storyViewsPanel
  if (storyViewsPanel) {
    let startY = 0;
    let currentY = 0;
    let isDragging = false;

    storyViewsPanel.addEventListener('touchstart', (e) => {
      if (e.target === storyViewsDragHandle || e.target.closest('.story-views-title') || storyViewsPanel.scrollTop === 0) {
        isDragging = true;
        startY = e.touches[0].clientY;
        currentY = startY;
        storyViewsPanel.style.transition = 'none';
      }
    }, { passive: true });

    storyViewsPanel.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      currentY = e.touches[0].clientY;
      const deltaY = currentY - startY;
      if (deltaY > 0) {
        storyViewsPanel.style.transform = `translateY(${deltaY}px)`;
      }
    }, { passive: true });

    storyViewsPanel.addEventListener('touchend', () => {
      if (!isDragging) return;
      isDragging = false;
      storyViewsPanel.style.transition = 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.1)';
      const deltaY = currentY - startY;
      if (deltaY > 70) {
        closeStoryViewsPanel();
      } else {
        storyViewsPanel.style.transform = 'translateY(0)';
      }
    });

    // Close on click outside panel
    if (storyContentBox) {
      storyContentBox.addEventListener('click', (e) => {
        if (state.isStoryViewsOpen && !e.target.closest('#story-views-panel') && !e.target.closest('#story-insights-trigger-btn')) {
          closeStoryViewsPanel();
        }
      });
    }

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.isStoryViewsOpen) {
        closeStoryViewsPanel();
      }
    });
  }

  async function fetchStoryInsights(storyData) {
    if (!storyViewsPanel || !storyInsightsList || !storyData) return;
    const storyId = storyData._id || storyData.id;
    if (!storyId) return;

    storyInsightsList.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 30px 20px;"><div class="hubble-spinner" style="width: 22px; height: 22px; border: 2px solid rgba(255,255,255,0.1); border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 10px auto;"></div>Loading viewers...</div>';
    if (window.lucide) window.lucide.createIcons();

    const token = localStorage.getItem('invibe_jwt_token');
    if (!token) {
      storyInsightsList.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 20px;">Please log in to view insights.</div>';
      return;
    }

    try {
      const res = await fetch(`${API_URL}/api/stories/${storyId}/insights`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      storyInsightsList.innerHTML = '';
      const viewers = data.viewers || [];
      if (storyInsightsViewsPanelText) {
        storyInsightsViewsPanelText.textContent = viewers.length;
      }

      if (viewers.length > 0) {
        viewers.forEach(user => {
          const row = document.createElement('div');
          row.className = 'insights-user-card';
          row.style.cssText = 'display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 12px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); margin-bottom: 8px;';

          const heartHtml = user.liked ? '<div class="insights-heart-badge" style="position: absolute; bottom: -2px; right: -2px; width: 18px; height: 18px; border-radius: 50%; background: #ef4444; color: white; display: flex; align-items: center; justify-content: center; font-size: 10px; border: 2px solid #1a1a24;"><i data-lucide="heart" style="width: 10px; height: 10px; fill: white;"></i></div>' : '';
          const timeStr = user.viewedAt ? formatViewerRelativeTime(user.viewedAt) : (user.liked ? 'Liked your story' : 'Viewed recently');

          row.innerHTML = `
            <div class="insights-avatar-wrap" style="position: relative; width: 40px; height: 40px; flex-shrink: 0;">
              <img src="${user.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80'}" alt="${user.fullName}" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">
              ${heartHtml}
            </div>
            <div style="display: flex; flex-direction: column; flex-grow: 1; min-width: 0;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 13px; font-weight: 600; color: var(--text-main, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${user.fullName || user.username}</span>
                <span style="font-size: 11px; color: var(--text-muted); flex-shrink: 0;">${timeStr}</span>
              </div>
              <span style="font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">@${user.username}</span>
            </div>
          `;
          storyInsightsList.appendChild(row);
        });
        if (window.lucide) window.lucide.createIcons();
      } else {
        storyInsightsList.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 40px 20px; font-size: 13px;">No viewers yet.</div>';
      }
    } catch (err) {
      console.error('Error fetching story insights:', err);
      storyInsightsList.innerHTML = `
        <div style="text-align: center; color: var(--text-muted); padding: 30px 20px; font-size: 13px;">
          <p style="margin: 0 0 10px 0;">Failed to load insights.</p>
          <button id="story-insights-retry-btn" style="padding: 6px 16px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; color: white; background: var(--primary, #a855f7); border: none;">Retry</button>
        </div>
      `;
      const retryBtn = document.getElementById('story-insights-retry-btn');
      if (retryBtn) {
        retryBtn.onclick = () => fetchStoryInsights(storyData);
      }
    }
  }

  if (storyInsightsTrigger) {
    storyInsightsTrigger.addEventListener('click', async () => {
      if (!storyViewsPanel || !storyInsightsList) return;

      const group = state.storyGroups[state.activeGroupIndex];
      if (!group) return;
      const storyData = group.stories[state.activeStoryIndex];
      if (!storyData || (!storyData._id && !storyData.id)) return;

      if (storyInsightsViewsPanelText) {
        storyInsightsViewsPanelText.textContent = storyData.viewsCount || 0;
      }

      storyViewsPanel.classList.add('active');
      state.isStoryViewsOpen = true;

      const mediaContainer = document.getElementById('story-viewer-media-container');
      if (mediaContainer) {
        const video = mediaContainer.querySelector('video');
        if (video && !video.paused) {
          video.pause();
          video.dataset.wasPlaying = 'true';
        }
      }
      if (window.StoryAudioManager) {
        window.StoryAudioManager.pause();
      }

      await fetchStoryInsights(storyData);
    });
  }

  // --- LOCAL STORAGE & BACKEND VIEWED STATE ---
  function getSeenStories() {
    try { return JSON.parse(localStorage.getItem('hihubble_seen_stories') || '[]'); }
    catch (e) { return []; }
  }

  function markStorySeen(id, syncBackend = true) {
    if (!id) return;
    const seen = getSeenStories();
    if (!seen.includes(id)) {
      seen.push(id);
      localStorage.setItem('hihubble_seen_stories', JSON.stringify(seen));
    }

    if (syncBackend) {
      const token = localStorage.getItem('invibe_jwt_token');
      if (token) {
        fetch(`${API_URL}/api/stories/${id}/view`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          }
        }).catch(err => console.warn('Failed to sync story view with backend:', err));
      }
    }

    updateStoryRingsUI();
  }

  function updateStoryRingsUI() {
    const seen = getSeenStories();
    const currentUser = getCurrentUser();
    const currentUserId = currentUser ? (currentUser.id || currentUser._id) : null;
    const currentUserIdStr = currentUserId ? currentUserId.toString() : '';

    const storyScroll = document.getElementById('stories-scroll');
    if (storyScroll && state.storyGroups && state.storyGroups.length > 0) {
      const cards = storyScroll.querySelectorAll('.story-card.active-story');
      cards.forEach(card => {
        const groupIdx = parseInt(card.getAttribute('data-group-index'), 10);
        const group = state.storyGroups[groupIdx];
        if (group && group.stories && group.stories.length > 0) {
          const isSeen = group.stories.every(s => seen.includes(s._id || s.id));
          if (isSeen) {
            card.classList.add('story-seen');
          } else {
            card.classList.remove('story-seen');
          }
        }
      });
    }

    // Update current user story button (#story-btn-current)
    const yourVibeBtn = document.getElementById('story-btn-current');
    if (yourVibeBtn) {
      const myGroup = state.storyGroups ? state.storyGroups.find(g => {
        const gAuthorId = (g.authorId || g.author?._id || g.author?.id || '').toString();
        return currentUserIdStr && gAuthorId === currentUserIdStr;
      }) : null;

      const avatarImg = yourVibeBtn.querySelector('img');
      const subSpan = yourVibeBtn.querySelector('span:last-child');
      const userProfileImg = localStorage.getItem('invibeProfileImage') || currentUser?.profileImage || 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=150&h=150&q=80';

      if (myGroup && myGroup.stories && myGroup.stories.length > 0) {
        const mySeen = myGroup.stories.every(s => seen.includes(s._id || s.id));
        if (mySeen) {
          yourVibeBtn.classList.add('story-seen');
        } else {
          yourVibeBtn.classList.remove('story-seen');
        }
        if (avatarImg) avatarImg.src = myGroup.avatar || userProfileImg;
        if (subSpan) {
          subSpan.textContent = `${myGroup.stories.length} hub${myGroup.stories.length > 1 ? 's' : ''}`;
          subSpan.style.color = 'var(--text-muted)';
        }
      } else {
        yourVibeBtn.classList.add('story-seen');
        if (avatarImg) avatarImg.src = userProfileImg;
        if (subSpan) {
          subSpan.textContent = 'Add Hubb';
          subSpan.style.color = 'transparent';
        }
      }
    }
  }

  window.markStorySeen = markStorySeen;
  window.markStoryAsViewed = markStorySeen;
  window.updateStoryRingsUI = updateStoryRingsUI;
  window.closeStoryViewer = closeStoryViewer;

  // Render story rings cleanly from state.storyGroups
  let _lastRenderedStoriesFingerprint = '';
  function renderStoryRings(forceRebuild = false) {
    const storyScroll = document.getElementById('stories-scroll');
    if (!storyScroll) return;

    if (!state.storyGroups || state.storyGroups.length === 0) {
      if (_lastRenderedStoriesFingerprint !== 'empty' || forceRebuild) {
        _lastRenderedStoriesFingerprint = 'empty';
        storyScroll.innerHTML = '';
        updateStoryRingsUI();
      }
      return;
    }

    const currentUser = getCurrentUser();
    const currentUserId = currentUser ? (currentUser.id || currentUser._id) : null;
    const currentUserIdStr = currentUserId ? currentUserId.toString() : '';
    const seen = getSeenStories();

    // Deterministic fingerprint of story groups
    const storiesFingerprint = state.storyGroups.map(g => {
      const isSeen = (g.stories || []).every(s => seen.includes(s._id || s.id));
      const sCount = g.stories ? g.stories.length : 0;
      return `${g.authorId}_${sCount}_${isSeen ? 1 : 0}`;
    }).join('|');

    if (!forceRebuild && storiesFingerprint === _lastRenderedStoriesFingerprint && storyScroll.children.length > 0) {
      updateStoryRingsUI();
      return;
    }

    _lastRenderedStoriesFingerprint = storiesFingerprint;
    storyScroll.innerHTML = '';

    state.storyGroups.forEach((group, idx) => {
      if (!group.stories || group.stories.length === 0) return;
      const isSeen = group.stories.every(s => getSeenStories().includes(s._id || s.id));
      const groupAuthorId = (group.authorId || group.author?._id || group.author?.id || '').toString();
      const isOwnGroup = currentUserIdStr && groupAuthorId === currentUserIdStr;

      // The logged-in user's own story is prominently represented on #story-btn-current
      if (isOwnGroup) return;

      const card = document.createElement('div');
      card.className = `story-card active-story ${isSeen ? 'story-seen' : ''}`;
      card.setAttribute('data-group-index', idx);
      const hubCount = group.stories ? group.stories.length : 1;
      card.innerHTML = `
        <div class="story-avatar-container hubbs-user-avatar" style="width: 64px; height: 64px; aspect-ratio: 1/1; margin: 0 auto 4px auto; flex-shrink: 0; border-radius: 50%; overflow: hidden; position: relative; display: flex; justify-content: center; align-items: center; padding: 3px;">
          <div class="story-ring" style="border-radius: 50%; position: absolute; top: 0; left: 0; right: 0; bottom: 0;"></div>
          <img src="${group.avatar}" alt="${group.name}" loading="lazy" decoding="async" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%; border: 2px solid rgba(0,0,0,0.1);" />
        </div>
        <div style="display: flex; flex-direction: column; align-items: center; text-align: center; width: 100%; overflow: hidden;">
          <span class="story-username" style="font-weight: 600; color: var(--text-main); font-size: 0.85rem; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${group.name}</span>
          <span style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">${hubCount} hub${hubCount > 1 ? 's' : ''}</span>
        </div>
      `;

      card.addEventListener('click', () => {
        openStoryViewer(idx, 0);
      });

      storyScroll.appendChild(card);
    });

    updateStoryRingsUI();
    debouncedCreateIcons();
  }
  window.renderStoryRings = renderStoryRings;

  // True 24-Hour Expiry: Clean expired stories from memory in real-time without page refresh
  function purgeExpiredStories() {
    if (!state.storyGroups || state.storyGroups.length === 0) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let changed = false;

    for (let gIdx = state.storyGroups.length - 1; gIdx >= 0; gIdx--) {
      const group = state.storyGroups[gIdx];
      if (!group || !group.stories) continue;
      const initialLen = group.stories.length;
      group.stories = group.stories.filter(s => {
        const createdDate = new Date(s.createdAt || s.created_at || 0);
        const createdMs = createdDate.getTime();
        return isNaN(createdMs) || createdMs > cutoff;
      });
      if (group.stories.length !== initialLen) {
        changed = true;
      }
      if (group.stories.length === 0) {
        state.storyGroups.splice(gIdx, 1);
        changed = true;
      }
    }

    if (changed) {
      console.log('[STORY PURGE] Expired stories (>24h) removed from state.');
      renderStoryRings();
      if (storyViewer && storyViewer.classList.contains('active')) {
        const activeGroup = state.storyGroups[state.activeGroupIndex];
        if (!activeGroup || !activeGroup.stories || !activeGroup.stories[state.activeStoryIndex]) {
          closeStoryViewer();
        }
      }
    }
  }
  window.purgeExpiredStories = purgeExpiredStories;

  // Background 24h story expiry timer (runs every 15 seconds)
  if (!window._hihubbleStoryPurgeInterval) {
    window._hihubbleStoryPurgeInterval = setInterval(purgeExpiredStories, 15000);
  }

  // Load dynamic stories from backend
  async function loadStories() {
    const token = localStorage.getItem('invibe_jwt_token');
    if (!token) return;

    try {
      const res = await fetch(`${API_URL}/api/stories`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to fetch stories');
      const dbStories = await res.json();
      console.log(`[STAGE 4: loadStories() FETCH COMPLETED] Count: ${dbStories.length}`);

      const yourVibeBtn = document.getElementById('story-btn-current');
      if (yourVibeBtn) {
        if (!yourVibeBtn.dataset.boundClick) {
          yourVibeBtn.dataset.boundClick = "true";
          yourVibeBtn.addEventListener('click', async (e) => {
            if (e.target.closest('#add-story-file-trigger')) return;
            const currentUser = getCurrentUser();
            const currentUserId = currentUser ? (currentUser.id || currentUser._id) : null;
            const currentUserIdStr = currentUserId ? currentUserId.toString() : '';
            if (state.storyGroups && state.storyGroups.length > 0) {
              const myGroupIdx = state.storyGroups.findIndex(g => {
                const gAuthorId = (g.authorId || g.author?._id || g.author?.id || '').toString();
                return currentUserIdStr && gAuthorId === currentUserIdStr;
              });
              if (myGroupIdx !== -1) {
                const myGroup = state.storyGroups[myGroupIdx];
                const seen = getSeenStories();
                let firstUnviewedIdx = myGroup.stories.findIndex(s => !seen.includes(s._id || s.id));
                if (firstUnviewedIdx === -1) firstUnviewedIdx = 0;
                openStoryViewer(myGroupIdx, firstUnviewedIdx);
              } else {
                switchView('create-hubbs');
              }
            } else {
              switchView('create-hubbs');
            }
          });
        }
      }

      const currentUser = getCurrentUser();
      const currentUserId = currentUser ? (currentUser.id || currentUser._id) : null;
      const currentUserIdStr = currentUserId ? currentUserId.toString() : '';
      const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;

      const groupedStories = {};
      dbStories.forEach(story => {
        const rawCreatedAt = story.createdAt || story.created_at || new Date().toISOString();
        const createdDate = new Date(rawCreatedAt);
        const createdMs = createdDate.getTime();

        // 24-hour expiry check on client side
        if (!isNaN(createdMs) && createdMs <= cutoff24h) {
          return; // Skip expired story
        }

        const likes = story.likes || [];
        const authorId = (story.author && (story.author._id || story.author.id)) || story.authorId;
        const isLiked = (story.isLiked !== undefined && typeof story.isLiked === 'boolean')
          ? story.isLiked
          : (currentUserIdStr ? likes.some(uid => (uid && uid.toString() === currentUserIdStr)) : false);
        const likesCount = (story.likesCount !== undefined && typeof story.likesCount === 'number')
          ? story.likesCount
          : likes.length;

        console.log(`  [STORY OBJECT FROM API] StoryId: ${story._id || story.id} | createdAt: ${rawCreatedAt} | formatted: ${formatStoryTime(rawCreatedAt)} | likesCount: ${likesCount} | isLiked: ${isLiked}`);

        if (!groupedStories[authorId]) {
          groupedStories[authorId] = {
            authorId: authorId,
            name: (story.author && story.author.fullName) || 'User',
            avatar: (story.author && story.author.profileImage) || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&h=80&q=80',
            stories: []
          };
        }

        const storyId = story._id || story.id;

        if (story.isViewed) {
          markStorySeen(storyId, false);
        }

        const itemsToPush = (story.mediaItems && story.mediaItems.length > 0) ? story.mediaItems : [{
          mediaUrl: story.mediaUrl,
          mediaType: story.mediaType || story.media_type || 'image'
        }];

        groupedStories[authorId].stories.push({
          _id: storyId,
          authorId: authorId,
          name: (story.author && story.author.fullName) || 'User',
          avatar: (story.author && story.author.profileImage) || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&h=80&q=80',
          img: itemsToPush[0].mediaUrl || itemsToPush[0].media_url || story.mediaUrl,
          caption: story.caption || '',
          mediaType: itemsToPush[0].mediaType || itemsToPush[0].media_type || story.mediaType || 'image',
          mediaItems: itemsToPush, // Persist the nested media array
          music: story.music || story.musicTrack || null,
          musicTrack: story.music || story.musicTrack || null,
          location: story.location || (story.locationData ? (story.locationData.displayName || story.locationData.name) : null),
          locationData: story.locationData || null,
          layers: story.layers || [],
          createdAt: rawCreatedAt,
          created_at: rawCreatedAt,
          time: formatStoryTime(rawCreatedAt),
          likesCount: likesCount,
          isLiked: isLiked,
          likes: likes,
          viewsCount: story.viewsCount || 0
        });
      });

      state.storyGroups = Object.values(groupedStories);

      // Keep active viewer like and time UI in sync if currently viewing
      if (storyViewer && storyViewer.classList.contains('active') && state.storyGroups[state.activeGroupIndex]) {
        const activeData = state.storyGroups[state.activeGroupIndex]?.stories?.[state.activeStoryIndex];
        if (activeData) {
          updateStoryLikeUI(activeData.isLiked || false, activeData.likesCount || 0);
          if (storyViewerTime) storyViewerTime.textContent = formatStoryTime(activeData.createdAt || activeData.created_at);
        }
      }

      renderStoryRings();
    } catch (err) {
      console.error('Error loading stories:', err);
    }
  }

  // Canonical Relative Time Formatter (Supports Date objects, ISO strings, Epoch timestamps)
  function formatStoryTime(input) {
    if (!input) return 'Just now';
    let date;
    if (input instanceof Date) {
      date = input;
    } else if (typeof input === 'number') {
      date = new Date(input);
    } else if (typeof input === 'string') {
      if (!isNaN(input) && !isNaN(parseFloat(input)) && input.trim().length >= 10 && !input.includes('-') && !input.includes(':')) {
        date = new Date(parseFloat(input));
      } else {
        date = new Date(input);
      }
    } else {
      return 'Just now';
    }

    const timeMs = date.getTime();
    if (isNaN(timeMs)) {
      return 'Just now';
    }

    const now = Date.now();
    const diffMs = Math.max(0, now - timeMs);
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 10) return 'Just now';
    if (diffSec < 60) return `${diffSec}s ago`;

    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;

    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;

    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays === 1) return 'Yesterday';
    return `${diffDays}d ago`;
  }

  window.formatStoryTime = formatStoryTime;
  window.formatTimeAgo = formatStoryTime;
  const formatTimeAgo = formatStoryTime;
  window.loadStories = loadStories;

  // Subscribe to Supabase Realtime changes on public.stories, public.posts, and public.comments
  if (supabase && typeof supabase.channel === 'function') {
    try {
      supabase.channel('public:stories_realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'stories' }, () => {
          console.log('⚡ Realtime story change event received from Supabase!');
          if (typeof loadStories === 'function') loadStories();
          if (typeof window.loadHubbStories === 'function') window.loadHubbStories();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'story_reactions' }, async (payload) => {
          console.log('⚡ Realtime story_reactions change event received!', payload);

          const changedStoryId = payload.new?.story_id || payload.old?.story_id;
          if (!changedStoryId) return;

          const currentUser = getCurrentUser();
          const currentUserId = currentUser ? (currentUser.id || currentUser._id) : null;
          const changedUserId = payload.new?.user_id || payload.old?.user_id;
          const isMe = changedUserId && currentUserId && (changedUserId.toString() === currentUserId.toString());

          // Update in-memory state
          if (state.storyGroups) {
            state.storyGroups.forEach(group => {
              (group.stories || []).forEach(story => {
                if (story._id === changedStoryId) {
                  if (!isMe) {
                    if (payload.eventType === 'INSERT') {
                      story.likesCount = (story.likesCount || 0) + 1;
                    } else if (payload.eventType === 'DELETE') {
                      story.likesCount = Math.max(0, (story.likesCount || 0) - 1);
                    }
                  }
                }
              });
            });
          }

          const group = state.storyGroups?.[state.activeGroupIndex];
          const activeStory = group?.stories?.[state.activeStoryIndex];
          if (activeStory && activeStory._id === changedStoryId) {
            if (!isMe) {
              updateStoryLikeUI(activeStory.isLiked || false, activeStory.likesCount || 0);
            }
          }
        })
        .subscribe();

      supabase.channel('public:posts_realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'posts' }, () => {
          console.log('⚡ Realtime post change event received from Supabase!');
          if (typeof loadFeedPosts === 'function') loadFeedPosts();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, (payload) => {
          console.log('⚡ Realtime comment change event received from Supabase!');
          const pId = payload.new?.post_id || payload.old?.post_id;
          if (pId && typeof window.refreshPostCommentsCount === 'function') {
            window.refreshPostCommentsCount(pId);
          }
          if (typeof loadFeedPosts === 'function') loadFeedPosts();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'likes' }, (payload) => {
          console.log('⚡ Realtime like change event received from Supabase!');
          const pId = payload.new?.post_id || payload.old?.post_id;
          if (pId && typeof window.refreshPostLikesCount === 'function') {
            window.refreshPostLikesCount(pId);
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'reels' }, (payload) => {
          console.log('⚡ Realtime reel change event received from Supabase!', payload);
          // Only refresh on INSERT or DELETE when not actively in middle of reel playback
          if (payload.eventType === 'INSERT' || payload.eventType === 'DELETE') {
            const exploreView = document.getElementById('view-explore');
            if (!exploreView || !exploreView.classList.contains('active')) {
              if (typeof loadFeedReels === 'function') loadFeedReels();
            }
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'reel_likes' }, (payload) => {
          console.log('⚡ Realtime reel_likes change event received from Supabase!', payload);
          const reelId = payload.new?.reel_id || payload.old?.reel_id;
          if (reelId) {
            const card = document.querySelector(`.reel-card[data-reel-id="${reelId}"]`);
            if (card) {
              fetch(`${API_URL}/api/reels`).then(r => r.json()).then(reels => {
                if (Array.isArray(reels)) {
                  const target = reels.find(r => (r._id || r.id) === reelId);
                  if (target) {
                    const countSpan = card.querySelector('.reel-like-action .action-count');
                    if (countSpan) countSpan.textContent = target.formattedLikes || target.likeCount || '0';
                  }
                }
              }).catch(() => { });
            }
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'reel_comments' }, (payload) => {
          console.log('⚡ Realtime reel_comments change event received from Supabase!', payload);
          const reelId = payload.new?.reel_id || payload.old?.reel_id;
          if (reelId) {
            const card = document.querySelector(`.reel-card[data-reel-id="${reelId}"]`);
            if (card) {
              fetch(`${API_URL}/api/reels`).then(r => r.json()).then(reels => {
                if (Array.isArray(reels)) {
                  const target = reels.find(r => (r._id || r.id) === reelId);
                  if (target) {
                    const countSpan = card.querySelector('.reel-comment-sim .action-count');
                    if (countSpan) countSpan.textContent = target.formattedComments || target.commentCount || '0';
                  }
                }
              }).catch(() => { });
            }
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'reel_views' }, () => {
          console.log('⚡ Realtime reel_views change event received from Supabase!');
        })
        .subscribe();
    } catch (rtErr) {
      console.warn('Realtime subscription notice:', rtErr);
    }
  }

  // Story Creation & Drafts logic
  const addStoryBtn = document.getElementById('add-story-file-trigger');
  const storyFileInput = document.getElementById('story-file-input');
  const storyCreationModal = document.getElementById('story-creation-modal');
  const storyCreationPreview = document.getElementById('story-creation-preview');
  const storyCreationCancel = document.getElementById('story-creation-cancel');
  const storyCreationDraft = document.getElementById('story-creation-draft');
  const storyCreationPublish = document.getElementById('story-creation-publish');
  const storyDraftsBtn = document.getElementById('story-drafts-btn');
  const storyDraftsModal = document.getElementById('story-drafts-modal');
  const storyDraftsClose = document.getElementById('story-drafts-close');
  const storyDraftsList = document.getElementById('story-drafts-list');
  let currentStoryImageBase64 = null;

  if (addStoryBtn) {
    addStoryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      switchView('create-hubbs');
    });
  }

  if (storyFileInput) {
    storyFileInput.addEventListener('change', () => {
      if (storyFileInput.files.length > 0) {
        const file = storyFileInput.files[0];
        const reader = new FileReader();
        reader.onload = (e) => {
          currentStoryImageBase64 = e.target.result;
          if (storyCreationPreview) storyCreationPreview.src = currentStoryImageBase64;
          if (storyCreationModal) storyCreationModal.classList.add('active');
          storyFileInput.value = '';
        };
        reader.readAsDataURL(file);
      }
    });
  }

  const closeStoryCreation = () => {
    if (storyCreationModal) storyCreationModal.classList.remove('active');
    currentStoryImageBase64 = null;
    window.currentStoryImageBase64 = null;
  };
  if (storyCreationCancel) storyCreationCancel.addEventListener('click', closeStoryCreation);

  async function submitStory(isDraft) {
    const token = localStorage.getItem('invibe_jwt_token');
    if (!token) {
      showToast('Please log in first! 🔐');
      return;
    }
    try {
      const res = await fetch(`${API_URL}/api/stories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ mediaUrl: window.currentStoryImageBase64 || currentStoryImageBase64, mediaType: 'image', isDraft })
      });
      if (!res.ok) throw new Error('Failed to save HUBBS');
      showToast(isDraft ? 'Draft saved!' : 'HUBBS Posted successfully! 📸✨');
      closeStoryCreation();
      loadStories();
    } catch (err) {
      console.error(err);
      showToast('Failed to process story.');
    }
  }

  window.submitStory = submitStory;

  if (storyCreationPublish) storyCreationPublish.addEventListener('click', () => submitStory(false));
  if (storyCreationDraft) storyCreationDraft.addEventListener('click', () => submitStory(true));

  async function loadDrafts() {
    if (typeof window.renderSeeAllDrafts === 'function') {
      const searchVal = document.getElementById('see-all-drafts-search')?.value || '';
      await window.renderSeeAllDrafts(searchVal);
    }
  }

  if (storyDraftsBtn) {
    storyDraftsBtn.addEventListener('click', () => {
      if (typeof window.openSeeAllDrafts === 'function') window.openSeeAllDrafts();
    });
  }
  if (storyDraftsClose) {
    storyDraftsClose.addEventListener('click', () => {
      if (storyDraftsModal) storyDraftsModal.classList.remove('active');
      if (typeof window.exitDraftsSelectionMode === 'function') window.exitDraftsSelectionMode();
      if (typeof window.closeDraftsConfirmDialog === 'function') window.closeDraftsConfirmDialog();
    });
  }

  // HUBBs Drafts Bottom Bar & Confirmation Listeners
  const selectModeBtn = document.getElementById('see-all-drafts-select-btn');
  const cancelSelectBtn = document.getElementById('see-all-drafts-cancel-select-btn');
  const deleteSelectedBtn = document.getElementById('see-all-drafts-delete-selected-btn');
  const deleteAllBtn = document.getElementById('see-all-drafts-delete-all-btn');
  const confirmCancelBtn = document.getElementById('see-all-drafts-confirm-cancel-btn');

  if (selectModeBtn) {
    selectModeBtn.addEventListener('click', () => {
      if (typeof window.enterDraftsSelectionMode === 'function') window.enterDraftsSelectionMode();
    });
  }
  if (cancelSelectBtn) {
    cancelSelectBtn.addEventListener('click', () => {
      if (typeof window.exitDraftsSelectionMode === 'function') window.exitDraftsSelectionMode();
    });
  }
  if (deleteSelectedBtn) {
    deleteSelectedBtn.addEventListener('click', () => {
      if (typeof window.promptDeleteSelectedDrafts === 'function') window.promptDeleteSelectedDrafts();
    });
  }
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener('click', () => {
      if (typeof window.promptDeleteAllDrafts === 'function') window.promptDeleteAllDrafts();
    });
  }
  if (confirmCancelBtn) {
    confirmCancelBtn.addEventListener('click', () => {
      if (typeof window.closeDraftsConfirmDialog === 'function') window.closeDraftsConfirmDialog();
    });
  }

  // Keyboard Shortcuts for HUBBs Drafts modal
  window.addEventListener('keydown', (e) => {
    const draftsModal = document.getElementById('story-drafts-modal');
    if (!draftsModal || !draftsModal.classList.contains('active')) return;

    // Don't intercept if user is typing in an input or textarea
    const isTyping = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

    if (e.key === 'Escape') {
      const confirmDialog = document.getElementById('see-all-drafts-confirm-dialog');
      if (confirmDialog && confirmDialog.style.display === 'flex') {
        window.closeDraftsConfirmDialog();
        return;
      }
      if (window.draftsSelectionMode) {
        window.exitDraftsSelectionMode();
      } else {
        draftsModal.classList.remove('active');
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      if (!isTyping) {
        e.preventDefault();
        window.selectAllDrafts();
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!isTyping && window.draftsSelectionMode && window.selectedDraftIds && window.selectedDraftIds.size > 0) {
        e.preventDefault();
        window.promptDeleteSelectedDrafts();
      }
    }
  });


  // --- CREATE POST CARD CONTROLLER ---
  const createPostCaption = document.getElementById('create-post-caption');
  const createPostFileInput = document.getElementById('create-post-file-input');
  const createPostMediaBtn = document.getElementById('create-post-media-btn');
  const createPostSubmitBtn = document.getElementById('create-post-submit-btn');
  const createPostPreviewContainer = document.getElementById('create-post-preview-container');
  const createPostPreviewImg = document.getElementById('create-post-preview-img');
  const createPostPreviewVideo = document.getElementById('create-post-preview-video');
  const createPostRemoveBtn = document.getElementById('create-post-remove-btn');
  let selectedPostMediaBase64 = null;
  let selectedPostMediaType = 'image';

  if (createPostMediaBtn) {
    createPostMediaBtn.addEventListener('click', (e) => {
      e.preventDefault();
      switchView('create-post');
    });
  }

  if (createPostCaption) {
    createPostCaption.addEventListener('click', (e) => {
      e.preventDefault();
      switchView('create-post');
    });
    createPostCaption.addEventListener('focus', (e) => {
      e.preventDefault();
      switchView('create-post');
    });
  }

  let selectedPostMediaBlobUrl = null;

  if (createPostFileInput) {
    createPostFileInput.addEventListener('change', () => {
      if (createPostFileInput.files.length > 0) {
        const file = createPostFileInput.files[0];
        const isVideo = file.type.startsWith('video/');
        selectedPostMediaType = isVideo ? 'video' : 'image';

        if (isVideo) {
          const tempVideo = document.createElement('video');
          tempVideo.preload = 'metadata';
          tempVideo.onloadedmetadata = () => {
            try { URL.revokeObjectURL(tempVideo.src); } catch (e) { }
            if (tempVideo.duration > 300) {
              showToast('Video length exceeds 5 minutes limit (max 5 mins allowed). ⏱️');
              createPostFileInput.value = '';
              selectedPostMediaBase64 = null;
              selectedPostMediaBlobUrl = null;
              if (createPostPreviewContainer) createPostPreviewContainer.style.display = 'none';
              updateSubmitButtonState();
            }
          };
          tempVideo.src = URL.createObjectURL(file);
        }

        const reader = new FileReader();
        reader.onload = (e) => {
          selectedPostMediaBase64 = e.target.result;
          createPostPreviewContainer.style.display = 'block';

          if (isVideo) {
            if (selectedPostMediaBlobUrl) {
              try { URL.revokeObjectURL(selectedPostMediaBlobUrl); } catch (err) { }
            }
            selectedPostMediaBlobUrl = URL.createObjectURL(file);
            createPostPreviewImg.style.display = 'none';
            createPostPreviewVideo.style.display = 'block';
            createPostPreviewVideo.controls = true;
            createPostPreviewVideo.src = selectedPostMediaBlobUrl;
          } else {
            createPostPreviewVideo.style.display = 'none';
            createPostPreviewImg.style.display = 'block';
            createPostPreviewImg.src = selectedPostMediaBase64;
          }
          updateSubmitButtonState();
        };
        reader.readAsDataURL(file);
      }
    });
  }

  if (createPostRemoveBtn) {
    createPostRemoveBtn.addEventListener('click', () => {
      createPostFileInput.value = '';
      if (selectedPostMediaBlobUrl) {
        try { URL.revokeObjectURL(selectedPostMediaBlobUrl); } catch (e) { }
        selectedPostMediaBlobUrl = null;
      }
      selectedPostMediaBase64 = null;
      createPostPreviewContainer.style.display = 'none';
      createPostPreviewImg.src = '';
      createPostPreviewVideo.src = '';
      updateSubmitButtonState();
    });
  }

  let isSubmittingPost = false;
  if (createPostSubmitBtn) {
    createPostSubmitBtn.addEventListener('click', async () => {
      if (isSubmittingPost) return;
      const captionText = createPostCaption.value.trim();
      const token = getAuthToken();

      if (!selectedPostMediaBase64 && !captionText) {
        showToast('Please write a caption or add a photo/video.');
        return;
      }

      isSubmittingPost = true;
      createPostSubmitBtn.disabled = true;
      createPostSubmitBtn.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Publishing...';
      debouncedCreateIcons();

      try {
        const currentUserStr = localStorage.getItem('invibeUser');
        const currentUser = currentUserStr ? JSON.parse(currentUserStr) : { username: 'user', fullName: 'User' };
        const mediaUrlPayload = selectedPostMediaBase64 || '';
        const mediaType = selectedPostMediaType || 'image';

        // Send backend network call to store in Supabase public.posts and public.post_media
        const apiRes = await fetch(`${API_URL}/api/posts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            caption: captionText,
            mediaUrl: mediaUrlPayload,
            mediaType: mediaType
          })
        });

        if (apiRes.ok) {
          const data = await apiRes.json();
          const durableMediaUrl = (data.media && data.media[0] && data.media[0].media_url) ? data.media[0].media_url : '';

          // Also persist as story in Supabase public.stories table using the durable media URL
          if (durableMediaUrl) {
            try {
              await fetch((window.API_URL || '') + '/api/stories', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                  caption: captionText,
                  mediaUrl: durableMediaUrl,
                  mediaType: mediaType
                })
              });
            } catch (storyErr) {
              console.warn("Story database save notice:", storyErr);
            }
          }

          showToast('New hub published successfully! 📸✨');

          // Reset fields and revoke preview URLs
          createPostCaption.value = '';
          if (createPostFileInput) createPostFileInput.value = '';
          if (selectedPostMediaBlobUrl) {
            try { URL.revokeObjectURL(selectedPostMediaBlobUrl); } catch (_) {}
            selectedPostMediaBlobUrl = null;
          }
          selectedPostMediaBase64 = null;
          if (createPostPreviewContainer) createPostPreviewContainer.style.display = 'none';
          if (createPostPreviewImg) createPostPreviewImg.src = '';
          if (createPostPreviewVideo) createPostPreviewVideo.src = '';
          updateSubmitButtonState();

          // Refresh lists
          await loadFeedPosts();
          if (typeof loadStories === 'function') await loadStories();
          loadUserProfile('me');
        } else {
          const errData = await apiRes.json().catch(() => ({}));
          const errMsg = errData.error || apiRes.statusText || 'Server error';
          console.error("Backend post save error:", errMsg);
          showToast(`Failed to publish post: ${errMsg} ❌`);
        }
      } catch (err) {
        console.error("Post submit error:", err);
        showToast(`Failed to publish post: ${err.message} ❌`);
      } finally {
        isSubmittingPost = false;
        createPostSubmitBtn.disabled = false;
        createPostSubmitBtn.innerHTML = '<i data-lucide="send" style="width:14px; height:14px;"></i> Share Your Hubs';
        debouncedCreateIcons();
      }
    });
  }


  // --- INTERACTIVE LUDO LOBBY ROLLER WIDGET ---
  const diceRoller = document.getElementById('ludo-dice-roller');
  const diceFace = document.getElementById('ludo-dice-face');
  const rollDiceBtn = document.getElementById('ludo-roll-btn');
  const ludoChatFeed = document.getElementById('ludo-chat-feed');

  function rollLudoDice() {
    if (state.isLudoRolling) return;

    state.isLudoRolling = true;
    diceFace.classList.add('rolling');
    showToast('Rolling dice... 🎲');

    setTimeout(() => {
      diceFace.classList.remove('rolling');
      const rolledNumber = Math.floor(Math.random() * 6) + 1;

      // Update Dots Layout
      updateDiceFaceDots(rolledNumber);

      // Log Action
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const myLine = document.createElement('div');
      myLine.className = 'chat-log-line';
      myLine.innerHTML = `🎲 <strong>You rolled a ${rolledNumber}!</strong> <span class="log-time">${time}</span>`;
      ludoChatFeed.appendChild(myLine);
      ludoChatFeed.scrollTop = ludoChatFeed.scrollHeight;

      // Party spark if rolled 6!
      if (rolledNumber === 6) {
        showToast('🎲 SIX! Roll again! 🎉');
        triggerConfettiAlert();
      }

      // Emma simulated reply after 1.2s
      simulateEmmaRoll();

      state.isLudoRolling = false;
    }, 600);
  }

  function updateDiceFaceDots(num) {
    diceFace.innerHTML = '';
    const dotsConfigs = {
      1: ['dot-center'],
      2: ['dot-top-left', 'dot-bottom-right'],
      3: ['dot-top-left', 'dot-center', 'dot-bottom-right'],
      4: ['dot-top-left', 'dot-top-right', 'dot-bottom-left', 'dot-bottom-right'],
      5: ['dot-top-left', 'dot-top-right', 'dot-center', 'dot-bottom-left', 'dot-bottom-right'],
      6: ['dot-top-left', 'dot-top-right', 'dot-mid-left', 'dot-mid-right', 'dot-bottom-left', 'dot-bottom-right']
    };

    const classes = dotsConfigs[num] || ['dot-center'];
    classes.forEach(c => {
      const dot = document.createElement('div');
      dot.className = `dice-dot ${c}`;
      diceFace.appendChild(dot);
    });
  }

  function simulateEmmaRoll() {
    setTimeout(() => {
      const emmaNum = Math.floor(Math.random() * 6) + 1;
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const emmaLine = document.createElement('div');
      emmaLine.className = 'chat-log-line';
      emmaLine.innerHTML = `🎲 <strong>Emma rolled a ${emmaNum}!</strong> <span class="log-time">${time}</span>`;

      const emmaSpeak = document.createElement('div');
      emmaSpeak.className = 'chat-log-line';

      if (emmaNum === 6) {
        emmaSpeak.innerHTML = `💬 <strong>Emma:</strong> Yes! Ludo token out! 🥳`;
      } else if (emmaNum < 3) {
        emmaSpeak.innerHTML = `💬 <strong>Emma:</strong> Bad luck, slow turn. 😴`;
      } else {
        emmaSpeak.innerHTML = `💬 <strong>Emma:</strong> Rolling coordinates are locked! 🚀`;
      }

      ludoChatFeed.appendChild(emmaLine);
      ludoChatFeed.appendChild(emmaSpeak);
      ludoChatFeed.scrollTop = ludoChatFeed.scrollHeight;
    }, 1200);
  }

  function triggerConfettiAlert() {
    // Generate dozens of hearts floating inside active window
    const lobby = document.querySelector('.gaming-together-layout');
    if (!lobby) return;

    for (let i = 0; i < 15; i++) {
      setTimeout(() => {
        const x = 50 + Math.random() * (lobby.clientWidth - 100);
        const y = lobby.clientHeight - 40;

        const floatEmoji = document.createElement('div');
        floatEmoji.className = 'floating-reaction-emoji';
        floatEmoji.textContent = '🎉';
        floatEmoji.style.left = `${x}px`;
        floatEmoji.style.top = `${y}px`;

        const rnd = -40 + Math.random() * 80;
        floatEmoji.style.setProperty('--rnd-x', `${rnd}px`);
        floatEmoji.style.setProperty('--rnd-x-end', `${rnd + (-40 + Math.random() * 80)}px`);

        lobby.appendChild(floatEmoji);
        setTimeout(() => floatEmoji.remove(), 1200);
      }, i * 60);
    }
  }

  if (diceRoller) diceRoller.addEventListener('click', rollLudoDice);
  if (rollDiceBtn) rollDiceBtn.addEventListener('click', rollLudoDice);


  // ─── CLIENT-SIDE END-TO-END ENCRYPTION (E2EE) SYSTEM ──────────────────────
  // Pure-JS RC4 stream cipher helper
  function rc4Cipher(str, key) {
    let s = [], j = 0, x, res = '';
    for (let i = 0; i < 256; i++) {
      s[i] = i;
    }
    for (let i = 0; i < 256; i++) {
      j = (j + s[i] + key.charCodeAt(i % key.length)) % 256;
      x = s[i]; s[i] = s[j]; s[j] = x;
    }
    let i = 0;
    j = 0;
    for (let y = 0; y < str.length; y++) {
      i = (i + 1) % 256;
      j = (j + s[i]) % 256;
      x = s[i]; s[i] = s[j]; s[j] = x;
      res += String.fromCharCode(str.charCodeAt(y) ^ s[(s[i] + s[j]) % 256]);
    }
    return res;
  }

  function encryptMessage(plaintext, secretKey) {
    try {
      const utf8SafeStr = unescape(encodeURIComponent(plaintext));
      const encrypted = rc4Cipher(utf8SafeStr, secretKey);
      return btoa(encrypted);
    } catch (e) {
      console.error('Encryption error:', e);
      return plaintext;
    }
  }

  function decryptMessage(contentStr, secretKey) {
    if (!contentStr || typeof contentStr !== 'string') return '';
    const trimmed = contentStr.trim();
    if (!trimmed) return '';

    // Plaintext indicators: JSON objects/arrays, strings with whitespace/linebreaks/HTML tags
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('<') || /\s/.test(trimmed)) {
      return trimmed;
    }

    // Strict Base64 ciphertext candidate check
    const isBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && (trimmed.length % 4 === 0);
    if (!isBase64) {
      return trimmed;
    }

    if (!secretKey) {
      return '[Unable to decrypt message]';
    }

    try {
      const binary = atob(trimmed);
      const decrypted = rc4Cipher(binary, secretKey);
      const utf8Result = decodeURIComponent(escape(decrypted));
      return utf8Result;
    } catch (_) {
      // Failed decryption of ciphertext: do NOT present raw ciphertext as decrypted text
      return '[Unable to decrypt message]';
    }
  }

  function getChatSecretKey(userA_Id, userB_Id) {
    if (!userA_Id || !userB_Id) return '';
    return [userA_Id.toString(), userB_Id.toString()].sort().join('_');
  }

  function getCurrentUser() {
    const userStr = localStorage.getItem('invibe_user') || localStorage.getItem('invibeUser');
    if (!userStr) return null;
    try { return JSON.parse(userStr); } catch { return null; }
  }

  // --- DYNAMIC CHAT LOGS AND FEEDS ---
  // --- CLEAN DIRECT MESSAGING STATE MODEL (Phase 1 & Phase 8) ---
  let lastRenderedThreadsFingerprint = ''; // Module-scoped threads rendering fingerprint
  const dmState = {
    activeConversationId: null, // ALWAYS stores the real conversation UUID
    activePartnerId: null, // stores targetUserId (e.g. for DM header & thread selection)
    conversationIdByUser: new Map(), // targetUserId -> actual conversations.id from DB
    messagesByConversation: new Map(), // targetUserId or conversationId -> array of msg objects
    loadingConversations: new Set(),
    loadedConversations: new Set(),
    realtimeChannel: null,
    initialized: false
  };
  window.dmState = dmState;

  // [DM DOM DEBUG] log helper
  function logDMDomDebug() {
    const dmRoots = document.querySelectorAll('#view-chats, #chat-mesh-container').length;
    const inboxCount = document.querySelectorAll('.chat-inbox-sidebar').length;
    const panelCount = document.querySelectorAll('.chat-window-main').length;
    const composerCount = document.querySelectorAll('#chat-message-input').length;
    console.warn('[DM DOM DEBUG] DM root count:', document.querySelectorAll('#view-chats').length);
    console.warn('[DM DOM DEBUG] Inbox count:', inboxCount);
    console.warn('[DM DOM DEBUG] Conversation panel count:', panelCount);
    console.warn('[DM DOM DEBUG] Composer count:', composerCount);
    return { dmRoots, inboxCount, panelCount, composerCount };
  }
  window.logDMDomDebug = logDMDomDebug;

  // Backward compatibility proxy for existing helpers
  const chatFeeds = new Proxy({}, {
    get(target, prop) {
      return dmState.messagesByConversation.get(prop) || [];
    },
    set(target, prop, value) {
      dmState.messagesByConversation.set(prop, value);
      return true;
    }
  });
  window.chatFeeds = chatFeeds;

  // Global instrumentation counters for runtime debugging
  window.__dmLoadMessagesCount = 0;
  window.__dmRenderMessagesCount = 0;

  // --- DYNAMIC CHAT DOM ELEMENTS ---
  const chatHeaderName = document.querySelector('.chat-header-name');
  const chatHeaderAvatar = document.querySelector('.chat-header-avatar');
  const chatHeaderStatus = document.getElementById('chat-header-status') || document.querySelector('.chat-header-status');
  const messagesScroll = document.getElementById('chat-messages-container');
  const chatThreadsList = document.querySelector('.chat-threads-list');

  let chatThreads = []; // List of active thread items from backend

  // --- CENTRALIZED PRODUCTION-GRADE PRESENCE MANAGER ---
  const presenceManager = {
    onlineUserIds: new Set(),
    activeUsersList: [],
    onlineCount: 0,
    isInitialized: false,
    _realtimeChannel: null,
    _heartbeatTimer: null,

    isUserOnline(userIdOrIdentifier) {
      if (!userIdOrIdentifier) return false;
      const cleanId = (getUserIdentifier(userIdOrIdentifier) || String(userIdOrIdentifier)).trim();
      return this.onlineUserIds.has(cleanId);
    },

    updateDMHeader(targetUserId) {
      const statusEl = document.getElementById('chat-header-status') || document.querySelector('.chat-header-status');
      if (!statusEl) return;
      if (!targetUserId) {
        statusEl.innerHTML = '<span class="dot-offline"></span> Offline';
        return;
      }
      const isOnline = this.isUserOnline(targetUserId);
      if (isOnline) {
        statusEl.innerHTML = '<span class="dot-green"></span> Online';
      } else {
        statusEl.innerHTML = '<span class="dot-offline"></span> Offline';
      }
    },

    syncAllPresenceUI() {
      // 1. Sync Active Hubbers Widget
      const activeVibersCount = document.getElementById('active-vibers-count');
      const activeVibersList = document.getElementById('active-vibers-list');
      if (activeVibersCount) {
        activeVibersCount.textContent = `${this.onlineCount} online`;
      }
      if (activeVibersList) {
        activeVibersList.innerHTML = '';
        if (this.activeUsersList.length === 0) {
          activeVibersList.innerHTML = '<p style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 12px; width: 100%;">No hubbers online</p>';
        } else {
          this.activeUsersList.slice(0, 5).forEach(user => {
            const circle = document.createElement('div');
            circle.className = 'face-circle online';
            circle.style.position = 'relative';
            circle.style.cursor = 'pointer';
            circle.title = `${user.fullName} (@${user.username})`;
            circle.innerHTML = `
              <img src="${user.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80'}" alt="${escapeHtml(user.fullName)}" style="width: 36px; height: 36px; border-radius: 50%; object-fit: cover;" />
              <span class="online-indicator-dot" style="position: absolute; bottom: 0; right: 0; width: 10px; height: 10px; background: #22c55e; border: 2px solid #1a1a24; border-radius: 50%;"></span>
            `;
            circle.addEventListener('click', () => {
              switchView('profile', getUserIdentifier(user));
            });
            activeVibersList.appendChild(circle);
          });
        }
      }

      // 2. Sync active DM Conversation Header
      const activeChatUserId = dmState.activePartnerId || state.currentChatThread;
      if (activeChatUserId) {
        this.updateDMHeader(activeChatUserId);
      }

      // 3. Sync Chat Inbox Thread items
      if (chatThreadsList) {
        chatThreadsList.querySelectorAll('.thread-item[data-thread]').forEach(item => {
          const tUserId = item.getAttribute('data-thread');
          const indicator = item.querySelector('.online-indicator');
          if (indicator && tUserId) {
            const isOnline = this.isUserOnline(tUserId);
            indicator.className = `online-indicator ${isOnline ? 'online' : 'offline'}`;
          }
        });
      }

      // 4. Sync Active Hubbers widget from single presence source
      if (typeof window.renderActiveVibersWidget === 'function') {
        window.renderActiveVibersWidget(this.activeUsersList, this.onlineCount);
      }
    },

    async fetchOnlineUsers() {
      const token = getAuthToken();
      const isLoggedIn = localStorage.getItem('invibeIsLoggedIn') === 'true';
      if (!token || !isLoggedIn) return;
      try {
        const res = await fetch(`${API_URL}/api/online-users`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        const rawOnlineIds = Array.isArray(data.onlineUserIds) ? data.onlineUserIds : [];
        this.onlineUserIds = new Set(rawOnlineIds.map(String));
        this.onlineCount = typeof data.onlineCount === 'number' ? data.onlineCount : 0;
        this.activeUsersList = Array.isArray(data.users) ? data.users : [];
        this.isInitialized = true;
        this.syncAllPresenceUI();
      } catch (err) {
        console.warn('[PresenceManager fetchOnlineUsers Warning]:', err.message);
      }
    },

    sendHeartbeat() {
      const token = getAuthToken();
      const isLoggedIn = localStorage.getItem('invibeIsLoggedIn') === 'true';
      if (!token || !isLoggedIn) return;
      fetch(`${API_URL}/api/presence/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      }).then((res) => {
        if (!res.ok) return;
        const currentUser = getCurrentUser();
        const myId = currentUser ? (currentUser.id || currentUser._id) : null;
        if (myId) {
          this.onlineUserIds.add(myId.toString());
        }
      }).catch(() => { });
    },

    init() {
      this.sendHeartbeat();
      this.fetchOnlineUsers();

      if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = setInterval(() => {
        this.sendHeartbeat();
        this.fetchOnlineUsers();
      }, 30000);

      this.setupRealtime();
    },

    setupRealtime() {
      if (!window.supabase) return;
      try {
        if (this._realtimeChannel) {
          window.supabase.removeChannel(this._realtimeChannel);
        }
        this._realtimeChannel = window.supabase
          .channel('global_online_users_presence')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'online_users' }, (payload) => {
            const rec = payload.new || payload.old;
            if (rec && rec.user_id) {
              const uId = rec.user_id.toString();
              if (payload.eventType === 'DELETE' || (payload.new && payload.new.status === 'offline')) {
                this.onlineUserIds.delete(uId);
              } else if (payload.new && payload.new.status === 'online') {
                this.onlineUserIds.add(uId);
              }
            }
            this.fetchOnlineUsers();
          })
          .subscribe();
      } catch (err) {
        console.warn('[Presence Realtime Subscribe Warning]:', err.message);
      }
    }
  };
  window.presenceManager = presenceManager;
  window.PresenceManager = presenceManager;

  // Helper to sync unread message badges globally
  function updateGlobalUnreadBadges(count) {
    const badges = [
      document.querySelector('#messages-shortcut-btn .badge'),
      document.querySelector('.nav-item[data-target-view="chats"] .nav-badge'),
      document.querySelector('.radial-item-bubble[data-target-view="chats"] .nav-icon-badge'),
      document.querySelector('#mobile-chats-badge')
    ];

    badges.forEach(badge => {
      if (!badge) return;
      if (count > 0) {
        badge.style.display = 'flex';
        badge.textContent = count > 99 ? '99+' : count;
      } else {
        badge.style.display = 'none';
        badge.textContent = '';
      }
    });
  }

  let _chatThreadsInFlightPromise = null;
  async function loadChatThreads(autoSelectFirst = false) {
    const token = getAuthToken();
    if (!token) return;

    // Check if the user is actively searching in the inbox sidebar
    const inboxSearchInput = document.getElementById('inbox-search-input');
    if (inboxSearchInput && inboxSearchInput.value.trim() !== '') {
      return;
    }

    if (_chatThreadsInFlightPromise) {
      return _chatThreadsInFlightPromise;
    }

    _chatThreadsInFlightPromise = (async () => {
      try {
        const res = await fetch(`${API_URL}/api/chats/threads`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Failed to load chat threads');
        chatThreads = await res.json();

        if (Array.isArray(chatThreads)) {
          chatThreads.forEach(thread => {
            if (thread.conversationId && thread.user) {
              const uId = getUserIdentifier(thread.user);
              if (uId) dmState.conversationIdByUser.set(uId, thread.conversationId);
            }
          });
        }

        renderChatThreadsList();

        const emptyState = document.getElementById('chat-empty-state');
        const chatHeader = document.getElementById('chat-window-header');
        const chatViewport = document.querySelector('.chat-dynamic-viewport');
        const chatFooter = document.getElementById('chat-global-footer');

        if (!Array.isArray(chatThreads) || chatThreads.length === 0) {
          // Zero conversations: show empty placeholder
          state.currentChatThread = null;
          dmState.activeConversationId = null;
          dmState.activePartnerId = null;
          if (emptyState) emptyState.style.display = 'flex';
          if (chatHeader) chatHeader.style.display = 'none';
          if (chatViewport) chatViewport.style.display = 'none';
          if (chatFooter) chatFooter.style.display = 'none';
        } else {
          // Conversations exist: only keep active conversation if already explicitly selected
          const activeUserId = dmState.activePartnerId || state.currentChatThread;
          if (activeUserId) {
            selectConversation(activeUserId);
          } else {
            if (emptyState) emptyState.style.display = 'flex';
            if (chatHeader) chatHeader.style.display = 'none';
            if (chatViewport) chatViewport.style.display = 'none';
            if (chatFooter) chatFooter.style.display = 'none';
          }
        }
      } catch (err) {
        console.error('Error loading chat threads:', err);
      } finally {
        _chatThreadsInFlightPromise = null;
      }
    })();

    return _chatThreadsInFlightPromise;
  }

  function formatConversationPreviewText(lastMsg, secretKey) {
    if (!lastMsg) return 'Start chatting...';
    const effectiveMediaType = (lastMsg.mediaType || lastMsg.media_type || (lastMsg.attachment && lastMsg.attachment.file_type) || '').toLowerCase();

    if (effectiveMediaType === 'image' || effectiveMediaType.includes('image')) {
      return '📷 Photo';
    }
    if (effectiveMediaType === 'video' || effectiveMediaType.includes('video')) {
      return '📹 Video';
    }
    if (effectiveMediaType === 'audio' || effectiveMediaType === 'voice' || effectiveMediaType.includes('audio') || effectiveMediaType.includes('voice')) {
      return '🎙️ Voice Note';
    }
    if (effectiveMediaType === 'file' || effectiveMediaType === 'document') {
      return '📄 Document';
    }

    if (!lastMsg.content) {
      if (lastMsg.mediaUrl || lastMsg.media_url) return '📷 Photo';
      return 'Start chatting...';
    }

    const sId = lastMsg.sender_id || (typeof lastMsg.sender === 'object' ? (lastMsg.sender._id || lastMsg.sender.id) : lastMsg.sender);
    const rId = lastMsg.recipient_id || (typeof lastMsg.recipient === 'object' ? (lastMsg.recipient._id || lastMsg.recipient.id) : lastMsg.recipient);
    const effectiveKey = (sId && rId) ? getChatSecretKey(sId, rId) : secretKey;

    let decrypted = effectiveKey ? decryptMessage(lastMsg.content, effectiveKey) : lastMsg.content;
    if (!decrypted) return 'Start chatting...';

    // Check if decrypted string contains media tags or base64 data URLs
    if (decrypted.startsWith('data:image/') || decrypted.includes('<img')) {
      return '📷 Photo';
    }
    if (decrypted.startsWith('data:video/') || decrypted.includes('<video')) {
      return '📹 Video';
    }
    if (decrypted.startsWith('data:audio/') || decrypted.includes('<audio')) {
      return '🎙️ Voice Note';
    }

    try {
      const parsed = JSON.parse(decrypted);
      if (parsed && typeof parsed === 'object') {
        if (parsed.type === 'image') return '📷 Photo';
        if (parsed.type === 'video') return '📹 Video';
        if (parsed.type === 'audio') return '🎙️ Voice Note';
        if (parsed.hubType === 'story') {
          const isStoryStillActive = isStoryActive(parsed.hubId, parsed.timestamp || lastMsg.createdAt || lastMsg.created_at);
          if (parsed.messageType === 'hubbs_reply' || parsed.isReply) {
            return parsed.text ? `Replied: ${parsed.text}` : 'Replied to HUBB';
          }
          return isStoryStillActive ? (parsed.text || 'Shared a Hub Story') : 'Shared a Story · Expired';
        }
        if (parsed.hubType === 'post' || parsed.hubType === 'reel') {
          return parsed.text || (parsed.hubType === 'reel' ? 'Shared a Reel' : 'Shared a Post');
        }
        if (parsed.text !== undefined) {
          decrypted = parsed.text;
        }
      }
    } catch (e) { }

    // Strip any remaining HTML tags from preview text
    const cleanText = decrypted.replace(/<[^>]*>/g, '').trim();
    if (!cleanText) {
      if (effectiveMediaType) {
        if (effectiveMediaType.includes('image')) return '📷 Photo';
        if (effectiveMediaType.includes('video')) return '📹 Video';
      }
      return 'Start chatting...';
    }

    return cleanText.length > 30 ? cleanText.substring(0, 27) + '...' : cleanText;
  }

  function renderChatThreadsList() {
    if (!chatThreadsList) return;
    chatThreadsList.innerHTML = '';

    // Calculate total unread globally
    const totalUnread = chatThreads.reduce((sum, thread) => sum + (thread.unreadCount || 0), 0);
    updateGlobalUnreadBadges(totalUnread);

    if (chatThreads.length === 0) {
      chatThreadsList.innerHTML = '<div class="empty-inbox-placeholder" style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; min-height:120px; padding:24px 16px; text-align:center; color:var(--text-muted);"><i data-lucide="message-square" style="width:28px; height:28px; margin-bottom:8px; opacity:0.4;"></i><span style="font-size:13px; font-weight:600; color:var(--text-main); margin-bottom:4px;">No conversations yet</span><span style="font-size:11.5px; opacity:0.75;">Search users above to start chatting with your hub.</span></div>';
      if (window.lucide) lucide.createIcons();
      return;
    }

    const activeUserId = dmState.activePartnerId || state.currentChatThread;

    chatThreads.forEach(thread => {
      const u = thread.user;
      if (!u) return;
      const uId = getUserIdentifier(u);

      const isCurrent = activeUserId && activeUserId.toString() === uId.toString();
      const lastMsg = thread.lastMessage;
      let lastTextPreview = 'Start chatting...';
      let lastTimeText = '';

      if (lastMsg) {
        const currentUser = getCurrentUser();
        if (currentUser) {
          const secretKey = getChatSecretKey(currentUser.id || currentUser._id, uId);
          lastTextPreview = formatConversationPreviewText(lastMsg, secretKey);

          const rawDate = lastMsg.createdAt || lastMsg.created_at;
          const msgDate = rawDate ? new Date(rawDate) : new Date();
          lastTimeText = msgDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
      }

      const isOnline = presenceManager.isUserOnline(uId) || !!u.isOnline;
      const statusClass = isOnline ? 'online' : 'offline';

      const item = document.createElement('div');
      item.className = `thread-item ${isCurrent ? 'active' : ''}`;
      item.setAttribute('data-thread', uId);

      item.innerHTML = `
        <div class="thread-avatar">
          <img src="${u.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80'}" alt="${escapeHtml(u.fullName || u.username)}" />
          <span class="online-indicator ${statusClass}"></span>
        </div>
        <div class="thread-details">
          <div class="thread-meta">
            <span class="thread-name">${escapeHtml(u.fullName || u.username)}</span>
            <span class="thread-time">${lastTimeText}</span>
          </div>
          <div class="thread-preview">
            <span class="preview-text">${escapeHtml(lastTextPreview)}</span>
            ${thread.unreadCount > 0 ? `<span class="unread-count">${thread.unreadCount}</span>` : ''}
          </div>
        </div>
      `;

      item.addEventListener('click', () => {
        // Pre-populate conversationIdByUser so selectConversation knows the DB conversation ID
        if (thread.conversationId && uId) {
          dmState.conversationIdByUser.set(uId, thread.conversationId);
        }
        selectConversation(u);
      });

      chatThreadsList.appendChild(item);
    });
  }

  function updateThreadLastMessageInPlace(targetUserId, msg) {
    if (!targetUserId || !msg) return;
    const threadEl = chatThreadsList?.querySelector(`.thread-item[data-thread="${targetUserId}"]`);
    const currentUser = getCurrentUser();
    if (!currentUser) return;

    const secretKey = getChatSecretKey(currentUser.id || currentUser._id, targetUserId);
    const previewText = formatConversationPreviewText(msg, secretKey);

    const msgDate = msg.createdAt ? new Date(msg.createdAt) : new Date();
    const timeText = msgDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (threadEl) {
      const prevSpan = threadEl.querySelector('.preview-text');
      if (prevSpan) prevSpan.textContent = previewText;
      const timeSpan = threadEl.querySelector('.thread-time');
      if (timeSpan) timeSpan.textContent = timeText;

      const isActive = (dmState.activePartnerId && dmState.activePartnerId.toString() === targetUserId.toString()) || (state.currentChatThread && state.currentChatThread.toString() === targetUserId.toString());
      if (!isActive) {
        const threadObj = chatThreads.find(t => t.user && (getUserIdentifier(t.user) === targetUserId.toString()));
        if (threadObj) {
          threadObj.unreadCount = (threadObj.unreadCount || 0) + 1;
          let countBadge = threadEl.querySelector('.unread-count');
          if (!countBadge) {
            countBadge = document.createElement('span');
            countBadge.className = 'unread-count';
            threadEl.querySelector('.thread-preview')?.appendChild(countBadge);
          }
          countBadge.textContent = threadObj.unreadCount;
          const totalUnread = chatThreads.reduce((sum, t) => sum + (t.unreadCount || 0), 0);
          updateGlobalUnreadBadges(totalUnread);
        }
      }
    }
  }

  // Unified conversation selection handler
  async function selectConversation(targetUserOrId) {
    const targetUserId = getUserIdentifier(targetUserOrId);
    if (!targetUserId) return;

    if (typeof clearVoiceNoteState === 'function') {
      clearVoiceNoteState();
    }

    state.currentChatThread = targetUserId;
    dmState.activePartnerId = targetUserId;

    const isConvUuid = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '');

    // Check if targetUserOrId was already a conversation UUID or if we have it in conversationIdByUser
    let selectedConversationId = dmState.conversationIdByUser.get(targetUserId) || null;
    if (!selectedConversationId && isConvUuid(targetUserId)) {
      selectedConversationId = targetUserId;
    }

    // If not resolved to a UUID yet, resolve/create canonical direct conversation via POST /api/chats/direct/:targetId
    if (!selectedConversationId || !isConvUuid(selectedConversationId)) {
      const token = getAuthToken();
      if (token) {
        try {
          const resDirect = await fetch(`${API_URL}/api/chats/direct/${encodeURIComponent(targetUserId)}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            }
          });
          if (resDirect.ok) {
            const directData = await resDirect.json();
            const resolvedId = directData.conversationId || directData.id || directData._id;
            if (resolvedId && isConvUuid(resolvedId)) {
              selectedConversationId = resolvedId;
              dmState.conversationIdByUser.set(targetUserId, resolvedId);
            }
          }
        } catch (err) {
          console.error('[DM Direct Resolution Error]:', err);
        }
      }
    }

    // activeConversationId is ALWAYS the real conversation UUID (never username, 'caller', or arbitrary string)
    dmState.activeConversationId = selectedConversationId || null;

    console.debug('[DM DEBUG] selectedUserId:', targetUserId);
    console.debug('[DM DEBUG] selectedConversationId:', selectedConversationId);
    console.debug('[DM DEBUG] activeConversationId:', dmState.activeConversationId);
    console.debug('[DM-RUNTIME] conversation selected:', targetUserId, Date.now());

    // Highlight active thread item in sidebar without wiping the list
    if (chatThreadsList) {
      chatThreadsList.querySelectorAll('.thread-item').forEach(t => {
        if (t.getAttribute('data-thread') === targetUserId) {
          t.classList.add('active');
        } else {
          t.classList.remove('active');
        }
      });
    }

    // Show chat window header, viewport, composer; hide empty placeholder
    const emptyState = document.getElementById('chat-empty-state');
    const chatHeader = document.getElementById('chat-window-header');
    const chatViewport = document.querySelector('.chat-dynamic-viewport');
    const chatFooter = document.getElementById('chat-global-footer');

    if (emptyState) emptyState.style.display = 'none';
    if (chatHeader) chatHeader.style.display = '';
    if (chatViewport) chatViewport.style.display = '';
    if (chatFooter) chatFooter.style.display = '';

    // Resolve user object for avatar / full name
    let userObj = typeof targetUserOrId === 'object' ? targetUserOrId : null;
    if (!userObj && Array.isArray(chatThreads)) {
      const found = chatThreads.find(t => t.user && (getUserIdentifier(t.user) === targetUserId));
      if (found) userObj = found.user;
    }

    if (userObj) {
      if (chatHeaderName) chatHeaderName.textContent = userObj.fullName || userObj.username || 'Hubble User';
      if (chatHeaderAvatar) chatHeaderAvatar.src = userObj.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80';
    }

    // Dynamically update the online presence indicator in the DM header
    presenceManager.updateDMHeader(targetUserId);

    if (chatHeaderName) {
      chatHeaderName.style.cursor = 'pointer';
      chatHeaderName.onclick = () => {
        if (targetUserId) switchView('profile', targetUserId);
      };
    }
    if (chatHeaderAvatar) {
      chatHeaderAvatar.style.cursor = 'pointer';
      chatHeaderAvatar.onclick = () => {
        if (targetUserId) switchView('profile', targetUserId);
      };
    }

    // 1. If messages already exist in memory: render them immediately (zero flicker)
    if (dmState.messagesByConversation.has(targetUserId)) {
      renderChatMessages(targetUserId);
    }
    // 2. Always sync latest messages in background using the real conversation UUID
    if (selectedConversationId) {
      loadMessages(selectedConversationId, targetUserId);
    }

    markMessagesAsRead(targetUserId);

    // Global layout trigger — show chat view, hide inbox
    const grid = document.querySelector('.chats-layout-grid');
    if (grid) grid.classList.add('chatting');
    document.body.classList.add('chat-active-mobile');
  }

  // Load messages from backend into dmState using conversation UUID
  async function loadMessages(convId, targetUserId) {
    const token = getAuthToken();
    if (!token || !convId) return;

    const partnerId = targetUserId || state.currentChatThread || dmState.activePartnerId;
    if (dmState.loadingConversations.has(convId)) return;

    // Request token to prevent stale async responses overwriting active conversation
    const requestToken = Date.now() + '_' + Math.random();
    dmState._activeLoadToken = dmState._activeLoadToken || {};
    dmState._activeLoadToken[convId] = requestToken;

    window.__dmLoadMessagesCount = (window.__dmLoadMessagesCount || 0) + 1;
    console.debug('[DM-RUNTIME] loadMessages:', window.__dmLoadMessagesCount, convId, Date.now());

    // Show skeleton loading state ONLY if this conversation has never been loaded
    if (!dmState.loadedConversations.has(convId) && (!partnerId || !dmState.loadedConversations.has(partnerId)) && messagesScroll) {
      console.debug('[DM-RUNTIME] loading ON:', convId, Date.now());
      messagesScroll.innerHTML = `
        <div class="chat-messages-skeleton" style="display:flex; flex-direction:column; gap:12px; padding:20px;">
          <div style="width:40%; height:36px; background:rgba(255,255,255,0.06); border-radius:16px; align-self:flex-start; animation:pulse 1.5s infinite;"></div>
          <div style="width:55%; height:42px; background:rgba(108,59,255,0.15); border-radius:16px; align-self:flex-end; animation:pulse 1.5s infinite;"></div>
          <div style="width:35%; height:36px; background:rgba(255,255,255,0.06); border-radius:16px; align-self:flex-start; animation:pulse 1.5s infinite;"></div>
        </div>
      `;
    }

    dmState.loadingConversations.add(convId);

    let querySucceeded = false;
    let queryError = null;

    try {
      const res = await fetch(`${API_URL}/api/chats/messages/${convId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      // Race condition guard: if user switched away, discard this response
      if (dmState._activeLoadToken?.[convId] !== requestToken) {
        console.debug('[DM-RUNTIME] stale response discarded for:', convId);
        return;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch messages`);

      // Capture the resolved conversationId from the server header
      const resolvedConvId = res.headers.get('X-Conversation-Id') || convId;
      if (partnerId) {
        dmState.conversationIdByUser.set(partnerId, resolvedConvId);
      }

      const messages = await res.json();
      querySucceeded = true;

      console.debug('[DM DEBUG] messagesQueryConversationId:', resolvedConvId);
      console.debug('[DM DEBUG] messagesReturned:', Array.isArray(messages) ? messages.length : 'not-array');
      console.debug('[DM DEBUG] messagesQueryError:', null);
      console.debug('[DM DEBUG] activeConversationId:', dmState.activeConversationId);

      const msgList = Array.isArray(messages) ? messages : [];
      if (partnerId) {
        dmState.messagesByConversation.set(partnerId, msgList);
        dmState.loadedConversations.add(partnerId);
      }
      dmState.messagesByConversation.set(resolvedConvId, msgList);
      dmState.loadedConversations.add(resolvedConvId);
    } catch (err) {
      queryError = err;
      console.error('[DM DEBUG] messagesQueryError:', err.message);
      console.debug('[DM DEBUG] messagesQueryConversationId:', convId);
      console.debug('[DM DEBUG] messagesReturned:', 0);
      console.error('Error loading messages:', err);
    } finally {
      dmState.loadingConversations.delete(convId);
      console.debug('[DM-RUNTIME] loading OFF:', convId, Date.now());

      // Only render if user is still looking at this conversation
      if (dmState.activeConversationId === convId || (partnerId && dmState.activePartnerId === partnerId)) {
        if (querySucceeded) {
          renderChatMessages(partnerId || convId);
        } else if (queryError) {
          // Show error state — NOT the empty conversation placeholder
          if (messagesScroll) {
            messagesScroll.innerHTML = `
              <div class="chat-empty-messages" style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; min-height:280px; color:var(--text-muted); text-align:center; padding:40px 20px;">
                <div style="font-size:42px; margin-bottom:12px;">⚠️</div>
                <h4 style="font-size:16px; font-weight:600; color:#ff6b6b; margin:0 0 6px 0;">Failed to load messages</h4>
                <p style="font-size:13px; color:rgba(255,255,255,0.6); max-width:240px; margin:0;">Please try again.</p>
              </div>
            `;
          }
        }
      }
    }
  }

  // Helper alias for backward compatibility across other handlers
  async function fetchMessages(convOrUserId) {
    const isConvUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(convOrUserId || '');
    if (isConvUuid) {
      await loadMessages(convOrUserId);
    } else {
      await selectConversation(convOrUserId);
    }
  }

  function getChatDateSeparatorText(dateInput) {
    if (!dateInput) return 'Today';
    const messageDate = new Date(dateInput);
    if (isNaN(messageDate.getTime())) return 'Today';

    const d = new Date(messageDate.getFullYear(), messageDate.getMonth(), messageDate.getDate());
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    if (d.getTime() === today.getTime()) {
      return 'Today';
    } else if (d.getTime() === yesterday.getTime()) {
      return 'Yesterday';
    } else {
      const day = messageDate.getDate();
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const month = monthNames[messageDate.getMonth()];
      const year = messageDate.getFullYear();
      return `${day} ${month} ${year}`;
    }
  }

  // Resolves a browser-loadable image URL from various message fields (URL, relative storage path, or attachment)
  function resolveBrowserMediaUrl(msg) {
    if (!msg) return '';
    let candidate = msg.mediaUrl || msg.media_url || '';
    if (!candidate && msg.attachment) {
      candidate = msg.attachment.storagePath || msg.attachment.storage_path || '';
    }
    if (!candidate && msg.attachments && msg.attachments.length > 0) {
      candidate = msg.attachments[0].storagePath || msg.attachments[0].storage_path || '';
    }
    if (!candidate && msg.content && typeof msg.content === 'string') {
      const raw = msg.content.trim();
      if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) {
        candidate = raw;
      } else {
        const srcMatch = raw.match(/src=["']([^"']+)["']/i);
        if (srcMatch && srcMatch[1]) {
          candidate = srcMatch[1];
        }
      }
    }
    if (!candidate || typeof candidate !== 'string') return '';
    const trimmed = candidate.trim();
    if (!trimmed) return '';

    // If already an HTTP(S) URL or data URL
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('data:')) {
      return trimmed;
    }

    // Hub keys like "story_...", "reel_...", "post_..." are logical reference IDs
    if (trimmed.startsWith('story_') || trimmed.startsWith('reel_') || trimmed.startsWith('post_') || trimmed.startsWith('reel')) {
      return trimmed;
    }

    // If it's a relative storage path (e.g. "chat-media/convId/..." or "convId/userId/filename.png")
    if (window.supabase) {
      try {
        const cleanPath = trimmed.replace(/^\/?(chat-media|chat-attachments)\//, '');
        const { data } = window.supabase.storage.from('chat-media').getPublicUrl(cleanPath);
        if (data?.publicUrl) return data.publicUrl;
      } catch (_) { }
    }

    return trimmed;
  }

  function formatMediaDuration(seconds) {
    if (!seconds || isNaN(seconds) || !isFinite(seconds) || seconds <= 0) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // Helper to determine if a shared story is still active or expired/unavailable
  function isStoryActive(hubId, storyTimestamp) {
    if (!hubId) return false;
    const cleanId = hubId.toString().replace(/^story_/, '');

    // 1. Check if timestamp is older than 24 hours (24h story lifecycle)
    if (storyTimestamp) {
      const sTime = new Date(storyTimestamp).getTime();
      if (!isNaN(sTime) && (Date.now() - sTime) > 24 * 60 * 60 * 1000) {
        return false;
      }
    }

    // 2. Check if story is present in loaded active storyGroups
    if (state.storyGroups && Array.isArray(state.storyGroups) && state.storyGroups.length > 0) {
      let found = false;
      state.storyGroups.forEach(group => {
        (group.stories || []).forEach(s => {
          const sId = (s._id || s.id || '').toString();
          if (sId && (sId === cleanId || sId === hubId.toString() || ('story_' + sId) === hubId.toString())) {
            const sCreatedAt = s.createdAt || s.created_at;
            if (sCreatedAt) {
              const t = new Date(sCreatedAt).getTime();
              if (!isNaN(t) && (Date.now() - t) <= 24 * 60 * 60 * 1000) {
                found = true;
              }
            } else {
              found = true;
            }
          }
        });
      });
      return found;
    }

    // 3. Fallback to timestamp if storyGroups not yet loaded
    if (storyTimestamp) {
      const sTime = new Date(storyTimestamp).getTime();
      return !isNaN(sTime) && (Date.now() - sTime) <= 24 * 60 * 60 * 1000;
    }

    return true;
  }

  // Builds a single message bubble DOM element
  function createMessageBubbleElement(msg, currentUserId, targetUserId, secretKey) {
    const rawDate = msg.createdAt || msg.created_at || msg.timestamp;
    const msgDate = rawDate ? new Date(rawDate) : new Date();
    const validDate = isNaN(msgDate.getTime()) ? new Date() : msgDate;

    // Robust sender & recipient ID resolution for message-level canonical secret key
    const msgSenderId = typeof msg.sender === 'object'
      ? (msg.sender._id || msg.sender.id || '')
      : (msg.sender || msg.sender_id || '');
    const msgRecipientId = typeof msg.recipient === 'object'
      ? (msg.recipient._id || msg.recipient.id || '')
      : (msg.recipient || msg.recipient_id || '');

    const effectiveKey = (msgSenderId && msgRecipientId)
      ? getChatSecretKey(msgSenderId, msgRecipientId)
      : (secretKey || ((currentUserId && targetUserId) ? getChatSecretKey(currentUserId, targetUserId) : ''));

    let decryptedText = decryptMessage(msg.content, effectiveKey);

    let hubInfo = null;
    let parsedMediaType = null;
    let parsedMediaUrl = null;

    try {
      const parsed = JSON.parse(decryptedText);
      if (parsed && typeof parsed === 'object') {
        if (parsed.type === 'image' || parsed.type === 'video' || parsed.type === 'audio') {
          parsedMediaType = parsed.type;
          parsedMediaUrl = parsed.url;
          decryptedText = parsed.caption || parsed.text || '';
        } else if (parsed.text !== undefined) {
          decryptedText = parsed.text;
          msg.replyTo = parsed.replyTo;
        }
        if (parsed.hubType) {
          hubInfo = parsed;
        }
      }
    } catch (e) {
      if (typeof decryptedText === 'string') {
        const imgMatch = decryptedText.match(/^<img[^>]+src=["']([^"']+)["'][^>]*>/i);
        const videoMatch = decryptedText.match(/^<video[^>]+src=["']([^"']+)["'][^>]*>/i);
        if (imgMatch) {
          parsedMediaType = 'image';
          parsedMediaUrl = imgMatch[1];
          decryptedText = '';
        } else if (videoMatch) {
          parsedMediaType = 'video';
          parsedMediaUrl = videoMatch[1];
          decryptedText = '';
        }
      }
    }

    const time = validDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isSent = msgSenderId.toString() === currentUserId.toString();

    // Linkify standard text content
    const urlRegex = /(\b(https?):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    const linkifiedText = (decryptedText || '').replace(urlRegex, (url) => {
      return `<a href="${url}" target="_blank" style="color: #6c3bff; text-decoration: underline; word-break: break-all;">${url}</a>`;
    });

    const rawMediaType = (msg.mediaType || msg.media_type || (msg.attachment && msg.attachment.file_type) || parsedMediaType || '').toLowerCase();
    const mimeTypeCandidate = ((msg.attachment && msg.attachment.mime_type) || msg.mimeType || msg.mime_type || '').toLowerCase();
    const nameCandidate = (msg.mediaName || msg.media_name || (msg.attachment && msg.attachment.file_name) || '').toLowerCase();
    const isVideo = rawMediaType === 'video' || rawMediaType.includes('video') || (parsedMediaType === 'video') || (msg.type === 'video') || mimeTypeCandidate.startsWith('video/') || nameCandidate.endsWith('.mp4') || nameCandidate.endsWith('.webm') || nameCandidate.endsWith('.mov');
    const isAudio = rawMediaType === 'audio' || rawMediaType === 'voice' || rawMediaType.includes('audio') || rawMediaType.includes('voice') || (parsedMediaType === 'audio') || mimeTypeCandidate.startsWith('audio/') || nameCandidate.endsWith('.mp3') || nameCandidate.endsWith('.ogg') || nameCandidate.endsWith('.wav');
    const isImage = (rawMediaType === 'image' || rawMediaType.includes('image') || (parsedMediaType === 'image') || mimeTypeCandidate.startsWith('image/') || (!rawMediaType && (msg.mediaUrl || msg.media_url))) && !isVideo && !isAudio;
    const isHub = rawMediaType === 'hub' || !!hubInfo || (msg.mediaName && (msg.mediaName.includes('Hub Story') || msg.mediaName.includes('Shared Story')));
    const hasMedia = (rawMediaType && rawMediaType !== 'text') || isVideo || isAudio || isImage || isHub;
    let displayContent = `<div class="bubble-content">${linkifiedText}</div>`;

    if (isHub) {
      const info = hubInfo || {
        hubId: msg.mediaUrl ? msg.mediaUrl.replace(/^(story_|reel_|post_)/, '') : '',
        hubType: msg.mediaUrl ? (msg.mediaUrl.startsWith('story_') ? 'story' : (msg.mediaUrl.startsWith('reel') ? 'reel' : 'post')) : (msg.mediaName?.includes('Story') ? 'story' : 'post'),
        thumbnail: '',
        authorName: isSent ? 'You' : (document.querySelector('.chat-header-name')?.textContent || 'Hubber'),
        authorAvatar: isSent ? '' : (document.querySelector('.chat-header-avatar')?.src || ''),
        text: decryptedText || 'Shared a Post'
      };

      const hubId = info.hubId || (msg.mediaUrl ? msg.mediaUrl.replace(/^(story_|reel_|post_)/, '') : '');
      const hubType = info.hubType || (msg.mediaUrl ? (msg.mediaUrl.startsWith('story_') ? 'story' : (msg.mediaUrl.startsWith('reel') ? 'reel' : 'post')) : (msg.mediaName?.includes('Story') ? 'story' : 'post'));
      const thumbnail = info.thumbnail || '';
      const authorName = info.authorName || 'Hubber';
      const authorAvatar = info.authorAvatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&h=80&q=80';
      const postText = info.text || 'Shared a Post';

      if (hubType === 'story') {
        const storyTime = info.timestamp || rawDate || msg.createdAt || msg.created_at;
        const isExpired = !isStoryActive(hubId, storyTime);

        console.log('[DM STORY DEBUG] PersonalChat:', {
          eventId: msg._id || msg.id,
          type: 'story_share',
          storyId: hubId,
          expired: isExpired,
          read: msg.status === 'read' || msg.is_read || msg.read,
          render: true
        });

        if (isExpired) {
          displayContent = `
            <div class="bubble-content chat-shared-hub-card chat-expired-story-card">
              <!-- Post Author Header -->
              <div class="expired-author-header">
                <img class="expired-author-avatar" src="${authorAvatar}" alt="${authorName}" />
                <span class="expired-author-name">${authorName}</span>
              </div>

              <!-- Expired Notice Details -->
              <div class="expired-notice-box">
                <div class="expired-icon-wrap">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--primary, #a855f7);"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                </div>
                <div class="expired-text-col">
                  <span class="expired-title">${authorName} shared a HUBB</span>
                  <span class="expired-desc">This HUBB has expired — you missed it.</span>
                </div>
              </div>

              <!-- Expired Status Indicator -->
              <div class="expired-footer-status">
                <span class="expired-status-dot"></span> HUBB Expired
              </div>
            </div>
          `;
        } else {
          // Active Story Card
          const isVideoThumbnail = info.isVideo || (thumbnail && (thumbnail.endsWith('.mp4') || thumbnail.endsWith('.webm') || thumbnail.endsWith('.mov') || thumbnail.includes('/video/')));

          displayContent = `
            <div class="bubble-content chat-shared-hub-card" 
                 onclick="if(typeof window.navigateToPost === 'function') { window.navigateToPost('${hubId}', 'story') } else { console.warn('navigateToPost not found') }">
              
              <!-- Post Author Header -->
              <div class="hub-author-header">
                <img class="hub-author-avatar" src="${authorAvatar}" alt="${authorName}" />
                <span class="hub-author-name">${authorName}</span>
              </div>

              <!-- Post Thumbnail -->
              ${thumbnail ? `
                <div style="position: relative; width: 100%; border-radius: 8px; overflow: hidden; background: #000; display: flex; justify-content: center; align-items: center;">
                  ${isVideoThumbnail ? `
                    <video src="${thumbnail}" muted playsinline loop autoplay style="width: 100%; max-height: 180px; object-fit: cover; display: block;"></video>
                    <div style="position: absolute; right: 8px; top: 8px; background: rgba(0,0,0,0.6); padding: 4px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #fff;"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                    </div>
                  ` : `
                    <img src="${thumbnail}" alt="HUBB Preview" loading="lazy" style="width: 100%; max-height: 180px; object-fit: cover; display: block;" />
                  `}
                </div>
              ` : `
                <!-- Placeholder/No media fallback -->
                <div style="width: 100%; height: 60px; border-radius: 8px; background: rgba(255, 255, 255, 0.03); display: flex; align-items: center; justify-content: center; border: 1px dashed rgba(255, 255, 255, 0.1);">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-muted);"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                </div>
              `}

              <!-- Post Content text -->
              <div class="hub-post-text">
                ${postText}
              </div>

              <!-- View Story Link -->
              <div style="font-size: 11px; color: var(--primary, #a855f7); font-weight: 600; text-align: right; display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-top: 2px;">
                View Story <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
              </div>
            </div>
          `;
        }
      } else {
        // Reel or Post Card
        const isVideoThumbnail = info.isVideo || (thumbnail && (thumbnail.endsWith('.mp4') || thumbnail.endsWith('.webm') || thumbnail.endsWith('.mov') || thumbnail.includes('/video/')));

        displayContent = `
          <div class="bubble-content chat-shared-hub-card" 
               onclick="if(typeof window.navigateToPost === 'function') { window.navigateToPost('${hubId}', '${hubType}') } else { console.warn('navigateToPost not found') }">
            
            <!-- Post Author Header -->
            <div class="hub-author-header">
              <img class="hub-author-avatar" src="${authorAvatar}" alt="${authorName}" />
              <span class="hub-author-name">${authorName}</span>
            </div>

            <!-- Post Thumbnail -->
            ${thumbnail ? `
              <div style="position: relative; width: 100%; border-radius: 8px; overflow: hidden; background: #000; display: flex; justify-content: center; align-items: center;">
                ${isVideoThumbnail ? `
                  <video src="${thumbnail}" muted playsinline loop autoplay style="width: 100%; max-height: 180px; object-fit: cover; display: block;"></video>
                  <div style="position: absolute; right: 8px; top: 8px; background: rgba(0,0,0,0.6); padding: 4px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #fff;"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                  </div>
                ` : `
                  <img src="${thumbnail}" alt="Post Preview" loading="lazy" style="width: 100%; max-height: 180px; object-fit: cover; display: block;" />
                `}
              </div>
            ` : `
              <!-- Placeholder/No media fallback -->
              <div style="width: 100%; height: 60px; border-radius: 8px; background: rgba(255, 255, 255, 0.03); display: flex; align-items: center; justify-content: center; border: 1px dashed rgba(255, 255, 255, 0.1);">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-muted);"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
              </div>
            `}

            <!-- Post Content text -->
            <div class="hub-post-text">
              ${postText}
            </div>

            <!-- View Post Link -->
            <div style="font-size: 11px; color: var(--primary, #a855f7); font-weight: 600; text-align: right; display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-top: 2px;">
              ${hubType === 'reel' ? 'View Reel' : 'View Post'} <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
            </div>
          </div>
        `;
      }
    } else if (hasMedia || isImage || isVideo || isAudio) {
      if (isImage) {
        const imageUrl = resolveBrowserMediaUrl(msg) || parsedMediaUrl || (decryptedText.startsWith('http') || decryptedText.startsWith('data:') ? decryptedText : '');
        const hasText = decryptedText && !decryptedText.startsWith('http') && !decryptedText.startsWith('data:') && decryptedText !== '[Decryption Failed]';
        const imgName = msg.mediaName || msg.media_name || 'Shared Image';

        if (imageUrl) {
          displayContent = `
            <div class="bubble-content chat-shared-media-card" style="padding: 4px; background: rgba(255,255,255,0.06); border-radius: var(--radius-md); overflow: hidden; cursor: pointer; max-width: 270px;">
              <img src="${imageUrl}" alt="${imgName}" loading="lazy" style="display: block; max-width: 260px; max-height: 260px; width: 100%; height: auto; border-radius: var(--radius-sm); object-fit: cover;" onclick="openMediaViewer('${msg._id || msg.id}')" onerror="console.warn('[IMAGE_LOAD_FAILED]', '${msg._id || msg.id}', '${imageUrl}'); this.onerror=null; this.parentElement.innerHTML='<div style=\\'padding:12px; font-size:12px; color:var(--text-muted); text-align:center;\\'>⚠️ Image unavailable</div>';" />
              ${hasText ? `<div style="padding: 6px 4px 2px; font-size: 13px; word-break: break-word;">${linkifiedText}</div>` : ''}
            </div>
          `;
        }
      } else if (isVideo) {
        const videoUrl = resolveBrowserMediaUrl(msg) || parsedMediaUrl || (decryptedText.startsWith('http') || decryptedText.startsWith('data:') ? decryptedText : '');
        const videoName = msg.mediaName || msg.media_name || (msg.attachment && msg.attachment.file_name) || 'Shared Video';
        const mimeType = (msg.attachment && msg.attachment.mime_type) || msg.mimeType || msg.mime_type || (videoName.endsWith('.webm') ? 'video/webm' : (videoName.endsWith('.ogg') ? 'video/ogg' : 'video/mp4'));
        const hasText = decryptedText && !decryptedText.startsWith('http') && !decryptedText.startsWith('data:') && decryptedText !== '[Decryption Failed]';
        const rawDur = msg.durationSeconds || (msg.attachment && msg.attachment.durationSeconds) || msg.duration || 0;
        const initialDurStr = formatMediaDuration(rawDur);

        if (videoUrl) {
          displayContent = `
            <div class="bubble-content chat-shared-media-card" style="padding: 4px; background: rgba(255,255,255,0.06); border-radius: var(--radius-md); overflow: hidden; max-width: 280px; position: relative;">
              <div style="position: relative; width: 100%; border-radius: var(--radius-sm); overflow: hidden; background: #000;">
                <video src="${videoUrl}" controls preload="metadata" playsinline style="display: block; max-width: 270px; max-height: 260px; width: 100%; height: auto; border-radius: var(--radius-sm); object-fit: cover;" onclick="event.stopPropagation();" onloadedmetadata="if(this.duration === Infinity || isNaN(this.duration) || this.duration === 0){ const p = this.currentTime; this.currentTime = 1e101; this.addEventListener('timeupdate', function f(){ this.removeEventListener('timeupdate', f); this.currentTime = p || 0; }, { once: true }); } const d = this.duration; if(d && isFinite(d) && d > 0){ const b = this.parentElement.querySelector('.video-duration-pill'); if(b){ const m = Math.floor(d / 60); const s = Math.floor(d % 60).toString().padStart(2, '0'); b.textContent = m + ':' + s; b.style.display = 'inline-flex'; } }" ondurationchange="const d = this.duration; if(d && isFinite(d) && d > 0){ const b = this.parentElement.querySelector('.video-duration-pill'); if(b){ const m = Math.floor(d / 60); const s = Math.floor(d % 60).toString().padStart(2, '0'); b.textContent = m + ':' + s; b.style.display = 'inline-flex'; } }">
                  <source src="${videoUrl}" type="${mimeType}">
                  <p style="font-size: 11px; padding: 8px; color: var(--text-muted);">Your browser does not support HTML5 video.</p>
                </video>
                <span class="video-duration-pill" style="position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.72); color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; font-family: monospace; letter-spacing: 0.5px; display: ${initialDurStr ? 'inline-flex' : 'none'}; align-items: center; gap: 3px; pointer-events: none; z-index: 2; backdrop-filter: blur(4px);"><i data-lucide="play" style="width: 8px; height: 8px; fill: currentColor;"></i>${initialDurStr}</span>
              </div>
              <div style="padding: 4px 6px 2px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <span style="font-size: 11px; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px;" title="${videoName}">${videoName}</span>
                <button type="button" class="icon-btn" onclick="openMediaViewer('${msg._id || msg.id}')" style="background: none; border: none; color: var(--primary); cursor: pointer; padding: 2px;" title="Expand Video"><i data-lucide="maximize-2" style="width: 14px; height: 14px;"></i></button>
              </div>
              ${hasText ? `<div style="padding: 4px 6px; font-size: 13px; word-break: break-word;">${linkifiedText}</div>` : ''}
            </div>
          `;
        }
      } else if (isAudio) {
        const audioUrl = resolveBrowserMediaUrl(msg) || parsedMediaUrl || (decryptedText.startsWith('http') || decryptedText.startsWith('data:') ? decryptedText : '');
        const audioName = msg.mediaName || msg.media_name || (msg.attachment && msg.attachment.file_name) || 'Voice Message';
        const mimeType = (msg.attachment && msg.attachment.mime_type) || msg.mimeType || msg.mime_type || (audioName.endsWith('.mp3') ? 'audio/mpeg' : (audioName.endsWith('.ogg') ? 'audio/ogg' : 'audio/webm'));
        const hasText = decryptedText && !decryptedText.startsWith('http') && !decryptedText.startsWith('data:') && decryptedText !== '[Decryption Failed]';

        if (audioUrl) {
          displayContent = `
            <div class="bubble-content chat-shared-media-card" style="padding: 8px 12px; background: rgba(255,255,255,0.06); border-radius: var(--radius-md); max-width: 280px; min-width: 220px; display: flex; flex-direction: column; gap: 6px; position: relative;">
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 6px; min-width: 0;">
                  <i data-lucide="mic" style="width: 14px; height: 14px; color: var(--primary); flex-shrink: 0;"></i>
                  <span style="font-size: 11px; font-weight: 500; opacity: 0.9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${audioName}">${audioName}</span>
                </div>
              </div>
              <audio src="${audioUrl}" controls preload="metadata" style="width: 100%; height: 36px; outline: none; border-radius: var(--radius-sm);" onclick="event.stopPropagation();">
                <source src="${audioUrl}" type="${mimeType}">
                Your browser does not support playing audio notes.
              </audio>
              ${hasText ? `<div style="padding: 2px 4px; font-size: 13px; word-break: break-word;">${linkifiedText}</div>` : ''}
            </div>
          `;
        }
      } else if (msg.mediaType === 'file') {
        displayContent = `
          <div class="chat-shared-file-container" style="display: flex; justify-content: space-between; align-items: center; width: 100%; gap: 12px;">
            <div onclick="openMediaViewer('${msg._id || msg.id}')" style="display: flex; align-items: center; gap: 8px; flex-grow: 1; cursor: pointer;">
              <i data-lucide="file-text" style="width:24px; height:24px; color:var(--primary); min-width:24px;"></i>
              <div class="chat-shared-file-info" style="text-align: left;">
                <span class="chat-shared-file-title" style="word-break: break-all; display: block;">${msg.mediaName || 'Document'}</span>
                <span class="chat-shared-file-size" style="font-size: 10px; opacity: 0.7; display: block;">${msg.mediaSize || ''}</span>
              </div>
            </div>
            <a href="${decryptedText}" download="${msg.mediaName || 'file'}" class="icon-btn" style="color: var(--primary); display: flex; align-items: center; justify-content: center; min-width: 32px; height: 32px; background: rgba(255,255,255,0.05); border-radius: 50%; border: none; cursor: pointer;" title="Download File">
              <i data-lucide="download" style="width: 16px; height: 16px;"></i>
            </a>
          </div>
        `;
      }
    }

    let replyPreviewHtml = '';
    if (msg.replyTo) {
      let rSender = msg.replyTo.senderName || 'User';
      let rText = msg.replyTo.text || 'Message';
      replyPreviewHtml = `
        <div class="replied-message-box">
          <div class="replied-sender">${rSender}</div>
          <div class="replied-text">${rText}</div>
        </div>
      `;
      displayContent = replyPreviewHtml + displayContent;
    }

    let tickHtml = '';
    if (isSent) {
      const isRead = msg.status === 'read' || msg.is_read || msg.read;
      if (isRead) {
        tickHtml = '<span class="msg-status-diamond-receipt read" title="Read"><svg class="msg-diamond-svg" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><polygon points="6,1.2 10.8,6 6,10.8 1.2,6"></polygon></svg></span>';
      } else {
        tickHtml = '<span class="msg-status-diamond-receipt unread" title="Sent"><svg class="msg-diamond-svg" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><polygon points="6,1.2 10.8,6 6,10.8 1.2,6"></polygon></svg></span>';
      }
    }

    const msgId = msg._id || msg.id || '';
    const msgIdAttr = msgId ? `data-msg-id="${msgId}"` : '';
    const rawTextAttr = `data-raw-text="${(decryptedText || '').replace(/"/g, '&quot;')}"`;
    const senderNameAttr = `data-sender-name="${isSent ? 'You' : (document.querySelector('.chat-header-name')?.textContent || 'User')}"`;

    const bubbleHtml = `
      <div class="${isSent ? 'chat-bubble sent' : 'chat-bubble received'}" ${msgIdAttr} ${rawTextAttr} ${senderNameAttr}>
        ${displayContent}
        <div class="bubble-time">${time} ${tickHtml}</div>
      </div>
    `;

    const actionsHtml = `
      <div style="position: relative;">
        <button class="message-action-trigger"><i data-lucide="chevron-down"></i></button>
        <div class="message-action-dropdown">
          <button class="message-action-item action-reply"><i data-lucide="corner-up-left"></i> Reply</button>
          <button class="message-action-item action-copy"><i data-lucide="copy"></i> Copy</button>
          <button class="message-action-item action-forward"><i data-lucide="forward"></i> Forward</button>
          ${isSent ? `<button class="message-action-item action-delete"><i data-lucide="trash-2"></i> Delete</button>` : ''}
        </div>
      </div>
    `;

    const wrapper = document.createElement('div');
    wrapper.className = isSent ? 'message-bubble-wrapper sent-wrapper' : 'message-bubble-wrapper received-wrapper';

    if (isSent) {
      wrapper.innerHTML = actionsHtml + bubbleHtml;
    } else {
      wrapper.innerHTML = bubbleHtml + actionsHtml;
    }

    return wrapper;
  }

  // Renders the messages from state for targetUserOrConvId (NO FETCHING ALLOWED HERE)
  function renderChatMessages(targetUserOrConvId) {
    if (!messagesScroll) return;

    window.__dmRenderMessagesCount = (window.__dmRenderMessagesCount || 0) + 1;
    console.debug('[DM-RUNTIME] renderMessages:', window.__dmRenderMessagesCount, targetUserOrConvId, Date.now());

    messagesScroll.innerHTML = '';

    const partnerId = dmState.activePartnerId || (getUserIdentifier(targetUserOrConvId) !== targetUserOrConvId ? getUserIdentifier(targetUserOrConvId) : targetUserOrConvId);
    const messages = dmState.messagesByConversation.get(partnerId) || dmState.messagesByConversation.get(targetUserOrConvId) || [];
    const currentUser = getCurrentUser();
    if (!currentUser) return;
    const currentUserId = (currentUser.id || currentUser._id || '').toString();
    const secretKey = (currentUserId && partnerId) ? getChatSecretKey(currentUserId, partnerId) : '';

    // Only show "No messages yet" if we know the query completed successfully AND returned 0 messages
    if (messages.length === 0) {
      if (!dmState.loadedConversations.has(partnerId) && !dmState.loadedConversations.has(targetUserOrConvId)) {
        // Query hasn't completed yet — leave skeleton/loading state in place
        return;
      }
      messagesScroll.innerHTML = `
        <div class="chat-empty-messages" style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; min-height:280px; color:var(--text-muted); text-align:center; padding:40px 20px;">
          <div style="font-size:42px; margin-bottom:12px; filter:drop-shadow(0 0 12px rgba(108,59,255,0.4));">👋</div>
          <h4 style="font-size:16px; font-weight:600; color:var(--text-main); margin:0 0 6px 0;">No messages yet</h4>
          <p style="font-size:13px; color:var(--text-muted); max-width:240px; margin:0;">Start the conversation 👋</p>
        </div>
      `;
      return;
    }

    let lastDateKey = null;

    messages.forEach(msg => {
      const rawDate = msg.createdAt || msg.created_at || msg.timestamp;
      const msgDate = rawDate ? new Date(rawDate) : new Date();
      const validDate = isNaN(msgDate.getTime()) ? new Date() : msgDate;
      const dateKey = `${validDate.getFullYear()}-${validDate.getMonth() + 1}-${validDate.getDate()}`;

      if (dateKey !== lastDateKey) {
        lastDateKey = dateKey;
        const separator = document.createElement('div');
        separator.className = 'chat-date-separator';
        separator.textContent = getChatDateSeparatorText(validDate);
        messagesScroll.appendChild(separator);
      }

      const wrapper = createMessageBubbleElement(msg, currentUserId, partnerId, secretKey);
      messagesScroll.appendChild(wrapper);
    });

    setTimeout(() => {
      if (messagesScroll) {
        messagesScroll.scrollTop = messagesScroll.scrollHeight;
      }
    }, 20);

    debouncedCreateIcons();
  }

  // Appends a single message smoothly without wiping the message viewport
  function appendSingleMessage(targetUserId, msg) {
    if (!msg || !targetUserId) return;
    const msgId = msg._id || msg.id;
    const convId = msg.conversationId || msg.conversation_id || dmState.conversationIdByUser.get(targetUserId);

    // Check if message is already stored in state
    let convList = dmState.messagesByConversation.get(targetUserId);
    if (!convList) {
      convList = [];
      dmState.messagesByConversation.set(targetUserId, convList);
    }
    const alreadyStored = convList.some(m => (m._id || m.id) === msgId);
    if (!alreadyStored) {
      convList.push(msg);
    }
    if (convId) {
      let byConvList = dmState.messagesByConversation.get(convId);
      if (!byConvList) {
        byConvList = [];
        dmState.messagesByConversation.set(convId, byConvList);
      }
      if (!byConvList.some(m => (m._id || m.id) === msgId)) {
        byConvList.push(msg);
      }
    }

    // Only update DOM if this conversation/partner is currently open
    const isCurrentlyOpen = (dmState.activePartnerId && dmState.activePartnerId.toString() === targetUserId.toString()) ||
                            (convId && dmState.activeConversationId && dmState.activeConversationId.toString() === convId.toString()) ||
                            (state.currentChatThread && state.currentChatThread.toString() === targetUserId.toString());
    if (!isCurrentlyOpen || !messagesScroll) return;

    // Deduplicate in DOM
    if (msgId && messagesScroll.querySelector(`[data-msg-id="${msgId}"]`)) {
      return;
    }

    console.debug('[DM-RUNTIME] renderSingleMessage:', msgId, Date.now());

    // Remove empty placeholder if present
    const emptyEl = messagesScroll.querySelector('.chat-empty-messages');
    if (emptyEl) emptyEl.remove();

    const currentUser = getCurrentUser();
    if (!currentUser) return;
    const currentUserId = (currentUser.id || currentUser._id || '').toString();
    const secretKey = getChatSecretKey(currentUserId, targetUserId);

    const wrapper = createMessageBubbleElement(msg, currentUserId, targetUserId, secretKey);
    messagesScroll.appendChild(wrapper);

    messagesScroll.scrollTop = messagesScroll.scrollHeight;
    debouncedCreateIcons();
  }

  async function markMessagesAsRead(targetUserId) {
    const token = getAuthToken();
    if (!token) return;

    // Optimistically update local state immediately
    const threadIndex = chatThreads.findIndex(t => t.user && (t.user._id === targetUserId || t.user.id === targetUserId));
    if (threadIndex !== -1 && chatThreads[threadIndex].unreadCount > 0) {
      chatThreads[threadIndex].unreadCount = 0;
      renderChatThreadsList();
    }

    try {
      await fetch(`${API_URL}/api/chats/${targetUserId}/read`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (err) {
      console.error('Error marking messages as read:', err);
    }
  }

  const backToInboxBtn = document.querySelector('.back-to-inbox-btn');
  if (backToInboxBtn) {
    backToInboxBtn.addEventListener('click', () => {
      const grid = document.querySelector('.chats-layout-grid');
      if (grid) grid.classList.remove('chatting');
      document.body.classList.remove('chat-active-mobile');
      // Clear active conversation state
      state.currentChatThread = null;
      dmState.activeConversationId = null;
      if (chatThreadsList) {
        chatThreadsList.querySelectorAll('.thread-item').forEach(t => t.classList.remove('active'));
      }
    });
  }

  // Chat message input and send
  const messageInput = document.getElementById('chat-message-input');
  const sendMsgBtn = document.getElementById('chat-send-msg-btn');

  let currentReplyToMessage = null;

  async function sendMessage() {
    if (pendingImageAttachment) {
      return sendImageMessage();
    }
    if (pendingVideoAttachment) {
      return sendVideoMessage();
    }
    const text = messageInput.value.trim();
    const targetUserId = state.currentChatThread;
    if (!text || !targetUserId) return;

    const currentUser = getCurrentUser();
    const token = getAuthToken();
    if (!currentUser || !token) return;

    const secretKey = getChatSecretKey(currentUser.id || currentUser._id, targetUserId);

    // Embed reply data into content payload if present
    let finalPayloadText = text;
    if (currentReplyToMessage) {
      finalPayloadText = JSON.stringify({
        text: text,
        replyTo: currentReplyToMessage
      });
    }

    const encryptedText = encryptMessage(finalPayloadText, secretKey);

    // Close emoji picker popover if open
    const emojiPopover = document.getElementById('chat-emoji-popover');
    if (emojiPopover) emojiPopover.classList.remove('active');

    // Clear reply state
    currentReplyToMessage = null;
    const replyContainer = document.getElementById('chat-reply-preview-container');
    if (replyContainer) replyContainer.style.display = 'none';

    messageInput.value = '';

    try {
      const res = await fetch(`${API_URL}/api/chats/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          recipient: targetUserId,
          content: encryptedText
        })
      });

      if (!res.ok) throw new Error('Failed to send message');
      const createdMsg = await res.json();

      // Append single sent message smoothly into active viewport (NO REFETCH / NO SKELETON / NO FLICKER)
      appendSingleMessage(targetUserId, createdMsg);

      // Update the thread item preview in sidebar in place
      updateThreadLastMessageInPlace(targetUserId, createdMsg);
    } catch (err) {
      console.error('Send error:', err);
      showToast('Failed to send message: ' + err.message);
    }
  }

  if (sendMsgBtn) {
    sendMsgBtn.addEventListener('click', sendMessage);
  }
  if (messageInput) {
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
      }
    });
  }
  // --- EMOJI PICKER & CAMERA INTERACTIVITY ---
  const smileBtn = document.getElementById('chat-smile-btn');
  const emojiPopover = document.getElementById('chat-emoji-popover');
  const emojiGrid = document.getElementById('emoji-picker-grid');
  const emojiSearchInput = emojiPopover?.querySelector('.emoji-picker-search');
  const emojiCategoryButtons = emojiPopover?.querySelectorAll('.emoji-category-btn');
  const chatCameraInput = document.getElementById('chat-camera-file-input');
  const chatImgPickerBtn = document.getElementById('chat-img-picker-btn');
  const cameraClickSim = document.getElementById('camera-click-sim');

  function renderEmojiGrid(category = 'All', search = '') {
    if (!emojiGrid) return;

    const normalized = search.trim().toLowerCase();
    const allEmojis = emojiLibrary[category] || emojiLibrary.All;
    const filtered = allEmojis.filter(emoji => {
      if (!normalized) return true;
      return emoji.toLowerCase().includes(normalized) || emoji.includes(search.trim());
    });

    emojiGrid.innerHTML = '';
    filtered.forEach(emoji => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-select-btn';
      btn.textContent = emoji;
      btn.setAttribute('title', emoji);
      emojiGrid.appendChild(btn);
    });
  }

  if (smileBtn && emojiPopover) {
    smileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      emojiPopover.classList.toggle('active');
      if (emojiPopover.classList.contains('active')) {
        renderEmojiGrid();
      }
    });
  }

  if (emojiCategoryButtons) {
    emojiCategoryButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const category = btn.getAttribute('data-emoji-category');
        emojiCategoryButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderEmojiGrid(category, emojiSearchInput?.value || '');
      });
    });
  }

  if (emojiSearchInput) {
    emojiSearchInput.addEventListener('input', () => {
      const activeCategory = emojiPopover.querySelector('.emoji-category-btn.active')?.getAttribute('data-emoji-category') || 'All';
      renderEmojiGrid(activeCategory, emojiSearchInput.value);
    });
  }

  // Handle emoji selection
  if (emojiPopover && messageInput) {
    emojiPopover.addEventListener('click', (e) => {
      const selectBtn = e.target.closest('.emoji-select-btn');
      if (selectBtn) {
        e.stopPropagation();
        const emoji = selectBtn.textContent.trim();
        const startPos = messageInput.selectionStart;
        const endPos = messageInput.selectionEnd;
        const textVal = messageInput.value;
        messageInput.value = textVal.substring(0, startPos) + emoji + textVal.substring(endPos);
        messageInput.focus();
        const newCursorPos = startPos + emoji.length;
        messageInput.setSelectionRange(newCursorPos, newCursorPos);
      }
    });
  }

  // Document listener to close emoji popover on click outside
  document.addEventListener('click', (e) => {
    if (emojiPopover && emojiPopover.classList.contains('active')) {
      if (!emojiPopover.contains(e.target) && (!smileBtn || !smileBtn.contains(e.target))) {
        emojiPopover.classList.remove('active');
      }
    }
  });

  // --- REAL DM SPATIAL CAMERA CAPTURE & VIDEO RECORDING LOGIC ---
  const cameraCaptureModal = document.getElementById('camera-capture-modal');
  const cameraModalCloseBtn = document.getElementById('camera-modal-close-btn');
  const dmCameraMirrorBtn = document.getElementById('dm-camera-mirror-btn');
  const dmCameraSwitchBtn = document.getElementById('dm-camera-switch-btn') || document.getElementById('dm-camera-flip-btn');
  const dmCameraVideo = document.getElementById('dm-camera-video');
  const dmCameraCanvas = document.getElementById('dm-camera-canvas');
  const dmCameraPreviewImg = document.getElementById('camera-preview-img');
  const dmCameraPreviewVideo = document.getElementById('dm-camera-preview-video');
  const cameraFallbackView = document.getElementById('camera-fallback-view');
  const fallbackUploadAction = document.getElementById('fallback-upload-action');
  const cameraCaptureAction = document.getElementById('camera-capture-action');
  const dmCameraRecordAction = document.getElementById('dm-camera-record-action');
  const dmModePhotoBtn = document.getElementById('dm-mode-photo-btn');
  const dmModeVideoBtn = document.getElementById('dm-mode-video-btn');
  const dmCameraModeBar = document.getElementById('dm-camera-mode-bar');
  const dmCameraRecordingBadge = document.getElementById('dm-camera-recording-badge');
  const dmCameraRecordTimer = document.getElementById('dm-camera-record-timer');
  const cameraPreviewControls = document.getElementById('camera-preview-controls');
  const cameraRetakeBtn = document.getElementById('camera-retake-btn');
  const cameraSendBtn = document.getElementById('camera-send-btn');

  let dmCameraStream = null;
  let dmCurrentFacingMode = 'user'; // 'user' | 'environment'
  let dmIsMirrored = true; // Preview only mirror toggle (independent of hardware camera)
  let dmCurrentMode = 'photo'; // 'photo' | 'video'
  let currentCameraContext = 'dm'; // 'dm' | 'story'
  let dmTempCapturedImage = null;
  let dmTempRecordedBlob = null;
  let dmTempRecordedUrl = null;
  let dmMediaRecorder = null;
  let dmRecordedChunks = [];
  let dmIsRecording = false;
  let dmRecordTimerInterval = null;
  let dmRecordSeconds = 0;

  function updateCameraSendButtonState() {
    if (!cameraSendBtn) return;
    if (currentCameraContext === 'story' || currentCameraContext === 'hubbs') {
      if (dmCurrentMode === 'video' || dmTempRecordedBlob) {
        cameraSendBtn.innerHTML = '<i data-lucide="check"></i> Use This Video';
      } else {
        cameraSendBtn.innerHTML = '<i data-lucide="check"></i> Use This Photo';
      }
    } else {
      cameraSendBtn.innerHTML = '<i data-lucide="send"></i> Send';
    }
    if (window.lucide) window.lucide.createIcons();
  }

  function applyDMMirrorState() {
    if (dmCameraVideo) {
      if (dmIsMirrored) {
        dmCameraVideo.classList.add('mirrored');
      } else {
        dmCameraVideo.classList.remove('mirrored');
      }
    }
    if (dmCameraMirrorBtn) {
      dmCameraMirrorBtn.classList.toggle('active', dmIsMirrored);
      dmCameraMirrorBtn.setAttribute('title', dmIsMirrored ? 'Mirror Preview: ON (Click to disable)' : 'Mirror Preview: OFF (Click to enable)');
    }
  }

  function setCameraHeaderControlsDisabled(disabled) {
    if (dmCameraMirrorBtn) dmCameraMirrorBtn.classList.toggle('disabled', disabled);
    if (dmCameraSwitchBtn) dmCameraSwitchBtn.classList.toggle('disabled', disabled);
  }

  async function startDMCameraStream() {
    if (dmCameraStream) {
      try {
        dmCameraStream.getTracks().forEach(t => t.stop());
      } catch (e) { }
      dmCameraStream = null;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (dmCameraVideo) dmCameraVideo.style.display = 'none';
      if (cameraFallbackView) cameraFallbackView.style.display = 'flex';
      if (cameraCaptureAction) cameraCaptureAction.classList.add('disabled');
      if (dmCameraRecordAction) dmCameraRecordAction.classList.add('disabled');
      return;
    }

    const videoConstraints = {
      facingMode: { ideal: dmCurrentFacingMode },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    };

    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: true
        });
      } catch (audioErr) {
        console.warn('Audio capture not available, falling back to video only:', audioErr);
        stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false
        });
      }

      dmCameraStream = stream;
      if (dmCameraVideo) {
        dmCameraVideo.srcObject = stream;
        dmCameraVideo.muted = true; // keep live preview quiet to prevent feedback loop
        dmCameraVideo.playsInline = true;
        dmCameraVideo.autoplay = true;

        applyDMMirrorState();

        dmCameraVideo.style.display = 'block';
        dmCameraVideo.onloadedmetadata = () => {
          dmCameraVideo.play().catch(e => console.warn('Camera video play caught:', e));
        };
        dmCameraVideo.play().catch(e => console.warn('Camera video play:', e));
      }

      if (dmCameraSwitchBtn) {
        dmCameraSwitchBtn.classList.toggle('active', dmCurrentFacingMode === 'environment');
        dmCameraSwitchBtn.setAttribute('title', dmCurrentFacingMode === 'user' ? 'Switch to Rear Camera' : 'Switch to Front Camera');
      }

      if (cameraFallbackView) cameraFallbackView.style.display = 'none';
      if (cameraCaptureAction) cameraCaptureAction.classList.remove('disabled');
      if (dmCameraRecordAction) dmCameraRecordAction.classList.remove('disabled');
    } catch (err) {
      console.warn('Webcam stream error:', err);
      if (dmCameraVideo) dmCameraVideo.style.display = 'none';
      if (cameraFallbackView) cameraFallbackView.style.display = 'flex';
      if (cameraCaptureAction) cameraCaptureAction.classList.add('disabled');
      if (dmCameraRecordAction) dmCameraRecordAction.classList.add('disabled');
    }
  }

  async function switchDMCamera() {
    if (dmIsRecording) return;

    // Check available devices gracefully
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        if (videoDevices.length <= 1 && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
          console.info('Single video device detected on desktop, attempting facingMode toggle gracefully.');
        }
      }
    } catch (e) {
      console.warn('Device check:', e);
    }

    dmCurrentFacingMode = (dmCurrentFacingMode === 'user') ? 'environment' : 'user';

    // Front camera defaults to mirrored ON; Rear camera defaults to mirrored OFF
    if (dmCurrentFacingMode === 'environment') {
      dmIsMirrored = false;
    } else {
      dmIsMirrored = true;
    }

    await startDMCameraStream();
    if (window.lucide) window.lucide.createIcons();
  }

  function toggleDMMirror() {
    if (dmIsRecording) return;
    dmIsMirrored = !dmIsMirrored;
    applyDMMirrorState();
  }

  function setDMCameraMode(mode) {
    if (dmIsRecording) return;
    dmCurrentMode = mode;

    if (mode === 'photo') {
      if (dmModePhotoBtn) dmModePhotoBtn.classList.add('active');
      if (dmModeVideoBtn) dmModeVideoBtn.classList.remove('active');
      if (cameraCaptureAction) cameraCaptureAction.style.display = 'flex';
      if (dmCameraRecordAction) dmCameraRecordAction.style.display = 'none';
    } else {
      if (dmModeVideoBtn) dmModeVideoBtn.classList.add('active');
      if (dmModePhotoBtn) dmModePhotoBtn.classList.remove('active');
      if (cameraCaptureAction) cameraCaptureAction.style.display = 'none';
      if (dmCameraRecordAction) dmCameraRecordAction.style.display = 'flex';
      if (dmCameraStream && dmCameraStream.getAudioTracks().length === 0) {
        startDMCameraStream();
      }
    }
  }

  function resetDMCameraUI() {
    dmTempCapturedImage = null;
    if (dmTempRecordedUrl) {
      try { URL.revokeObjectURL(dmTempRecordedUrl); } catch (e) { }
      dmTempRecordedUrl = null;
    }
    dmTempRecordedBlob = null;
    dmRecordedChunks = [];
    dmIsRecording = false;

    if (dmRecordTimerInterval) {
      clearInterval(dmRecordTimerInterval);
      dmRecordTimerInterval = null;
    }
    dmRecordSeconds = 0;

    setCameraHeaderControlsDisabled(false);

    if (dmCameraPreviewImg) {
      dmCameraPreviewImg.style.display = 'none';
      dmCameraPreviewImg.src = '';
    }
    if (dmCameraPreviewVideo) {
      dmCameraPreviewVideo.pause();
      dmCameraPreviewVideo.style.display = 'none';
      dmCameraPreviewVideo.src = '';
    }
    if (dmCameraRecordingBadge) {
      dmCameraRecordingBadge.style.display = 'none';
    }
    if (dmCameraRecordAction) {
      dmCameraRecordAction.classList.remove('recording');
    }

    if (dmCameraVideo) {
      dmCameraVideo.style.display = 'block';
      try { dmCameraVideo.play(); } catch (e) { }
    }

    if (dmCameraModeBar) dmCameraModeBar.style.display = 'flex';
    if (cameraPreviewControls) cameraPreviewControls.style.display = 'none';

    setDMCameraMode(dmCurrentMode);
    applyDMMirrorState();
    if (window.lucide) window.lucide.createIcons();
  }

  function openCameraCapture(context = 'dm') {
    if (!cameraCaptureModal) return;
    currentCameraContext = context;

    const container = cameraCaptureModal.querySelector('.camera-modal-container');
    const titleSpan = document.querySelector('#camera-modal-title span');

    if (currentCameraContext === 'story' || currentCameraContext === 'hubbs') {
      if (container) {
        container.classList.add('story-mode');
        container.classList.add('hubbs-mode');
      }
      if (titleSpan) titleSpan.textContent = 'HUBBS Camera';
    } else {
      if (container) {
        container.classList.remove('story-mode');
        container.classList.remove('hubbs-mode');
      }
      if (titleSpan) titleSpan.textContent = 'Spatial Camera';
    }

    cameraCaptureModal.classList.add('active');
    dmCurrentFacingMode = 'user';
    dmIsMirrored = true;
    resetDMCameraUI();
    startDMCameraStream();
    if (window.lucide) window.lucide.createIcons();
  }
  window.openCameraCapture = openCameraCapture;

  function closeCameraCapture() {
    if (!cameraCaptureModal) return;
    cameraCaptureModal.classList.remove('active');

    const container = cameraCaptureModal.querySelector('.camera-modal-container');
    if (container) {
      container.classList.remove('story-mode');
      container.classList.remove('hubbs-mode');
    }

    if (dmIsRecording && dmMediaRecorder) {
      try { dmMediaRecorder.stop(); } catch (e) { }
    }

    if (dmCameraStream) {
      try {
        dmCameraStream.getTracks().forEach(track => track.stop());
      } catch (e) { }
      dmCameraStream = null;
    }

    if (dmCameraVideo) {
      dmCameraVideo.srcObject = null;
    }

    dmCurrentFacingMode = 'user';
    dmIsMirrored = true;
    currentCameraContext = 'dm';
    resetDMCameraUI();
  }

  if (dmCameraMirrorBtn) {
    dmCameraMirrorBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleDMMirror();
    });
  }

  if (dmCameraSwitchBtn) {
    dmCameraSwitchBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      switchDMCamera();
    });
  }

  if (dmModePhotoBtn) {
    dmModePhotoBtn.addEventListener('click', () => setDMCameraMode('photo'));
  }
  if (dmModeVideoBtn) {
    dmModeVideoBtn.addEventListener('click', () => setDMCameraMode('video'));
  }

  if (cameraCaptureAction) {
    cameraCaptureAction.addEventListener('click', async () => {
      if (!dmCameraStream || !dmCameraVideo || !dmCameraCanvas) return;

      const width = dmCameraVideo.videoWidth || 640;
      const height = dmCameraVideo.videoHeight || 480;

      dmCameraCanvas.width = width;
      dmCameraCanvas.height = height;

      const ctx = dmCameraCanvas.getContext('2d');
      if (ctx) {
        ctx.save();
        if (dmIsMirrored) {
          ctx.translate(width, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(dmCameraVideo, 0, 0, width, height);
        ctx.restore();

        try {
          dmTempCapturedImage = dmCameraCanvas.toDataURL('image/jpeg', 0.92);

          dmCameraVideo.style.display = 'none';
          if (dmCameraPreviewImg) {
            dmCameraPreviewImg.src = dmTempCapturedImage;
            dmCameraPreviewImg.style.display = 'block';
          }

          if (dmCameraModeBar) dmCameraModeBar.style.display = 'none';
          cameraCaptureAction.style.display = 'none';
          if (dmCameraRecordAction) dmCameraRecordAction.style.display = 'none';
          if (cameraPreviewControls) cameraPreviewControls.style.display = 'flex';
          updateCameraSendButtonState();
          if (window.lucide) window.lucide.createIcons();
        } catch (err) {
          console.error('Error capturing image from canvas:', err);
          showToast('Failed to capture photo from camera feed.');
        }
      }
    });
  }

  function formatRecordTime(totalSeconds) {
    const mins = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const secs = (totalSeconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  }

  async function startVideoRecording() {
    if (!dmCameraStream) {
      await startDMCameraStream();
    }
    if (!dmCameraStream) return;

    // Ensure audio track is present for recorded stream
    if (dmCameraStream.getAudioTracks().length === 0) {
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioStream.getAudioTracks().forEach(t => dmCameraStream.addTrack(t));
      } catch (e) {
        console.warn('Could not attach microphone audio track to stream:', e);
      }
    }

    dmRecordedChunks = [];
    dmIsRecording = true;
    dmRecordSeconds = 0;
    setCameraHeaderControlsDisabled(true);

    let chosenMime = '';
    if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
      const candidates = [
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=h264,opus',
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4',
        'video/webm'
      ];
      for (const c of candidates) {
        if (MediaRecorder.isTypeSupported(c)) {
          chosenMime = c;
          break;
        }
      }
    }

    let options = chosenMime ? { mimeType: chosenMime } : {};

    try {
      dmMediaRecorder = new MediaRecorder(dmCameraStream, options);
    } catch (e) {
      try {
        dmMediaRecorder = new MediaRecorder(dmCameraStream);
      } catch (err) {
        console.error('MediaRecorder initialization failed:', err);
        showToast('Video recording is not supported on this browser.');
        dmIsRecording = false;
        return;
      }
    }

    dmMediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        dmRecordedChunks.push(event.data);
      }
    };

    dmMediaRecorder.onstop = () => {
      finishVideoRecording();
    };

    dmMediaRecorder.start(250);

    if (dmCameraRecordAction) dmCameraRecordAction.classList.add('recording');
    if (dmCameraRecordingBadge) {
      dmCameraRecordingBadge.style.display = 'flex';
      if (dmCameraRecordTimer) dmCameraRecordTimer.textContent = '00:00';
    }

    dmRecordTimerInterval = setInterval(() => {
      dmRecordSeconds++;
      if (dmCameraRecordTimer) dmCameraRecordTimer.textContent = formatRecordTime(dmRecordSeconds);
      if (dmRecordSeconds >= 60) {
        stopVideoRecording();
      }
    }, 1000);
  }

  function stopVideoRecording() {
    if (!dmIsRecording || !dmMediaRecorder) return;
    dmIsRecording = false;
    setCameraHeaderControlsDisabled(false);
    if (dmRecordTimerInterval) {
      clearInterval(dmRecordTimerInterval);
      dmRecordTimerInterval = null;
    }
    if (dmCameraRecordingBadge) dmCameraRecordingBadge.style.display = 'none';
    if (dmCameraRecordAction) dmCameraRecordAction.classList.remove('recording');

    if (dmMediaRecorder.state !== 'inactive') {
      try { dmMediaRecorder.stop(); } catch (e) { }
    }
  }

  function finishVideoRecording() {
    const mimeType = (dmMediaRecorder && dmMediaRecorder.mimeType) ? dmMediaRecorder.mimeType : 'video/webm';
    dmTempRecordedBlob = new Blob(dmRecordedChunks, { type: mimeType });
    if (dmTempRecordedUrl) {
      try { URL.revokeObjectURL(dmTempRecordedUrl); } catch (e) { }
    }
    dmTempRecordedUrl = URL.createObjectURL(dmTempRecordedBlob);

    if (dmCameraVideo) dmCameraVideo.style.display = 'none';
    if (dmCameraPreviewVideo) {
      dmCameraPreviewVideo.src = dmTempRecordedUrl;
      dmCameraPreviewVideo.muted = false; // allow user to preview recorded sound
      dmCameraPreviewVideo.style.display = 'block';
      dmCameraPreviewVideo.load();
      dmCameraPreviewVideo.play().catch(e => console.warn('Preview play caught:', e));
    }

    if (dmCameraModeBar) dmCameraModeBar.style.display = 'none';
    if (dmCameraRecordAction) dmCameraRecordAction.style.display = 'none';
    if (cameraCaptureAction) cameraCaptureAction.style.display = 'none';
    if (cameraPreviewControls) cameraPreviewControls.style.display = 'flex';
    updateCameraSendButtonState();
    if (window.lucide) window.lucide.createIcons();
  }

  if (dmCameraRecordAction) {
    dmCameraRecordAction.addEventListener('click', () => {
      if (!dmIsRecording) {
        startVideoRecording();
      } else {
        stopVideoRecording();
      }
    });
  }

  if (cameraRetakeBtn) {
    cameraRetakeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      resetDMCameraUI();
    });
  }

  if (cameraSendBtn) {
    cameraSendBtn.addEventListener('click', async (e) => {
      e.preventDefault();

      if (currentCameraContext === 'story' || currentCameraContext === 'hubbs') {
        if (dmTempCapturedImage) {
          try {
            const res = await fetch(dmTempCapturedImage);
            const blob = await res.blob();
            const file = new File([blob], `hubbs_photo_${Date.now()}.jpg`, { type: 'image/jpeg' });
            if (typeof window.handleCreateHubbsFiles === 'function') {
              await window.handleCreateHubbsFiles([file]);
            }
            showToast('Photo added to HUBBS! 📸');
          } catch (err) {
            console.error('Error attaching captured photo to HUBBS:', err);
            showToast('Failed to add captured photo.');
          }
        } else if (dmTempRecordedBlob) {
          try {
            const rawMime = dmTempRecordedBlob.type || (dmMediaRecorder && dmMediaRecorder.mimeType) || 'video/webm';
            const cleanMime = rawMime.split(';')[0].trim().toLowerCase();
            const ext = cleanMime.includes('mp4') ? 'mp4' : 'webm';
            const file = new File([dmTempRecordedBlob], `hubbs_video_${Date.now()}.${ext}`, { type: cleanMime });
            if (typeof window.handleCreateHubbsFiles === 'function') {
              await window.handleCreateHubbsFiles([file]);
            }
            showToast('Video added to HUBBS! 🎥');
          } catch (err) {
            console.error('Error attaching recorded video to HUBBS:', err);
            showToast('Failed to add recorded video.');
          }
        }
        closeCameraCapture();
        return;
      }

      const targetUserId = state.currentChatThread;
      const currentUser = getCurrentUser();
      const token = getAuthToken();

      if (!targetUserId || !currentUser || !token) {
        showToast('Please select a conversation first.');
        closeCameraCapture();
        return;
      }

      if (dmTempCapturedImage) {
        try {
          const res = await fetch(`${API_URL}/api/chats/message`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              recipient: targetUserId,
              content: '',
              mediaUrl: dmTempCapturedImage,
              mediaType: 'image',
              mediaName: `Photo_${Date.now()}.jpg`,
              mediaSize: Math.round(dmTempCapturedImage.length * 0.75)
            })
          });

          if (res.ok) {
            const createdMsg = await res.json();
            appendSingleMessage(targetUserId, createdMsg);
            updateThreadLastMessageInPlace(targetUserId, createdMsg);
            showToast('Photo sent! 📷');
          } else {
            await fetchMessages(targetUserId, true);
            loadChatThreads();
          }
        } catch (err) {
          console.error('Photo send error:', err);
          showToast('Failed to send photo.');
        }
      } else if (dmTempRecordedBlob) {
        try {
          const rawMime = dmTempRecordedBlob.type || (dmMediaRecorder && dmMediaRecorder.mimeType) || 'video/webm';
          const cleanMime = rawMime.split(';')[0].trim().toLowerCase();
          const ext = cleanMime.includes('mp4') ? 'mp4' : 'webm';
          const fileName = `Video_${Date.now()}.${ext}`;
          const videoFile = new File([dmTempRecordedBlob], fileName, { type: cleanMime });

          const reader = new FileReader();
          reader.onload = async function (evt) {
            const videoDataUrl = evt.target.result;
            const res = await fetch(`${API_URL}/api/chats/message`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({
                recipient: targetUserId,
                content: '',
                mediaUrl: videoDataUrl,
                mediaType: 'video',
                mediaName: fileName,
                mediaSize: videoFile.size,
                mimeType: cleanMime,
                durationSeconds: dmRecordSeconds || 0
              })
            });

            if (res.ok) {
              const createdMsg = await res.json();
              appendSingleMessage(targetUserId, createdMsg);
              updateThreadLastMessageInPlace(targetUserId, createdMsg);
              showToast('Video sent! 🎥');
            } else {
              await fetchMessages(targetUserId, true);
              loadChatThreads();
            }
          };
          reader.readAsDataURL(videoFile);
        } catch (err) {
          console.error('Video send error:', err);
          showToast('Failed to send video.');
        }
      }

      closeCameraCapture();
    });
  }

  // Bind DM camera triggers to open the capture modal
  if (chatImgPickerBtn) {
    chatImgPickerBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openCameraCapture('dm');
    });
  }

  if (cameraClickSim) {
    cameraClickSim.addEventListener('click', (e) => {
      e.preventDefault();
      openCameraCapture('dm');
    });
  }

  if (cameraModalCloseBtn) {
    cameraModalCloseBtn.addEventListener('click', closeCameraCapture);
  }

  // Close modal on click outside modal container
  if (cameraCaptureModal) {
    cameraCaptureModal.addEventListener('click', (e) => {
      if (e.target === cameraCaptureModal) {
        closeCameraCapture();
      }
    });
  }

  // Fallback upload action triggers hidden file selector
  if (fallbackUploadAction) {
    fallbackUploadAction.addEventListener('click', () => {
      if (currentCameraContext === 'story' || currentCameraContext === 'hubbs') {
        const fileInput = document.getElementById('ch-hidden-file-input');
        if (fileInput) fileInput.click();
      } else if (chatCameraInput) {
        chatCameraInput.click();
      }
      closeCameraCapture();
    });
  }

  // Modify file selector change event to also close camera modal if open
  if (chatCameraInput) {
    chatCameraInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async function (evt) {
        const mediaDataUrl = evt.target.result;
        const targetUserId = state.currentChatThread;
        const currentUser = getCurrentUser();
        const token = getAuthToken();

        if (targetUserId && currentUser && token) {
          try {
            const isVideo = file.type.startsWith('video/');
            const isAudio = file.type.startsWith('audio/');
            const mediaType = isVideo ? 'video' : (isAudio ? 'audio' : 'image');

            const res = await fetch(`${API_URL}/api/chats/message`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({
                recipient: targetUserId,
                content: '',
                mediaUrl: mediaDataUrl,
                mediaType: mediaType,
                mediaName: file.name,
                mediaSize: file.size
              })
            });

            if (res.ok) {
              const createdMsg = await res.json();
              appendSingleMessage(targetUserId, createdMsg);
              updateThreadLastMessageInPlace(targetUserId, createdMsg);
            } else {
              await fetchMessages(targetUserId, true);
              loadChatThreads();
            }
          } catch (err) {
            console.error('File send error:', err);
            showToast('Failed to send file.');
          }
        }

        closeCameraCapture();
      };
      reader.readAsDataURL(file);
      // Clear value so the same file can be chosen again
      chatCameraInput.value = '';
    });
  }



  // --- INBOX SIDEBAR CONTROLS (INTERACTIVITY) ---
  const inboxSearchInput = document.getElementById('inbox-search-input');
  const hubberSearchDropdown = document.getElementById('hubber-search-dropdown');
  let followingHubbersCache = null;

  async function fetchFollowingHubbers() {
    if (followingHubbersCache) return followingHubbersCache;
    const token = localStorage.getItem('invibe_jwt_token');
    if (!token) return [];
    try {
      const currentUser = getCurrentUser();
      const userId = currentUser ? (currentUser.id || currentUser._id) : 'me';
      const res = await fetch(`${API_URL}/api/users/${userId}/following-list`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        followingHubbersCache = await res.json();
        return followingHubbersCache;
      }
    } catch (err) {
      console.error(err);
    }
    return [];
  }

  function renderHubberDropdown(users) {
    if (!hubberSearchDropdown) return;
    hubberSearchDropdown.innerHTML = '';
    if (!users || users.length === 0) {
      hubberSearchDropdown.innerHTML = '<div class="hubber-dropdown-empty">No Hubbers found</div>';
      hubberSearchDropdown.classList.add('active');
      return;
    }

    users.forEach(u => {
      const item = document.createElement('div');
      item.className = 'hubber-dropdown-item';
      item.innerHTML = `
        <img src="${u.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80'}" class="hubber-dropdown-avatar" />
        <div class="hubber-dropdown-info">
          <div class="hubber-dropdown-name">${u.fullName || u.username}</div>
          <div class="hubber-dropdown-username">@${u.username}</div>
        </div>
      `;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevent input blur so we can click
        hubberSearchDropdown.classList.remove('active');
        inboxSearchInput.value = '';
        selectConversation(u);
      });
      hubberSearchDropdown.appendChild(item);
    });
    hubberSearchDropdown.classList.add('active');
  }

  if (inboxSearchInput) {
    inboxSearchInput.addEventListener('focus', async () => {
      const users = await fetchFollowingHubbers();
      const query = inboxSearchInput.value.trim().toLowerCase();
      if (!query) {
        if (users.length === 0) {
          if (hubberSearchDropdown) {
            hubberSearchDropdown.innerHTML = '<div class="hubber-dropdown-empty">You\'re not following anyone yet.</div>';
            hubberSearchDropdown.classList.add('active');
          }
        } else {
          renderHubberDropdown(users);
        }
      } else {
        const filtered = users.filter(u => (u.fullName || '').toLowerCase().includes(query) || (u.username || '').toLowerCase().includes(query));
        renderHubberDropdown(filtered);
      }
    });

    inboxSearchInput.addEventListener('blur', () => {
      if (hubberSearchDropdown) hubberSearchDropdown.classList.remove('active');
    });

    inboxSearchInput.addEventListener('input', async () => {
      // Update Dropdown
      const users = await fetchFollowingHubbers();
      const query = inboxSearchInput.value.trim().toLowerCase();

      if (!query) {
        if (users.length === 0) {
          if (hubberSearchDropdown) {
            hubberSearchDropdown.innerHTML = '<div class="hubber-dropdown-empty">You\'re not following anyone yet.</div>';
            hubberSearchDropdown.classList.add('active');
          }
        } else {
          renderHubberDropdown(users);
        }
      } else {
        const filtered = users.filter(u => (u.fullName || '').toLowerCase().includes(query) || (u.username || '').toLowerCase().includes(query));
        renderHubberDropdown(filtered);
      }

      // Existing behavior for chatThreadsList
      lastRenderedThreadsFingerprint = ''; // Ensure search results render without cache blocking
      const rawQuery = inboxSearchInput.value.trim();
      if (!rawQuery) {
        loadChatThreads();
        return;
      }

      const token = localStorage.getItem('invibe_jwt_token');
      if (!token) return;

      try {
        const res = await fetch(`${API_URL}/api/users/search?q=${encodeURIComponent(rawQuery)}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Search failed');
        const apiUsers = await res.json();

        chatThreads = apiUsers.map(u => ({
          user: u,
          lastMessage: null,
          unreadCount: 0
        }));

        renderChatThreadsList();
      } catch (err) {
        console.error('Inbox search error:', err);
      }
    });
  }

  const catPills = document.querySelectorAll('.cat-pill');
  catPills.forEach(pill => {
    pill.addEventListener('click', () => {
      catPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const category = pill.getAttribute('data-cat');

      const items = document.querySelectorAll('.thread-item');
      items.forEach(item => {
        item.style.display = 'flex';
      });
      showToast(`Filtered inbox: ${category.toUpperCase()}`);
    });
  });


  // --- SWITCH CHAT SUB-VIEW MODES ---
  const modeTabs = document.querySelectorAll('.mode-tab');
  const chatSubPanels = document.querySelectorAll('.chat-sub-panel');
  const chatGlobalFooter = document.getElementById('chat-global-footer');

  window.switchChatModeGlobal = (mode) => {
    switchChatMode(mode);
  };

  window.selectConversationGlobal = (targetUserId) => {
    selectConversation(targetUserId);
  };

  function switchChatMode(modeName) {
    state.chatMode = modeName;

    modeTabs.forEach(tab => {
      const mode = tab.getAttribute('data-chat-mode');
      if (mode === modeName) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });

    chatSubPanels.forEach(panel => {
      const targetId = (modeName === 'voice-call') ? 'chat-sub-view-call' : `chat-sub-view-${modeName}`;
      if (panel.id === targetId) {
        panel.classList.add('active');
      } else {
        panel.classList.remove('active');
      }
    });

    if (modeName === 'call' || modeName === 'voice-call') {
      if (chatGlobalFooter) chatGlobalFooter.style.display = 'none';
      if (state.currentChatThread) {
        const thread = chatThreads.find(t => t.user && (getUserIdentifier(t.user) === state.currentChatThread.toString()));
        const user = thread ? thread.user : null;
        const recipientName = user ? (user.fullName || user.username) : 'User';
        const recipientAvatar = user ? user.profileImage : '';
        const conversationId = dmState.conversationIdByUser.get(state.currentChatThread);

        if (modeName === 'voice-call') {
          initiateAudioCall(state.currentChatThread, conversationId, recipientName, recipientAvatar);
        } else {
          initiateVideoCall(state.currentChatThread, conversationId, recipientName, recipientAvatar);
        }
      }
    } else {
      if (chatGlobalFooter) chatGlobalFooter.style.display = 'flex';
      if (window.audioState && window.audioState.isCallActive) {
        try { endAudioCall(); } catch (_) { }
      }
      if (window.videoState && window.videoState.isCallActive) {
        try { endVideoCall(); } catch (_) { }
      }
      const watchVideo = document.getElementById('watch-together-video');
      if (watchVideo && modeName !== 'watch') {
        watchVideo.pause();
      }
    }
    if (modeName === 'media') {
      loadSharedMediaHub();
    }
    showToast(`Switched Chat layout: ${modeName.toUpperCase()} ⚡`);
  }

  modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.getAttribute('data-chat-mode');
      if (mode) switchChatMode(mode);
    });
  });


  // --- PHASE 3A: IMAGE ATTACHMENT SYSTEM ---
  const chatImageInput = document.getElementById('chat-image-file-input');
  const chatImagePreviewContainer = document.getElementById('chat-image-preview-container');
  const chatImagePreviewImg = document.getElementById('chat-image-preview-img');
  const chatImagePreviewName = document.getElementById('chat-image-preview-name');
  const chatImagePreviewSize = document.getElementById('chat-image-preview-size');
  const chatImagePreviewCancel = document.getElementById('chat-image-preview-cancel');
  const chatImagePreviewSend = document.getElementById('chat-image-preview-send');

  const attachmentBtnPicker = document.getElementById('attachment-btn-picker');
  const galleryPickerBtn = document.getElementById('chat-gallery-picker-btn');

  let pendingImageAttachment = null;
  let isSendingImage = false;

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function clearPendingImage() {
    pendingImageAttachment = null;
    if (chatImagePreviewContainer) chatImagePreviewContainer.style.display = 'none';
    if (chatImagePreviewImg) chatImagePreviewImg.src = '';
    if (chatImageInput) chatImageInput.value = '';
    const attachmentsDrawer = document.getElementById('chat-attachments-drawer');
    if (attachmentsDrawer) attachmentsDrawer.classList.remove('active');
  }

  function handleImageFileSelection(file) {
    if (!file) return;

    // If a video file reaches image selection, delegate to video handler
    if (file.type.startsWith('video/') || /\.(mp4|webm|ogg|mov|m4v)$/i.test(file.name)) {
      return handleVideoFileSelection(file);
    }

    // 1. Validate MIME type
    const validMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const isImageMime = validMimes.includes(file.type) || file.type.startsWith('image/');
    if (!isImageMime) {
      showToast('Please select a valid image (JPEG, PNG, WEBP, GIF).');
      if (chatImageInput) chatImageInput.value = '';
      return;
    }

    // 2. Validate Extension
    const extMatch = file.name.match(/\.([0-9a-z]+)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : '';
    const validExts = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
    if (!validExts.includes(ext)) {
      showToast('Unsupported image format. Allowed: JPG, PNG, WEBP, GIF.');
      if (chatImageInput) chatImageInput.value = '';
      return;
    }

    // 3. Validate Size (Max 15MB)
    const maxSizeBytes = 15 * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      showToast('Image is too large. Maximum size allowed is 15MB.');
      if (chatImageInput) chatImageInput.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = function (evt) {
      const dataUrl = evt.target.result;
      pendingImageAttachment = {
        file,
        dataUrl,
        name: file.name,
        size: file.size,
        mimeType: file.type
      };

      if (chatImagePreviewImg) chatImagePreviewImg.src = dataUrl;
      if (chatImagePreviewName) chatImagePreviewName.textContent = file.name;
      if (chatImagePreviewSize) chatImagePreviewSize.textContent = formatFileSize(file.size);
      if (chatImagePreviewContainer) chatImagePreviewContainer.style.display = 'flex';

      // Close drawer if open
      const attachmentsDrawer = document.getElementById('chat-attachments-drawer');
      if (attachmentsDrawer) attachmentsDrawer.classList.remove('active');

      debouncedCreateIcons();
    };
    reader.readAsDataURL(file);
  }

  async function sendImageMessage() {
    if (!pendingImageAttachment || isSendingImage) return;

    const targetUserId = state.currentChatThread;
    const currentUser = getCurrentUser();
    const token = getAuthToken();

    if (!targetUserId || !currentUser || !token) {
      showToast('Please select a conversation to send the image.');
      return;
    }

    isSendingImage = true;
    if (chatImagePreviewSend) {
      chatImagePreviewSend.disabled = true;
      chatImagePreviewSend.innerHTML = '<i data-lucide="loader" class="spin"></i> Sending...';
    }

    try {
      const res = await fetch(`${API_URL}/api/chats/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          recipient: targetUserId,
          content: '',
          mediaUrl: pendingImageAttachment.dataUrl,
          mediaType: 'image',
          mediaName: pendingImageAttachment.name,
          mediaSize: pendingImageAttachment.size
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to send image.');
      }

      const createdMsg = await res.json();

      // Append sent image smoothly into active conversation viewport (Right-aligned)
      appendSingleMessage(targetUserId, createdMsg);

      // Update sidebar thread preview in-place
      updateThreadLastMessageInPlace(targetUserId, createdMsg);

      clearPendingImage();
      showToast('Image sent! 📷');
    } catch (err) {
      console.error('Image send error:', err);
      showToast('Image upload failed.');
    } finally {
      isSendingImage = false;
      if (chatImagePreviewSend) {
        chatImagePreviewSend.disabled = false;
        chatImagePreviewSend.innerHTML = '<i data-lucide="send" style="width: 14px; height: 14px;"></i> Send';
      }
      debouncedCreateIcons();
    }
  }

  if (attachmentBtnPicker && chatImageInput) {
    attachmentBtnPicker.addEventListener('click', () => {
      chatImageInput.click();
    });
  }

  if (galleryPickerBtn && chatImageInput) {
    galleryPickerBtn.addEventListener('click', () => {
      chatImageInput.click();
    });
  }

  if (chatImagePreviewCancel) {
    chatImagePreviewCancel.addEventListener('click', clearPendingImage);
  }

  if (chatImagePreviewSend) {
    chatImagePreviewSend.addEventListener('click', sendImageMessage);
  }

  // --- PHASE 3B: VIDEO ATTACHMENT SYSTEM ---
  const chatVideoInput = document.getElementById('chat-video-file-input');
  const chatVideoPreviewContainer = document.getElementById('chat-video-preview-container');
  const chatVideoPreviewElement = document.getElementById('chat-video-preview-element');
  const chatVideoPreviewName = document.getElementById('chat-video-preview-name');
  const chatVideoPreviewSize = document.getElementById('chat-video-preview-size');
  const chatVideoPreviewDuration = document.getElementById('chat-video-preview-duration');
  const chatVideoPreviewCancel = document.getElementById('chat-video-preview-cancel');
  const chatVideoPreviewSend = document.getElementById('chat-video-preview-send');

  let pendingVideoAttachment = null;
  let isSendingVideo = false;
  let videoBlobUrl = null;

  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds) || !isFinite(seconds)) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function clearPendingVideo() {
    pendingVideoAttachment = null;
    if (chatVideoPreviewContainer) chatVideoPreviewContainer.style.display = 'none';
    if (chatVideoPreviewElement) {
      chatVideoPreviewElement.pause();
      chatVideoPreviewElement.src = '';
      chatVideoPreviewElement.load();
    }
    if (videoBlobUrl) {
      URL.revokeObjectURL(videoBlobUrl);
      videoBlobUrl = null;
    }
    if (chatVideoInput) chatVideoInput.value = '';
    const attachmentsDrawer = document.getElementById('chat-attachments-drawer');
    if (attachmentsDrawer) attachmentsDrawer.classList.remove('active');
  }

  function handleVideoFileSelection(file) {
    if (!file) return;

    // 1. Validate MIME type
    const validVideoMimes = ['video/mp4', 'video/webm', 'video/ogg'];
    const isVideoMime = validVideoMimes.includes(file.type) || file.type.startsWith('video/');
    if (!isVideoMime) {
      showToast('Please select a valid video (MP4, WebM, OGG).');
      if (chatVideoInput) chatVideoInput.value = '';
      return;
    }

    // 2. Validate Extension
    const extMatch = file.name.match(/\.([0-9a-z]+)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : '';
    const validVideoExts = ['mp4', 'webm', 'ogg', 'mov', 'm4v'];
    if (!validVideoExts.includes(ext)) {
      showToast('Unsupported video format. Allowed: MP4, WebM, OGG, MOV, M4V.');
      if (chatVideoInput) chatVideoInput.value = '';
      return;
    }

    // 3. Validate Size (Max 100MB for videos)
    const maxVideoSizeBytes = 100 * 1024 * 1024;
    if (file.size > maxVideoSizeBytes) {
      showToast('Video is too large. Maximum size is 100MB.');
      if (chatVideoInput) chatVideoInput.value = '';
      return;
    }

    // Revoke any previous blob URL before creating a new one
    if (videoBlobUrl) {
      URL.revokeObjectURL(videoBlobUrl);
      videoBlobUrl = null;
    }

    // Use Object URL for local preview only — never persisted
    videoBlobUrl = URL.createObjectURL(file);

    pendingVideoAttachment = {
      file,
      blobUrl: videoBlobUrl,
      name: file.name,
      size: file.size,
      mimeType: file.type,
      durationSeconds: 0
    };

    if (chatVideoPreviewElement) {
      chatVideoPreviewElement.src = videoBlobUrl;
      chatVideoPreviewElement.load();
      chatVideoPreviewElement.onloadedmetadata = () => {
        const dur = chatVideoPreviewElement.duration;
        if (pendingVideoAttachment) pendingVideoAttachment.durationSeconds = Math.round(dur) || 0;
        if (chatVideoPreviewDuration) {
          chatVideoPreviewDuration.textContent = formatDuration(dur) ? `• ${formatDuration(dur)}` : '';
        }
      };
    }

    if (chatVideoPreviewName) chatVideoPreviewName.textContent = file.name;
    if (chatVideoPreviewSize) chatVideoPreviewSize.textContent = formatFileSize(file.size);
    if (chatVideoPreviewDuration) chatVideoPreviewDuration.textContent = '';
    if (chatVideoPreviewContainer) chatVideoPreviewContainer.style.display = 'flex';

    const attachmentsDrawer = document.getElementById('chat-attachments-drawer');
    if (attachmentsDrawer) attachmentsDrawer.classList.remove('active');

    debouncedCreateIcons();
  }

  async function sendVideoMessage() {
    if (!pendingVideoAttachment || isSendingVideo) return;

    const targetUserId = state.currentChatThread;
    const currentUser = getCurrentUser();
    const token = getAuthToken();

    if (!targetUserId || !currentUser || !token) {
      showToast('Please select a conversation to send the video.');
      return;
    }

    isSendingVideo = true;
    if (chatVideoPreviewSend) {
      chatVideoPreviewSend.disabled = true;
      chatVideoPreviewSend.innerHTML = '<i data-lucide="loader" class="spin"></i> Uploading...';
      debouncedCreateIcons();
    }

    try {
      // Read file as base64 for upload — do NOT use blob URL
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Failed to read video file.'));
        reader.readAsDataURL(pendingVideoAttachment.file);
      });

      const res = await fetch(`${API_URL}/api/chats/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          recipient: targetUserId,
          content: '',
          mediaUrl: dataUrl,
          mediaType: 'video',
          mediaName: pendingVideoAttachment.name,
          mediaSize: pendingVideoAttachment.size,
          durationSeconds: pendingVideoAttachment.durationSeconds || 0
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Video upload failed.');
      }

      const createdMsg = await res.json();

      // Append sent video smoothly into active conversation viewport (Right-aligned)
      appendSingleMessage(targetUserId, createdMsg);

      // Update sidebar thread preview in-place
      updateThreadLastMessageInPlace(targetUserId, createdMsg);

      clearPendingVideo();
      showToast('Video sent! 🎥');
    } catch (err) {
      console.error('[VIDEO_UPLOAD_ERROR]', err.message);
      showToast(err.message || 'Video upload failed.');
    } finally {
      isSendingVideo = false;
      if (chatVideoPreviewSend) {
        chatVideoPreviewSend.disabled = false;
        chatVideoPreviewSend.innerHTML = '<i data-lucide="send" style="width: 14px; height: 14px;"></i> Send';
      }
      debouncedCreateIcons();
    }
  }

  function handleMediaFileSelection(file) {
    if (!file) return;
    console.log('[DM MEDIA] selected file:', {
      name: file.name,
      type: file.type,
      size: file.size
    });

    const isVideo = (file.type && file.type.startsWith('video/')) || /\.(mp4|webm|ogg|mov|m4v)$/i.test(file.name);
    const isImage = (file.type && file.type.startsWith('image/')) || /\.(jpg|jpeg|png|webp|gif)$/i.test(file.name);

    const mediaType = isVideo ? 'video' : (isImage ? 'image' : 'unknown');
    console.log('[DM MEDIA] detected type:', mediaType);

    if (isVideo) {
      handleVideoFileSelection(file);
    } else if (isImage) {
      handleImageFileSelection(file);
    } else {
      showToast('Unsupported media format. Allowed: Images (JPG, PNG, WEBP, GIF) and Videos (MP4, WebM, OGG, MOV).');
      if (chatImageInput) chatImageInput.value = '';
      if (chatVideoInput) chatVideoInput.value = '';
    }
  }

  if (chatImageInput) {
    chatImageInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      handleMediaFileSelection(file);
    });
  }

  if (chatVideoInput) {
    chatVideoInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      handleMediaFileSelection(file);
    });
  }

  if (chatVideoPreviewCancel) {
    chatVideoPreviewCancel.addEventListener('click', clearPendingVideo);
  }

  if (chatVideoPreviewSend) {
    chatVideoPreviewSend.addEventListener('click', sendVideoMessage);
  }


  const mediaViewerModal = document.getElementById('media-viewer-modal');
  const mediaViewerCloseBtn = document.getElementById('media-viewer-close-btn');
  const mediaViewerTitle = document.getElementById('media-viewer-title');
  const mediaViewerViewport = document.querySelector('.media-viewer-viewport');
  const mediaViewerName = document.getElementById('media-viewer-name');
  const mediaViewerSize = document.getElementById('media-viewer-size');
  const mediaViewerReplyInput = document.getElementById('media-viewer-reply-input');
  const mediaViewerReplySend = document.getElementById('media-viewer-reply-send');

  let activeViewerMessageId = null;

  async function openMediaViewer(messageId) {
    activeViewerMessageId = messageId;
    const targetUserId = state.currentChatThread;
    if (!targetUserId || !mediaViewerModal) return;

    const conversationMsgs = dmState.messagesByConversation.get(targetUserId) || [];
    const msg = conversationMsgs.find(m => (m._id || m.id || '').toString() === messageId.toString());
    const effectiveType = (msg?.mediaType || msg?.media_type || (msg?.attachment?.file_type) || (msg?.mediaUrl || msg?.media_url ? 'image' : '')).toLowerCase();
    if (!msg || !effectiveType || effectiveType === 'text') return;

    const currentUser = getCurrentUser();
    if (!currentUser) return;
    const currentUserId = currentUser.id || currentUser._id;
    const secretKey = getChatSecretKey(currentUserId, targetUserId);
    const decryptedData = decryptMessage(msg.content, secretKey);

    mediaViewerViewport.innerHTML = '';
    mediaViewerName.textContent = msg.mediaName || msg.media_name || 'Shared Media';
    mediaViewerSize.textContent = msg.mediaSize || msg.media_size || '';
    mediaViewerReplyInput.value = '';

    if (effectiveType === 'image' || effectiveType.includes('image')) {
      mediaViewerTitle.textContent = 'View Image';
      const img = document.createElement('img');
      img.src = resolveBrowserMediaUrl(msg) || (decryptedData.startsWith('http') || decryptedData.startsWith('data:') ? decryptedData : '');
      img.style.maxWidth = '100%';
      img.style.maxHeight = '80vh';
      img.style.borderRadius = 'var(--radius-md)';
      img.style.objectFit = 'contain';
      mediaViewerViewport.appendChild(img);
    } else if (effectiveType === 'video' || effectiveType.includes('video')) {
      mediaViewerTitle.textContent = 'Play Video';
      const videoUrl = resolveBrowserMediaUrl(msg) || (decryptedData.startsWith('http') || decryptedData.startsWith('data:') ? decryptedData : '');
      const mimeType = (msg.attachment && msg.attachment.mime_type) || msg.mimeType || msg.mime_type || 'video/mp4';
      const video = document.createElement('video');
      video.controls = true;
      video.autoplay = false;
      video.preload = 'metadata';
      video.playsInline = true;
      video.src = videoUrl;
      video.style.maxWidth = '100%';
      video.style.maxHeight = '80vh';
      video.style.borderRadius = 'var(--radius-md)';
      video.style.display = 'block';

      const source = document.createElement('source');
      source.src = videoUrl;
      source.type = mimeType;
      video.appendChild(source);

      video.addEventListener('loadedmetadata', () => {
        if (video.duration === Infinity || isNaN(video.duration) || video.duration === 0) {
          const p = video.currentTime;
          video.currentTime = 1e101;
          video.addEventListener('timeupdate', function f() {
            video.removeEventListener('timeupdate', f);
            video.currentTime = p || 0;
          }, { once: true });
        }
      });
      video.addEventListener('error', () => {
        console.error('[VIEWER_VIDEO_ERROR]', {
          messageId,
          videoUrl,
          errorCode: video.error ? video.error.code : 'unknown',
          errorMessage: video.error ? video.error.message : ''
        });
      });

      mediaViewerViewport.appendChild(video);
    } else if (effectiveType === 'audio' || effectiveType === 'voice' || effectiveType.includes('audio') || effectiveType.includes('voice')) {
      mediaViewerTitle.textContent = 'Play Voice Note';
      const audioUrl = resolveBrowserMediaUrl(msg) || (decryptedData.startsWith('http') || decryptedData.startsWith('data:') ? decryptedData : '');
      const mimeType = (msg.attachment && msg.attachment.mime_type) || msg.mimeType || msg.mime_type || 'audio/webm';
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.autoplay = false;
      audio.src = audioUrl;
      audio.style.width = '100%';
      audio.style.maxWidth = '360px';

      const source = document.createElement('source');
      source.src = audioUrl;
      source.type = mimeType;
      audio.appendChild(source);

      mediaViewerViewport.appendChild(audio);
    } else if (msg.mediaType === 'file') {
      mediaViewerTitle.textContent = 'View Document';
      mediaViewerViewport.innerHTML = `
        <div style="text-align:center; padding:20px;">
          <i data-lucide="file-text" style="width:60px; height:60px; color:var(--primary); margin-bottom:12px;"></i>
          <p style="font-size:14px; font-weight:600; margin-bottom:16px;">${msg.mediaName}</p>
          <a href="${decryptedData}" download="${msg.mediaName}" class="glass-btn bg-pink-btn" style="padding:10px 24px; border-radius:var(--radius-md); text-decoration:none; display:inline-flex; align-items:center; gap:8px;"><i data-lucide="download"></i> Download File</a>
        </div>
      `;
      debouncedCreateIcons();
    } else if (msg.mediaType === 'hub') {
      mediaViewerTitle.textContent = 'View Shared Hub Item';
      const isReel = msg.mediaUrl.startsWith('reel');
      mediaViewerViewport.innerHTML = `
        <div style="text-align:center; padding:20px;">
          <i data-lucide="sparkles" style="width:60px; height:60px; color:var(--primary); margin-bottom:12px;"></i>
          <p style="font-size:14px; font-weight:600; margin-bottom:16px;">${msg.mediaName}</p>
          <button class="glass-btn bg-pink-btn" onclick="navigateToHubShare('${msg.mediaUrl}')" style="padding:10px 24px; border-radius:var(--radius-md); display:inline-flex; align-items:center; gap:8px;"><i data-lucide="external-link"></i> Open ${isReel ? 'Reel' : 'Post'}</button>
        </div>
      `;
      debouncedCreateIcons();
    }

    mediaViewerModal.classList.add('active');
  }
  window.openMediaViewer = openMediaViewer;

  function navigateToHubShare(id) {
    if (mediaViewerModal) mediaViewerModal.classList.remove('active');
    if (id.startsWith('reel')) {
      const reelsTab = document.querySelector('[data-view="reels"]');
      if (reelsTab) reelsTab.click();
      showToast(`Navigated to shared Reel! 🎬`);
    } else {
      const feedTab = document.querySelector('[data-view="home"]');
      if (feedTab) feedTab.click();
      showToast(`Navigated to shared Post! 📸`);
    }
  }
  window.navigateToHubShare = navigateToHubShare;

  if (mediaViewerCloseBtn) {
    mediaViewerCloseBtn.addEventListener('click', () => {
      mediaViewerModal.classList.remove('active');
      const audio = mediaViewerViewport.querySelector('audio');
      if (audio) audio.pause();
      const video = mediaViewerViewport.querySelector('video');
      if (video) video.pause();
    });
  }

  async function sendMediaViewerReply() {
    const text = mediaViewerReplyInput.value.trim();
    if (!text || !activeViewerMessageId) return;

    const targetUserId = state.currentChatThread;
    const currentUser = getCurrentUser();
    const token = getAuthToken();
    if (!targetUserId || !currentUser || !token) return;

    const conversationMsgs = chatFeeds[targetUserId] || [];
    const msg = conversationMsgs.find(m => m._id.toString() === activeViewerMessageId.toString());
    const mediaName = msg ? msg.mediaName || 'Media' : 'Media';

    const replyText = `💬 Reply to "${mediaName}": ${text}`;

    const secretKey = getChatSecretKey(currentUser.id || currentUser._id, targetUserId);
    const encryptedText = encryptMessage(replyText, secretKey);

    try {
      const res = await fetch(`${API_URL}/api/chats/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          recipient: targetUserId,
          content: encryptedText
        })
      });
      if (!res.ok) throw new Error();

      mediaViewerReplyInput.value = '';
      mediaViewerModal.classList.remove('active');
      showToast('Sent reply! 💬');

      await fetchMessages(targetUserId, true);
      loadChatThreads();
    } catch (err) {
      showToast('Failed to send reply.');
    }
  }

  if (mediaViewerReplySend) {
    mediaViewerReplySend.addEventListener('click', sendMediaViewerReply);
  }
  if (mediaViewerReplyInput) {
    mediaViewerReplyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendMediaViewerReply();
      }
    });
  }

  // --- DYNAMIC SHARED MEDIA HUB IMPLEMENTATION ---
  async function loadSharedMediaHub() {
    const targetUserId = state.currentChatThread;
    const mediaGrid = document.getElementById('shared-media-items-grid');
    if (!targetUserId || !mediaGrid) return;

    const activeTab = document.querySelector('#media-hub-tabs .m-pill.active');
    const filterType = activeTab ? activeTab.getAttribute('data-media-filter') : 'all';

    const searchInput = document.getElementById('media-search-input');
    const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

    await fetchMessages(targetUserId, false);
    const messages = chatFeeds[targetUserId] || [];

    let mediaMessages = messages.filter(m => m.mediaType);

    if (filterType !== 'all') {
      mediaMessages = mediaMessages.filter(m => m.mediaType === filterType);
    }

    if (query) {
      mediaMessages = mediaMessages.filter(m => {
        const name = (m.mediaName || '').toLowerCase();
        return name.includes(query);
      });
    }

    mediaGrid.innerHTML = '';

    if (mediaMessages.length === 0) {
      mediaGrid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted); font-size: 12px;">No shared media items found in this chat.</div>';
      return;
    }

    const currentUser = getCurrentUser();
    if (!currentUser) return;
    const currentUserId = currentUser.id || currentUser._id;
    const secretKey = getChatSecretKey(currentUserId, targetUserId);

    mediaMessages.forEach(msg => {
      const card = document.createElement('div');
      card.className = 'media-item-card';
      card.setAttribute('data-type', msg.mediaType);
      card.addEventListener('click', () => {
        openMediaViewer(msg._id);
      });

      if (msg.mediaType === 'image') {
        const decryptedData = decryptMessage(msg.content, secretKey);
        card.innerHTML = `
          <img src="${decryptedData}" alt="${msg.mediaName}" style="width: 100%; height: 100%; object-fit: cover;" />
          <div class="media-item-desc">
            <span class="file-name">${msg.mediaName || 'Image'}</span>
            <span class="file-size">${msg.mediaSize || ''}</span>
          </div>
        `;
      } else if (msg.mediaType === 'video') {
        card.classList.add('video-thumb');
        card.innerHTML = `
          <div class="thumb-play-btn"><i data-lucide="play"></i></div>
          <div style="background: #000; width: 100%; height: 100%; display: flex; justify-content: center; align-items: center; color: #fff;"><i data-lucide="video" style="width: 30px; height: 30px; opacity: 0.6;"></i></div>
          <div class="media-item-desc">
            <span class="file-name">${msg.mediaName || 'Video'}</span>
            <span class="file-size">${msg.mediaSize || ''}</span>
          </div>
        `;
      } else if (msg.mediaType === 'voice') {
        card.classList.add('voice-thumb');
        card.innerHTML = `
          <div class="voice-waveform">
            <span></span><span></span><span></span><span></span><span></span><span></span><span></span>
          </div>
          <div class="media-item-desc">
            <span class="file-name">${msg.mediaName || 'Voice Note'}</span>
            <span class="file-size">${msg.mediaSize || ''}</span>
          </div>
        `;
      } else if (msg.mediaType === 'file') {
        card.classList.add('doc-thumb');
        card.innerHTML = `
          <div class="thumb-doc-icon"><i data-lucide="file-text"></i></div>
          <div class="media-item-desc">
            <span class="file-name">${msg.mediaName || 'Document'}</span>
            <span class="file-size">${msg.mediaSize || ''}</span>
          </div>
        `;
      } else if (msg.mediaType === 'hub') {
        card.classList.add('doc-thumb');
        card.style.background = 'rgba(108,59,255,0.1)';
        card.innerHTML = `
          <div class="thumb-doc-icon"><i data-lucide="sparkles" style="color: var(--primary);"></i></div>
          <div class="media-item-desc">
            <span class="file-name">${msg.mediaName || 'Shared Post'}</span>
            <span class="file-size">Hub Link</span>
          </div>
        `;
      }

      mediaGrid.appendChild(card);
    });

    debouncedCreateIcons();
  }
  window.loadSharedMediaHub = loadSharedMediaHub;

  const mediaHubPills = document.querySelectorAll('#media-hub-tabs .m-pill');
  mediaHubPills.forEach(pill => {
    pill.addEventListener('click', () => {
      mediaHubPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      loadSharedMediaHub();
    });
  });

  const mediaSearchInput = document.getElementById('media-search-input');
  if (mediaSearchInput) {
    mediaSearchInput.addEventListener('input', () => {
      loadSharedMediaHub();
    });
  }


  // --- CHAT ATTACHMENTS DRAWER ---
  const toggleAttachmentsBtn = document.getElementById('toggle-attachments-btn');
  const attachmentsDrawer = document.getElementById('chat-attachments-drawer');

  if (toggleAttachmentsBtn) {
    toggleAttachmentsBtn.addEventListener('click', () => {
      toggleAttachmentsBtn.classList.toggle('active');
      attachmentsDrawer.classList.toggle('active');
    });
  }

  // Drawer options click mode swapping
  const drawerBtns = document.querySelectorAll('.attachment-action-btn');
  drawerBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const openMode = btn.getAttribute('data-open-mode');
      if (openMode) {
        switchChatMode(openMode);
        toggleAttachmentsBtn.classList.remove('active');
        attachmentsDrawer.classList.remove('active');
      }
    });
  });

  const simpleDrawerAlerts = [
    { id: 'poll-click-sim', label: 'Poll Widget created: "What time is offsite?" 📊' }
  ];

  simpleDrawerAlerts.forEach(sim => {
    const el = document.getElementById(sim.id);
    if (el) {
      el.addEventListener('click', () => {
        showToast(sim.label);
        toggleAttachmentsBtn.classList.remove('active');
        attachmentsDrawer.classList.remove('active');
      });
    }
  });

  // --- ATTACHMENTS DRAWER ACTION BUTTONS ---
  const filesBtnPicker = document.getElementById('files-btn-picker');
  const attachmentFileInput = document.getElementById('attachment-file-input');
  const attachmentDocInput = document.getElementById('attachment-doc-input');

  if (filesBtnPicker && attachmentDocInput) {
    filesBtnPicker.addEventListener('click', () => {
      attachmentDocInput.click();
    });
  }

  async function handleAttachmentFileUpload(file) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function (evt) {
      const fileDataUrl = evt.target.result;
      const targetUserId = state.currentChatThread;
      const currentUser = getCurrentUser();
      const token = getAuthToken();

      if (targetUserId && currentUser && token) {
        try {
          let mediaType = 'file';
          if (file.type.startsWith('image/')) {
            mediaType = 'image';
          } else if (file.type.startsWith('video/')) {
            mediaType = 'video';
          } else if (file.type.startsWith('audio/')) {
            mediaType = 'voice';
          }

          const sizeStr = (file.size / 1024 / 1024).toFixed(1) + ' MB';
          const secretKey = getChatSecretKey(currentUser.id || currentUser._id, targetUserId);
          const encryptedText = encryptMessage(fileDataUrl, secretKey);

          await fetch(`${API_URL}/api/chats/message`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              recipient: targetUserId,
              content: encryptedText,
              mediaUrl: 'drawer_upload',
              mediaType: mediaType,
              mediaName: file.name,
              mediaSize: sizeStr
            })
          });
          await fetchMessages(targetUserId, true);
          loadChatThreads();
          showToast(`File "${file.name}" sent! 📎`);

          // Close drawer
          if (toggleAttachmentsBtn) toggleAttachmentsBtn.classList.remove('active');
          if (attachmentsDrawer) attachmentsDrawer.classList.remove('active');
        } catch (err) {
          console.error('File upload error:', err);
          showToast('Failed to upload file.');
        }
      }
    };
    reader.readAsDataURL(file);
  }

  if (attachmentFileInput) {
    attachmentFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      handleAttachmentFileUpload(file);
      e.target.value = ''; // Reset
    });
  }

  if (attachmentDocInput) {
    attachmentDocInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      handleAttachmentFileUpload(file);
      e.target.value = ''; // Reset
    });
  }

  // Geolocation sharing
  const locClickSimBtn = document.getElementById('loc-click-sim');
  if (locClickSimBtn) {
    locClickSimBtn.addEventListener('click', () => {
      if (!navigator.geolocation) {
        showToast('Geolocation is not supported by your browser.');
        return;
      }

      showToast('Fetching your location... 📍');

      navigator.geolocation.getCurrentPosition(async (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;

        const targetUserId = state.currentChatThread;
        const currentUser = getCurrentUser();
        const token = getAuthToken();

        if (targetUserId && currentUser && token) {
          try {
            const secretKey = getChatSecretKey(currentUser.id || currentUser._id, targetUserId);
            const encryptedText = encryptMessage(mapsUrl, secretKey);

            await fetch(`${API_URL}/api/chats/message`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({
                recipient: targetUserId,
                content: encryptedText,
                mediaType: 'location',
                mediaName: 'Shared Location'
              })
            });

            await fetchMessages(targetUserId, true);
            loadChatThreads();
            showToast('Location shared! 🗺️');

            // Close drawer
            if (toggleAttachmentsBtn) toggleAttachmentsBtn.classList.remove('active');
            if (attachmentsDrawer) attachmentsDrawer.classList.remove('active');
          } catch (err) {
            console.error('Location send error:', err);
            showToast('Failed to share location.');
          }
        }
      }, (error) => {
        console.error('Geolocation error:', error);
        showToast('Failed to get location: ' + error.message);
      }, {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 0
      });
    });
  }

  // --- PHASE 4: AUDIO / VOICE MESSAGES SYSTEM & STATE MACHINE ---
  const micClickSimBtn = document.getElementById('mic-click-sim');
  const chatMicInputBtn = document.getElementById('chat-mic-input-btn');
  const voiceRecordingBar = document.getElementById('chat-voice-recording-bar');
  const voiceRecordingTimer = document.getElementById('voice-recording-timer');
  const voiceRecordingCancelBtn = document.getElementById('voice-recording-cancel-btn');
  const voiceRecordingPauseBtn = document.getElementById('voice-recording-pause-btn');
  const voiceRecordingPauseText = document.getElementById('voice-recording-pause-text');
  const voiceRecordingStopBtn = document.getElementById('voice-recording-stop-btn');

  const voicePreviewBar = document.getElementById('chat-voice-preview-bar');
  const voicePreviewPlayBtn = document.getElementById('voice-preview-play-btn');
  const voicePreviewDuration = document.getElementById('voice-preview-duration');
  const voicePreviewAudioElem = document.getElementById('voice-preview-audio-elem');
  const voicePreviewTrack = document.getElementById('voice-preview-track');
  const voicePreviewProgress = document.getElementById('voice-preview-progress');
  const voicePreviewDeleteBtn = document.getElementById('voice-preview-delete-btn');
  const voicePreviewSendBtn = document.getElementById('voice-preview-send-btn');

  // Legacy fallback containers if present
  const voiceNotePreviewContainer = document.getElementById('voice-note-preview-container');
  const voiceNotePreviewAudio = document.getElementById('voice-note-preview-audio');
  const voiceNotePreviewDelete = document.getElementById('voice-note-preview-delete');
  const voiceNotePreviewSend = document.getElementById('voice-note-preview-send');

  let mediaRecorder = null;
  let audioChunks = [];
  let isRecordingAudio = false;
  let recordingTimeout = null;
  let recordingStartTime = 0;
  let recordedDurationSeconds = 0;
  let activeAudioStream = null;
  let voiceTimerInterval = null;
  let voiceRecordedSeconds = 0;
  let voiceIsPaused = false;

  let tempVoiceNoteBase64 = null;
  let tempVoiceNoteBlobSize = null;
  let tempVoiceNoteBlob = null;
  let tempAudioObjectUrl = null;
  let isSendingVoiceNote = false;

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function setVoiceComposerState(newState) {
    const inputRow = document.querySelector('.chat-input-row');

    if (newState === 'idle') {
      if (inputRow) inputRow.style.display = 'flex';
      if (voiceRecordingBar) voiceRecordingBar.style.display = 'none';
      if (voicePreviewBar) voicePreviewBar.style.display = 'none';
      if (voiceNotePreviewContainer) voiceNotePreviewContainer.style.display = 'none';
      clearVoiceTimer();
      cleanupAudioStream();
      isRecordingAudio = false;
      voiceIsPaused = false;
      if (voicePreviewAudioElem) {
        voicePreviewAudioElem.pause();
        voicePreviewAudioElem.src = '';
      }
      if (voicePreviewProgress) voicePreviewProgress.style.width = '0%';
      if (voicePreviewPlayBtn) {
        voicePreviewPlayBtn.innerHTML = '<i data-lucide="play" style="width: 15px; height: 15px; fill: currentColor;"></i>';
      }
      if (voiceRecordingPauseText) voiceRecordingPauseText.textContent = 'Pause';
    } else if (newState === 'recording') {
      if (inputRow) inputRow.style.display = 'none';
      if (voiceRecordingBar) voiceRecordingBar.style.display = 'flex';
      if (voicePreviewBar) voicePreviewBar.style.display = 'none';
      if (voiceNotePreviewContainer) voiceNotePreviewContainer.style.display = 'none';
    } else if (newState === 'preview') {
      if (inputRow) inputRow.style.display = 'none';
      if (voiceRecordingBar) voiceRecordingBar.style.display = 'none';
      if (voicePreviewBar) voicePreviewBar.style.display = 'flex';
      if (voiceNotePreviewContainer) voiceNotePreviewContainer.style.display = 'none';
      clearVoiceTimer();
      cleanupAudioStream();
      isRecordingAudio = false;
    }
    debouncedCreateIcons();
  }

  function startVoiceTimer() {
    clearVoiceTimer();
    voiceRecordedSeconds = 0;
    voiceIsPaused = false;
    if (voiceRecordingTimer) voiceRecordingTimer.textContent = '00:00';

    voiceTimerInterval = setInterval(() => {
      if (!voiceIsPaused) {
        voiceRecordedSeconds++;
        if (voiceRecordingTimer) voiceRecordingTimer.textContent = formatTime(voiceRecordedSeconds);
      }
    }, 1000);
  }

  function clearVoiceTimer() {
    if (voiceTimerInterval) {
      clearInterval(voiceTimerInterval);
      voiceTimerInterval = null;
    }
  }

  function cleanupAudioStream() {
    if (activeAudioStream) {
      try {
        activeAudioStream.getTracks().forEach(track => track.stop());
      } catch (_) { }
      activeAudioStream = null;
    }
  }

  function clearVoiceNoteState() {
    tempVoiceNoteBase64 = null;
    tempVoiceNoteBlobSize = null;
    tempVoiceNoteBlob = null;
    recordedDurationSeconds = 0;
    if (tempAudioObjectUrl) {
      try {
        URL.revokeObjectURL(tempAudioObjectUrl);
      } catch (_) { }
      tempAudioObjectUrl = null;
    }
    if (voiceNotePreviewAudio) {
      voiceNotePreviewAudio.pause();
      voiceNotePreviewAudio.src = '';
    }
    if (voicePreviewAudioElem) {
      voicePreviewAudioElem.pause();
      voicePreviewAudioElem.src = '';
    }
    setVoiceComposerState('idle');
  }

  async function startAudioRecording() {
    clearPendingImage();
    clearPendingVideo();
    clearVoiceNoteState();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Microphone is not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      activeAudioStream = stream;
      audioChunks = [];

      const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
      let chosenMime = '';
      for (const mime of mimeTypes) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
          chosenMime = mime;
          break;
        }
      }

      mediaRecorder = chosenMime ? new MediaRecorder(stream, { mimeType: chosenMime }) : new MediaRecorder(stream);
      recordingStartTime = Date.now();

      mediaRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      });

      mediaRecorder.addEventListener('stop', async () => {
        recordedDurationSeconds = Math.max(1, voiceRecordedSeconds || Math.round((Date.now() - recordingStartTime) / 1000));
        cleanupAudioStream();

        const finalMime = mediaRecorder.mimeType || chosenMime || 'audio/webm';
        const audioBlob = new Blob(audioChunks, { type: finalMime });

        if (audioBlob.size < 300) {
          showToast('No audio was recorded.');
          clearVoiceNoteState();
          return;
        }

        const reader = new FileReader();
        reader.onloadend = () => {
          tempVoiceNoteBase64 = reader.result;
          tempVoiceNoteBlobSize = formatFileSize(audioBlob.size);
          tempVoiceNoteBlob = audioBlob;

          if (tempAudioObjectUrl) {
            try { URL.revokeObjectURL(tempAudioObjectUrl); } catch (_) { }
          }
          tempAudioObjectUrl = URL.createObjectURL(audioBlob);

          if (voicePreviewAudioElem) {
            voicePreviewAudioElem.src = tempAudioObjectUrl;
            voicePreviewAudioElem.onended = () => {
              if (voicePreviewPlayBtn) {
                voicePreviewPlayBtn.innerHTML = '<i data-lucide="play" style="width: 15px; height: 15px; fill: currentColor;"></i>';
                debouncedCreateIcons();
              }
              if (voicePreviewProgress) voicePreviewProgress.style.width = '0%';
            };
            voicePreviewAudioElem.ontimeupdate = () => {
              if (voicePreviewAudioElem.duration) {
                const pct = (voicePreviewAudioElem.currentTime / voicePreviewAudioElem.duration) * 100;
                if (voicePreviewProgress) voicePreviewProgress.style.width = `${pct}%`;
                if (voicePreviewDuration) voicePreviewDuration.textContent = formatTime(Math.floor(voicePreviewAudioElem.currentTime));
              }
            };
          }

          if (voicePreviewDuration) {
            voicePreviewDuration.textContent = formatTime(recordedDurationSeconds);
          }

          const attachmentsDrawer = document.getElementById('chat-attachments-drawer');
          if (attachmentsDrawer) attachmentsDrawer.classList.remove('active');

          setVoiceComposerState('preview');
        };
        reader.readAsDataURL(audioBlob);
      });

      mediaRecorder.start();
      isRecordingAudio = true;
      setVoiceComposerState('recording');
      startVoiceTimer();

      // Auto-stop after 120 seconds
      if (recordingTimeout) clearTimeout(recordingTimeout);
      recordingTimeout = setTimeout(() => {
        if (isRecordingAudio && mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
      }, 120000);

    } catch (err) {
      console.error('Microphone access error:', err);
      showToast('Microphone permission denied or unavailable.');
      cleanupAudioStream();
      clearVoiceNoteState();
    }
  }

  // Mic Button Listeners
  if (chatMicInputBtn) {
    chatMicInputBtn.addEventListener('click', () => {
      startAudioRecording();
    });
  }

  if (micClickSimBtn) {
    micClickSimBtn.addEventListener('click', () => {
      startAudioRecording();
    });
  }

  // Recording State Controls
  if (voiceRecordingCancelBtn) {
    voiceRecordingCancelBtn.addEventListener('click', () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
      clearVoiceNoteState();
      showToast('Recording cancelled.');
    });
  }

  if (voiceRecordingPauseBtn) {
    voiceRecordingPauseBtn.addEventListener('click', () => {
      if (!mediaRecorder) return;
      if (mediaRecorder.state === 'recording') {
        mediaRecorder.pause();
        voiceIsPaused = true;
        if (voiceRecordingPauseText) voiceRecordingPauseText.textContent = 'Resume';
        voiceRecordingPauseBtn.innerHTML = '<i data-lucide="play" style="width: 13px; height: 13px;"></i> <span id="voice-recording-pause-text">Resume</span>';
      } else if (mediaRecorder.state === 'paused') {
        mediaRecorder.resume();
        voiceIsPaused = false;
        if (voiceRecordingPauseText) voiceRecordingPauseText.textContent = 'Pause';
        voiceRecordingPauseBtn.innerHTML = '<i data-lucide="pause" style="width: 13px; height: 13px;"></i> <span id="voice-recording-pause-text">Pause</span>';
      }
      debouncedCreateIcons();
    });
  }

  if (voiceRecordingStopBtn) {
    voiceRecordingStopBtn.addEventListener('click', () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
    });
  }

  // Preview State Controls
  if (voicePreviewPlayBtn) {
    voicePreviewPlayBtn.addEventListener('click', () => {
      if (!voicePreviewAudioElem || !voicePreviewAudioElem.src) return;
      if (voicePreviewAudioElem.paused) {
        voicePreviewAudioElem.play();
        voicePreviewPlayBtn.innerHTML = '<i data-lucide="pause" style="width: 15px; height: 15px; fill: currentColor;"></i>';
      } else {
        voicePreviewAudioElem.pause();
        voicePreviewPlayBtn.innerHTML = '<i data-lucide="play" style="width: 15px; height: 15px; fill: currentColor;"></i>';
      }
      debouncedCreateIcons();
    });
  }

  if (voicePreviewTrack) {
    voicePreviewTrack.addEventListener('click', (e) => {
      if (!voicePreviewAudioElem || !voicePreviewAudioElem.duration) return;
      const rect = voicePreviewTrack.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, clickX / rect.width));
      voicePreviewAudioElem.currentTime = pct * voicePreviewAudioElem.duration;
    });
  }

  if (voicePreviewDeleteBtn) {
    voicePreviewDeleteBtn.addEventListener('click', () => {
      clearVoiceNoteState();
      showToast('Voice note deleted.');
    });
  }

  if (voiceNotePreviewDelete) {
    voiceNotePreviewDelete.addEventListener('click', () => {
      clearVoiceNoteState();
      showToast('Voice note discarded.');
    });
  }

  async function sendVoiceNoteMessage() {
    if (!tempVoiceNoteBase64 || isSendingVoiceNote) return;

    const targetUserId = state.currentChatThread;
    const currentUser = getCurrentUser();
    const token = getAuthToken();

    if (!targetUserId || !currentUser || !token) {
      showToast('Please select a conversation to send the voice note.');
      return;
    }

    isSendingVoiceNote = true;
    if (voicePreviewSendBtn) {
      voicePreviewSendBtn.disabled = true;
      voicePreviewSendBtn.innerHTML = '<i data-lucide="loader" class="spin"></i> Sending...';
    }
    if (voiceNotePreviewSend) {
      voiceNotePreviewSend.disabled = true;
      voiceNotePreviewSend.innerHTML = '<i data-lucide="loader" class="spin"></i> Uploading...';
    }

    try {
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const res = await fetch(`${API_URL}/api/chats/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          recipient: targetUserId,
          content: '',
          mediaUrl: tempVoiceNoteBase64,
          mediaType: 'audio',
          mediaName: `Voice Note - ${timeStr}`,
          mediaSize: tempVoiceNoteBlob ? tempVoiceNoteBlob.size : 0,
          durationSeconds: recordedDurationSeconds || 0
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to send voice note.');
      }

      const createdMsg = await res.json();

      // Append sent voice note smoothly into active conversation viewport
      appendSingleMessage(targetUserId, createdMsg);

      // Update sidebar thread preview in-place
      updateThreadLastMessageInPlace(targetUserId, createdMsg);

      clearVoiceNoteState();
      showToast('Voice note sent! 🎙️');
    } catch (err) {
      console.error('Audio upload error:', err);
      showToast('Voice message could not be sent.');
    } finally {
      isSendingVoiceNote = false;
      if (voicePreviewSendBtn) {
        voicePreviewSendBtn.disabled = false;
        voicePreviewSendBtn.innerHTML = '<i data-lucide="send" style="width: 13px; height: 13px;"></i> Send';
      }
      if (voiceNotePreviewSend) {
        voiceNotePreviewSend.disabled = false;
        voiceNotePreviewSend.innerHTML = '<i data-lucide="send" style="width: 14px; height: 14px;"></i> Send';
      }
      debouncedCreateIcons();
    }
  }

  if (voicePreviewSendBtn) {
    voicePreviewSendBtn.addEventListener('click', sendVoiceNoteMessage);
  }

  if (voiceNotePreviewSend) {
    voiceNotePreviewSend.addEventListener('click', sendVoiceNoteMessage);
  }


  // --- WATCH TOGETHER REACTIONS ---
  const watchReactBtns = document.querySelectorAll('.react-burst-btn');
  const watchContainer = document.querySelector('.watch-together-container');

  function triggerWatchReaction(emoji) {
    if (!watchContainer) return;

    const spawnX = watchContainer.clientWidth - 120 + (Math.random() * 80);
    const spawnY = watchContainer.clientHeight - 40;

    const floatEmoji = document.createElement('div');
    floatEmoji.className = 'floating-reaction-emoji';
    floatEmoji.textContent = emoji;
    floatEmoji.style.left = `${spawnX}px`;
    floatEmoji.style.top = `${spawnY}px`;

    const rnd = -50 + Math.random() * 100;
    const rndXEnd = rnd + (-60 + Math.random() * 120);
    floatEmoji.style.setProperty('--rnd-x', `${rnd}px`);
    floatEmoji.style.setProperty('--rnd-x-end', `${rndXEnd}px`);

    watchContainer.appendChild(floatEmoji);
    setTimeout(() => floatEmoji.remove(), 1200);
  }

  watchReactBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const emoji = btn.getAttribute('data-emoji');
      triggerWatchReaction(emoji);

      // Live Chat update log
      if (watchMessagesScroll) {
        const line = document.createElement('div');
        line.className = 'watch-msg animate-appear';
        line.innerHTML = `<span class="w-user me">You:</span> Reacted with ${emoji}`;
        watchMessagesScroll.appendChild(line);
        watchMessagesScroll.scrollTop = watchMessagesScroll.scrollHeight;
      }

      // Increment viewer count
      const watchCount = document.getElementById('watch-count-lbl');
      if (watchCount) watchCount.textContent = '4';
    });
  });


  // --- OLD CALL IMPLEMENTATION REMOVED FOR ISOLATION ---



  // --- GLOBAL SEARCH CARD FILTER CONTROLLER (Disabled. Replaced with dynamic database search) ---

  // Tags filter pills click
  const tagPills = document.querySelectorAll('.tag-pill');
  tagPills.forEach(pill => {
    pill.addEventListener('click', () => {
      tagPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');

      const filter = pill.getAttribute('data-filter-tag');
      let matchCount = 0;

      const feedContainer = document.getElementById('home-feed-posts');
      const feedCards = feedContainer ? feedContainer.querySelectorAll('.feed-card') : [];

      feedCards.forEach(card => {
        if (card.id === 'feed-empty-state') return;
        
        let tags = (card.getAttribute('data-tags') || '').toLowerCase();
        
        // --- MOBILE ENHANCED HASHTAG FILTERING ---
        if (window.innerWidth <= 768 && typeof window.renderHomeFeed === 'function') {
          // Break out of the loop and handle filtering below
          return;
        }
        // -----------------------------------------

        if (filter === 'all' || tags.split(' ').includes(filter.toLowerCase())) {
          card.style.display = 'flex';
          matchCount++;
        } else {
          card.style.display = 'none';
        }
      });
      
      // Mobile-only true re-rendering
      if (window.innerWidth <= 768 && typeof window.renderHomeFeed === 'function') {
        const allPosts = window.feedPosts || [];
        if (filter === 'all') {
          window.renderHomeFeed(allPosts);
        } else {
          const filterNorm = filter.toLowerCase().trim();
          const filtered = allPosts.filter(post => {
            let matches = false;
            const postTagsArr = post.topics || post.tags || post.hashtags || [];
            
            const checkTag = (t) => {
              if (t && String(t).toLowerCase().replace('#', '').trim() === filterNorm) matches = true;
            };
            
            if (Array.isArray(postTagsArr)) {
              postTagsArr.forEach(checkTag);
            } else if (typeof postTagsArr === 'string') {
              postTagsArr.split(',').forEach(checkTag);
            }
            
            if (post.caption) {
              // Exact hashtag match
              const hashMatches = post.caption.match(/#\w+/g);
              if (hashMatches) {
                hashMatches.forEach(m => {
                  if (m.toLowerCase().replace('#', '') === filterNorm) matches = true;
                });
              }
              // Word match (e.g. caption containing "love" without #)
              const wordRegex = new RegExp(`\\b${filterNorm}\\b`, 'i');
              if (wordRegex.test(post.caption)) matches = true;
            }
            
            if (post.content) {
              const wordRegex = new RegExp(`\\b${filterNorm}\\b`, 'i');
              if (wordRegex.test(post.content)) matches = true;
            }
            
            return matches;
          });
          
          if (filtered.length === 0) {
            const container = document.getElementById('home-feed-posts');
            if (container) {
              container.innerHTML = `
                <div id="feed-empty-state" style="text-align: center; padding: 48px 20px; background: var(--card-bg); border: var(--card-border); border-radius: var(--radius-lg); margin-top: 10px;">
                  <h3 style="font-family: var(--font-display); font-size: 16px; font-weight: 600; color: var(--text-main); margin-bottom: 6px;">No posts found for #${filter.toUpperCase()}</h3>
                </div>
              `;
            }
          } else {
            window.renderHomeFeed(filtered);
          }
        }
        return;
      }

      let emptyStateCard = document.getElementById('feed-empty-state');
      if (matchCount === 0) {
        if (!emptyStateCard) {
          emptyStateCard = document.createElement('div');
          emptyStateCard.id = 'feed-empty-state';
          emptyStateCard.style.cssText = 'text-align:center; padding:40px; color:rgba(255,255,255,0.5); width:100%; grid-column: 1/-1;';
          emptyStateCard.textContent = `No posts found for #${filter.toUpperCase()}`;
          if (feedContainer) feedContainer.appendChild(emptyStateCard);
        } else {
          emptyStateCard.style.display = 'block';
          emptyStateCard.textContent = `No posts found for #${filter.toUpperCase()}`;
        }
      } else {
        if (emptyStateCard) emptyStateCard.style.display = 'none';
      }

      showToast(`Filter: #${filter.toUpperCase()}`);
    });
  });


  // --- COLLABORATIVE FILE DOWNLOADS & FOLDER FILTER ---
  const mediaTabs = document.getElementById('media-hub-tabs');
  const mediaHubSearch = document.getElementById('media-search-input');

  if (mediaTabs) {
    const tabs = mediaTabs.querySelectorAll('.m-pill');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const filter = tab.getAttribute('data-media-filter');
        const mediaCards = document.querySelectorAll('#shared-media-items-grid .media-item-card');

        mediaCards.forEach(card => {
          const type = card.getAttribute('data-type');
          if (filter === 'all' || type === filter) {
            card.style.display = 'block';
          } else {
            card.style.display = 'none';
          }
        });
      });
    });
  }

  if (mediaHubSearch) {
    mediaHubSearch.addEventListener('input', () => {
      const term = mediaHubSearch.value.toLowerCase().trim();
      const mediaCards = document.querySelectorAll('#shared-media-items-grid .media-item-card');

      mediaCards.forEach(card => {
        const name = card.querySelector('.file-name').textContent.toLowerCase();
        if (name.includes(term)) {
          card.style.display = 'block';
        } else {
          card.style.display = 'none';
        }
      });
    });
  }


  // --- SIMPLE BUTTON INTERACTIONS AND ALERTS ---

  // Disabled hardcoded follow suggestion listeners. Managed dynamically in loadFollowSuggestions()

  // Suggested Hubbers "See All" triggers
  document.querySelectorAll('#sug-see-all-btn, .sug-see-all-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSuggestedVibersModal();
    });
  });

  // Trending hash words click
  const trendItems = document.querySelectorAll('.trend-item');
  trendItems.forEach(item => {
    item.addEventListener('click', () => {
      const word = item.getAttribute('data-trend-word');
      switchView('home');
      // Set search bar value and trigger filter
      if (globalSearchInput) {
        globalSearchInput.value = `#${word}`;
        globalSearchInput.dispatchEvent(new Event('input'));
      }
      showToast(`Filtered feed: #${word} 🔥`);
    });
  });

  // --- PREMIUM EDIT PROFILE MODAL SYSTEM ---
  const editProfileModal = document.getElementById('edit-profile-modal');
  const editProfileBtn = document.getElementById('edit-profile-action-btn');
  const editProfileCloseBtn = document.getElementById('edit-profile-close-btn');
  const editProfileCancelBtn = document.getElementById('edit-profile-cancel-btn');
  const editProfileSaveBtn = document.getElementById('edit-profile-save-btn');

  // Inputs
  const editNameInput = document.getElementById('edit-profile-name-input');
  const editHandleInput = document.getElementById('edit-profile-handle-input');
  const editBioInput = document.getElementById('edit-profile-bio-input');
  const editPhoneInput = document.getElementById('edit-profile-phone-input');
  const edit2faSelect = document.getElementById('edit-profile-2fa-preference');

  // Files
  const avatarFileInput = document.getElementById('edit-profile-avatar-file');
  const bannerFileInput = document.getElementById('edit-profile-banner-file');
  const uploadAvatarTrigger = document.getElementById('upload-avatar-trigger-btn');
  const uploadBannerTrigger = document.getElementById('upload-banner-trigger-btn');

  // Previews inside Modal
  const avatarPreview = document.getElementById('edit-profile-avatar-preview');
  const bannerPreview = document.getElementById('edit-profile-banner-preview');

  // Fields to update on the main page
  const profileBannerImg = document.querySelector('.profile-banner img');
  const profileLargeAvatar = document.querySelector('.profile-screen-avatar');
  const profilePreviewAvatarImg = document.querySelector('.profile-preview-avatar img');
  const headerAvatarImg = document.querySelector('#header-profile-avatar img');
  const profileNameH2 = document.querySelector('.profile-summary-top h3');
  const profilePreviewNameH3 = document.querySelector('.profile-preview-info h3');
  const profileHandleP = document.querySelector('.profile-screen-handle');
  const profilePreviewHandleP = document.querySelector('.profile-preview-info p');
  const profileBioP = document.getElementById('profile-bio-text');

  let currentAvatarUrl = "";
  let currentBannerUrl = "";

  if (editProfileBtn) {
    editProfileBtn.addEventListener('click', () => {
      // Load current values
      if (editNameInput) {
        // Strip the HTML space if any
        const nameText = profileNameH2 ? profileNameH2.childNodes[0].textContent.trim() : "Alex Rivers";
        editNameInput.value = nameText;
      }
      if (editHandleInput) {
        editHandleInput.value = profileHandleP ? profileHandleP.textContent.trim() : "@alexrivers";
      }
      if (editBioInput) {
        editBioInput.value = profileBioP ? profileBioP.textContent.trim() : "";
      }

      // Load user preferences for phone and 2FA
      const currentUserStr = localStorage.getItem('invibeUser');
      if (currentUserStr) {
        try {
          const currentUser = JSON.parse(currentUserStr);
          if (editPhoneInput) editPhoneInput.value = currentUser.phoneNumber || "";
          if (edit2faSelect) edit2faSelect.value = currentUser.preferred2faMethod || "email";
        } catch (e) {
          console.error(e);
        }
      }

      // Previews
      if (avatarPreview && profileLargeAvatar) {
        avatarPreview.src = profileLargeAvatar.src;
        currentAvatarUrl = profileLargeAvatar.src;
      }
      
      const savedBanner = localStorage.getItem('invibeBannerImage') || currentUser?.bannerImage || currentUser?.cover_image_url || (profileBannerImg && profileBannerImg.src && !profileBannerImg.src.endsWith('/') && !profileBannerImg.src.includes('data:image/gif') ? profileBannerImg.src : '');
      currentBannerUrl = savedBanner || '';
      if (bannerPreview) {
        if (savedBanner) {
          bannerPreview.src = savedBanner;
          bannerPreview.style.opacity = '1';
        } else {
          bannerPreview.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40" viewBox="0 0 100 40"><rect width="100" height="40" fill="%231e1e2d"/></svg>';
          bannerPreview.style.opacity = '0.5';
        }
      }

      // Show modal
      if (editProfileModal) {
        editProfileModal.classList.add('active');
        editProfileModal.style.display = 'flex';
      }
    });
  }

  function closeEditProfileModal() {
    if (editProfileModal) {
      editProfileModal.classList.remove('active');
      editProfileModal.style.display = 'none';
    }
    updateAppUI();
  }

  if (editProfileCloseBtn) editProfileCloseBtn.addEventListener('click', closeEditProfileModal);
  if (editProfileCancelBtn) editProfileCancelBtn.addEventListener('click', closeEditProfileModal);

  // File upload trigger buttons
  if (uploadAvatarTrigger && avatarFileInput) {
    uploadAvatarTrigger.addEventListener('click', () => avatarFileInput.click());
  }
  if (uploadBannerTrigger && bannerFileInput) {
    uploadBannerTrigger.addEventListener('click', () => bannerFileInput.click());
  }

  // Previews on file select
  if (avatarFileInput) {
    avatarFileInput.addEventListener('change', () => {
      if (avatarFileInput.files.length > 0) {
        const file = avatarFileInput.files[0];
        const reader = new FileReader();
        reader.onload = (e) => {
          if (avatarPreview) avatarPreview.src = e.target.result;
          currentAvatarUrl = e.target.result;
        };
        reader.readAsDataURL(file);
      }
    });
  }

  if (bannerFileInput) {
    bannerFileInput.addEventListener('change', () => {
      if (bannerFileInput.files.length > 0) {
        const file = bannerFileInput.files[0];
        const reader = new FileReader();
        reader.onload = (e) => {
          if (bannerPreview) {
            bannerPreview.src = e.target.result;
            bannerPreview.style.opacity = '1';
          }
          currentBannerUrl = e.target.result;
        };
        reader.readAsDataURL(file);
      }
    });
  }

  // Save changes
  if (editProfileSaveBtn) {
    editProfileSaveBtn.addEventListener('click', async () => {
      const newName = editNameInput ? editNameInput.value.trim() : "";
      const newHandle = editHandleInput ? editHandleInput.value.trim() : "";
      const newBio = editBioInput ? editBioInput.value.trim() : "";
      const newPhone = editPhoneInput ? editPhoneInput.value.trim() : "";
      const new2faMethod = edit2faSelect ? edit2faSelect.value : "email";

      if (!newName || !newHandle) {
        showToast('Name and Handle are required! ⚠️');
        return;
      }

      let formattedHandle = newHandle.startsWith('@') ? newHandle.slice(1) : newHandle;
      formattedHandle = formattedHandle.trim().toLowerCase();

      const originalBtnHtml = editProfileSaveBtn.innerHTML;
      editProfileSaveBtn.disabled = true;
      editProfileSaveBtn.innerHTML = '<i data-lucide="loader" class="spin"></i> Saving...';
      if (window.debouncedCreateIcons) window.debouncedCreateIcons();

      const token = localStorage.getItem('invibe_jwt_token');

      // 1. Update local user session & localStorage DB
      const userStr = localStorage.getItem('invibeUser');
      const currentUser = userStr ? JSON.parse(userStr) : {};
      let resolvedAvatarUrl = currentAvatarUrl;
      let resolvedBannerUrl = currentBannerUrl;

      if (bannerFileInput && bannerFileInput.files && bannerFileInput.files.length > 0) {
        const file = bannerFileInput.files[0];
        if (!currentBannerUrl || !currentBannerUrl.startsWith('data:image')) {
          currentBannerUrl = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => resolve(currentBannerUrl || '');
            reader.readAsDataURL(file);
          });
          resolvedBannerUrl = currentBannerUrl;
        }
      }

      // 2. Perform backend & Supabase sync
      try {
        const res = await fetch(`${API_URL}/api/users/profile`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            fullName: newName,
            username: formattedHandle,
            bio: newBio,
            profileImage: currentAvatarUrl || undefined,
            bannerImage: currentBannerUrl || undefined,
            phoneNumber: newPhone,
            preferred2faMethod: new2faMethod
          })
        });

        if (res.ok) {
          const data = await res.json();
          if (data && data.user) {
            if (data.user.profileImage) resolvedAvatarUrl = data.user.profileImage;
            if (data.user.bannerImage) resolvedBannerUrl = data.user.bannerImage;
          }
        } else {
          const errData = await res.json().catch(() => ({}));
          console.warn("Backend profile sync error:", errData.error);
        }
      } catch (err) {
        console.warn("Backend profile sync notice:", err.message);
      } finally {
        if (editProfileSaveBtn) {
          editProfileSaveBtn.disabled = false;
          editProfileSaveBtn.innerHTML = originalBtnHtml;
          if (window.debouncedCreateIcons) window.debouncedCreateIcons();
        }
      }

      const updatedUser = {
        ...currentUser,
        fullName: newName,
        username: formattedHandle,
        bio: newBio,
        phoneNumber: newPhone,
        preferred2faMethod: new2faMethod,
        profileImage: resolvedAvatarUrl || currentUser.profileImage,
        bannerImage: resolvedBannerUrl || currentUser.bannerImage || currentUser.cover_image_url
      };

      localStorage.setItem('invibeUser', JSON.stringify(updatedUser));
      if (resolvedAvatarUrl && !resolvedAvatarUrl.startsWith('data:image/gif;base64')) {
        localStorage.setItem('invibeProfileImage', resolvedAvatarUrl);
      }
      if (resolvedBannerUrl && !resolvedBannerUrl.startsWith('data:image/gif;base64')) {
        localStorage.setItem('invibeBannerImage', resolvedBannerUrl);
      } else {
        localStorage.removeItem('invibeBannerImage');
      }
      localStorage.setItem('invibeBio', newBio);

      // Synchronize in-memory feed posts and comments
      const myId = (updatedUser.id || updatedUser._id || '').toString();
      if (Array.isArray(window.feedPosts)) {
        window.feedPosts.forEach(p => {
          const pAuthorId = (getUserIdentifier(p.author) || '').toString();
          if ((myId && pAuthorId === myId) || (p.author && p.author.username === formattedHandle)) {
            if (p.author) {
              p.author.profileImage = resolvedAvatarUrl;
              p.author.fullName = newName;
              p.author.username = formattedHandle;
            }
          }
          if (Array.isArray(p.comments)) {
            p.comments.forEach(c => {
              const cAuthorId = (getUserIdentifier(c.author) || '').toString();
              if ((myId && cAuthorId === myId) || (c.author && c.author.username === formattedHandle)) {
                if (c.author) {
                  c.author.profileImage = resolvedAvatarUrl;
                  c.author.fullName = newName;
                  c.author.username = formattedHandle;
                }
              }
            });
          }
        });
      }

      const displayHandle = newHandle.startsWith('@') ? newHandle : '@' + newHandle;

      // 1. Update text fields on profile page
      if (profileNameH2) {
        profileNameH2.innerHTML = `${newName}`;
        debouncedCreateIcons();
      }
      if (profilePreviewNameH3) profilePreviewNameH3.textContent = newName;
      if (profileHandleP) profileHandleP.textContent = displayHandle;
      if (profilePreviewHandleP) profilePreviewHandleP.textContent = displayHandle;
      if (profileBioP) profileBioP.textContent = newBio;

      // 2. Update images across all components
      if (resolvedAvatarUrl) {
        if (profileLargeAvatar) profileLargeAvatar.src = resolvedAvatarUrl;
        if (profilePreviewAvatarImg) profilePreviewAvatarImg.src = resolvedAvatarUrl;
        if (headerAvatarImg) headerAvatarImg.src = resolvedAvatarUrl;

        // Also update story user avatar if needed
        const storyViewerAvatar = document.getElementById('story-viewer-avatar');
        if (storyViewerAvatar) storyViewerAvatar.src = resolvedAvatarUrl;
      }

      const finalBannerUrl = resolvedBannerUrl || currentBannerUrl;
      if (finalBannerUrl) {
        if (profileBannerImg) {
          profileBannerImg.src = finalBannerUrl;
          profileBannerImg.style.display = 'block';
        }
        const sidebarBanner = document.querySelector('.sidebar-left .card-cover-bg');
        if (sidebarBanner) {
          sidebarBanner.style.backgroundImage = `url(${finalBannerUrl})`;
          sidebarBanner.style.backgroundSize = 'cover';
          sidebarBanner.style.backgroundPosition = 'center';
        }
      }

      updateAppUI();
      showToast('Profile updated successfully! ✨');
      closeEditProfileModal();
    });
  }

  // Saved/tagged tabs profile switcher
  const postsTab = document.getElementById('profile-posts-tab');
  const savedTab = document.getElementById('profile-saved-tab');
  const taggedTab = document.getElementById('profile-tagged-tab');
  const profileGrid = document.querySelector('.profile-posts-grid');

  const profileData = {
    posts: [
      "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=300&q=80",
      "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=300&q=80",
      "https://images.unsplash.com/photo-1504384308090-c894fdcc538d?auto=format&fit=crop&w=300&q=80"
    ],
    saved: [
      "https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=300&q=80",
      "https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&w=300&q=80",
      "https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=300&q=80"
    ],
    tagged: [
      "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=300&q=80",
      "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?auto=format&fit=crop&w=300&q=80",
      "https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=300&q=80"
    ]
  };

  function updateProfileGrid(tabName) {
    if (!profileGrid) return;
    const images = profileData[tabName] || [];
    profileGrid.innerHTML = images.map(imgSrc => `
      <div class="grid-post-card">
        <img src="${imgSrc}" alt="Profile item" />
      </div>
    `).join('');
  }

  function handleTabClick(activeTab, tabName, toastMessage) {
    [postsTab, savedTab, taggedTab].forEach(tab => {
      if (tab) tab.classList.remove('active');
    });
    if (activeTab) activeTab.classList.add('active');
    updateProfileGrid(tabName);
    if (toastMessage) showToast(toastMessage);
  }

  if (postsTab) postsTab.addEventListener('click', () => handleTabClick(postsTab, 'posts', 'Loading posts... 📸'));
  if (savedTab) savedTab.addEventListener('click', () => handleTabClick(savedTab, 'saved', 'Loading bookmarks... 🔖'));
  if (taggedTab) taggedTab.addEventListener('click', () => handleTabClick(taggedTab, 'tagged', 'Loading tagged content... 🏷️'));

  const profileOptionButtons = document.querySelectorAll('.profile-option-btn');
  const appearanceToggle = document.getElementById('profile-appearance-toggle');
  const profileLogoutBtn = document.getElementById('profile-logout-btn');

  // --- NEW MODALS SYSTEM ---
  const privacyModal = document.getElementById('privacy-settings-modal');
  const privacyCloseBtn = document.getElementById('privacy-modal-close-btn');
  const privacyCancelBtn = document.getElementById('privacy-modal-cancel-btn');
  const privacySaveBtn = document.getElementById('privacy-modal-save-btn');
  const privacyE2eeToggle = document.getElementById('privacy-e2ee-toggle');
  const privacyHideStoryList = document.getElementById('privacy-hide-story-list');

  const notificationsModal = document.getElementById('notifications-settings-modal');
  const notificationsCloseBtn = document.getElementById('notifications-modal-close-btn');
  const notificationsCancelBtn = document.getElementById('notifications-modal-cancel-btn');
  const notificationsSaveBtn = document.getElementById('notifications-modal-save-btn');

  const helpModal = document.getElementById('help-support-modal');
  const helpCloseBtn = document.getElementById('help-modal-close-btn');
  const helpCancelBtn = document.getElementById('help-modal-cancel-btn');
  const helpSubmitBtn = document.getElementById('help-modal-submit-btn');

  const aboutModal = document.getElementById('about-modal');
  const aboutCloseBtn = document.getElementById('about-modal-close-btn');
  const aboutOkBtn = document.getElementById('about-modal-ok-btn');


  function populatePrivacyStoryList() {
    if (!privacyHideStoryList) return;
    const hubbers = state.stories || [];
    privacyHideStoryList.innerHTML = hubbers.map((user, idx) => `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 4px 0;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <img src="${user.avatar}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;" />
          <span style="font-size: 0.85rem; color: var(--text-main);">${user.name}</span>
        </div>
        <input type="checkbox" class="hide-story-checkbox" data-username="${user.name}" style="accent-color: var(--accent-gradient, #f35626);" />
      </div>
    `).join('');

    const hiddenUsers = JSON.parse(localStorage.getItem('privacy_hidden_stories') || '[]');
    const checkboxes = privacyHideStoryList.querySelectorAll('.hide-story-checkbox');
    checkboxes.forEach(cb => {
      if (hiddenUsers.includes(cb.dataset.username)) {
        cb.checked = true;
      }
    });
  }

  if (privacyCloseBtn) privacyCloseBtn.addEventListener('click', () => privacyModal.classList.remove('active'));
  if (privacyCancelBtn) privacyCancelBtn.addEventListener('click', () => privacyModal.classList.remove('active'));
  if (privacySaveBtn) {
    privacySaveBtn.addEventListener('click', () => {
      const isE2ee = privacyE2eeToggle ? privacyE2eeToggle.checked : false;
      const hiddenUsers = [];
      if (privacyHideStoryList) {
        const checked = privacyHideStoryList.querySelectorAll('.hide-story-checkbox:checked');
        checked.forEach(cb => hiddenUsers.push(cb.dataset.username));
      }
      localStorage.setItem('privacy_e2ee_enabled', isE2ee);
      localStorage.setItem('privacy_hidden_stories', JSON.stringify(hiddenUsers));
      showToast('Privacy settings updated! 🔒');
      privacyModal.classList.remove('active');
    });
  }

  if (notificationsCloseBtn) notificationsCloseBtn.addEventListener('click', () => notificationsModal.classList.remove('active'));
  if (notificationsCancelBtn) notificationsCancelBtn.addEventListener('click', () => notificationsModal.classList.remove('active'));
  if (notificationsSaveBtn) {
    notificationsSaveBtn.addEventListener('click', () => {
      showToast('Notification settings updated! 🔔');
      notificationsModal.classList.remove('active');
    });
  }

  if (helpCloseBtn) helpCloseBtn.addEventListener('click', () => helpModal.classList.remove('active'));
  if (helpCancelBtn) helpCancelBtn.addEventListener('click', () => helpModal.classList.remove('active'));
  if (helpSubmitBtn) {
    helpSubmitBtn.addEventListener('click', () => {
      const msgVal = document.getElementById('help-message-input')?.value;
      if (msgVal) {
        showToast('Support ticket submitted successfully! 💬');
        if (document.getElementById('help-message-input')) document.getElementById('help-message-input').value = '';
        helpModal.classList.remove('active');
      } else {
        showToast('Please type a message before submitting. ⚠️');
      }
    });
  }

  if (aboutCloseBtn) aboutCloseBtn.addEventListener('click', () => aboutModal.classList.remove('active'));
  if (aboutOkBtn) aboutOkBtn.addEventListener('click', () => aboutModal.classList.remove('active'));



  if (appearanceToggle) {
    appearanceToggle.checked = document.body.classList.contains('light-theme');
    appearanceToggle.addEventListener('change', () => {
      const isLight = appearanceToggle.checked;
      applyTheme(isLight ? 'light' : 'dark', true);
      showToast(isLight ? 'Switched appearance on ☀️' : 'Switched appearance off 🌙');
    });
  }

  profileOptionButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      switch (action) {
        case 'edit-profile':
          if (editProfileModal) {
            editProfileModal.classList.add('active');
          }
          break;
        case 'vibe-settings':
          showToast('Opening Hubs Settings... ⚙️');
          switchView('settings');
          break;
        case 'privacy':
          if (privacyModal) {
            populatePrivacyStoryList();
            if (privacyE2eeToggle) {
              privacyE2eeToggle.checked = localStorage.getItem('privacy_e2ee_enabled') === 'true';
            }
            privacyModal.classList.add('active');
          }
          break;
        case 'notifications':
          if (notificationsModal) {
            notificationsModal.classList.add('active');
          }
          break;
        case 'help':
          if (helpModal) {
            helpModal.classList.add('active');
          }
          break;
        case 'about':
          if (aboutModal) {
            aboutModal.classList.add('active');
          }
          break;
        default:
          showToast('Action not available yet.');
      }
    });
  });

  if (profileLogoutBtn) {
    profileLogoutBtn.addEventListener('click', () => {
      localStorage.removeItem('invibeIsLoggedIn');
      localStorage.removeItem('invibeUser');
      localStorage.removeItem('invibeProfileImage');
      localStorage.removeItem('invibe_jwt_token');
      showToast('Logged out successfully. 👋');
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    });
  }

  // --- REELS SAVE INTERACTION SYSTEM ---
  const reelSaveActionItems = document.querySelectorAll('.reel-save-action');
  const reelThumbnails = {
    "1": "https://images.unsplash.com/photo-1504384308090-c894fdcc538d?auto=format&fit=crop&w=300&q=80", // Tech Setup (for Coding Reel)
    "2": "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=300&q=80"  // Mountain Lake (for Offsite Reel)
  };

  reelSaveActionItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const reelId = item.getAttribute('data-reel-id');
      const starBtn = item.querySelector('.action-circle-btn');
      const textSpan = item.querySelector('.action-count');
      const thumbnailSrc = reelThumbnails[reelId];

      if (!starBtn.classList.contains('active')) {
        // Save the Reel
        starBtn.classList.add('active');
        if (textSpan) textSpan.textContent = 'Saved';

        // Add to profileData.saved
        if (thumbnailSrc && !profileData.saved.includes(thumbnailSrc)) {
          profileData.saved.unshift(thumbnailSrc); // prepend so it appears first
        }

        showToast('Reel saved to profile! ⭐');
      } else {
        // Unsave the Reel
        starBtn.classList.remove('active');
        if (textSpan) textSpan.textContent = 'Save';

        // Remove from profileData.saved
        if (thumbnailSrc) {
          const index = profileData.saved.indexOf(thumbnailSrc);
          if (index > -1) {
            profileData.saved.splice(index, 1);
          }
        }

        showToast('Reel removed from saved! 🗑️');
      }

      // If the user is currently viewing the 'saved' tab on the profile page, refresh the grid
      if (savedTab && savedTab.classList.contains('active')) {
        updateProfileGrid('saved');
      }
    });
  });

  // Inbox drop items click alerts
  const drGroup = document.getElementById('dr-new-group');
  const drBroad = document.getElementById('dr-new-broad');
  const drInvite = document.getElementById('dr-invite');
  const drScan = document.getElementById('dr-scan');
  const drStarred = document.getElementById('dr-starred');
  const drArchived = document.getElementById('dr-archived');
  const drSettings = document.getElementById('dr-settings');
  const newChatBtn = document.getElementById('new-chat-btn');
  const newChatDropdown = document.getElementById('new-chat-dropdown');

  if (newChatBtn && newChatDropdown) {
    newChatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      newChatDropdown.classList.toggle('active');
    });

    document.addEventListener('click', (e) => {
      if (!newChatDropdown.contains(e.target) && e.target !== newChatBtn) {
        newChatDropdown.classList.remove('active');
      }
    });
  }

  function handleDropdownClick() {
    if (newChatDropdown) {
      newChatDropdown.classList.remove('active');
    }
  }

  if (drGroup) drGroup.addEventListener('click', () => { handleDropdownClick(); showToast('Setup New Chat Group lobby 👥'); });
  if (drBroad) drBroad.addEventListener('click', () => { handleDropdownClick(); showToast('Broadcasting system active 📻'); });
  if (drInvite) drInvite.addEventListener('click', () => { handleDropdownClick(); showToast('Invitation code copied: HUBBLE-2026 🎟️'); });
  if (drScan) drScan.addEventListener('click', () => { handleDropdownClick(); showToast('Access camera feed for QR Scan... 📷'); });
  if (drStarred) drStarred.addEventListener('click', () => { handleDropdownClick(); showToast('Starred message filter active ⭐'); });
  if (drArchived) drArchived.addEventListener('click', () => { handleDropdownClick(); showToast('Archived threads loaded 📦'); });
  if (drSettings) drSettings.addEventListener('click', () => {
    handleDropdownClick();
    switchView('settings');
    showToast('Opening Settings Dashboard... ⚙️');
  });
  // --- DASHBOARD SETTINGS CONTROLLER ---
  const colorPickerDots = document.querySelectorAll('.color-picker-dot');
  const toggleCaustics = document.getElementById('toggle-caustics-checkbox');
  const togglePrivacy = document.getElementById('toggle-privacy-checkbox');
  const toggleNotif = document.getElementById('toggle-notif-checkbox');

  // Theme Accent Picker
  colorPickerDots.forEach(dot => {
    dot.addEventListener('click', () => {
      colorPickerDots.forEach(d => d.classList.remove('active'));
      dot.classList.add('active');

      const selectedColor = dot.getAttribute('data-color');
      document.documentElement.style.setProperty('--primary', selectedColor);

      showToast(`Accent color updated! 🎨`);
    });
  });

  // Toggle Caustics Overlay
  if (toggleCaustics) {
    toggleCaustics.addEventListener('change', () => {
      const isEnabled = toggleCaustics.checked;
      if (isEnabled) {
        document.documentElement.style.setProperty('--bg-caustics', 'radial-gradient(circle at 20% 30%, rgba(108, 59, 255, 0.15) 0%, transparent 40%), radial-gradient(circle at 80% 70%, rgba(255, 79, 163, 0.1) 0%, transparent 45%)');
        showToast('Ambient caustics enabled ✨');
      } else {
        document.documentElement.style.setProperty('--bg-caustics', 'none');
        showToast('Ambient caustics disabled');
      }
    });
  }

  // Toggles Privacy / Notifications
  if (togglePrivacy) {
    togglePrivacy.addEventListener('change', () => {
      showToast(togglePrivacy.checked ? 'Account set to Private 🔒' : 'Account set to Public 🌐');
    });
  }
  if (toggleNotif) {
    toggleNotif.addEventListener('change', () => {
      showToast(toggleNotif.checked ? 'Notifications Enabled 🔔' : 'Notifications Silenced 🔕');
    });
  }

  // --- COMMENTS & SHARE MODALS CONTROLLER ---
  // --- COMMENTS & SHARE MODALS CONTROLLER ---
  const commentsModal = document.getElementById('comments-modal');
  const shareModal = document.getElementById('share-modal');
  if (shareModal) shareModal.style.zIndex = '3000';
  if (commentsModal) commentsModal.style.zIndex = '3000';

  document.querySelectorAll('.modal-close-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.story-viewer-overlay');
      if (modal) modal.classList.remove('active');
    });
  });

  window.handleSharedHubClick = function (type, id) {
    if (type === 'story') {
      if (state.storyGroups) {
        for (let gIdx = 0; gIdx < state.storyGroups.length; gIdx++) {
          const sIdx = (state.storyGroups[gIdx].stories || []).findIndex(s => s._id === id || ('story_' + s._id) === id);
          if (sIdx !== -1) {
            openStoryViewer(gIdx, sIdx);
            return;
          }
        }
      }
      if (typeof openStoryViewer === 'function' && state.storyGroups && state.storyGroups.length > 0) {
        openStoryViewer(0, 0);
      } else {
        switchView('feed');
      }
    } else if (type === 'reel') {
      switchView('explore');
    } else {
      switchView('feed');
    }
  };

  let shareSearchDebounceTimer = null;
  let cachedShareUsers = [];
  let currentShareSelection = new Map();
  let currentShareKey = null;

  function updateShareFooter(modal) {
    if (!modal) return;
    const footer = modal.querySelector('.share-modal-footer');
    if (!footer) return;
    const countSpan = footer.querySelector('.share-selection-count');
    if (currentShareSelection.size > 0) {
      footer.style.display = 'flex';
      if (countSpan) countSpan.innerText = `${currentShareSelection.size} selected`;
    } else {
      footer.style.display = 'none';
    }
  }

  function openShare(key, modalOverride = shareModal) {
    currentShareSelection.clear();
    currentShareKey = key;
    const modal = modalOverride || shareModal;
    if (modal) updateShareFooter(modal);
    if (!modal) return;

    const shareList = modal.querySelector('.share-friends-list');
    if (!shareList) return;

    const searchInput = modal.querySelector('#share-search-input') || modal.querySelector('.share-search-input');
    if (searchInput) {
      searchInput.value = '';
      if (!searchInput.dataset.boundSearch) {
        searchInput.dataset.boundSearch = 'true';
        searchInput.addEventListener('input', (e) => {
          const query = e.target.value.trim();
          clearTimeout(shareSearchDebounceTimer);
          shareSearchDebounceTimer = setTimeout(() => {
            if (!query) {
              renderShareCards(cachedShareUsers, key, modal, shareList);
              return;
            }
            const filteredHubbies = cachedShareUsers.filter(u =>
              (u.fullName || '').toLowerCase().includes(query.toLowerCase()) ||
              (u.username || '').toLowerCase().includes(query.toLowerCase())
            );
            renderShareCards(filteredHubbies, key, modal, shareList);
          }, 150);
        });

        // Ensure when user taps/focuses the input, it shows all hubbies
        searchInput.addEventListener('focus', () => {
          const query = searchInput.value.trim();
          if (!query) {
            renderShareCards(cachedShareUsers, key, modal, shareList);
          }
        });
      }
    }

    renderShareFriends(key, modal, shareList);
    modal.classList.add('active');
  }

  async function renderShareFriends(key, modal = shareModal, shareList = null) {
    const list = shareList || modal?.querySelector('.share-friends-list');
    if (!list) return;

    list.innerHTML = '<div style="padding:10px; font-size:12px; color:var(--text-muted); text-align:center; grid-column: 1 / -1;">Loading Hubbies...</div>';

    const token = localStorage.getItem('invibe_jwt_token');
    const currentUser = getCurrentUser();
    if (!token || !currentUser) {
      list.innerHTML = '<div style="padding:10px; font-size:12px; color:var(--text-muted); text-align:center; grid-column: 1 / -1;">Please log in to share with Hubbies.</div>';
      return;
    }

    try {
      const currentUserId = (currentUser.id || currentUser._id || '').toString();
      const userMap = new Map();

      console.log("diagnostic-share: currentUser =", currentUser);
      console.log("diagnostic-share: currentUserId =", currentUserId);
      console.log("diagnostic-share: token =", token);
      console.log("diagnostic-share: API_URL =", API_URL);

      // 1. Fetch Following list
      try {
        const followingRes = await fetch(`${API_URL}/api/users/${currentUserId}/following-list`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log("diagnostic-share: followingRes status =", followingRes.status);
        if (followingRes.status === 401) {
          console.warn("Session expired. Logging out.");
          if (typeof handleLogout === 'function') handleLogout();
          return;
        }
        if (followingRes.ok) {
          const followings = await followingRes.json();
          console.log("diagnostic-share: followings =", followings);
          (followings || []).forEach(f => {
            const fid = (f._id || f.id || '').toString();
            if (fid && fid !== currentUserId) {
              userMap.set(fid, {
                _id: f._id || f.id,
                fullName: f.fullName || f.username || 'Hubber',
                username: f.username || 'user',
                profileImage: f.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80'
              });
            }
          });
        } else {
          console.error("diagnostic-share: followingRes failed", followingRes.statusText);
        }
      } catch (err) {
        console.warn('Error fetching following for share popup:', err);
      }

      // 2. Fetch Followers list
      try {
        const followersRes = await fetch(`${API_URL}/api/users/${currentUserId}/followers-list`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log("diagnostic-share: followersRes status =", followersRes.status);
        if (followersRes.status === 401) {
          console.warn("Session expired. Logging out.");
          if (typeof handleLogout === 'function') handleLogout();
          return;
        }
        if (followersRes.ok) {
          const followers = await followersRes.json();
          console.log("diagnostic-share: followers =", followers);
          (followers || []).forEach(f => {
            const fid = (f._id || f.id || '').toString();
            if (fid && fid !== currentUserId) {
              userMap.set(fid, {
                _id: f._id || f.id,
                fullName: f.fullName || f.username || 'Hubber',
                username: f.username || 'user',
                profileImage: f.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80'
              });
            }
          });
        } else {
          console.error("diagnostic-share: followersRes failed", followersRes.statusText);
        }
      } catch (err) {
        console.warn('Error fetching followers for share popup:', err);
      }

      // 3. Fallback: Retrieve existing chat conversations
      try {
        const threadsRes = await fetch(`${API_URL}/api/chats/threads`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (threadsRes.ok) {
          const threads = await threadsRes.json();
          (threads || []).forEach(t => {
            const u = t.user;
            if (u && (u._id || u.id)) {
              const uid = (u._id || u.id).toString();
              if (uid !== currentUserId) {
                userMap.set(uid, {
                  _id: u._id || u.id,
                  fullName: u.fullName || u.username || 'Hubber',
                  username: u.username || 'user',
                  profileImage: u.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80'
                });
              }
            }
          });
        }
      } catch (threadsErr) {
        console.warn('Error fetching threads for share popup:', threadsErr);
      }

      cachedShareUsers = Array.from(userMap.values());
      renderShareCards(cachedShareUsers, key, modal, list);
    } catch (err) {
      console.error('Error rendering friends share list:', err);
      list.innerHTML = '<div style="padding:10px; font-size:12px; color:var(--text-muted); text-align:center; grid-column: 1 / -1;">Failed to load friends.</div>';
    }
  }

  function renderShareCards(users, key, modal, list) {
    list.innerHTML = '';

    if (!users || users.length === 0) {
      list.innerHTML = '<div style="padding:16px; font-size:12px; color:var(--text-muted); text-align:center; grid-column: 1 / -1;">No Hubbies found.</div>';
      return;
    }

    const token = localStorage.getItem('invibe_jwt_token');
    const currentUser = getCurrentUser();
    const currentUserId = currentUser ? (currentUser.id || currentUser._id) : null;

    users.forEach(u => {
      if (!u || !u._id) return;

      const card = document.createElement('div');
      card.className = 'share-friend-card';
      card.title = `${u.fullName} (@${u.username})`;
      if (currentShareSelection.has(u._id)) {
        card.classList.add('selected');
      }

      card.innerHTML = `
        <div style="position: relative; display: inline-block;">
          <img src="${u.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80'}" class="share-friend-avatar" alt="${u.fullName}" />
          <div class="share-friend-card-check"><i data-lucide="check" style="width: 12px; height: 12px; color: white;"></i></div>
        </div>
        <span class="share-friend-name" style="font-weight: 600; font-size: 12px; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center;">${u.fullName}</span>
        <span style="font-size: 10px; color: var(--text-muted); width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center;">@${u.username}</span>
      `;

      card.addEventListener('click', () => {
        if (!currentUser || !token) return;

        if (currentShareSelection.has(u._id)) {
          currentShareSelection.delete(u._id);
          card.classList.remove('selected');
        } else {
          currentShareSelection.set(u._id, u);
          card.classList.add('selected');
        }
        updateShareFooter(modal);
      });

      list.appendChild(card);
    });
  }

  // Handle comment click events (focuses the inline comment input field on dynamic posts or opens modal)
  let currentCommentPostId = null;

  if (commentsModal) {
    const sendBtn = commentsModal.querySelector('.comment-send-btn');
    const inputField = commentsModal.querySelector('input');

    if (sendBtn && inputField) {
      sendBtn.addEventListener('click', async () => {
        const text = inputField.value.trim();
        if (text && currentCommentPostId) {
          await submitComment(currentCommentPostId, text, inputField);
        }
      });
      inputField.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const text = inputField.value.trim();
          if (text && currentCommentPostId) {
            await submitComment(currentCommentPostId, text, inputField);
          }
        }
      });
    }
  }

  // Multi-Share submission logic
  document.addEventListener('click', async (e) => {
    const submitBtn = e.target.closest('.multi-share-submit-btn');
    if (submitBtn && currentShareSelection.size > 0 && currentShareKey) {
      e.preventDefault();
      e.stopPropagation();

      const token = localStorage.getItem('invibe_jwt_token');
      const currentUser = getCurrentUser();
      const currentUserId = currentUser ? (currentUser.id || currentUser._id) : null;
      if (!currentUser || !token) return;

      const originalContent = submitBtn.innerHTML;
      submitBtn.disabled = true;
      submitBtn.innerHTML = `<i data-lucide="loader" class="animate-spin" style="width: 14px; height: 14px;"></i>`;
      lucide.createIcons({ icons: { loader: window.lucide.icons.Loader } });

      try {
        const key = currentShareKey;
        const isStory = key.startsWith('story_');
        const isReel = key.startsWith('reel_') || key.startsWith('reel');
        const isPost = key.startsWith('post_');
        const isForward = key.startsWith('forward_');
        const rawId = key.replace(/^(story_|reel_|post_|forward_)/, '');

        let hubPayload = {
          text: isStory ? 'Shared a Hub Story' : (isReel ? 'Shared a Reel' : (isForward ? 'Forwarded Message' : 'Shared a Post')),
          hubType: isStory ? 'story' : (isReel ? 'reel' : (isForward ? 'forward' : 'post')),
          hubId: rawId,
          thumbnail: '',
          isVideo: false,
          authorName: currentUser.fullName || currentUser.username || 'Hubber',
          authorAvatar: currentUser.profileImage || '',
          timestamp: new Date().toISOString()
        };

        if (isForward) {
           const bubble = document.querySelector(`.chat-bubble[data-msg-id="${rawId}"]`);
           if (bubble) {
               let forwardText = bubble.getAttribute('data-raw-text') || '';
               forwardText = forwardText.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
               if (!forwardText || forwardText === '[Decryption Failed]') {
                  if (bubble.querySelector('a[download]')) forwardText = bubble.querySelector('a[download]').href;
                  else if (bubble.querySelector('img')) forwardText = bubble.querySelector('img').src;
                  else if (bubble.querySelector('video')) forwardText = bubble.querySelector('video').src;
                  else forwardText = 'Forwarded Message';
               }
               hubPayload.text = forwardText;
           }
        }

        if (isStory && state.storyGroups) {
          state.storyGroups.forEach(g => {
            (g.stories || []).forEach(s => {
              if (s._id === rawId || ('story_' + s._id) === key) {
                hubPayload.thumbnail = s.img || '';
                hubPayload.authorName = s.name || hubPayload.authorName;
                hubPayload.authorAvatar = s.avatar || '';
                hubPayload.text = s.caption ? `Shared a Hub: "${s.caption}"` : 'Shared a Hub Story';
              }
            });
          });
        }

        if (isPost) {
          let postObj = null;
          if (window.feedPosts) {
            postObj = window.feedPosts.find(p => p._id === rawId);
          }
          if (!postObj) {
            try {
              const res = await fetch(`${API_URL}/api/posts/${rawId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
              });
              if (res.ok) {
                postObj = await res.json();
              }
            } catch (err) {
              console.error("Error fetching post for sharing:", err);
            }
          }

          if (postObj) {
            let thumbnail = '';
            let isVideo = false;
            if (postObj.mediaItems && postObj.mediaItems.length > 0) {
              thumbnail = postObj.mediaItems[0].url || '';
              isVideo = postObj.mediaItems[0].type === 'video';
            } else if (postObj.mediaUrl) {
              thumbnail = postObj.mediaUrl;
              isVideo = postObj.mediaType === 'video';
            }
            hubPayload.thumbnail = thumbnail;
            hubPayload.isVideo = isVideo;
            hubPayload.authorName = postObj.author?.fullName || postObj.author?.username || 'Hubber';
            hubPayload.authorAvatar = postObj.author?.profileImage || '';
            hubPayload.text = postObj.caption ? `Shared a Post: "${postObj.caption}"` : 'Shared a Post';
          }
        }

        if (isReel) {
          let reelObj = null;
          if (window.feedReels) {
            reelObj = window.feedReels.find(r => (r._id || r.id || '').toString() === rawId.toString());
          }
          if (reelObj) {
            hubPayload.thumbnail = reelObj.videoUrl || '';
            hubPayload.isVideo = true;
            hubPayload.authorName = reelObj.author?.fullName || reelObj.author?.username || 'Hubber';
            hubPayload.authorAvatar = reelObj.author?.profileImage || '';
            hubPayload.text = reelObj.caption ? `Shared a Reel: "${reelObj.caption}"` : 'Shared a Reel';
          }
        }

        const payloadString = isForward ? hubPayload.text : JSON.stringify(hubPayload);
        let successCount = 0;
        const promises = Array.from(currentShareSelection.values()).map(async (u) => {
          const secretKey = getChatSecretKey(currentUserId, u._id);
          const encryptedText = encryptMessage(payloadString, secretKey);

          const sendRes = await fetch(`${API_URL}/api/chats/message`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              recipient: u._id,
              content: encryptedText,
              mediaUrl: isForward ? '' : key,
              mediaType: isForward ? 'text' : 'hub',
              mediaName: isForward ? '' : (isStory ? 'Shared Hub Story' : (isReel ? 'Shared Reel' : 'Shared Post')),
              mediaSize: isForward ? '' : 'Link'
            })
          });

          if (sendRes.ok) successCount++;
        });

        await Promise.allSettled(promises);

        if (successCount > 0) {
          showToast(`Shared successfully to ${successCount} Hubbie${successCount > 1 ? 's' : ''}! ✈️`);
        } else {
          showToast('Failed to share item.');
        }

        const modal = submitBtn.closest('.story-viewer-overlay');
        if (modal) modal.classList.remove('active');
        currentShareSelection.clear();
        currentShareKey = null;

        loadChatThreads();
        // Not doing specific fetchMessages unless single share but this is fine

      } catch (err) {
        console.error('Error in multi-share:', err);
        showToast('Failed to share item.');
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalContent;
      }
    }
  });

  // Share trigger click
  document.addEventListener('click', async (e) => {
    const shareBtn = e.target.closest('.share-btn-action, .share-btn, .feed-share-btn');
    if (shareBtn) {
      e.preventDefault();
      e.stopPropagation();

      const card = shareBtn.closest('.feed-card');
      const postId = shareBtn.getAttribute('data-post-id') || card?.getAttribute('data-post-id') || card?.id?.replace('post-', '') || '1';

      const localModal = card?.querySelector('.feed-share-modal') || document.getElementById('share-modal');

      openShare('post_' + postId, localModal);
    }
  });

  // ─── LIVE DATABASE & FEED POSTS INTEGRATION WITH SWR CACHING ───
  let _cachedFeedPosts = null;
  let _lastFeedFetchTime = 0;
  let _feedPostsInFlightPromise = null;
  let _lastRenderedFeedFingerprint = '';
  const FEED_CACHE_TTL = 60 * 1000; // 60 seconds

  async function loadFeedPosts(forceRefresh = false) {
    const feedContainer = document.getElementById('home-feed-posts');
    if (!feedContainer) return;

    const now = Date.now();
    const isCacheFresh = _cachedFeedPosts && (now - _lastFeedFetchTime < FEED_CACHE_TTL);

    // If cache exists, render from memory immediately without blanking or flickering
    if (_cachedFeedPosts && _cachedFeedPosts.length > 0) {
      if (feedContainer.children.length === 0 || forceRefresh) {
        window.renderHomeFeed(_cachedFeedPosts);
      }
      if (!forceRefresh && isCacheFresh) {
        return;
      }
    }

    if (_feedPostsInFlightPromise) {
      return _feedPostsInFlightPromise;
    }

    _feedPostsInFlightPromise = (async () => {
      try {
        const res = await fetch(`${API_URL}/api/posts`);
        if (res.ok) {
          const posts = await res.json();
          _cachedFeedPosts = posts;
          _lastFeedFetchTime = Date.now();
          window.feedPosts = posts;
          window.renderHomeFeed(posts);
        }
      } catch (err) {
        console.warn("API loadFeedPosts notice:", err.message);
      } finally {
        _feedPostsInFlightPromise = null;
      }
    })();

    return _feedPostsInFlightPromise;
  }

  window.renderHomeFeed = function(postsToRender, forceRebuild = false) {
    const feedContainer = document.getElementById('home-feed-posts');
    if (!feedContainer) return;

    if (!postsToRender || postsToRender.length === 0) {
      if (_lastRenderedFeedFingerprint !== 'empty' || forceRebuild) {
        _lastRenderedFeedFingerprint = 'empty';
        feedContainer.innerHTML = `
          <div id="feed-empty-state" style="text-align: center; padding: 48px 20px; background: var(--card-bg); border: var(--card-border); border-radius: var(--radius-lg); margin-top: 10px;">
            <div style="font-size: 32px; margin-bottom: 10px;">✨</div>
            <h3 style="font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--text-main); margin-bottom: 6px;">No posts published yet</h3>
            <p style="font-size: 13px; color: var(--text-muted); margin: 0;">Be the first to share a hub with the world using the form above!</p>
          </div>
        `;
      }
      return;
    }

    const currentUserStr = localStorage.getItem('invibeUser');
    const currentUser = currentUserStr ? JSON.parse(currentUserStr) : null;
    const currentUserId = currentUser ? (currentUser.id || currentUser._id) : null;

    // Generate deterministic fingerprint of feed state
    const currentFingerprint = postsToRender.map(p => {
      const pid = p._id || p.id;
      const likesCount = Array.isArray(p.likes) ? p.likes.length : (p.likesCount || 0);
      const isLiked = currentUser ? (p.likes || []).includes(currentUserId) : false;
      const isSaved = window.savedHubbs && window.savedHubbs.some(s => (s.id || s._id) === pid);
      const commentsCount = Array.isArray(p.comments) ? p.comments.length : (p.commentCount || 0);
      return `${pid}_${likesCount}_${isLiked ? 1 : 0}_${isSaved ? 1 : 0}_${commentsCount}`;
    }).join('|');

    if (!forceRebuild && currentFingerprint === _lastRenderedFeedFingerprint && feedContainer.children.length > 0) {
      return; // 100% Identical feed already in DOM — skip destructive DOM wipe!
    }

    _lastRenderedFeedFingerprint = currentFingerprint;
    feedContainer.innerHTML = '';

    const storedFollowing = JSON.parse(localStorage.getItem('invibe_following_users') || '[]');
    const storedPending = JSON.parse(localStorage.getItem('invibe_pending_users') || '[]');
    const followingSet = new Set(storedFollowing);
    const pendingSet = new Set(storedPending);

    postsToRender.forEach(post => {
      const isLikedByMe = currentUser ? (post.likes || []).includes(currentUserId) : false;
      const isSavedByMe = window.savedHubbs && window.savedHubbs.some(s => s.id === post._id);
      const authorObj = post.author || {};
      const authorId = getUserIdentifier(authorObj) || 'usr_unknown';
      const authorName = authorObj.fullName || authorObj.username || 'User';
      const authorUsername = authorObj.username || 'user';
      const isMe = !!(currentUserId && (currentUserId.toString() === authorId.toString() || (currentUser?.username && currentUser.username.toLowerCase() === authorUsername.toLowerCase())));
      const isFollowing = followingSet.has(authorId);
      const isPending = pendingSet.has(authorId);

      const localUserAvatar = localStorage.getItem('invibeProfileImage') || currentUser?.profileImage;
      const resolvedAuthorAvatar = (isMe && localUserAvatar)
        ? localUserAvatar
        : (authorObj.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&h=80&q=80');

      const card = document.createElement('article');
      card.className = 'feed-card';
      card.id = `post-${post._id}`;
      // Extract hashtags from caption (e.g. #happy, #chill)
      const hashtags = ['all'];
      if (post.caption) {
        const matches = post.caption.match(/#\w+/g);
        if (matches) {
          matches.forEach(m => {
            hashtags.push(m.toLowerCase().replace('#', ''));
          });
        }
      }
      card.setAttribute('data-tags', hashtags.join(' '));

      const shouldRenderComments = window.innerWidth > 768 || window.activeCommentPostId === post._id;

      card.innerHTML = `
        <div class="post-header">
          <div class="post-author-info">
            <img src="${resolvedAuthorAvatar}" alt="${authorName}" loading="lazy" decoding="async" class="author-avatar" style="cursor: pointer;" data-user-id="${authorId}" />
            <div class="post-author-text">
              <div class="post-author-title-row">
                <h4 class="author-name" style="margin: 0; cursor: pointer;" data-user-id="${authorId}">${authorName}</h4>
                <span class="author-handle">@${authorUsername}</span>
              </div>
              <div class="post-meta">
                <span class="post-time">${new Date(post.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <span class="dot-separator">•</span>
                <i data-lucide="globe" class="meta-icon"></i>
                ${post.location ? `
                  <span class="dot-separator">•</span>
                  <span class="post-location">
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:block; flex-shrink: 0;"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                    <span class="post-location-text">${post.location}</span>
                  </span>
                ` : ''}
              </div>
            </div>
          </div>
          <div class="post-header-actions">
            ${!isMe ? `
              <button type="button" class="btn-follow-user ${isFollowing ? 'following' : (isPending ? 'pending' : '')}" data-user-id="${authorId}" data-username="${authorUsername}">
                ${isFollowing ? 'Following' : (isPending ? 'Requested' : '+ Follow')}
              </button>
            ` : ''}
            <button class="post-options-btn" data-post-id="${post._id}" data-author-id="${authorId}"><i data-lucide="more-horizontal"></i></button>
          </div>
        </div>

        ${(() => {
          const rawMediaItems = Array.isArray(post.mediaItems) ? post.mediaItems : [];
          const validItems = rawMediaItems.filter(item => item && item.url && !item.url.trim().toLowerCase().startsWith('blob:'));
          const singleMediaUrl = (post.mediaUrl && !post.mediaUrl.trim().toLowerCase().startsWith('blob:')) ? post.mediaUrl : (validItems[0]?.url || '');
          const hasMedia = validItems.length > 0 || !!singleMediaUrl;

          if (!hasMedia) return '';

          return `
            <div class="post-media-container" style="position:relative; overflow:hidden; border-radius: 12px; margin: 12px 0;">
              ${(validItems.length > 1)
              ? `
                <div class="post-carousel-wrapper" style="position: relative; width: 100%; max-height: 480px; overflow: hidden; display: flex; flex-direction: column;">
                  <div class="post-carousel-slides" onscroll="((container) => {
                    const index = Math.round(container.scrollLeft / container.clientWidth);
                    const dots = container.parentNode.querySelectorAll('.carousel-dot');
                    dots.forEach((dot, idx) => {
                      dot.style.background = idx === index ? '#6C3BFF' : 'rgba(255, 255, 255, 0.5)';
                      dot.style.transform = idx === index ? 'scale(1.2)' : 'scale(1)';
                    });
                  })(this)" style="display: flex; overflow-x: auto; overflow-y: hidden; scroll-snap-type: x mandatory; scrollbar-width: none; -ms-overflow-style: none; width: 100%; height: 100%;">
                    ${validItems.map((item, idx) => `
                      <div class="carousel-slide-item" style="flex: 0 0 100%; width: 100%; height: 100%; scroll-snap-align: start; display: flex; justify-content: center; align-items: center; background: #000; position: relative; overflow: hidden;">
                        ${item.type === 'video'
                  ? `<video src="${item.url}" controls loop muted playsinline style="width: 100%; max-height: 100%; object-fit: contain; display: block;" class="post-media-video"></video>`
                  : `<img src="${item.url}" alt="Post Media ${idx + 1}" loading="lazy" decoding="async" class="post-media-img" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; display: block;" />`
                }
                      </div>
                    `).join('')}
                  </div>
                  
                  <!-- Bottom Controls with chevrons beside the dots -->
                  <div class="carousel-controls-bottom" style="position: absolute; bottom: 12px; left: 0; right: 0; display: flex; justify-content: center; align-items: center; gap: 12px; z-index: 5;">
                    <button class="carousel-nav-btn prev-btn" onclick="this.parentNode.parentNode.querySelector('.post-carousel-slides').scrollBy({left: -this.parentNode.parentNode.clientWidth, behavior: 'smooth'})" style="background: rgba(0,0,0,0.5); border: none; border-radius: 50%; width: 22px; height: 22px; color: white; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 11px; font-weight: bold; outline: none; transition: all 0.2s ease;">‹</button>
                    
                    <div class="carousel-dots-container" style="display: flex; gap: 6px; pointer-events: none; align-items: center;">
                      ${validItems.map((_, idx) => `
                        <span class="carousel-dot ${idx === 0 ? 'active' : ''}" style="width: 6px; height: 6px; border-radius: 50%; background: ${idx === 0 ? '#6C3BFF' : 'rgba(255, 255, 255, 0.5)'}; transition: all 0.2s ease;"></span>
                      `).join('')}
                    </div>
                    
                    <button class="carousel-nav-btn next-btn" onclick="this.parentNode.parentNode.querySelector('.post-carousel-slides').scrollBy({left: this.parentNode.parentNode.clientWidth, behavior: 'smooth'})" style="background: rgba(0,0,0,0.5); border: none; border-radius: 50%; width: 22px; height: 22px; color: white; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 11px; font-weight: bold; outline: none; transition: all 0.2s ease;">›</button>
                  </div>
                </div>
                `
              : (post.mediaType === 'video'
                ? `<video src="${singleMediaUrl}" controls loop muted playsinline style="border-radius:12px; display:block;" class="post-media-video"></video>
                   <div class="video-mute-container" style="position: absolute; left: 16px; bottom: 48px; z-index: 12;">
                     <button class="action-circle-btn mute-btn-action" data-post-id="${post._id}">
                       <i data-lucide="volume-2"></i>
                     </button>
                   </div>`
                : `<img src="${singleMediaUrl}" alt="Post Media" loading="lazy" decoding="async" class="post-media-img" style="border-radius:12px; display:block;" />`
              )}
            </div>
          `;
        })()}

          <!-- Speaker Overlay Button (if musicUrl is present) -->
          ${(() => {
          const musicUrl = getPostMusicUrl(post);
          return musicUrl ? `
              <button class="post-music-speaker-btn" onclick="window.togglePostMusic(this, '${musicUrl}', '${post._id}')" style="position: absolute; left: 12px; bottom: 12px; background: rgba(0,0,0,0.6); border: none; border-radius: 50%; width: 28px; height: 28px; color: white; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 10; outline: none; transition: background 0.2s, transform 0.2s;">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/></svg>
              </button>
            ` : '';
        })()}

          <!-- Vertical engagement overlay right aligned -->
          <div class="post-engagement-actions">
            <div class="engagement-item like-btn-action ${isLikedByMe ? 'liked' : ''}" data-post-id="${post._id}">
              <button class="action-circle-btn heart-btn"><i data-lucide="heart" style="${isLikedByMe ? 'fill:#8b5cf6; stroke:#8b5cf6;' : ''}"></i></button>
              <span class="action-count">${(post.likes || []).length}</span>
            </div>
            <div class="engagement-item comment-btn-action" data-post-id="${post._id}">
              <button class="action-circle-btn"><i data-lucide="message-circle"></i></button>
              <span class="action-count">${(post.comments || []).length}</span>
            </div>
            <div class="engagement-item share-btn-action" data-post-id="${post._id}">
              <button class="action-circle-btn"><i data-lucide="send"></i></button>
            </div>
            <div class="engagement-item bookmark-btn-action" data-post-id="${post._id}">
              <button class="action-circle-btn bookmark-btn ${isSavedByMe ? 'saved' : ''}"><i data-lucide="bookmark" style="${isSavedByMe ? 'fill:#FBBF24; stroke:#FBBF24;' : ''}"></i></button>
            </div>
          </div>
        </div>

          <div class="post-details">
            <p class="post-caption"><strong class="author-username" style="margin-right: 8px; cursor: pointer;">${authorUsername}</strong>${post.caption}</p>
            
            ${shouldRenderComments ? window.getCommentsSectionHTML(post, currentUserId, currentUser, localUserAvatar) : `<div class="comments-section-placeholder" id="comments-placeholder-${post._id}"></div>`}
          </div>
        `;

      feedContainer.appendChild(card);

      // Click handlers to view post author profile
      const avatarEl = card.querySelector('.author-avatar');
      const nameEl = card.querySelector('.author-name');
      const usernameEl = card.querySelector('.author-username');

      [avatarEl, nameEl, usernameEl].forEach(el => {
        if (el && authorId && authorId !== 'usr_unknown') {
          el.style.cursor = 'pointer';
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            switchView('profile', authorId);
          });
        }
      });

      // Click handlers for comment author avatars and usernames in post
      const commentAvatars = card.querySelectorAll('.comment-author-avatar, .comment-author-name');
      commentAvatars.forEach(el => {
        const cUserId = el.getAttribute('data-user-id');
        if (cUserId) {
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            switchView('profile', cUserId);
          });
        }
      });
    });

    debouncedCreateIcons();

    // Local Like and Bookmark listeners removed in favor of global event delegation

    const dynamicVideoOverlays = feedContainer.querySelectorAll('.video-play-overlay');
    dynamicVideoOverlays.forEach(overlay => {
      const container = overlay.closest('.post-media-container');
      const video = container.querySelector('.post-media-video');
      const playIcon = overlay.querySelector('i');

      overlay.addEventListener('click', (e) => {
        e.stopPropagation();
        video.play();
        overlay.style.display = 'none';
        debouncedCreateIcons();
      });

      video.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!video.paused) {
          video.pause();
          playIcon.setAttribute('data-lucide', 'play');
          overlay.style.display = 'flex';
          overlay.style.background = 'rgba(0,0,0,0.25)';
          overlay.style.opacity = '1';
          debouncedCreateIcons();
        }
      });
    });

    const muteButtons = feedContainer.querySelectorAll('.mute-btn-action');
    muteButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const container = btn.closest('.post-media-container');
        const video = container.querySelector('.post-media-video');
        const muteIcon = btn.querySelector('i');

        if (video.muted) {
          video.muted = false;
          muteIcon.setAttribute('data-lucide', 'volume-2');
        } else {
          video.muted = true;
          muteIcon.setAttribute('data-lucide', 'volume-2');
        }
        debouncedCreateIcons();
      });
    });

    const mediaBoxes = feedContainer.querySelectorAll('.post-media-container');
    mediaBoxes.forEach(container => {
      let lastTap = 0;
      container.addEventListener('click', async (e) => {
        if (e.target.closest('.post-engagement-actions') || e.target.closest('.video-mute-container')) return; // ignore clicks on engagement overlays or mute button
        const now = Date.now();
        const timespan = now - lastTap;
        if (timespan < 300 && timespan > 0) {
          e.preventDefault();
          const btn = container.closest('.feed-card').querySelector('.like-btn-action');
          const pid = btn.getAttribute('data-post-id');
          const rect = container.getBoundingClientRect();
          const relativeX = e.clientX - rect.left;
          const relativeY = e.clientY - rect.top;

          triggerHeartExplosion(relativeX, relativeY, container);

          if (!btn.classList.contains('liked')) {
            await togglePostLike(pid, btn);
          }
        }
        lastTap = now;
      });
    });

    // Posted via Enter key only (send button removed)

    const commentInputs = feedContainer.querySelectorAll('.comment-input-field');
    commentInputs.forEach(input => {
      input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const pid = input.id.replace('comment-input-', '');
          const text = input.value.trim();
          if (text) {
            await submitComment(pid, text, input);
          }
        }
      });
    });
  };

  function triggerBtnHeartExplosion(anchorElement) {
    if (!anchorElement) return;
    const rect = anchorElement.getBoundingClientRect();

    // Spawn 8 purple hearts
    for (let i = 0; i < 8; i++) {
      const heart = document.createElement('div');
      heart.className = 'heart-particle';
      heart.innerHTML = `
        <svg viewBox="0 0 24 24" fill="#8b5cf6" stroke="#8b5cf6" stroke-width="2" style="width: 100%; height: 100%;">
          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>
        </svg>
      `;

      const size = Math.random() * 10 + 12; // sizes 12px to 22px
      heart.style.width = `${size}px`;
      heart.style.height = `${size}px`;

      const startX = rect.left + rect.width / 2 - size / 2;
      const startY = rect.top + rect.height / 2 - size / 2;
      heart.style.left = `${startX}px`;
      heart.style.top = `${startY}px`;

      const angle = (Math.random() * 360) * Math.PI / 180;
      const distance = Math.random() * 40 + 35;
      const tx = Math.cos(angle) * distance;
      const ty = -Math.random() * 70 - 30; // Float upwards
      const rot = Math.random() * 90 - 45;
      const scale = Math.random() * 0.4 + 0.8;

      heart.style.setProperty('--tx', `${tx}px`);
      heart.style.setProperty('--ty', `${ty}px`);
      heart.style.setProperty('--rot', `${rot}deg`);
      heart.style.setProperty('--scale', scale);

      heart.style.animationDelay = `${Math.random() * 0.1}s`;

      document.body.appendChild(heart);

      setTimeout(() => {
        heart.remove();
      }, 1100);
    }
  }

  async function togglePostLike(postId, btnElement) {
    const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');

    if (!token) {
      showToast('Please log in to like posts.');
      return;
    }

    // 1. Snapshot initial state for rollback
    const isOriginallyLiked = btnElement.classList.contains('liked');
    const countSpan = btnElement.querySelector('.action-count');
    const heartIcon = btnElement.querySelector('i, svg');
    const originalCount = parseInt(countSpan ? countSpan.textContent : '0') || 0;

    // 2. Optimistic UI Update
    const nextIsLiked = !isOriginallyLiked;
    const nextCount = nextIsLiked ? originalCount + 1 : Math.max(0, originalCount - 1);

    if (nextIsLiked) {
      btnElement.classList.add('liked');
      if (heartIcon) {
        heartIcon.style.fill = '#8b5cf6';
        heartIcon.style.stroke = '#8b5cf6';
      }
      triggerBtnHeartExplosion(btnElement);
    } else {
      btnElement.classList.remove('liked');
      if (heartIcon) {
        heartIcon.style.fill = 'none';
        heartIcon.style.stroke = 'currentColor';
      }
    }
    if (countSpan) countSpan.textContent = nextCount;

    try {
      const path = `/api/posts/${postId}/like`;
      let res;
      try {
        res = await fetch(path, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-User-Token': token
          }
        });
      } catch (_) {
        res = await fetch(`${API_URL}${path}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-User-Token': token
          }
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to toggle like.');

      // 3. Confirm with official server state
      if (data.isLiked) {
        btnElement.classList.add('liked');
        if (heartIcon) {
          heartIcon.style.fill = '#8b5cf6';
          heartIcon.style.stroke = '#8b5cf6';
        }
        showToast('Liked post! 💜');
      } else {
        btnElement.classList.remove('liked');
        if (heartIcon) {
          heartIcon.style.fill = 'none';
          heartIcon.style.stroke = 'currentColor';
        }
      }
      if (countSpan) countSpan.textContent = data.likesCount;
    } catch (err) {
      console.error("Post like failed, rolling back UI:", err);
      // 4. ROLL BACK ON FAILURE
      if (isOriginallyLiked) {
        btnElement.classList.add('liked');
        if (heartIcon) {
          heartIcon.style.fill = '#8b5cf6';
          heartIcon.style.stroke = '#8b5cf6';
        }
      } else {
        btnElement.classList.remove('liked');
        if (heartIcon) {
          heartIcon.style.fill = 'none';
          heartIcon.style.stroke = 'currentColor';
        }
      }
      if (countSpan) countSpan.textContent = originalCount;
      showToast(err.message || 'Failed to like post.');
    }
  }

  async function toggleCommentLike(commentId, btnElement) {
    const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
    if (!token) {
      showToast('Please log in to like comments.');
      return;
    }

    const isOriginallyLiked = btnElement.classList.contains('liked');
    const countSpan = btnElement.querySelector('.comment-like-count');
    const originalCount = parseInt(countSpan ? countSpan.textContent : '0') || 0;

    // Optimistic Update
    btnElement.classList.toggle('liked', !isOriginallyLiked);
    if (countSpan) countSpan.textContent = !isOriginallyLiked ? originalCount + 1 : Math.max(0, originalCount - 1);

    try {
      const path = `/api/comments/${commentId}/like`;
      let res;
      try {
        res = await fetch(path, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
      } catch (_) {
        res = await fetch(`${API_URL}${path}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to like comment.');

      btnElement.classList.toggle('liked', data.isLiked);
      if (countSpan) countSpan.textContent = data.likesCount;
    } catch (err) {
      // Rollback
      btnElement.classList.toggle('liked', isOriginallyLiked);
      if (countSpan) countSpan.textContent = originalCount;
      showToast(err.message || 'Failed to like comment.');
    }
  }

  async function submitComment(postId, text, inputField, parentCommentId = null) {
    const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');

    if (!token) {
      showToast('Please log in to post a comment.');
      return;
    }

    if (!text || !text.trim()) {
      showToast('Comment text cannot be empty.');
      return;
    }

    const originalValue = inputField.value;
    inputField.value = '';

    try {
      const path = parentCommentId ? `/api/comments/${parentCommentId}/reply` : `/api/posts/${postId}/comment`;
      let res;
      try {
        res = await fetch(path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'X-User-Token': token
          },
          body: JSON.stringify({ text: text.trim(), parentCommentId })
        });
      } catch (_) {
        res = await fetch(`${API_URL}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'X-User-Token': token
          },
          body: JSON.stringify({ text: text.trim(), parentCommentId })
        });
      }

      const responseData = await res.json();
      if (!res.ok) throw new Error(responseData.error || 'Failed to post comment.');

      const commentsList = Array.isArray(responseData) ? responseData : (responseData.comments || [responseData.comment]);

      // Update post card comment count badge
      const card = document.getElementById(`post-${postId}`) || inputField.closest('.feed-card') || document.querySelector(`[data-post-id="${postId}"]`)?.closest('.feed-card');
      if (card) {
        const countBadge = card.querySelector('.comment-btn-action .action-count');
        if (countBadge) countBadge.textContent = commentsList.length;
      }

      // Update list container
      const listContainer = document.getElementById(`comments-list-${postId}`) || document.querySelector('#comments-modal .comments-list');
      if (listContainer && Array.isArray(commentsList)) {
        listContainer.innerHTML = '';
        commentsList.forEach(comment => {
          const item = document.createElement('div');
          item.className = `comment-item ${comment.parentCommentId ? 'nested-reply' : ''}`;
          item.style = `display: flex; gap: 8px; margin-bottom: 8px; font-size: 13px; ${comment.parentCommentId ? 'margin-left: 24px; border-left: 2px solid rgba(255,255,255,0.1); padding-left: 8px;' : ''}`;
          const cAuthor = comment.author || { username: 'user', profileImage: '' };
          item.innerHTML = `
            <img src="${cAuthor.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&h=80&q=80'}" alt="" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover;" />
            <div style="flex: 1;">
              <strong style="color: var(--text-color); margin-right: 4px;">${cAuthor.username || 'user'}</strong>
              <span style="color: var(--text-muted);">${comment.text}</span>
            </div>
          `;
          listContainer.appendChild(item);
        });
      }

      showToast('Comment posted! 💬');
    } catch (err) {
      console.error("Comment submission failed, rolling back UI:", err);
      // ROLL BACK INPUT
      inputField.value = originalValue;
      showToast(err.message || 'Failed to post comment.');
    }
  }

  async function refreshPostCommentsCount(postId) {
    const card = document.getElementById(`post-${postId}`);
    if (!card) return;
    try {
      const res = await fetch(`${API_URL}/api/posts/${postId}/comments`);
      if (res.ok) {
        const comments = await res.json();
        const countBadge = card.querySelector('.comment-btn-action .action-count');
        if (countBadge && Array.isArray(comments)) {
          countBadge.textContent = comments.length;
        }
      }
    } catch (_) { }
  }
  window.refreshPostCommentsCount = refreshPostCommentsCount;

  async function refreshPostLikesCount(postId) {
    const card = document.getElementById(`post-${postId}`);
    if (!card) return;
    try {
      const res = await fetch(`${API_URL}/api/posts`);
      if (res.ok) {
        const posts = await res.json();
        const targetPost = posts.find(p => p._id === postId);
        if (targetPost) {
          const countBadge = card.querySelector('.like-btn-action .action-count');
          if (countBadge) countBadge.textContent = (targetPost.likes || []).length;
        }
      }
    } catch (_) { }
  }
  window.refreshPostLikesCount = refreshPostLikesCount;

  window.loadFeedPosts = loadFeedPosts;
  window.loadFeed = loadFeedPosts;

  let _cachedReels = null;
  let _lastReelsFetchTime = 0;
  let _reelsInFlightPromise = null;
  const REELS_CACHE_TTL = 120 * 1000; // 2 minutes

  async function loadFeedReels(forceRefresh = false) {
    const scroller = document.querySelector('#explore-reels-container .reels-scroller');
    if (!scroller) return;

    const now = Date.now();
    const isCacheFresh = _cachedReels && (now - _lastReelsFetchTime < REELS_CACHE_TTL);

    // If reels are already rendered in DOM and cache is fresh, skip destructive reload
    if (!forceRefresh && isCacheFresh && scroller.children.length > 0) {
      return;
    }

    if (_reelsInFlightPromise) {
      return _reelsInFlightPromise;
    }

    _reelsInFlightPromise = (async () => {
      try {
        const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

        console.log('[HUBB FEED] Fetching reels from API...');
        const res = await fetch(`${API_URL}/api/reels`, { headers });
        console.log('[HUBB FEED] API response status:', res.status);

        if (!res.ok) throw new Error('Failed to fetch reels (HTTP ' + res.status + ')');
        const rawData = await res.json();

        let reels = [];
        if (Array.isArray(rawData)) reels = rawData;
        else if (Array.isArray(rawData?.reels)) reels = rawData.reels;
        else if (Array.isArray(rawData?.data)) reels = rawData.data;

        _cachedReels = reels;
        _lastReelsFetchTime = Date.now();

        // Skip DOM rebuild if the same reel IDs are already rendered
        const newIds = reels.map(r => r._id || r.id).join(',');
        const existingIds = Array.from(scroller.querySelectorAll('.reel-card')).map(c => c.getAttribute('data-reel-id')).join(',');
        if (newIds && newIds === existingIds && scroller.children.length > 0) {
          console.log('[HUBB FEED] Reels unchanged, skipping DOM rebuild.');
          window.feedReels = reels;
          return;
        }

        window.feedReels = reels;

      console.log('[HUBB FEED] reel count:', reels.length);
      if (reels.length > 0) {
        console.log('[HUBB FEED] first reel:', reels[0]);
      }

      // Pause and release existing video resources to prevent detached audio play bug
      scroller.querySelectorAll('.reel-video').forEach(vid => {
        try {
          vid.pause();
          vid.removeAttribute('src');
          vid.load();
        } catch (e) {
          console.warn('[REEL UNLOAD ERROR]', e);
        }
      });

      scroller.innerHTML = '';

      if (!Array.isArray(reels) || reels.length === 0) {
        scroller.innerHTML = `
          <div class="empty-reels-state" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 420px; width: 100%; text-align: center; color: rgba(255,255,255,0.7); gap: 14px; padding: 24px; box-sizing: border-box;">
            <div style="width: 72px; height: 72px; border-radius: 50%; background: rgba(168,85,247,0.15); display: flex; align-items: center; justify-content: center; border: 1px solid rgba(168,85,247,0.3);">
              <i data-lucide="clapperboard" style="width: 36px; height: 36px; color: #a855f7;"></i>
            </div>
            <h3 style="margin: 0; color: var(--text-main); font-size: 1.2rem; font-weight: 700;">No Hubbing Reels Yet</h3>
            <p style="margin: 0; font-size: 13px; max-width: 300px; color: var(--text-muted); line-height: 1.5;">Be the first to create and share a reel in Hi-HUBBLE!</p>
            <button class="welcome-btn btn-primary open-hubbing-editor-btn" style="padding: 10px 24px; font-size: 13.5px; font-weight: 600; border-radius: 10px; cursor: pointer; border: none; color: white; display: flex; align-items: center; gap: 8px; background: linear-gradient(135deg, #a855f7 0%, #d946ef 100%); box-shadow: 0 4px 15px rgba(168,85,247,0.4); transition: transform 0.2s ease;">
              <i data-lucide="plus" style="width:16px; height:16px;"></i> Post a Reel
            </button>
          </div>
        `;
        const openBtn = scroller.querySelector('.open-hubbing-editor-btn');
        if (openBtn) {
          openBtn.addEventListener('click', () => {
            const modal = document.getElementById('explore-create-modal');
            if (modal) modal.classList.add('active');
          });
        }
        if (window.debouncedCreateIcons) window.debouncedCreateIcons();
        return;
      }

      reels.forEach(reel => {
        const authorName = reel.author ? (reel.author.fullName || reel.author.username || 'Hubble User') : 'Hubble User';
        const authorUser = reel.author ? (reel.author.username || 'hubble_user') : 'hubble_user';
        const authorAvatar = reel.author?.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=100&h=100&q=80';

        const captionText = reel.caption || '';
        const captionHtml = captionText.replace(/#(\w+)/g, '<span style="color:#c084fc; font-weight:600;">#$1</span>');
        const isReelSaved = reel.isSaved || (window.savedHubbs && window.savedHubbs.some(s => s.id === (reel._id || reel.id)));

        console.log('[HUBB FEED] rendering reel:', reel._id || reel.id);
        console.log('[HUBB VIDEO] video URL:', reel.videoUrl);

        const card = document.createElement('div');
        card.className = 'reel-card';
        card.setAttribute('data-reel-id', reel._id || reel.id);
        card.style.cssText = `position: relative; width: 100%; height: 640px; margin: 0 auto 24px auto; border-radius: 18px; overflow: hidden; background: #000; box-shadow: 0 12px 35px rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.12); box-sizing: border-box;`;

        card.innerHTML = `
          <video data-src="${reel.videoUrl}" loop muted playsinline preload="none" class="reel-video" style="width:100%; height:100%; object-fit:cover; display:block;"></video>
          
          <div class="reel-play-icon-overlay" style="cursor: pointer; z-index: 4;">
            <i data-lucide="play" style="width:30px; height:30px; color:white; opacity:0.9;"></i>
          </div>
          
          <div class="double-tap-heart"><i data-lucide="heart"></i></div>

          <div class="reel-overlay" style="position:absolute; inset:0; background: linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.15) 50%, rgba(0,0,0,0.3) 100%); display:flex; justify-content:space-between; align-items:flex-end; padding:20px; box-sizing:border-box; z-index:5;">
            
            <div class="reel-left-info" style="display:flex; flex-direction:column; gap:10px; max-width:72%; position:relative; z-index:7;">
              <div class="reel-user" style="display:flex; align-items:center; gap:8px;">
                <img src="${authorAvatar}" alt="${authorName}" style="width:36px; height:36px; border-radius:50%; object-fit:cover; border:2px solid #a855f7;" />
                <div style="display:flex; flex-direction:column; gap:2px;">
                  <div style="display:flex; align-items:center; gap:8px;">
                    <span style="color:white; font-size:13px; font-weight:600;">@${authorUser}</span>
                    <strong class="reel-follow-btn" data-author-id="${reel.author?._id || reel.author?.id || ''}" style="color:white; font-size:11px; cursor:pointer; background:linear-gradient(135deg, #a855f7 0%, #ec4899 100%); padding:3px 10px; border-radius:12px; font-weight:600;">Follow</strong>
                  </div>
                  ${reel.location ? `
                    <div class="reel-location-badge" style="display:flex; align-items:center; gap:4px; color:rgba(255,255,255,0.7); font-size:10.5px;">
                      <i data-lucide="map-pin" style="width:10px; height:10px; color:#ec4899;"></i>
                      <span>${reel.location}</span>
                    </div>
                  ` : ''}
                </div>
              </div>
              <p class="reel-caption" style="color:white; font-size:13px; margin:0; line-height:1.4;">${captionHtml}</p>
              <div class="reel-music" style="display:flex; align-items:center; gap:6px; color:rgba(255,255,255,0.8); font-size:11px;">
                <i data-lucide="music" style="width:12px; height:12px;" class="music-icon-spin"></i> <span>${reel.audioTrackName || ('Original Audio - ' + authorUser)}</span>
              </div>
            </div>
          </div>

          <!-- Bottom navigation zone overlays the bottom area of the reel -->
          <div class="reel-bottom-navigation-zone" style="position: absolute; bottom: 0; left: 0; right: 0; height: 50px; z-index: 6; cursor: pointer;"></div>

          <!-- Right Actions Block (moved outside overlay for higher stack priority) -->
          <div class="reel-right-actions" style="position: absolute; bottom: 20px; right: 20px; display:flex; flex-direction:column; gap:14px; align-items:center; z-index:10 !important;">
            <div class="reel-actions-capsule" style="background: rgba(15, 23, 42, 0.45); backdrop-filter: blur(12px); border-radius: 36px; padding: 18px 8px; border: 1px solid rgba(255,255,255,0.12); display: flex; flex-direction: column; gap: 18px; align-items: center; box-shadow: 0 10px 30px rgba(0,0,0,0.4);">
              
              <!-- 1. Like -->
              <div class="reel-action-btn reel-like-action" data-reel-id="${reel._id || reel.id}" style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;">
                <button class="action-circle-btn heart-btn ${reel.isLiked ? 'liked' : ''}" style="background:none; border:none; color:white; width:40px; height:40px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
                  <i data-lucide="heart" style="${reel.isLiked ? 'fill:#8b5cf6; stroke:#8b5cf6;' : ''}"></i>
                </button>
                <span class="action-count" style="color:white; font-size:11px; font-weight:700;">${reel.formattedLikes || reel.likeCount || '0'}</span>
              </div>

              <!-- 2. Comment -->
              <div class="reel-action-btn reel-comment-sim" data-reel-id="${reel._id || reel.id}" style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;">
                <button class="action-circle-btn" style="background:none; border:none; color:white; width:40px; height:40px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
                  <i data-lucide="message-circle"></i>
                </button>
                <span class="action-count" style="color:white; font-size:11px; font-weight:700;">${reel.formattedComments || reel.commentCount || '0'}</span>
              </div>

              <!-- 3. Share -->
              <div class="reel-action-btn reel-share-sim" data-reel-id="${reel._id || reel.id}" style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;">
                <button class="action-circle-btn" style="background:none; border:none; color:white; width:40px; height:40px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
                  <i data-lucide="send"></i>
                </button>
                <span class="action-count" style="color:white; font-size:11px; font-weight:700;">${reel.formattedShares || reel.shareCount || '0'}</span>
              </div>

              <!-- 4. Save/Bookmark -->
              <div class="reel-action-btn reel-save-action" data-reel-id="${reel._id || reel.id}" style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;">
                <button class="action-circle-btn star-btn ${isReelSaved ? 'saved' : ''}" style="background:none; border:none; color:white; width:40px; height:40px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
                  <i data-lucide="bookmark" style="${isReelSaved ? 'fill:#FBBF24; stroke:#FBBF24;' : ''}"></i>
                </button>
              </div>

              <!-- 5. Sound / Audio Mute Toggle -->
              <div class="reel-action-btn reel-audio-action" data-reel-id="${reel._id || reel.id}" style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;" title="Toggle Audio">
                <button class="action-circle-btn reel-audio-toggle-btn" style="background:none; border:none; color:white; width:40px; height:40px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
                  <i data-lucide="${window.reelsMuted === false ? 'volume-2' : 'volume-x'}"></i>
                </button>
              </div>
            </div>

            <!-- 5. More Options -->
            <div class="reel-action-btn reel-more-sim" data-reel-id="${reel._id || reel.id}">
              <button class="action-circle-btn" style="width:40px; height:40px; border-radius:50%; background:rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.15); display:flex; align-items:center; justify-content:center; color:white; cursor:pointer;">
                <i data-lucide="more-horizontal"></i>
              </button>
            </div>
          </div>

          <!-- Bottom Center Mascot Circle -->
          <div class="reel-mascot-overlay" style="position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); width: 44px; height: 44px; border-radius: 50%; background: radial-gradient(circle, rgba(168,85,247,0.9) 0%, rgba(139,92,246,0.5) 60%, transparent 100%); display: flex; align-items: center; justify-content: center; box-shadow: 0 0 20px rgba(168,85,247,0.8); z-index: 8; cursor: pointer; border: 1.5px solid rgba(255,255,255,0.3);" title="Hi-HUBBLE Mascot">
            <img src="/hihubble-mascot-circle.png" alt="Mascot" style="width: 38px; height: 38px; border-radius: 50%; object-fit: cover;" />
          </div>

          <!-- Comments Modal -->
          <div class="story-viewer-overlay reel-comments-modal" data-reel-id="${reel._id || reel.id}">
            <div class="comments-card glass-panel" style="backdrop-filter: blur(20px); border-radius: 20px; width: 90%; max-width: 380px; max-height: 80vh; display: flex; flex-direction: column; overflow: hidden;">
              <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; padding:16px 20px;">
                <h3 style="margin:0; font-size:16px; font-weight:600;">Comments</h3>
                <button class="modal-close-btn" style="background:none; border:none; cursor:pointer; font-size:18px;"><i data-lucide="x"></i></button>
              </div>
              <div class="comments-list" style="flex:1; overflow-y:auto; padding:16px; min-height:180px; max-height:360px;"></div>
              <div class="comments-footer" style="display:flex; gap:10px; padding:12px 16px;">
                <input type="text" placeholder="Add a comment..." style="flex:1; border-radius:20px; padding:8px 16px; font-size:13px; outline:none;" />
                <button class="comment-send-btn" style="width:36px; height:36px; border-radius:50%; background:linear-gradient(135deg, #a855f7 0%, #d946ef 100%); border:none; color:white; display:flex; align-items:center; justify-content:center; cursor:pointer;"><i data-lucide="send" style="width:16px; height:16px;"></i></button>
              </div>
            </div>
          </div>

          <!-- Share Modal -->
          <div class="story-viewer-overlay reel-share-modal" data-reel-id="${reel._id || reel.id}">
            <div class="share-card glass-panel" style="background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(20px); border-radius: 20px; border: 1px solid rgba(255,255,255,0.15); width: 90%; max-width: 360px; display: flex; flex-direction: column; overflow: hidden;">
              <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; padding:16px 20px; border-bottom:1px solid rgba(255,255,255,0.1);">
                <h3 style="margin:0; font-size:16px; color:white; font-weight:600;">Share Reel</h3>
                <button class="modal-close-btn" style="background:none; border:none; color:white; cursor:pointer; font-size:18px;"><i data-lucide="x"></i></button>
              </div>
              <div class="share-options" style="padding: 20px; display: flex; flex-direction: column; gap: 12px;">
                <button class="copy-link-btn" style="padding: 12px; border-radius: 12px; background: linear-gradient(135deg, #a855f7 0%, #d946ef 100%); color: white; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; font-weight: 600; font-size: 13.5px;"><i data-lucide="copy" style="width:18px; height:18px;"></i> Copy Reel Link</button>
              </div>
            </div>
          </div>
        `;

        // Diagnostic video element listeners + error isolation
        const video = card.querySelector('.reel-video');
        if (video) {
          video.addEventListener('loadedmetadata', () => console.log('[HUBBING PLAYER] event=loadedmetadata reelId=' + (reel._id || reel.id) + ' duration=' + (video.duration ? video.duration.toFixed(2) : '0') + ' dim=' + video.videoWidth + 'x' + video.videoHeight));
          video.addEventListener('canplay', () => console.log('[HUBBING PLAYER] event=canplay reelId=' + (reel._id || reel.id) + ' readyState=' + video.readyState));
          video.addEventListener('play', () => console.log('[HUBBING PLAYER] event=play reelId=' + (reel._id || reel.id) + ' currentTime=' + video.currentTime.toFixed(2)));
          video.addEventListener('playing', () => console.log('[HUBBING PLAYER] event=playing reelId=' + (reel._id || reel.id) + ' currentTime=' + video.currentTime.toFixed(2) + ' paused=' + video.paused + ' readyState=' + video.readyState));
          video.addEventListener('pause', () => console.log('[HUBBING PLAYER] event=pause reelId=' + (reel._id || reel.id) + ' currentTime=' + video.currentTime.toFixed(2)));
          video.addEventListener('waiting', () => console.debug('[HUBBING PLAYER] event=waiting reelId=' + (reel._id || reel.id) + ' currentTime=' + video.currentTime.toFixed(2) + ' readyState=' + video.readyState + ' networkState=' + video.networkState));
          video.addEventListener('stalled', () => console.debug('[HUBBING PLAYER] event=stalled reelId=' + (reel._id || reel.id) + ' currentTime=' + video.currentTime.toFixed(2)));
          video.addEventListener('seeking', () => console.log('[HUBBING PLAYER] event=seeking reelId=' + (reel._id || reel.id) + ' currentTime=' + video.currentTime.toFixed(2)));
          video.addEventListener('seeked', () => console.log('[HUBBING PLAYER] event=seeked reelId=' + (reel._id || reel.id) + ' currentTime=' + video.currentTime.toFixed(2)));
          video.addEventListener('ended', () => console.log('[HUBBING PLAYER] event=ended reelId=' + (reel._id || reel.id)));
          video.addEventListener('error', () => {
            console.error('[HUBBING PLAYER] event=error reelId=' + (reel._id || reel.id), video.error);
            // Isolate failed reel — mark card but do NOT crash the feed
            card.setAttribute('data-reel-failed', 'true');
            const overlay = card.querySelector('.reel-play-icon-overlay');
            if (overlay) overlay.innerHTML = '<span style="color:rgba(255,255,255,0.6);font-size:12px;">Video unavailable</span>';
          });
        }

        scroller.appendChild(card);
      });

      if (window.debouncedCreateIcons) window.debouncedCreateIcons();
      wireReelInteractions(scroller);

      // Notify HubbingPlaybackController after feed rendering
      if (window.hubbingPlaybackController) {
        window.hubbingPlaybackController.scheduleSettleEvaluation(100);
      }

    } catch (err) {
      console.error('[HUBB FEED] Error loading reels:', err);
    } finally {
      _reelsInFlightPromise = null;
    }
  })();

  return _reelsInFlightPromise;
}

  window.loadFeedReels = loadFeedReels;

  async function toggleReelLike(reelId, btnElement) {
    const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
    if (!token) {
      showToast('Please log in to like reels! 🔐');
      return;
    }

    try {
      const res = await fetch(`${API_URL}/api/reels/${reelId}/like`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const countSpan = btnElement.closest('.reel-action-btn').querySelector('.action-count');
      const heartIcon = btnElement.querySelector('i, svg');

      if (data.isLiked) {
        btnElement.classList.add('liked');
        if (heartIcon) {
          heartIcon.style.fill = '#8b5cf6';
          heartIcon.style.stroke = '#8b5cf6';
        }
        showToast('Liked Reel! 💜');
      } else {
        btnElement.classList.remove('liked');
        if (heartIcon) {
          heartIcon.style.fill = 'none';
          heartIcon.style.stroke = 'currentColor';
        }
      }
      if (countSpan) countSpan.textContent = data.formattedLikes || data.likesCount;
    } catch (err) {
      console.error('Error liking reel:', err);
      showToast(err.message);
    }
  }

  async function toggleReelSave(reelId, btnElement) {
    const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
    if (!token) {
      showToast('Please log in to save reels! 🔐');
      return;
    }

    try {
      const res = await fetch(`${API_URL}/api/reels/${reelId}/save`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const card = btnElement.closest('.reel-card');
      const video = card ? card.querySelector('video') : null;
      const starIcon = btnElement.querySelector('i, svg');

      if (data.isSaved) {
        btnElement.classList.add('saved');
        if (starIcon) {
          starIcon.style.fill = '#FBBF24';
          starIcon.style.stroke = '#FBBF24';
        }
        if (video) {
          const mediaData = { id: reelId, type: 'video', url: video.src, isReel: true };
          if (!window.savedHubbs.find(s => s.id === mediaData.id)) {
            window.savedHubbs.push(mediaData);
          }
        }
        showToast('Reel saved to bookmarks! 🌟');
      } else {
        btnElement.classList.remove('saved');
        if (starIcon) {
          starIcon.style.fill = 'none';
          starIcon.style.stroke = 'currentColor';
        }
        window.savedHubbs = window.savedHubbs.filter(s => s.id !== reelId);
        showToast('Reel removed from bookmarks.');
      }

      const savedGrid = document.getElementById('profile-saved-grid');
      if (savedGrid && savedGrid.classList.contains('active')) {
        if (typeof window.fetchSavedHubbs === 'function') {
          await window.fetchSavedHubbs();
        }
        if (typeof renderSavedHubbs === 'function') {
          renderSavedHubbs();
        }
      }
    } catch (err) {
      showToast(err.message);
    }
  }

  function formatReelCommentTime(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return '';
      const now = new Date();
      const diffSec = Math.floor((now - d) / 1000);
      if (diffSec < 60) return 'Just now';
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `${diffMin}m`;
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return `${diffHr}h`;
      const diffDays = Math.floor(diffHr / 24);
      if (diffDays < 7) return `${diffDays}d`;
      const diffWeeks = Math.floor(diffDays / 7);
      if (diffWeeks < 4) return `${diffWeeks}w`;
      return `${Math.floor(diffDays / 30)}mo`;
    } catch (_) {
      return '';
    }
  }

  async function loadReelComments(reelId, modalElement) {
    const listElem = modalElement.querySelector('.comments-list');
    if (!listElem) return;
    listElem.innerHTML = '<div class="reel-comments-status" style="padding: 20px; text-align: center; color: var(--text-muted, #94a3b8); font-size: 13px;">Loading comments...</div>';

    try {
      const res = await fetch(`${API_URL}/api/reels/${reelId}/comments`);
      const comments = await res.json();
      listElem.innerHTML = '';
      if (!Array.isArray(comments) || comments.length === 0) {
        listElem.innerHTML = '<div class="reel-comments-status" style="padding: 20px; text-align: center; color: var(--text-muted, #94a3b8); font-size: 13px;">No comments yet. Be the first to comment!</div>';
        return;
      }
      comments.forEach(c => {
        const item = document.createElement('div');
        item.className = 'comment-item';
        item.style.cssText = 'display: flex; gap: 10px; margin-bottom: 12px; align-items: flex-start;';
        const avatar = c.author?.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=100&h=100&q=80';
        const cAuthorId = getUserIdentifier(c.author);
        const timeAgoStr = formatReelCommentTime(c.createdAt || c.created_at);
        const rawContent = c.content || c.text || '';
        const formattedContent = rawContent.replace(/@(\w+)/g, '<span class="comment-mention" style="color:var(--primary, #8b5cf6); font-weight:600; cursor:pointer;">@$1</span>');

        item.innerHTML = `
          <img src="${avatar}" class="comment-author-avatar" style="width:30px; height:30px; border-radius:50%; object-fit:cover; border:1px solid var(--border-color, rgba(255,255,255,0.2)); cursor:pointer;" />
          <div class="comment-bubble" style="flex:1; background: var(--surface-hover, rgba(255,255,255,0.06)); border: 1px solid var(--border-color, rgba(255,255,255,0.1)); padding: 8px 12px; border-radius: 12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:2px;">
              <div class="comment-author-name" style="font-size:12px; font-weight:700; color:var(--text-main, #ffffff); cursor:pointer;">@${c.author?.username || 'user'}</div>
              ${timeAgoStr ? `<span class="comment-time" style="font-size:10.5px; color:var(--text-muted, #94a3b8);">${timeAgoStr}</span>` : ''}
            </div>
            <div class="comment-text" style="font-size:12.5px; color:var(--text-main, #ffffff); line-height: 1.4; word-break: break-word;">${formattedContent}</div>
          </div>
        `;

        const userClickEls = item.querySelectorAll('.comment-author-avatar, .comment-author-name');
        userClickEls.forEach(el => {
          if (el && cAuthorId) {
            el.addEventListener('click', (e) => {
              e.stopPropagation();
              modalElement.classList.remove('active');
              switchView('profile', cAuthorId);
            });
          }
        });

        const mentionEls = item.querySelectorAll('.comment-mention');
        mentionEls.forEach(mEl => {
          mEl.addEventListener('click', (e) => {
            e.stopPropagation();
            const username = mEl.textContent.replace('@', '').trim();
            if (username) {
              modalElement.classList.remove('active');
              switchView('profile', username);
            }
          });
        });

        listElem.appendChild(item);
      });
    } catch (err) {
      listElem.innerHTML = '<div class="reel-comments-status error" style="padding: 20px; text-align: center; color: #ef4444; font-size: 13px;">Failed to load comments</div>';
    }
  }

  async function submitReelComment(reelId, text, inputField, modalElement, countSpan) {
    const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
    if (!token) {
      showToast('Please log in to post a comment! 🔐');
      return;
    }
    const trimmed = (text || '').trim();
    if (!trimmed) return;

    try {
      const res = await fetch(`${API_URL}/api/reels/${reelId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ content: trimmed })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Unable to post comment. Please try again.');
      }

      inputField.value = '';
      if (countSpan) {
        countSpan.textContent = data.formattedComments !== undefined ? data.formattedComments : data.commentCount;
      }
      showToast('Comment posted! 💬');
      await loadReelComments(reelId, modalElement);
    } catch (err) {
      console.error('Error posting comment:', err);
      showToast(err.message || 'Unable to post comment. Please try again.');
    }
  }

  async function handleReelShare(reelId, shareModal, countSpan) {
    try {
      const res = await fetch(`${API_URL}/api/reels/${reelId}/share`, { method: 'POST' });
      const data = await res.json();
      if (data.formattedShares && countSpan) {
        countSpan.textContent = data.formattedShares;
      }
    } catch (_) { }

    if (typeof openShare === 'function') {
      openShare('reel_' + reelId);
    } else {
      if (shareModal) shareModal.classList.add('active');
      const copyBtn = shareModal ? shareModal.querySelector('.copy-link-btn') : null;
      if (copyBtn) {
        copyBtn.onclick = () => {
          const reelUrl = `${window.location.origin}/#reel-${reelId}`;
          navigator.clipboard.writeText(reelUrl).then(() => {
            showToast('Reel link copied to clipboard! 📋');
            if (shareModal) shareModal.classList.remove('active');
          });
        };
      }
    }
  }

  async function toggleFollowFromReel(authorId, btnElement) {
    const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
    if (!token) {
      showToast('Please log in to follow users! 🔐');
      return;
    }

    try {
      const res = await fetch(`${API_URL}/api/users/${authorId}/follow`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      btnElement.textContent = 'Hubbies';
      btnElement.style.background = 'rgba(255,255,255,0.25)';
      showToast(data.message || 'Followed successfully!');
      if (typeof loadProfileStats === 'function') loadProfileStats();
      if (typeof loadFollowSuggestions === 'function') loadFollowSuggestions();
    } catch (err) {
      showToast(err.message);
    }
  }

  // --- ONLINE PRESENCE HEARTBEAT SYSTEM ---
  function sendPresenceHeartbeat() {
    if (typeof presenceManager !== 'undefined') {
      presenceManager.sendHeartbeat();
    }
  }

  if (typeof presenceManager !== 'undefined') {
    presenceManager.init();
  }

  setTimeout(() => {
    loadFollowSuggestions();
    loadTrendingHubbs();
    if (typeof presenceManager !== 'undefined') {
      presenceManager.fetchOnlineUsers();
    }
  }, 100);

  const sendLogoutBeacon = () => {
    const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
    if (token) {
      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify({})], { type: 'application/json' });
        navigator.sendBeacon(`${API_URL}/api/users/logout-presence?token=${encodeURIComponent(token)}`, blob);
      }
      fetch(`${API_URL}/api/users/logout-presence`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        keepalive: true
      }).catch(() => { });
    }
  };

  window.addEventListener('beforeunload', sendLogoutBeacon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (typeof presenceManager !== 'undefined') {
        presenceManager.sendHeartbeat();
        presenceManager.fetchOnlineUsers();
      }
    }
  });

  // --- UNIFIED SUGGESTED HUBBERS SERVICE WITH 5-MINUTE CACHE & IN-FLIGHT DEDUPLICATION ---
  let _cachedSuggestedHubbers = null;
  let _lastSuggestedFetchTime = 0;
  let _suggestedHubbersInFlightPromise = null;
  const SUGGESTIONS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  function invalidateSuggestedHubbersCache() {
    _cachedSuggestedHubbers = null;
    _lastSuggestedFetchTime = 0;
  }
  window.invalidateSuggestedHubbersCache = invalidateSuggestedHubbersCache;

  async function getSuggestedHubbers(limit = 50, forceRefresh = false) {
    const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
    if (!token) return [];

    const now = Date.now();
    if (!forceRefresh && _cachedSuggestedHubbers && (now - _lastSuggestedFetchTime < SUGGESTIONS_CACHE_TTL)) {
      return _cachedSuggestedHubbers;
    }

    if (_suggestedHubbersInFlightPromise) {
      return _suggestedHubbersInFlightPromise;
    }

    _suggestedHubbersInFlightPromise = (async () => {
      try {
        const res = await fetch(`${API_URL}/api/users/suggestions?limit=${limit}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch suggestions`);
        const suggestions = await res.json();
        _cachedSuggestedHubbers = suggestions || [];
        _lastSuggestedFetchTime = Date.now();
        console.log(`[Suggested Hubbers Service] Fetched ${_cachedSuggestedHubbers.length} suggestions (limit: ${limit})`);
        return _cachedSuggestedHubbers;
      } catch (err) {
        console.error('[Suggested Hubbers Service Error]:', err);
        return _cachedSuggestedHubbers || [];
      } finally {
        _suggestedHubbersInFlightPromise = null;
      }
    })();

    return _suggestedHubbersInFlightPromise;
  }

  // --- SUGGESTED HUBBERS HOME WIDGET ---
  async function loadFollowSuggestions() {
    const listContainer = document.querySelector('.suggested-users-list') || document.getElementById('suggested-users-list');
    if (!listContainer) {
      console.warn('[Suggested Hubbers] Container element .suggested-users-list not found in DOM');
      return;
    }

    const suggestions = await getSuggestedHubbers(50);
    console.log(`[Suggested Hubbers Widget] Rendering ${suggestions.length} items to Home widget`);

    listContainer.innerHTML = '';
    if (!suggestions || suggestions.length === 0) {
      listContainer.innerHTML = '<p style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 13px;">No suggestions available.</p>';
      return;
    }

    suggestions.slice(0, 3).forEach(user => {
      const row = document.createElement('div');
      row.className = 'user-row';
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.justifyContent = 'space-between';
      row.style.padding = '8px 0';

      const isRequested = user.followStatus === 'pending';
      const isFollowing = user.followStatus === 'following';

      let btnClass = 'follow-row-btn';
      let btnText = 'Follow';
      let btnStyle = 'padding: 6px 14px; border-radius: 20px; font-weight: 600; font-size: 12px; border: none; cursor: pointer; transition: all 0.2s; background: var(--primary, #a855f7); color: white;';

      if (isRequested) {
        btnText = 'Requested';
        btnStyle = 'padding: 6px 14px; border-radius: 20px; font-weight: 600; font-size: 12px; border: none; cursor: not-allowed; background: rgba(255,255,255,0.15); color: var(--text-muted, #94a3b8);';
      } else if (isFollowing) {
        btnText = 'Hubbies';
        btnStyle = 'padding: 6px 14px; border-radius: 20px; font-weight: 600; font-size: 12px; border: none; cursor: pointer; background: #22c55e; color: white;';
      }

      row.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px; cursor: pointer;" class="user-info-area">
          <img src="${user.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&h=80&q=80'}" alt="${user.fullName}" class="user-row-avatar" style="width: 38px; height: 38px; border-radius: 50%; object-fit: cover;" />
          <div class="user-row-info">
            <h5 style="margin: 0; font-size: 13px; font-weight: 600; color: var(--text-color);">${user.fullName}</h5>
            <p style="margin: 0; font-size: 11px; color: var(--text-muted);">@${user.username} • <span style="color: var(--primary);">${user.followersCount || 0} Hubbers</span></p>
          </div>
        </div>
        <button class="${btnClass}" data-user-id="${user._id}" style="${btnStyle}" ${isRequested ? 'disabled' : ''}>${btnText}</button>
      `;
      listContainer.appendChild(row);

      const infoArea = row.querySelector('.user-info-area');
      if (infoArea) {
        infoArea.addEventListener('click', () => {
          switchView('profile', getUserIdentifier(user));
        });
      }

      const btnElement = row.querySelector('.follow-row-btn');
      if (btnElement) {
        btnElement.addEventListener('click', async (e) => {
          e.stopPropagation();
          await toggleFollowUser(user._id, btnElement, user);
        });
      }
    });
  }

  // --- TRENDING HUBBS HOME WIDGET ---
  async function loadTrendingHubbs() {
    const container = document.getElementById('trending-hubbs-list');
    if (!container) return;

    try {
      const res = await fetch(`${API_URL}/api/posts/trending`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const hubbs = await res.json();

      container.innerHTML = '';
      if (!hubbs || hubbs.length === 0) {
        container.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 13px;">No trending hubbs.</div>';
        return;
      }

      hubbs.forEach(hubb => {
        const item = document.createElement('div');
        item.className = 'trending-hubb-item';
        item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; margin-bottom: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; cursor: pointer; transition: all 0.2s ease;';

        item.addEventListener('mouseenter', () => {
          item.style.background = 'rgba(168, 85, 247, 0.12)';
          item.style.borderColor = 'rgba(168, 85, 247, 0.3)';
        });
        item.addEventListener('mouseleave', () => {
          item.style.background = 'rgba(255,255,255,0.03)';
          item.style.borderColor = 'rgba(255,255,255,0.06)';
        });

        const displayTitle = (hubb.title || '').replace(/<[^>]*>/g, '').trim() || 'Latest Hubb';

        item.innerHTML = `
          <div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;">
            ${hubb.mediaUrl ? `
              <div style="width: 36px; height: 36px; border-radius: 8px; overflow: hidden; flex-shrink: 0; background: #000;">
                ${hubb.mediaType === 'video' ? `<video src="${hubb.mediaUrl}" style="width:100%; height:100%; object-fit:cover;"></video>` : `<img src="${hubb.mediaUrl}" style="width:100%; height:100%; object-fit:cover;" />`}
              </div>
            ` : `
              <div style="width: 36px; height: 36px; border-radius: 8px; flex-shrink: 0; background: linear-gradient(135deg, #6c3bff, #a855f7); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 14px;">
                #
              </div>
            `}
            <div style="min-width: 0; flex: 1;">
              <div style="font-size: 12px; font-weight: 600; color: var(--text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${displayTitle}</div>
              <div style="font-size: 10px; color: var(--text-muted); display: flex; align-items: center; gap: 4px; margin-top: 1px;">
                <span style="color: var(--primary, #a855f7); font-weight: 600;">${hubb.hashtag}</span>
                <span>•</span>
                <span>@${hubb.author.username}</span>
              </div>
            </div>
          </div>
          <div style="font-size: 10px; color: var(--text-muted); display: flex; align-items: center; gap: 3px; padding-left: 6px; flex-shrink: 0;">
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="color: #ef4444;"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
            <span>${hubb.likesCount || 0}</span>
          </div>
        `;

        item.addEventListener('click', () => {
          const card = document.getElementById(`post-${hubb._id}`);
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.style.outline = '2px solid var(--primary, #a855f7)';
            setTimeout(() => { card.style.outline = 'none'; }, 2000);
          }
        });

        container.appendChild(item);
      });
    } catch (err) {
      console.error('[loadTrendingHubbs Error]:', err);
    }
  }


  // --- UNIFIED ROBUST FOLLOW / HUBBIES REQUEST HANDLER ---
  async function toggleFollowUser(targetUserId, btnElement, userObj = null) {
    const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
    if (!token) {
      showToast('Please log in to connect with Hubbers! 🔐');
      return;
    }

    if (!targetUserId || !btnElement) return;

    // Prevent duplicate spam clicks
    if (btnElement.disabled || btnElement.getAttribute('data-submitting') === 'true') {
      return;
    }

    const currentText = btnElement.textContent.trim();
    const isFollowing = btnElement.classList.contains('followed') || currentText === 'Hubbies';
    const isPending = btnElement.classList.contains('requested') || currentText === 'Requested';

    if (isPending) {
      showToast('Hubbies request is already pending. ⏳');
      return;
    }

    const endpoint = isFollowing ? 'unfollow' : 'follow';
    const fullApiUrl = `${API_URL}/api/users/${targetUserId}/${endpoint}`;

    // 1. Immediately disable button & show loading state to prevent double-clicks
    const prevText = btnElement.textContent;
    const prevDisabled = btnElement.disabled;
    const prevStyle = btnElement.getAttribute('style') || '';
    btnElement.disabled = true;
    btnElement.setAttribute('data-submitting', 'true');
    btnElement.textContent = endpoint === 'follow' ? 'Sending...' : 'Updating...';

    try {
      const res = await fetch(fullApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Follow action failed');

      if (endpoint === 'follow') {
        if (data.status === 'following') {
          btnElement.classList.add('followed');
          btnElement.classList.remove('requested');
          btnElement.textContent = 'Hubbies';
          btnElement.style.background = '#22c55e';
          btnElement.style.color = '#ffffff';
          btnElement.disabled = false;
        } else {
          btnElement.classList.add('requested');
          btnElement.classList.remove('followed');
          btnElement.textContent = 'Requested';
          btnElement.style.background = 'rgba(255, 255, 255, 0.15)';
          btnElement.style.color = 'var(--text-muted, #94a3b8)';
          btnElement.disabled = true;
        }
        showToast(data.message || 'Hubbies request sent successfully! 📩');
      } else {
        btnElement.classList.remove('followed', 'requested');
        btnElement.textContent = 'Follow';
        btnElement.style.background = 'var(--primary, #a855f7)';
        btnElement.style.color = '#ffffff';
        btnElement.disabled = false;
        showToast('Unfollowed successfully.');
      }

      // Update counters & UI
      if (typeof loadProfileStats === 'function') loadProfileStats();
      if (typeof loadFollowSuggestions === 'function') loadFollowSuggestions();
    } catch (err) {
      console.error('[toggleFollowUser Error]:', err.message);
      btnElement.textContent = prevText;
      btnElement.disabled = prevDisabled;
      btnElement.setAttribute('style', prevStyle);
      showToast(err.message || 'Action failed, please try again.');
    } finally {
      btnElement.removeAttribute('data-submitting');
    }
  }

  // --- SUGGESTED HUBBERS "SEE ALL" MODAL SYSTEM ---
  const suggestedVibersModal = document.getElementById('suggested-vibers-modal');
  const suggestedVibersCloseBtn = document.getElementById('suggested-vibers-close-btn');
  const suggestedVibersContent = document.getElementById('suggested-vibers-content');
  const suggestedHubbersSearchInput = document.getElementById('suggested-hubbers-search-input');
  let cachedSuggestedHubbers = [];

  if (suggestedVibersCloseBtn && suggestedVibersModal) {
    suggestedVibersCloseBtn.addEventListener('click', () => {
      suggestedVibersModal.classList.remove('active');
    });
  }

  // Render cards in the modal
  function renderModalHubbersList(users) {
    if (!suggestedVibersContent) return;
    suggestedVibersContent.innerHTML = '';

    if (!users || users.length === 0) {
      suggestedVibersContent.innerHTML = `
        <div style="text-align: center; padding: 40px 16px; color: var(--text-muted);">
          <i data-lucide="users" style="width: 36px; height: 36px; opacity: 0.4; margin-bottom: 8px; display: inline-block;"></i>
          <p style="font-size: 13.5px; margin: 0;">No discoverable Hubbers found.</p>
        </div>
      `;
      debouncedCreateIcons();
      return;
    }

    users.forEach(user => {
      const card = document.createElement('div');
      card.className = 'suggested-hubber-card';
      card.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; margin-bottom: 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 14px; transition: all 0.2s ease;';

      const isRequested = user.followStatus === 'pending';
      const isFollowing = user.followStatus === 'following';

      let btnClass = 'search-follow-btn modal-suggest-follow-btn';
      let btnText = 'Follow';
      let btnStyle = 'padding: 6px 16px; border-radius: 20px; font-weight: 600; font-size: 12px; border: none; cursor: pointer; background: var(--primary, #a855f7); color: white; flex-shrink: 0; transition: all 0.2s ease;';

      if (isRequested) {
        btnClass += ' requested';
        btnText = 'Requested';
        btnStyle = 'padding: 6px 16px; border-radius: 20px; font-weight: 600; font-size: 12px; border: none; cursor: not-allowed; background: rgba(255,255,255,0.15); color: var(--text-muted, #94a3b8); flex-shrink: 0;';
      } else if (isFollowing) {
        btnClass += ' followed';
        btnText = 'Hubbies';
        btnStyle = 'padding: 6px 16px; border-radius: 20px; font-weight: 600; font-size: 12px; border: none; cursor: pointer; background: #22c55e; color: white; flex-shrink: 0;';
      }

      const bioHtml = user.bio ? `<p class="hubber-card-bio" style="margin: 3px 0 0 0; font-size: 11.5px; color: var(--text-muted); max-width: 250px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${user.bio}</p>` : '';
      const statsHtml = `<span style="font-size: 11px; color: var(--text-muted); display: block; margin-top: 3px;">${user.postsCount || 0} Hubbs • <span style="color: var(--primary, #a855f7); font-weight: 600;">${user.followersCount || 0} Hubbies</span></span>`;

      card.innerHTML = `
        <div class="person-info" style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; cursor: pointer;">
          <img src="${user.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=100&h=100&q=80'}" alt="${user.fullName}" style="width: 44px; height: 44px; border-radius: 50%; object-fit: cover; flex-shrink: 0; border: 1.5px solid rgba(168,85,247,0.3);" />
          <div style="flex: 1; min-width: 0;">
            <strong style="font-size: 13.5px; color: var(--text-color); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${user.fullName}</strong>
            <span style="font-size: 11.5px; color: var(--text-muted); display: block;">@${user.username}</span>
            ${bioHtml}
            ${statsHtml}
          </div>
        </div>
        <button class="${btnClass}" data-user-id="${user._id}" style="${btnStyle}" ${isRequested ? 'disabled' : ''}>
          ${btnText}
        </button>
      `;

      // Profile click navigation
      const infoArea = card.querySelector('.person-info');
      if (infoArea) {
        infoArea.addEventListener('click', () => {
          if (suggestedVibersModal) suggestedVibersModal.classList.remove('active');
          switchView('profile', getUserIdentifier(user));
        });
      }

      // Follow action
      const followBtn = card.querySelector('.modal-suggest-follow-btn');
      if (followBtn) {
        followBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const uid = followBtn.getAttribute('data-user-id');
          await toggleFollowUser(uid, followBtn, user);
        });
      }

      suggestedVibersContent.appendChild(card);
    });

    debouncedCreateIcons();
  }

  async function openSuggestedVibersModal() {
    if (!suggestedVibersContent) return;

    // Reset search bar
    if (suggestedHubbersSearchInput) {
      suggestedHubbersSearchInput.value = '';
    }

    suggestedVibersContent.innerHTML = `
      <div style="text-align: center; padding: 40px 16px; color: var(--text-muted);">
        <i data-lucide="loader" style="width: 28px; height: 28px; animation: spin 1s linear infinite; margin-bottom: 8px; display: inline-block;"></i>
        <p style="font-size: 13px; margin: 0;">Discovering Hubbers...</p>
      </div>
    `;
    debouncedCreateIcons();

    if (suggestedVibersModal) suggestedVibersModal.classList.add('active');

    try {
      const suggestions = await getSuggestedHubbers(50);
      cachedSuggestedHubbers = suggestions || [];
      console.log(`[Suggested Hubbers Modal] Rendering ${cachedSuggestedHubbers.length} items to Modal`);

      renderModalHubbersList(cachedSuggestedHubbers);

      // Wire up live search filter
      if (suggestedHubbersSearchInput) {
        suggestedHubbersSearchInput.oninput = (e) => {
          const q = (e.target.value || '').toLowerCase().trim().replace(/^@/, '');
          if (!q) {
            renderModalHubbersList(cachedSuggestedHubbers);
            return;
          }
          const filtered = cachedSuggestedHubbers.filter(u =>
            (u.fullName && u.fullName.toLowerCase().includes(q)) ||
            (u.username && u.username.toLowerCase().includes(q))
          );
          renderModalHubbersList(filtered);
        };
      }
    } catch (err) {
      console.error('[openSuggestedVibersModal Error]:', err);
      suggestedVibersContent.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--error-color);">Error loading suggestions</div>';
    }
  }

  // --- ACTIVE HUBBERS WIDGET ---
  const activeVibersCount = document.getElementById('active-vibers-count');
  const activeVibersList = document.getElementById('active-vibers-list');

  function renderActiveVibersWidget(activeUsers = [], onlineCount = 0) {
    if (!activeVibersList) return;
    if (activeVibersCount) {
      activeVibersCount.textContent = `${onlineCount} online`;
    }

    activeVibersList.innerHTML = '';
    if (!activeUsers || activeUsers.length === 0) {
      activeVibersList.innerHTML = '<p style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 12px; width: 100%;">No hubbers online</p>';
      return;
    }

    activeUsers.slice(0, 5).forEach(user => {
      const circle = document.createElement('div');
      circle.className = 'face-circle online';
      circle.style.position = 'relative';
      circle.style.cursor = 'pointer';
      circle.title = `${user.fullName} (@${user.username})`;
      circle.innerHTML = `
        <img src="${user.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80'}" alt="${user.fullName}" style="width: 36px; height: 36px; border-radius: 50%; object-fit: cover;" />
        <span class="online-indicator-dot" style="position: absolute; bottom: 0; right: 0; width: 10px; height: 10px; background: #22c55e; border: 2px solid #1a1a24; border-radius: 50%;"></span>
      `;

      circle.addEventListener('click', () => {
        switchView('profile', getUserIdentifier(user));
      });

      activeVibersList.appendChild(circle);
    });
  }
  window.renderActiveVibersWidget = renderActiveVibersWidget;

  async function loadActiveVibers() {
    const pm = (typeof presenceManager !== 'undefined' ? presenceManager : null) || window.presenceManager || window.PresenceManager;
    if (!pm) return;
    if (pm.isInitialized) {
      renderActiveVibersWidget(pm.activeUsersList, pm.onlineCount);
    } else {
      await pm.fetchOnlineUsers();
    }
  }
  window.loadActiveVibers = loadActiveVibers;

  async function loadProfileStats() {
    const currentUserStr = localStorage.getItem('invibeUser');
    if (!currentUserStr) return;
    const currentUser = JSON.parse(currentUserStr);
    const currentUserId = (currentUser.id || currentUser._id || '').toString();

    try {
      const res = await fetch(`${API_URL}/api/users/${currentUserId}/relations`);
      if (!res.ok) throw new Error('Failed to fetch user relations');
      const data = await res.json();

      const sidebarFollowers = document.getElementById('user-followers-count');
      const sidebarFollowing = document.getElementById('user-following-count');
      if (sidebarFollowers) sidebarFollowers.textContent = formatCount(data.followersCount);
      if (sidebarFollowing) sidebarFollowing.textContent = formatCount(data.followingCount);

      // Only update profile view counters if the active view belongs to the logged in user
      const isViewingSelf = (!state.viewingProfileUserId || state.viewingProfileUserId === 'me' || state.viewingProfileUserId === currentUserId || state.viewingProfileUserId === currentUser.username);

      if (isViewingSelf) {
        const profileFollowers = document.getElementById('profile-followers-count');
        const profileFollowing = document.getElementById('profile-following-count');
        const profileVibes = document.getElementById('profile-vibes-count');

        if (profileFollowers) profileFollowers.textContent = formatCount(data.followersCount);
        if (profileFollowing) profileFollowing.textContent = formatCount(data.followingCount);
        if (profileVibes && data.postsCount !== undefined) profileVibes.textContent = formatCount(data.postsCount);
      }
    } catch (err) {
      console.error('Error loading profile stats:', err);
    }
  }

  function formatCount(num) {
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num;
  }

  // --- REELS OPTIONS DROPDOWN HELPERS ---
  window.reelsAutoplay = false;
  window.lastScrollTopBeforeFullscreen = 0;

  function copyReelLink(reelId) {
    const link = `${window.location.origin}${window.location.pathname}?reelId=${reelId}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link)
        .then(() => {
          showToast('Link copied 🔗');
        })
        .catch(err => {
          console.error('[COPY LINK ERROR]', err);
          fallbackCopyTextToClipboard(link);
        });
    } else {
      fallbackCopyTextToClipboard(link);
    }
  }

  function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      const successful = document.execCommand('copy');
      if (successful) {
        showToast('Link copied 🔗');
      } else {
        alert('Unable to copy link.');
      }
    } catch (err) {
      console.error('[FALLBACK COPY ERROR]', err);
      alert('Unable to copy link.');
    }
    document.body.removeChild(textArea);
  }

  function requestReelFullscreen(el) {
    // Store current scroll position of main content wrapper
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      window.lastScrollTopBeforeFullscreen = mainContent.scrollTop;
    }

    if (el.requestFullscreen) {
      el.requestFullscreen();
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    } else if (el.msRequestFullscreen) {
      el.msRequestFullscreen();
    }
  }

  function exitReelFullscreen() {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen();
    }
  }

  // Restore scroll position on exiting fullscreen
  document.addEventListener('fullscreenchange', () => {
    const isCurrentlyFullscreen = document.fullscreenElement !== null;
    if (!isCurrentlyFullscreen && window.lastScrollTopBeforeFullscreen !== undefined) {
      const mainContent = document.querySelector('.main-content');
      if (mainContent) {
        mainContent.scrollTop = window.lastScrollTopBeforeFullscreen;
      }
    }
  });
  document.addEventListener('webkitfullscreenchange', () => {
    const isCurrentlyFullscreen = document.webkitFullscreenElement !== null;
    if (!isCurrentlyFullscreen && window.lastScrollTopBeforeFullscreen !== undefined) {
      const mainContent = document.querySelector('.main-content');
      if (mainContent) {
        mainContent.scrollTop = window.lastScrollTopBeforeFullscreen;
      }
    }
  });

  function scrollToReelCard(nextCard) {
    if (!nextCard) return;
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      const mainContentRect = mainContent.getBoundingClientRect();
      const nextCardRect = nextCard.getBoundingClientRect();

      const header = document.querySelector('#view-explore .explore-header-row');
      const headerHeight = header ? header.offsetHeight : 0;

      const targetScrollTop = nextCardRect.top - mainContentRect.top + mainContent.scrollTop - headerHeight - 8;

      mainContent.scrollTo({
        top: targetScrollTop,
        behavior: 'smooth'
      });
    }
  }

  function syncAutoplayLoopState() {
    document.querySelectorAll('.reel-video').forEach(video => {
      video.loop = !window.reelsAutoplay;
    });
  }

  function wireReelInteractions(scroller) {
    const cards = scroller.querySelectorAll('.reel-card');
    cards.forEach(card => {
      const video = card.querySelector('.reel-video');
      const playPop = card.querySelector('.reel-play-icon-overlay');
      const likeBtn = card.querySelector('.reel-like-action .heart-btn');
      const reelId = card.querySelector('.reel-like-action')?.getAttribute('data-reel-id');

      // Video state change listeners to keep UI synchronized
      if (video) {
        video.loop = !window.reelsAutoplay;
        video.addEventListener('play', () => {
          if (playPop) {
            playPop.classList.remove('paused-state');
          }
          if (window.debouncedCreateIcons) window.debouncedCreateIcons();
        });

        video.addEventListener('pause', () => {
          if (playPop) {
            playPop.classList.add('paused-state');
          }
          if (window.debouncedCreateIcons) window.debouncedCreateIcons();
        });

        video.addEventListener('ended', () => {
          if (window.reelsAutoplay) {
            const isCurrentlyFullscreen = document.fullscreenElement === card || document.webkitFullscreenElement === card;
            if (isCurrentlyFullscreen) {
              exitReelFullscreen();
            }

            const scroller = video.closest('.reels-scroller');
            if (scroller) {
              const cards = Array.from(scroller.querySelectorAll('.reel-card'));
              const currentIndex = cards.indexOf(card);
              if (currentIndex !== -1) {
                const nextCard = cards[currentIndex + 1];
                if (nextCard) {
                  scrollToReelCard(nextCard);
                }
              }
            }
          }
        });
      }

      const togglePlayPause = () => {
        if (window.hubbingPlaybackController) {
          window.hubbingPlaybackController.togglePlayPause(card);
        }
      };

      card.addEventListener('click', (e) => {
        if (e.detail > 1) return;
        if (e.target.closest('.reel-right-actions')) return;
        togglePlayPause();
      });

      let lastReelTap = 0;
      card.addEventListener('click', async (e) => {
        const now = Date.now();
        const timespan = now - lastReelTap;
        if (timespan < 300 && timespan > 0) {
          e.preventDefault();
          const rect = card.getBoundingClientRect();
          const relativeX = e.clientX - rect.left;
          const relativeY = e.clientY - rect.top;

          triggerHeartExplosion(relativeX, relativeY, card);

          if (likeBtn && !likeBtn.classList.contains('liked')) {
            await toggleReelLike(reelId, likeBtn);
          } else {
            triggerHeartExplosion(relativeX, relativeY, card);
          }
        }
        lastReelTap = now;
      });

      const likeBtnAction = card.querySelector('.reel-like-action');
      if (likeBtnAction && likeBtn) {
        likeBtnAction.addEventListener('click', async (e) => {
          e.stopPropagation();
          await toggleReelLike(reelId, likeBtn);
        });
      }

      const saveBtnAction = card.querySelector('.reel-save-action');
      const starBtn = card.querySelector('.reel-save-action .star-btn');
      if (saveBtnAction && starBtn) {
        saveBtnAction.addEventListener('click', async (e) => {
          e.stopPropagation();
          await toggleReelSave(reelId, starBtn);
        });
      }

      const audioBtnAction = card.querySelector('.reel-audio-action');
      if (audioBtnAction) {
        audioBtnAction.addEventListener('click', (e) => {
          e.stopPropagation();
          if (window.hubbingPlaybackController) {
            window.hubbingPlaybackController.toggleAudio(card);
          }
        });
      }

      const followReel = card.querySelector('.reel-follow-btn');
      if (followReel) {
        followReel.addEventListener('click', async (e) => {
          e.stopPropagation();
          const authorId = followReel.getAttribute('data-author-id');
          await toggleFollowFromReel(authorId, followReel);
        });
      }

      const reelUserEls = card.querySelectorAll('.reel-user img, .reel-user span');
      const reelAuthorId = followReel?.getAttribute('data-author-id');
      reelUserEls.forEach(el => {
        if (el && reelAuthorId) {
          el.style.cursor = 'pointer';
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            switchView('profile', reelAuthorId);
          });
        }
      });

      const commentBtn = card.querySelector('.reel-comment-sim');
      const commentModal = card.querySelector('.reel-comments-modal');
      const commentCountSpan = card.querySelector('.reel-comment-sim .action-count');
      if (commentBtn && commentModal) {
        commentBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          commentModal.classList.add('active');
          loadReelComments(reelId, commentModal);
        });
        const closeBtn = commentModal.querySelector('.modal-close-btn');
        if (closeBtn) {
          closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            commentModal.classList.remove('active');
          });
        }
        commentModal.addEventListener('click', (e) => {
          if (e.target === commentModal) {
            commentModal.classList.remove('active');
          }
        });

        const sendBtn = commentModal.querySelector('.comment-send-btn');
        const inputField = commentModal.querySelector('input');
        if (sendBtn && inputField) {
          const handleSend = async () => {
            const text = inputField.value.trim();
            if (text) {
              await submitReelComment(reelId, text, inputField, commentModal, commentCountSpan);
            }
          };
          sendBtn.addEventListener('click', handleSend);
          inputField.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleSend();
            }
          });
        }
      }

      const shareBtn = card.querySelector('.reel-share-sim');
      const shareModal = card.querySelector('.reel-share-modal');
      const shareCountSpan = card.querySelector('.reel-share-sim .action-count');
      if (shareBtn && shareModal) {
        shareBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          handleReelShare(reelId, shareModal, shareCountSpan);
        });
        const closeBtn = shareModal.querySelector('.modal-close-btn');
        if (closeBtn) {
          closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            shareModal.classList.remove('active');
          });
        }
        shareModal.addEventListener('click', (e) => {
          if (e.target === shareModal) {
            shareModal.classList.remove('active');
          }
        });
      }

      const mascotOverlay = card.querySelector('.reel-mascot-overlay');
      if (mascotOverlay) {
        mascotOverlay.addEventListener('click', (e) => {
          e.stopPropagation();
          mascotOverlay.style.transform = 'translateX(-50%) scale(1.2)';
          setTimeout(() => { mascotOverlay.style.transform = 'translateX(-50%) scale(1)'; }, 300);
          showToast('Hi-HUBBLE Hubbing Mascot 🚀💜');
        });
      }

      const capsule = card.querySelector('.reel-actions-capsule');
      if (capsule) {
        let isDraggingCapsule = false;
        let wasDragging = false;
        let startX, startY;
        let posX = 0;
        let posY = 0;
        let minX = -Infinity, maxX = Infinity, minY = -Infinity, maxY = Infinity;
        let currentRAF = null;
        let pendingTargetX = 0;
        let pendingTargetY = 0;

        capsule.addEventListener('mousedown', dragStart);
        capsule.addEventListener('touchstart', dragStart, { passive: false });

        capsule.addEventListener('click', (e) => {
          if (wasDragging) {
            e.stopPropagation();
            e.preventDefault();
          }
        }, true);

        function getDragCoords(e) {
          if (e.touches && e.touches.length > 0) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
          if (e.changedTouches && e.changedTouches.length > 0) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
          return { x: e.clientX, y: e.clientY };
        }

        function dragStart(e) {
          if (window.innerWidth > 768) return;
          if (e.type === 'mousedown' && e.button !== 0) return;
          isDraggingCapsule = false;
          wasDragging = false;
          const coords = getDragCoords(e);
          startX = coords.x;
          startY = coords.y;
          posX = parseFloat(capsule.getAttribute('data-x')) || 0;
          posY = parseFloat(capsule.getAttribute('data-y')) || 0;
          
          const cardRect = card.getBoundingClientRect();
          const capsuleRect = capsule.getBoundingClientRect();
          const initialLeft = capsuleRect.left - posX;
          const initialTop = capsuleRect.top - posY;
          
          minX = cardRect.left - initialLeft + 12;
          maxX = cardRect.right - capsuleRect.width - initialLeft - 12;
          minY = cardRect.top - initialTop + 12;
          maxY = cardRect.bottom - capsuleRect.height - initialTop - 12;

          capsule.style.transition = 'none';
          capsule.classList.add('dragging-capsule');
          document.addEventListener('mousemove', dragMove);
          document.addEventListener('mouseup', dragEnd);
          document.addEventListener('touchmove', dragMove, { passive: false });
          document.addEventListener('touchend', dragEnd);
        }

        function updatePosition() {
          currentRAF = null;
          capsule.style.transform = `translate3d(${pendingTargetX}px, ${pendingTargetY}px, 0) scale(1.05)`;
          capsule.setAttribute('data-target-x', pendingTargetX.toString());
          capsule.setAttribute('data-target-y', pendingTargetY.toString());
        }

        function dragMove(e) {
          const coords = getDragCoords(e);
          const deltaX = coords.x - startX;
          const deltaY = coords.y - startY;

          if (!isDraggingCapsule) {
            if (Math.abs(deltaX) > 6 || Math.abs(deltaY) > 6) {
              isDraggingCapsule = true;
              wasDragging = true;
            }
          }

          if (isDraggingCapsule) {
            if (e.cancelable) e.preventDefault();
            let targetX = posX + deltaX;
            let targetY = posY + deltaY;

            targetX = Math.max(minX, Math.min(maxX, targetX));
            targetY = Math.max(minY, Math.min(maxY, targetY));

            pendingTargetX = targetX;
            pendingTargetY = targetY;

            if (!currentRAF) {
              currentRAF = requestAnimationFrame(updatePosition);
            }
          }
        }

        function dragEnd() {
          document.removeEventListener('mousemove', dragMove);
          document.removeEventListener('mouseup', dragEnd);
          document.removeEventListener('touchmove', dragMove);
          document.removeEventListener('touchend', dragEnd);

          if (currentRAF) {
            cancelAnimationFrame(currentRAF);
            currentRAF = null;
            updatePosition();
          }

          capsule.style.transition = '';
          capsule.classList.remove('dragging-capsule');

          if (isDraggingCapsule) {
            const finalX = parseFloat(capsule.getAttribute('data-target-x')) || 0;
            const finalY = parseFloat(capsule.getAttribute('data-target-y')) || 0;
            capsule.setAttribute('data-x', finalX.toString());
            capsule.setAttribute('data-y', finalY.toString());
            capsule.style.transform = `translate3d(${finalX}px, ${finalY}px, 0)`;
            showToast('Repositioned Reels menu! ⚓');
            setTimeout(() => {
              wasDragging = false;
              isDraggingCapsule = false;
            }, 50);
          } else {
            capsule.style.transform = `translate3d(${posX}px, ${posY}px, 0)`;
            isDraggingCapsule = false;
            wasDragging = false;
          }
        }
      }

      // Dedicated bottom tap-zone listener for smooth reel navigation
      const navZone = card.querySelector('.reel-bottom-navigation-zone');
      if (navZone) {
        navZone.addEventListener('click', (e) => {
          e.stopPropagation();
          const cards = Array.from(scroller.querySelectorAll('.reel-card'));
          const currentIndex = cards.indexOf(card);
          if (currentIndex !== -1) {
            let nextCard = cards[currentIndex + 1];
            if (!nextCard) {
              // Loop back to first reel smoothly
              nextCard = cards[0];
            }
            if (nextCard) {
              const mainContent = document.querySelector('.main-content');
              if (mainContent) {
                const mainContentRect = mainContent.getBoundingClientRect();
                const nextCardRect = nextCard.getBoundingClientRect();

                // Get header offset dynamically if it exists (e.g. on Explore/Hubbing page)
                const header = document.querySelector('#view-explore .explore-header-row');
                const headerHeight = header ? header.offsetHeight : 0;

                const targetScrollTop = nextCardRect.top - mainContentRect.top + mainContent.scrollTop - headerHeight - 8;

                mainContent.scrollTo({
                  top: targetScrollTop,
                  behavior: 'smooth'
                });
              }
            }
          }
        });
      }
      // 6. Action Menu Toggling and Binding
      const moreBtn = card.querySelector('.reel-more-sim');
      if (moreBtn) {
        // Ensure z-index is set high to sit above any bottom nav zones
        moreBtn.style.cssText = "position: relative; z-index: 10 !important;";

        moreBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        moreBtn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
        moreBtn.addEventListener('pointerdown', (e) => e.stopPropagation());

        moreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();

          const existingDropdown = moreBtn.querySelector('.reel-action-dropdown');
          if (existingDropdown) {
            existingDropdown.remove();
          } else {
            // Close any other open dropdowns
            document.querySelectorAll('.reel-action-dropdown').forEach(d => d.remove());

            // Check current fullscreen state
            const isCurrentlyFullscreen = document.fullscreenElement === card || document.webkitFullscreenElement === card;

            // Create dropdown menu
            const dropdown = document.createElement('div');
            dropdown.className = 'reel-action-dropdown';
            dropdown.style.cssText = `position: absolute; bottom: 48px; right: 0; background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.15); border-radius: 12px; padding: 6px; display: flex; flex-direction: column; gap: 4px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); z-index: 100; min-width: 140px;`;

            dropdown.innerHTML = `
              <button class="menu-item copy-link" style="background: none; border: none; color: white; padding: 8px 12px; border-radius: 8px; font-size: 12px; text-align: left; cursor: pointer; display: flex; align-items: center; gap: 8px; font-weight: 500; transition: background 0.15s; width: 100%; box-sizing: border-box;"><i data-lucide="copy" style="width: 13px; height: 13px; stroke: white;"></i> Copy Link</button>
              <button class="menu-item toggle-fullscreen" style="background: none; border: none; color: white; padding: 8px 12px; border-radius: 8px; font-size: 12px; text-align: left; cursor: pointer; display: flex; align-items: center; gap: 8px; font-weight: 500; transition: background 0.15s; width: 100%; box-sizing: border-box;"><i data-lucide="${isCurrentlyFullscreen ? 'minimize' : 'maximize'}" style="width: 13px; height: 13px; stroke: white;"></i> ${isCurrentlyFullscreen ? 'Exit Full Screen' : 'Full Screen'}</button>
              <button class="menu-item toggle-autoplay" style="background: none; border: none; color: white; padding: 8px 12px; border-radius: 8px; font-size: 12px; text-align: left; cursor: pointer; display: flex; align-items: center; gap: 8px; font-weight: 500; transition: background 0.15s; width: 100%; box-sizing: border-box;"><i data-lucide="play-circle" style="width: 13px; height: 13px; stroke: white;"></i> Autoplay${window.reelsAutoplay ? ' ✓' : ''}</button>
            `;

            moreBtn.appendChild(dropdown);
            if (window.debouncedCreateIcons) window.debouncedCreateIcons();

            // 1. Copy Link Click
            const copyLinkBtn = dropdown.querySelector('.copy-link');
            if (copyLinkBtn) {
              copyLinkBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
                dropdown.remove();
                copyReelLink(reelId);
              });
            }

            // 2. Full Screen Click
            const fsBtn = dropdown.querySelector('.toggle-fullscreen');
            if (fsBtn) {
              fsBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
                dropdown.remove();
                if (isCurrentlyFullscreen) {
                  exitReelFullscreen();
                } else {
                  requestReelFullscreen(card);
                }
              });
            }

            // 3. Autoplay Click
            const apBtn = dropdown.querySelector('.toggle-autoplay');
            if (apBtn) {
              apBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
                dropdown.remove();
                window.reelsAutoplay = !window.reelsAutoplay;
                syncAutoplayLoopState();
                const status = window.reelsAutoplay ? 'enabled ✓' : 'disabled';
                showToast(`Autoplay ${status}`);
              });
            }
          }
        });
      }
    });
  }

  // Close all reels action dropdowns on clicking outside
  document.addEventListener('click', (e) => {
    const openDropdowns = document.querySelectorAll('.reel-action-dropdown');
    openDropdowns.forEach(dropdown => {
      if (!dropdown.closest('.reel-more-sim')?.contains(e.target)) {
        dropdown.remove();
      }
    });
  });

  // --- USER PROFILE LOADER SYSTEM ---
  let currentProfileRequestId = 0;

  async function loadUserProfile(targetUserIdInput) {
    const requestId = ++currentProfileRequestId;
    const currentUserStr = localStorage.getItem('invibeUser');
    if (!currentUserStr) return;
    const currentUser = JSON.parse(currentUserStr);
    const currentUserId = (currentUser.id || currentUser._id || '').toString();
    const localPhoto = localStorage.getItem('invibeProfileImage');

    const cleanInputId = getUserIdentifier(targetUserIdInput);
    const isMe = (!cleanInputId || cleanInputId === 'me' || cleanInputId === currentUserId || cleanInputId === currentUser.username);

    // Track active profile viewing ID in global state
    state.viewingProfileUserId = isMe ? currentUserId : cleanInputId;

    const profileAvatar = document.querySelector('.profile-screen-avatar');
    const profileName = document.querySelector('.profile-summary-top h3');
    const profileHandle = document.querySelector('.profile-screen-handle');
    const profileBio = document.getElementById('profile-bio-text');
    const followBtn = document.getElementById('profile-follow-btn');
    const optionsList = document.querySelector('.profile-options-list');
    const logoutBtn = document.getElementById('profile-logout-btn');
    const followersCount = document.getElementById('profile-followers-count');
    const followingCount = document.getElementById('profile-following-count');
    const vibesCount = document.getElementById('profile-vibes-count');
    const vibesGrid = document.getElementById('profile-vibes-grid');
    const reelsGrid = document.getElementById('profile-reels-grid');
    const taggedGrid = document.getElementById('profile-tagged-grid');
    const savedTabBtn = document.querySelector('.profile-content-tab[data-profile-tab="saved"]');
    const vibesTabBtn = document.querySelector('.profile-content-tab[data-profile-tab="vibes"]');
    const savedGrid = document.getElementById('profile-saved-grid');

    // Handle Own Profile vs Other User UI Elements Visibility
    const profileSettingsBtn = document.getElementById('profile-settings-btn');
    if (isMe) {
      if (profileSettingsBtn) profileSettingsBtn.style.visibility = 'visible';
      if (followBtn) followBtn.style.display = 'none';
      if (optionsList) optionsList.style.display = 'grid';
      if (logoutBtn) logoutBtn.style.display = 'block';
      if (savedTabBtn) savedTabBtn.style.display = '';

      // Initialize UI with current local profile data for instant responsiveness
      if (profileAvatar) profileAvatar.src = localPhoto || currentUser.profileImage || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80';
      if (profileName) profileName.innerHTML = escapeHtml(currentUser.fullName || currentUser.username || 'User');
      if (profileHandle) profileHandle.textContent = '@' + (currentUser.username || 'user');
      if (profileBio) profileBio.textContent = currentUser.bio || 'Hubber creator on Hi-Hubble 🚀';

      const savedBannerUrl = localStorage.getItem('invibeBannerImage') || currentUser.bannerImage || currentUser.cover_image_url;
      const profileBannerImg = document.querySelector('.profile-banner img');
      if (profileBannerImg) {
        if (savedBannerUrl) {
          profileBannerImg.src = savedBannerUrl;
          profileBannerImg.style.display = 'block';
          profileBannerImg.style.opacity = '1';
        } else {
          profileBannerImg.src = '';
        }
      }
    } else {
      if (profileSettingsBtn) profileSettingsBtn.style.visibility = 'hidden';
      if (optionsList) optionsList.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = 'none';
      if (savedTabBtn) savedTabBtn.style.display = 'none';
      if (savedGrid) savedGrid.classList.remove('active');

      // Make sure active tab is not saved tab when viewing other users
      if (vibesTabBtn && !vibesTabBtn.classList.contains('active') && savedGrid?.classList.contains('active')) {
        document.querySelectorAll('.profile-content-tab').forEach(b => b.classList.remove('active'));
        vibesTabBtn.classList.add('active');
        if (vibesGrid) vibesGrid.classList.add('active');
      }

      if (followBtn) {
        followBtn.style.display = 'block';
        followBtn.setAttribute('data-user-id', cleanInputId);
        followBtn.classList.remove('followed');
        followBtn.textContent = 'Follow';
      }

      // Show clean loading state while fetching other user
      if (profileName) profileName.innerHTML = '<span style="opacity: 0.6;">Loading...</span>';
      if (profileHandle) profileHandle.textContent = '@' + (cleanInputId && cleanInputId.startsWith('@') ? cleanInputId.slice(1) : (cleanInputId || 'user'));
      if (profileBio) profileBio.textContent = '';
      if (profileAvatar) profileAvatar.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      const profileBannerImg = document.querySelector('.profile-banner img');
      if (profileBannerImg) {
        profileBannerImg.src = '';
        profileBannerImg.style.display = 'none';
      }
    }

    // Set initial loading placeholders for grids
    if (vibesGrid) vibesGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 30px; color: var(--text-muted); font-size: 13px;">Loading hubs... 📸</div>';
    if (taggedGrid) taggedGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 30px; color: var(--text-muted); font-size: 13px;">Loading tagged reels... 🏷️</div>';
    if (reelsGrid) reelsGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 30px; color: var(--text-muted); font-size: 13px;">Loading reels... 🎥</div>';

    const targetQueryId = isMe ? (currentUser.id || currentUser._id || currentUser.username) : cleanInputId;

    try {
      const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
      const res = await fetch(`${API_URL}/api/users/${encodeURIComponent(targetQueryId)}/profile`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });

      // Guard against race conditions: ignore response if user navigated to another profile while waiting
      if (requestId !== currentProfileRequestId) {
        console.log(`[Profile Navigation] Ignored stale profile response for request #${requestId}`);
        return;
      }

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error('Received non-JSON response from server. Please check connection.');
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Failed to load profile (Status ${res.status})`);
      }

      const data = await res.json();
      if (!data || !data.user) {
        throw new Error('User profile data not found.');
      }

      const u = data.user;
      const posts = Array.isArray(data.posts) ? data.posts : [];
      const reels = Array.isArray(data.reels) ? data.reels : [];

      // Render profile header details
      if (profileAvatar) {
        profileAvatar.src = u.profileImage || (isMe ? (localPhoto || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80') : 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80');
      }
      if (profileName) {
        profileName.innerHTML = escapeHtml(u.fullName || u.username || (isMe ? 'My Profile' : 'Hubber'));
      }
      if (profileHandle) {
        profileHandle.textContent = '@' + (u.username || 'user');
      }
      if (profileBio) {
        profileBio.textContent = u.bio || 'Hubber creator on Hi-Hubble 🚀';
      }

      const targetUserBannerUrl = isMe ? (localStorage.getItem('invibeBannerImage') || u.bannerImage || u.cover_image_url || '') : (u.bannerImage || u.cover_image_url || '');
      const profileBannerImg = document.querySelector('.profile-banner img');
      if (profileBannerImg) {
        if (targetUserBannerUrl) {
          profileBannerImg.src = targetUserBannerUrl;
          profileBannerImg.style.display = 'block';
          profileBannerImg.style.opacity = '1';
        } else {
          profileBannerImg.src = '';
          profileBannerImg.style.display = 'none';
        }
      }
      if (isMe && targetUserBannerUrl) {
        localStorage.setItem('invibeBannerImage', targetUserBannerUrl);
        const sidebarBanner = document.querySelector('.sidebar-left .card-cover-bg');
        if (sidebarBanner) {
          sidebarBanner.style.backgroundImage = `url(${targetUserBannerUrl})`;
          sidebarBanner.style.backgroundSize = 'cover';
          sidebarBanner.style.backgroundPosition = 'center';
        }
      }

      // Render stats
      if (followersCount) followersCount.textContent = formatCount(u.followersCount || 0);
      if (followingCount) followingCount.textContent = formatCount(u.followingCount || 0);
      if (vibesCount) vibesCount.textContent = formatCount(u.postsCount !== undefined ? u.postsCount : posts.length);

      // Setup follow button for other users
      if (!isMe && followBtn) {
        followBtn.style.display = 'block';
        followBtn.setAttribute('data-user-id', u._id || u.id);
        if (u.isFollowing) {
          followBtn.classList.add('followed');
          followBtn.textContent = 'Hubbies';
        } else if (u.isPending) {
          followBtn.classList.add('followed');
          followBtn.textContent = 'Requested';
        } else {
          followBtn.classList.remove('followed');
          followBtn.textContent = 'Follow';
        }
      }

      // Render Posts Grid
      if (vibesGrid) {
        vibesGrid.innerHTML = '';
        if (posts.length === 0) {
          vibesGrid.innerHTML = '<div class="profile-grid-empty" style="grid-column: 1/-1; text-align: center; padding: 40px 20px; color: var(--text-muted); font-size: 13.5px;">No hubs shared yet. 📸</div>';
        } else {
          posts.forEach(post => {
            const item = document.createElement('div');
            item.className = 'profile-grid-item';
            item.style.cursor = 'pointer';
            item.innerHTML = `
              <img src="${post.mediaUrl || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=800&q=80'}" alt="Hub" />
              <div class="profile-grid-item-overlay">
                <span><i data-lucide="heart"></i> ${(post.likes || []).length}</span>
                <span><i data-lucide="message-square"></i> ${(post.comments || []).length}</span>
              </div>
            `;
            item.addEventListener('click', () => openProfilePostViewer(post));
            vibesGrid.appendChild(item);
          });
        }
      }

      // Render Reels Grid
      if (reelsGrid) {
        reelsGrid.innerHTML = '';
        if (reels.length === 0) {
          reelsGrid.innerHTML = '<div class="profile-grid-empty" style="grid-column: 1/-1; text-align: center; padding: 40px 20px; color: var(--text-muted); font-size: 13.5px;">No reels uploaded yet. 🎥</div>';
        } else {
          reels.forEach(reel => {
            const item = document.createElement('div');
            item.className = 'profile-grid-item';
            item.style.cursor = 'pointer';
            item.innerHTML = `
              <video src="${reel.videoUrl}" muted loop playsinline></video>
              <div class="profile-grid-item-overlay">
                <span><i data-lucide="heart"></i> ${(reel.likes || []).length}</span>
              </div>
            `;
            const video = item.querySelector('video');
            if (video) {
              item.addEventListener('mouseenter', () => video.play().catch(() => { }));
              item.addEventListener('mouseleave', () => { video.pause(); video.currentTime = 0; });
            }
            item.addEventListener('click', () => {
              openProfileReelViewer(reel);
            });
            reelsGrid.appendChild(item);
          });
        }
      }

      // Render Tagged Reels Grid
      if (taggedGrid) {
        taggedGrid.innerHTML = '';
        const taggedReels = data.taggedReels || [];
        if (taggedReels.length === 0) {
          taggedGrid.innerHTML = '<div class="profile-grid-empty" style="grid-column: 1/-1; text-align: center; padding: 40px 20px; color: var(--text-muted); font-size: 13.5px;">No tagged reels yet. 🏷️</div>';
        } else {
          taggedReels.forEach(reel => {
            const item = document.createElement('div');
            item.className = 'profile-grid-item';
            item.style.cursor = 'pointer';
            item.innerHTML = `
              <video src="${reel.videoUrl}" muted loop playsinline></video>
              <div class="profile-grid-item-overlay">
                <span><i data-lucide="heart"></i> ${(reel.likes || []).length}</span>
              </div>
            `;
            const video = item.querySelector('video');
            if (video) {
              item.addEventListener('mouseenter', () => video.play().catch(() => { }));
              item.addEventListener('mouseleave', () => { video.pause(); video.currentTime = 0; });
            }
            item.addEventListener('click', () => {
              openProfileReelViewer(reel);
            });
            taggedGrid.appendChild(item);
          });
        }
      }

      debouncedCreateIcons();
    } catch (err) {
      if (requestId !== currentProfileRequestId) return;
      console.error('[loadUserProfile Error]:', err);
      if (profileName) profileName.innerHTML = `<span style="color: var(--error-color, #ef4444); font-size: 15px;">Unable to load profile</span>`;
      if (profileBio) profileBio.textContent = err.message || 'Could not retrieve user details. Please check connection.';
      if (vibesGrid) vibesGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 30px; color: var(--error-color, #ef4444); font-size: 13px;">Unable to load posts.</div>`;
      if (reelsGrid) reelsGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 30px; color: var(--error-color, #ef4444); font-size: 13px;">Unable to load reels.</div>`;
    }
  }

  // --- PROFILE POST VIEWER MODAL SYSTEM ---
  const profilePostViewerModal = document.getElementById('profile-post-viewer-modal');
  const profilePostViewerCloseBtn = document.getElementById('profile-post-viewer-close-btn');
  const profilePostViewerContent = document.getElementById('profile-post-viewer-content');

  function openProfilePostViewer(post) {
    if (!profilePostViewerModal || !profilePostViewerContent) return;

    const currentUserStr = localStorage.getItem('invibeUser');
    const currentUser = currentUserStr ? JSON.parse(currentUserStr) : null;
    const currentUserId = currentUser ? (currentUser.id || currentUser._id) : null;
    const isLikedByMe = currentUser ? (post.likes || []).includes(currentUserId) : false;
    const postAuthorId = getUserIdentifier(post.author);
    const postAuthorUsername = (post.author?.username || '').toLowerCase();
    const isMe = !!(currentUserId && (currentUserId.toString() === (postAuthorId || '').toString() || (currentUser?.username && currentUser.username.toLowerCase() === postAuthorUsername)));
    const localUserAvatar = localStorage.getItem('invibeProfileImage') || currentUser?.profileImage;

    const resolvedAuthorAvatar = (isMe && localUserAvatar)
      ? localUserAvatar
      : (post.author?.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&h=80&q=80');

    const shouldRenderComments = window.innerWidth > 768 || window.activeCommentPostId === post._id;

    const cardHTML = `
      <article class="feed-card" id="post-${post._id}">
        <div class="post-header">
          <div class="post-author-info" style="cursor: pointer;">
            <img src="${resolvedAuthorAvatar}" alt="${post.author?.fullName || 'User'}" class="author-avatar" />
            <div class="post-author-text">
              <div class="post-author-title-row">
                <h4 class="author-name">${post.author?.fullName || post.author?.username || 'User'}</h4>
                <span class="author-handle">@${post.author?.username || 'user'}</span>
              </div>
              <div class="post-meta">
                <span class="post-time">${new Date(post.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <span class="dot-separator">•</span>
                <i data-lucide="globe" class="meta-icon"></i>
                ${post.location ? `
                  <span class="dot-separator">•</span>
                  <span class="post-location">
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:block; flex-shrink: 0;"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                    <span class="post-location-text">${post.location}</span>
                  </span>
                ` : ''}
              </div>
            </div>
          </div>
          <div class="post-header-actions">
            <button class="post-options-btn" data-post-id="${post._id}" data-author-id="${postAuthorId || ''}"><i data-lucide="more-horizontal"></i></button>
          </div>
        </div>

        <div class="post-media-container" style="position:relative; overflow:hidden; border-radius: 12px; margin: 12px 0;">
          ${(post.mediaItems && post.mediaItems.length > 1)
        ? `
            <div class="post-carousel-wrapper" style="position: relative; width: 100%; max-height: 480px; overflow: hidden; display: flex; flex-direction: column;">
              <div class="post-carousel-slides" onscroll="((container) => {
                const index = Math.round(container.scrollLeft / container.clientWidth);
                const dots = container.parentNode.querySelectorAll('.carousel-dot');
                dots.forEach((dot, idx) => {
                  dot.style.background = idx === index ? '#6C3BFF' : 'rgba(255, 255, 255, 0.5)';
                  dot.style.transform = idx === index ? 'scale(1.2)' : 'scale(1)';
                });
              })(this)" style="display: flex; overflow-x: auto; overflow-y: hidden; scroll-snap-type: x mandatory; scrollbar-width: none; -ms-overflow-style: none; width: 100%; height: 100%;">
                ${post.mediaItems.map((item, idx) => `
                  <div class="carousel-slide-item" style="flex: 0 0 100%; width: 100%; height: 100%; scroll-snap-align: start; display: flex; justify-content: center; align-items: center; background: #000; position: relative; overflow: hidden;">
                    ${item.type === 'video'
            ? `<video src="${item.url}" controls loop muted playsinline style="width: 100%; max-height: 100%; object-fit: contain; display: block;" class="post-media-video"></video>`
            : `<img src="${item.url}" alt="Post Media ${idx + 1}" class="post-media-img" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; display: block;" />`
          }
                  </div>
                `).join('')}
              </div>
              
              <div class="carousel-controls-bottom" style="position: absolute; bottom: 12px; left: 0; right: 0; display: flex; justify-content: center; align-items: center; gap: 12px; z-index: 5;">
                <button class="carousel-nav-btn prev-btn" onclick="this.parentNode.parentNode.querySelector('.post-carousel-slides').scrollBy({left: -this.parentNode.parentNode.clientWidth, behavior: 'smooth'})" style="background: rgba(0,0,0,0.5); border: none; border-radius: 50%; width: 22px; height: 22px; color: white; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 11px; font-weight: bold; outline: none; transition: all 0.2s ease;">‹</button>
                
                <div class="carousel-dots-container" style="display: flex; gap: 6px; pointer-events: none; align-items: center;">
                  ${post.mediaItems.map((_, idx) => `
                    <span class="carousel-dot ${idx === 0 ? 'active' : ''}" style="width: 6px; height: 6px; border-radius: 50%; background: ${idx === 0 ? '#6C3BFF' : 'rgba(255, 255, 255, 0.5)'}; transition: all 0.2s ease;"></span>
                  `).join('')}
                </div>
                
                <button class="carousel-nav-btn next-btn" onclick="this.parentNode.parentNode.querySelector('.post-carousel-slides').scrollBy({left: this.parentNode.parentNode.clientWidth, behavior: 'smooth'})" style="background: rgba(0,0,0,0.5); border: none; border-radius: 50%; width: 22px; height: 22px; color: white; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 11px; font-weight: bold; outline: none; transition: all 0.2s ease;">›</button>
              </div>
            </div>
            `
        : (post.mediaType === 'video'
          ? `<video src="${post.mediaUrl}" loop muted playsinline style="border-radius:12px; display:block;" class="post-media-video"></video>
                 <div class="video-play-overlay">
                   <button class="play-btn-big"><i data-lucide="play"></i></button>
                 </div>
                 <div class="video-mute-container" style="position: absolute; left: 16px; bottom: 24px; z-index: 12;">
                   <button class="action-circle-btn mute-btn-action" data-post-id="${post._id}">
                     <i data-lucide="volume-2"></i>
                   </button>
                 </div>`
          : `<img src="${post.mediaUrl}" alt="Post Media" class="post-media-img" style="border-radius:12px; display:block;" />`
        )
      }

          ${(() => {
        const musicUrl = getPostMusicUrl(post);
        return musicUrl ? `
              <button class="post-music-speaker-btn" onclick="window.togglePostMusic(this, '${musicUrl}', '${post._id}')" style="position: absolute; left: 12px; bottom: 12px; background: rgba(0,0,0,0.6); border: none; border-radius: 50%; width: 28px; height: 28px; color: white; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 10; outline: none; transition: background 0.2s, transform 0.2s;">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/></svg>
              </button>
            ` : '';
      })()}

          <div class="post-engagement-actions">
            <div class="engagement-item like-btn-action ${isLikedByMe ? 'liked' : ''}" data-post-id="${post._id}">
              <button class="action-circle-btn heart-btn"><i data-lucide="heart" style="${isLikedByMe ? 'fill:#8b5cf6; stroke:#8b5cf6;' : ''}"></i></button>
              <span class="action-count">${(post.likes || []).length}</span>
            </div>
            <div class="engagement-item comment-btn-action" data-post-id="${post._id}">
              <button class="action-circle-btn"><i data-lucide="message-circle"></i></button>
              <span class="action-count">${(post.comments || []).length}</span>
            </div>
            <div class="engagement-item share-btn-action" data-post-id="${post._id}">
              <button class="action-circle-btn"><i data-lucide="send"></i></button>
            </div>
            <div class="engagement-item bookmark-btn-action" data-post-id="${post._id}">
              <button class="action-circle-btn bookmark-btn"><i data-lucide="bookmark"></i></button>
            </div>
          </div>
        </div>

        <div class="post-details">
          <p class="post-caption"><strong class="author-username" style="margin-right: 8px; cursor: pointer;">${post.author?.username || 'user'}</strong>${post.caption}</p>
          
          ${shouldRenderComments ? window.getCommentsSectionHTML(post, currentUserId, currentUser, localUserAvatar) : `<div class="comments-section-placeholder" id="comments-placeholder-${post._id}"></div>`}
        </div>
      </article>
    `;

    profilePostViewerContent.innerHTML = cardHTML;
    profilePostViewerModal.classList.add('active');

    debouncedCreateIcons();

    // Wire post author clicks to navigate to profile
    const authorEl = profilePostViewerContent.querySelector('.post-author-info, .author-username');
    if (authorEl && postAuthorId) {
      authorEl.addEventListener('click', () => {
        profilePostViewerModal.classList.remove('active');
        switchView('profile', postAuthorId);
      });
    }

    // Wire comment author clicks to navigate to profile
    const commentUserEls = profilePostViewerContent.querySelectorAll('.comment-author-avatar, .comment-author-name');
    commentUserEls.forEach(el => {
      const cUid = el.getAttribute('data-user-id');
      if (cUid) {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          profilePostViewerModal.classList.remove('active');
          switchView('profile', cUid);
        });
      }
    });

    // Wire up like button
    const likeBtn = profilePostViewerContent.querySelector('.like-btn-action');
    if (likeBtn) {
      likeBtn.addEventListener('click', async () => {
        const pid = likeBtn.getAttribute('data-post-id');
        await togglePostLike(pid, likeBtn);
      });
    }

    // Wire up bookmark button
    const bookmarkBtn = profilePostViewerContent.querySelector('.bookmark-btn');
    if (bookmarkBtn) {
      bookmarkBtn.addEventListener('click', () => {
        bookmarkBtn.classList.toggle('saved');
        const icon = bookmarkBtn.querySelector('i, svg');
        if (bookmarkBtn.classList.contains('saved')) {
          if (icon) { icon.style.fill = '#FBBF24'; icon.style.stroke = '#FBBF24'; }
          showToast('Saved to bookmarks! 🔖');
        } else {
          if (icon) { icon.style.fill = 'none'; icon.style.stroke = 'currentColor'; }
          showToast('Removed from bookmarks');
        }
      });
    }

    // Wire up share button
    const shareBtn = profilePostViewerContent.querySelector('.share-btn-action');
    if (shareBtn) {
      shareBtn.addEventListener('click', () => {
        showToast('Share link copied! 🔗');
      });
    }

    // Wire up comment input enter key
    const commentInput = profilePostViewerContent.querySelector('.comment-input-field');
    if (commentInput) {
      commentInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const pid = commentInput.id.replace('comment-input-', '');
          const text = commentInput.value.trim();
          if (text) {
            await submitComment(pid, text, commentInput);
          }
        }
      });
    }

    // Wire up video play overlay
    const videoOverlay = profilePostViewerContent.querySelector('.video-play-overlay');
    if (videoOverlay) {
      videoOverlay.addEventListener('click', () => {
        const container = videoOverlay.closest('.post-media-container');
        const video = container.querySelector('.post-media-video');
        const playIcon = videoOverlay.querySelector('i');
        if (video.paused) {
          video.play();
          playIcon.setAttribute('data-lucide', 'pause');
          videoOverlay.style.background = 'rgba(0,0,0,0)';
          videoOverlay.style.opacity = '0';
        } else {
          video.pause();
          playIcon.setAttribute('data-lucide', 'play');
          videoOverlay.style.background = 'rgba(0,0,0,0.25)';
          videoOverlay.style.opacity = '1';
        }
        debouncedCreateIcons();
      });
    }

    // Wire up video mute/unmute
    const muteBtn = profilePostViewerContent.querySelector('.mute-btn-action');
    if (muteBtn) {
      muteBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const container = muteBtn.closest('.post-media-container');
        const video = container.querySelector('.post-media-video');
        const muteIcon = muteBtn.querySelector('i');

        if (video.muted) {
          video.muted = false;
          muteIcon.setAttribute('data-lucide', 'volume-2');
        } else {
          video.muted = true;
          muteIcon.setAttribute('data-lucide', 'volume-x');
        }
        debouncedCreateIcons();
      });
    }

    // Wire up double-tap heart on media
    const mediaContainer = profilePostViewerContent.querySelector('.post-media-container');
    if (mediaContainer) {
      let lastTap = 0;
      mediaContainer.addEventListener('click', async (e) => {
        if (e.target.closest('.post-engagement-actions') || e.target.closest('.video-mute-container')) return;
        const now = Date.now();
        const timespan = now - lastTap;
        if (timespan < 300 && timespan > 0) {
          e.preventDefault();
          const btn = mediaContainer.closest('.feed-card').querySelector('.like-btn-action');
          const pid = btn.getAttribute('data-post-id');
          const rect = mediaContainer.getBoundingClientRect();
          const relativeX = e.clientX - rect.left;
          const relativeY = e.clientY - rect.top;

          triggerHeartExplosion(relativeX, relativeY, mediaContainer);

          if (!btn.classList.contains('liked')) {
            await togglePostLike(pid, btn);
          }
        }
        lastTap = now;
      });
    }
  }

  // Close profile post viewer modal
  if (profilePostViewerCloseBtn && profilePostViewerModal) {
    profilePostViewerCloseBtn.addEventListener('click', () => {
      profilePostViewerModal.classList.remove('active');
      // Pause any playing video
      const video = profilePostViewerContent.querySelector('video');
      if (video) video.pause();
    });
  }
  // Close on overlay background click
  if (profilePostViewerModal) {
    profilePostViewerModal.addEventListener('click', (e) => {
      if (e.target === profilePostViewerModal) {
        profilePostViewerModal.classList.remove('active');
        const video = profilePostViewerContent.querySelector('video');
        if (video) video.pause();
      }
    });
  }

  // --- PROFILE REEL VIEWER MODAL SYSTEM ---
  const profileReelViewerModal = document.getElementById('profile-reel-viewer-modal');
  const profileReelViewerCloseBtn = document.getElementById('profile-reel-viewer-close-btn');
  const profileReelViewerContent = document.getElementById('profile-reel-viewer-content');

  function openProfileReelViewer(reel) {
    if (!profileReelViewerModal || !profileReelViewerContent || !reel) return;

    const authorName = reel.author ? (reel.author.fullName || reel.author.username || 'Hubble User') : 'Hubble User';
    const authorUser = reel.author ? (reel.author.username || 'hubble_user') : 'hubble_user';
    const authorAvatar = reel.author?.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=100&h=100&q=80';
    const authorId = reel.author?._id || reel.author?.id || '';
    const reelId = reel._id || reel.id;

    const captionText = reel.caption || '';
    const captionHtml = captionText.replace(/#(\w+)/g, '<span style="color:#c084fc; font-weight:600;">#$1</span>');
    const isReelSaved = !!reel.isSaved || (window.savedHubbs && window.savedHubbs.some(s => (s._id || s.id) === reelId));
    const isLiked = !!reel.isLiked;
    const formattedLikes = reel.formattedLikes || reel.likeCount || (reel.likes || []).length || '0';
    const formattedComments = reel.formattedComments || reel.commentCount || '0';
    const formattedShares = reel.formattedShares || reel.shareCount || '0';

    const card = document.createElement('div');
    card.className = 'reel-card';
    card.setAttribute('data-reel-id', reelId);
    card.style.cssText = 'position: relative; width: 100%; height: 100%; margin: 0; border-radius: 0; overflow: hidden; background: #000; box-sizing: border-box;';

    card.innerHTML = `
      <video src="${reel.videoUrl}" loop ${window.reelsMuted !== false ? 'muted' : ''} playsinline preload="auto" class="reel-video" style="width:100%; height:100%; object-fit:cover; display:block;"></video>
      
      <div class="reel-play-icon-overlay" style="cursor: pointer; z-index: 4;">
        <i data-lucide="play" style="width:30px; height:30px; color:white; opacity:0.9;"></i>
      </div>
      
      <div class="double-tap-heart"><i data-lucide="heart"></i></div>

      <div class="reel-overlay" style="position:absolute; inset:0; background: linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.15) 50%, rgba(0,0,0,0.3) 100%); display:flex; justify-content:space-between; align-items:flex-end; padding:18px; box-sizing:border-box; z-index:5;">
        <div class="reel-left-info" style="display:flex; flex-direction:column; gap:8px; max-width:70%; position:relative; z-index:7;">
          <div class="reel-user" style="display:flex; align-items:center; gap:8px; cursor: pointer;">
            <img src="${authorAvatar}" alt="${authorName}" style="width:34px; height:34px; border-radius:50%; object-fit:cover; border:2px solid #a855f7;" />
            <div style="display:flex; flex-direction:column; gap:2px;">
              <span style="color:white; font-size:13px; font-weight:600;">@${authorUser}</span>
              ${reel.location ? `
                <div class="reel-location-badge" style="display:flex; align-items:center; gap:4px; color:rgba(255,255,255,0.7); font-size:10.5px;">
                  <i data-lucide="map-pin" style="width:10px; height:10px; color:#ec4899;"></i>
                  <span>${reel.location}</span>
                </div>
              ` : ''}
            </div>
          </div>
          <p class="reel-caption" style="color:white; font-size:13px; margin:0; line-height:1.4;">${captionHtml}</p>
          <div class="reel-music" style="display:flex; align-items:center; gap:6px; color:rgba(255,255,255,0.8); font-size:11px;">
            <i data-lucide="music" style="width:12px; height:12px;" class="music-icon-spin"></i> <span>${reel.audioTrackName || ('Original Audio - ' + authorUser)}</span>
          </div>
        </div>
      </div>

      <!-- Right Actions Block -->
      <div class="reel-right-actions" style="position: absolute; bottom: 20px; right: 16px; display:flex; flex-direction:column; gap:12px; align-items:center; z-index:10 !important;">
        <div class="reel-actions-capsule" style="background: rgba(15, 23, 42, 0.5); backdrop-filter: blur(12px); border-radius: 36px; padding: 16px 8px; border: 1px solid rgba(255,255,255,0.15); display: flex; flex-direction: column; gap: 16px; align-items: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
          
          <!-- 1. Like -->
          <div class="reel-action-btn reel-like-action" data-reel-id="${reelId}" style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;">
            <button class="action-circle-btn heart-btn ${isLiked ? 'liked' : ''}" style="background:none; border:none; color:white; width:38px; height:38px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
              <i data-lucide="heart" style="${isLiked ? 'fill:#8b5cf6; stroke:#8b5cf6;' : ''}"></i>
            </button>
            <span class="action-count" style="color:white; font-size:11px; font-weight:700;">${formattedLikes}</span>
          </div>

          <!-- 2. Comment -->
          <div class="reel-action-btn reel-comment-sim" data-reel-id="${reelId}" style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;">
            <button class="action-circle-btn" style="background:none; border:none; color:white; width:38px; height:38px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
              <i data-lucide="message-circle"></i>
            </button>
            <span class="action-count" style="color:white; font-size:11px; font-weight:700;">${formattedComments}</span>
          </div>

          <!-- 3. Share -->
          <div class="reel-action-btn reel-share-sim" data-reel-id="${reelId}" style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;">
            <button class="action-circle-btn" style="background:none; border:none; color:white; width:38px; height:38px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
              <i data-lucide="send"></i>
            </button>
            <span class="action-count" style="color:white; font-size:11px; font-weight:700;">${formattedShares}</span>
          </div>

          <!-- 4. Save/Bookmark -->
          <div class="reel-action-btn reel-save-action" data-reel-id="${reelId}" style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;">
            <button class="action-circle-btn star-btn ${isReelSaved ? 'saved' : ''}" style="background:none; border:none; color:white; width:38px; height:38px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
              <i data-lucide="bookmark" style="${isReelSaved ? 'fill:#FBBF24; stroke:#FBBF24;' : ''}"></i>
            </button>
          </div>

          <!-- 5. Sound / Audio Mute Toggle -->
          <div class="reel-action-btn reel-audio-action" data-reel-id="${reelId}" style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;" title="Toggle Audio">
            <button class="action-circle-btn reel-audio-toggle-btn" style="background:none; border:none; color:white; width:38px; height:38px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
              <i data-lucide="${window.reelsMuted === false ? 'volume-2' : 'volume-x'}"></i>
            </button>
          </div>
        </div>
      </div>

      <!-- Comments Modal -->
      <div class="story-viewer-overlay reel-comments-modal" data-reel-id="${reelId}">
        <div class="comments-card glass-panel" style="backdrop-filter: blur(20px); border-radius: 20px; width: 90%; max-width: 380px; max-height: 80vh; display: flex; flex-direction: column; overflow: hidden;">
          <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; padding:16px 20px;">
            <h3 style="margin:0; font-size:16px; font-weight:600;">Comments</h3>
            <button class="modal-close-btn" style="background:none; border:none; cursor:pointer; font-size:18px;"><i data-lucide="x"></i></button>
          </div>
          <div class="comments-list" style="flex:1; overflow-y:auto; padding:16px; min-height:180px; max-height:360px;"></div>
          <div class="comments-footer" style="display:flex; gap:10px; padding:12px 16px;">
            <input type="text" placeholder="Add a comment..." style="flex:1; border-radius:20px; padding:8px 16px; font-size:13px; outline:none;" />
            <button class="comment-send-btn" style="width:36px; height:36px; border-radius:50%; background:linear-gradient(135deg, #a855f7 0%, #d946ef 100%); border:none; color:white; display:flex; align-items:center; justify-content:center; cursor:pointer;"><i data-lucide="send" style="width:16px; height:16px;"></i></button>
          </div>
        </div>
      </div>

      <!-- Share Modal -->
      <div class="story-viewer-overlay reel-share-modal" data-reel-id="${reelId}">
        <div class="share-card glass-panel" style="background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(20px); border-radius: 20px; border: 1px solid rgba(255,255,255,0.15); width: 90%; max-width: 360px; display: flex; flex-direction: column; overflow: hidden;">
          <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; padding:16px 20px; border-bottom:1px solid rgba(255,255,255,0.1);">
            <h3 style="margin:0; font-size:16px; color:white; font-weight:600;">Share Reel</h3>
            <button class="modal-close-btn" style="background:none; border:none; color:white; cursor:pointer; font-size:18px;"><i data-lucide="x"></i></button>
          </div>
          <div class="share-options" style="padding: 20px; display: flex; flex-direction: column; gap: 12px;">
            <button class="copy-link-btn" style="padding: 12px; border-radius: 12px; background: linear-gradient(135deg, #a855f7 0%, #d946ef 100%); color: white; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; font-weight: 600; font-size: 13.5px;"><i data-lucide="copy" style="width:18px; height:18px;"></i> Copy Reel Link</button>
          </div>
        </div>
      </div>
    `;

    profileReelViewerContent.innerHTML = '';
    profileReelViewerContent.appendChild(card);
    profileReelViewerModal.classList.add('active');

    debouncedCreateIcons();
    wireReelInteractions(profileReelViewerContent);

    // Auto-play the reel in modal
    const video = card.querySelector('.reel-video');
    if (video) {
      video.muted = window.reelsMuted !== false;
      video.play().catch(err => {
        console.log('[Profile Reel Viewer] Autoplay blocked, trying muted playback:', err.message);
        video.muted = true;
        video.play().catch(() => {});
      });
    }
  }

  function closeProfileReelViewer() {
    if (!profileReelViewerModal) return;
    profileReelViewerModal.classList.remove('active');
    if (profileReelViewerContent) {
      const video = profileReelViewerContent.querySelector('video');
      if (video) {
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();
        } catch (_) {}
      }
      profileReelViewerContent.innerHTML = '';
    }
  }

  if (profileReelViewerCloseBtn) {
    profileReelViewerCloseBtn.addEventListener('click', closeProfileReelViewer);
  }
  if (profileReelViewerModal) {
    profileReelViewerModal.addEventListener('click', (e) => {
      if (e.target === profileReelViewerModal) {
        closeProfileReelViewer();
      }
    });
  }

  // Bind profile tabs selection logic
  const profileTabButtons = document.querySelectorAll('.profile-content-tab');
  profileTabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      profileTabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tabName = btn.getAttribute('data-profile-tab');

      const vibesGrid = document.getElementById('profile-vibes-grid');
      const reelsGrid = document.getElementById('profile-reels-grid');
      const savedGrid = document.getElementById('profile-saved-grid');
      const taggedGrid = document.getElementById('profile-tagged-grid');

      if (vibesGrid) vibesGrid.classList.remove('active');
      if (reelsGrid) reelsGrid.classList.remove('active');
      if (savedGrid) savedGrid.classList.remove('active');
      if (taggedGrid) taggedGrid.classList.remove('active');

      if (tabName === 'vibes') {
        if (vibesGrid) vibesGrid.classList.add('active');
      } else if (tabName === 'reels') {
        if (reelsGrid) reelsGrid.classList.add('active');
      } else if (tabName === 'saved') {
        if (savedGrid) {
          savedGrid.classList.add('active');
          renderSavedHubbs();
        }
      } else if (tabName === 'tagged') {
        if (taggedGrid) taggedGrid.classList.add('active');
      }
    });
  });

  window.renderSavedHubbs = renderSavedHubbs;
  async function renderSavedHubbs() {
    const savedGrid = document.getElementById('profile-saved-grid');
    if (!savedGrid) return;

    if (typeof window.fetchSavedHubbs === 'function') {
      await window.fetchSavedHubbs();
    }

    if (!window.activeSavedFilter) {
      window.activeSavedFilter = 'posts';
    }

    let wrapper = savedGrid.querySelector('.saved-hubbs-wrapper');
    if (!wrapper) {
      savedGrid.innerHTML = `
          <div class="saved-hubbs-wrapper" style="grid-column: 1 / -1; width: 100%; display: flex; flex-direction: column; gap: 16px;">
            <!-- Header -->
            <div class="saved-hubbs-header" style="margin-bottom: 8px;">
              <h3 style="font-size: 1.3rem; font-weight: 700; color: var(--text-main); margin: 0 0 4px 0;">Saved Hubbs</h3>
              <p style="font-size: 0.85rem; color: var(--text-muted); margin: 0;">All your saved posts and reels in one place.</p>
            </div>
            
            <!-- Filter tabs -->
            <div class="saved-hubbs-filters" style="display: flex; gap: 10px; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 12px; align-items: center;">
              <button class="ex-tab-pill" id="saved-filter-posts" style="padding: 6px 16px; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px;">
                <i data-lucide="image" style="width: 14px; height: 14px;"></i> Posts
              </button>
              <button class="ex-tab-pill" id="saved-filter-reels" style="padding: 6px 16px; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px;">
                <i data-lucide="video" style="width: 14px; height: 14px;"></i> Hubbing
              </button>
            </div>

            <!-- Content Areas -->
            <div id="saved-posts-container" class="profile-grid" style="display: none; grid-template-columns: repeat(3, 1fr); gap: 8px; width: 100%;"></div>
            <div id="saved-reels-container" class="reels-panel" style="display: none; width: 100%; flex-direction: column; align-items: center;">
              <div class="reels-scroller" style="width: 100%; max-width: 100%; height: auto; overflow: visible; padding-bottom: 0; display: flex; flex-direction: column; align-items: center; gap: 24px;"></div>
            </div>
          </div>
        `;

      wrapper = savedGrid.querySelector('.saved-hubbs-wrapper');

      const postsBtn = wrapper.querySelector('#saved-filter-posts');
      const reelsBtn = wrapper.querySelector('#saved-filter-reels');

      postsBtn.addEventListener('click', () => {
        window.activeSavedFilter = 'posts';
        renderSavedHubbs();
      });

      reelsBtn.addEventListener('click', () => {
        window.activeSavedFilter = 'reels';
        renderSavedHubbs();
      });
    }

    const postsBtn = wrapper.querySelector('#saved-filter-posts');
    const reelsBtn = wrapper.querySelector('#saved-filter-reels');
    const postsContainer = wrapper.querySelector('#saved-posts-container');
    const reelsContainer = wrapper.querySelector('#saved-reels-container');
    const reelsScroller = reelsContainer.querySelector('.reels-scroller');

    if (window.activeSavedFilter === 'posts') {
      postsBtn.classList.add('active');
      reelsBtn.classList.remove('active');
      postsContainer.style.display = 'grid';
      reelsContainer.style.display = 'none';

      postsContainer.innerHTML = '';
      const savedPosts = (window.savedHubbs || []).filter(item => !item.isReel);

      if (savedPosts.length === 0) {
        postsContainer.innerHTML = '<div class="profile-grid-empty" style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted); font-size: 14px;">No saved posts yet.</div>';
      } else {
        savedPosts.forEach(post => {
          const item = document.createElement('div');
          item.className = 'profile-grid-item';
          item.style.cursor = 'pointer';
          item.innerHTML = `
              <img src="${post.mediaUrl || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=800&q=80'}" alt="Hub" />
              <div class="profile-grid-item-overlay">
                <span><i data-lucide="heart"></i> ${(post.likes || []).length}</span>
                <span><i data-lucide="message-square"></i> ${(post.comments || []).length}</span>
              </div>
            `;
          item.addEventListener('click', () => {
            openProfilePostViewer(post);
          });
          postsContainer.appendChild(item);
        });
      }
    } else {
      postsBtn.classList.remove('active');
      reelsBtn.classList.add('active');
      postsContainer.style.display = 'none';
      reelsContainer.style.display = 'flex';

      reelsScroller.innerHTML = '';
      const savedReels = (window.savedHubbs || []).filter(item => item.isReel);

      if (savedReels.length === 0) {
        reelsScroller.innerHTML = '<div class="profile-grid-empty" style="text-align: center; padding: 40px; color: var(--text-muted); font-size: 14px;">No saved reels yet.</div>';
      } else {
        savedReels.forEach(reel => {
          const authorName = reel.author ? (reel.author.fullName || reel.author.username || 'Hubble User') : 'Hubble User';
          const authorUser = reel.author ? (reel.author.username || 'hubble_user') : 'hubble_user';
          const authorAvatar = reel.author?.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=100&h=100&q=80';

          const captionText = reel.caption || '';
          const captionHtml = captionText.replace(/#(\w+)/g, '<span style="color:#c084fc; font-weight:600;">#$1</span>');
          const isReelSaved = true;

          const card = document.createElement('div');
          card.className = 'reel-card';
          card.setAttribute('data-reel-id', reel._id || reel.id);
          card.style.cssText = `position: relative; width: 100%; height: 640px; margin: 0 auto 24px auto; border-radius: 18px; overflow: hidden; background: #000; box-shadow: 0 12px 35px rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.12); box-sizing: border-box;`;

          card.innerHTML = `
              <video data-src="${reel.videoUrl}" loop muted playsinline preload="none" class="reel-video" style="width:100%; height:100%; object-fit:cover; display:block;"></video>
              
              <div class="reel-play-icon-overlay" style="cursor: pointer; z-index: 4;">
                <i data-lucide="play" style="width:30px; height:30px; color:white; opacity:0.9;"></i>
              </div>
              
              <div class="double-tap-heart"><i data-lucide="heart"></i></div>

              <div class="reel-overlay" style="position:absolute; inset:0; background: linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.15) 50%, rgba(0,0,0,0.3) 100%); display:flex; justify-content:space-between; align-items:flex-end; padding:20px; box-sizing:border-box; z-index:5;">
                
                <div class="reel-left-info" style="display:flex; flex-direction:column; gap:10px; max-width:72%; position:relative; z-index:7;">
                  <div class="reel-user" style="display:flex; align-items:center; gap:8px;">
                    <img src="${authorAvatar}" alt="${authorName}" style="width:36px; height:36px; border-radius:50%; object-fit:cover; border:2px solid #a855f7;" />
                    <div style="display:flex; flex-direction:column; gap:2px;">
                      <div style="display:flex; align-items:center; gap:8px;">
                        <span style="color:white; font-size:13px; font-weight:600;">@${authorUser}</span>
                        <strong class="reel-follow-btn" data-author-id="${reel.author?._id || reel.author?.id || ''}" style="color:white; font-size:11px; cursor:pointer; background:linear-gradient(135deg, #a855f7 0%, #ec4899 100%); padding:3px 10px; border-radius:12px; font-weight:600;">Follow</strong>
                      </div>
                      ${reel.location ? `
                        <div class="reel-location-badge" style="display:flex; align-items:center; gap:4px; color:rgba(255,255,255,0.7); font-size:10.5px;">
                          <i data-lucide="map-pin" style="width:10px; height:10px; color:#ec4899;"></i>
                          <span>${reel.location}</span>
                        </div>
                      ` : ''}
                    </div>
                  </div>
                  <p class="reel-caption" style="color:white; font-size:13px; margin:0; line-height:1.4;">${captionHtml}</p>
                  <div class="reel-music" style="display:flex; align-items:center; gap:6px; color:rgba(255,255,255,0.8); font-size:11px;">
                    <i data-lucide="music" style="width:12px; height:12px;" class="music-icon-spin"></i> <span>${reel.audioTrackName || ('Original Audio - ' + authorUser)}</span>
                  </div>
                </div>
                
                <div class="reel-right-actions" style="display:flex; flex-direction:column; gap:14px; align-items:center; position:relative; z-index:7;">
                  <div class="reel-actions-capsule" style="background: rgba(15, 23, 42, 0.45); backdrop-filter: blur(12px); border-radius: 36px; padding: 18px 8px; border: 1px solid rgba(255,255,255,0.12); display: flex; flex-direction: column; gap: 18px; align-items: center; box-shadow: 0 10px 30px rgba(0,0,0,0.4);">
                    
                    <!-- 1. Like -->
                    <div class="reel-action-btn reel-like-action" data-reel-id="${reel._id || reel.id}" style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;">
                      <button class="action-circle-btn heart-btn ${reel.isLiked ? 'liked' : ''}" style="background:none; border:none; color:white; width:40px; height:40px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
                        <i data-lucide="heart" style="${reel.isLiked ? 'fill:#8b5cf6; stroke:#8b5cf6;' : ''}"></i>
                      </button>
                      <span class="action-count" style="color:white; font-size:11px; font-weight:700;">${reel.formattedLikes || reel.likeCount || '0'}</span>
                    </div>

                    <!-- 2. Comment -->
                    <div class="reel-action-btn reel-comment-sim" data-reel-id="${reel._id || reel.id}" style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;">
                      <button class="action-circle-btn" style="background:none; border:none; color:white; width:40px; height:40px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
                        <i data-lucide="message-circle"></i>
                      </button>
                      <span class="action-count" style="color:white; font-size:11px; font-weight:700;">${reel.formattedComments || reel.commentCount || '0'}</span>
                    </div>

                    <!-- 3. Share -->
                    <div class="reel-action-btn reel-share-sim" data-reel-id="${reel._id || reel.id}" style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;">
                      <button class="action-circle-btn" style="background:none; border:none; color:white; width:40px; height:40px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
                        <i data-lucide="send"></i>
                      </button>
                      <span class="action-count" style="color:white; font-size:11px; font-weight:700;">${reel.formattedShares || reel.shareCount || '0'}</span>
                    </div>

                    <!-- 4. Save/Bookmark -->
                    <div class="reel-action-btn reel-save-action" data-reel-id="${reel._id || reel.id}" style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;">
                      <button class="action-circle-btn star-btn saved" style="background:none; border:none; color:white; width:40px; height:40px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
                        <i data-lucide="bookmark" style="fill:#FBBF24; stroke:#FBBF24;"></i>
                      </button>
                    </div>

                    <!-- 5. Sound / Audio Mute Toggle -->
                    <div class="reel-action-btn reel-audio-action" data-reel-id="${reel._id || reel.id}" style="display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer;" title="Toggle Audio">
                      <button class="action-circle-btn reel-audio-toggle-btn" style="background:none; border:none; color:white; width:40px; height:40px; display:flex; align-items:center; justify-content:center; cursor:pointer;">
                        <i data-lucide="${window.reelsMuted === false ? 'volume-2' : 'volume-x'}"></i>
                      </button>
                    </div>
                  </div>

                  <!-- 5. More Options -->
                  <div class="reel-action-btn reel-more-sim" data-reel-id="${reel._id || reel.id}">
                    <button class="action-circle-btn" style="width:40px; height:40px; border-radius:50%; background:rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.15); display:flex; align-items:center; justify-content:center; color:white; cursor:pointer;">
                      <i data-lucide="more-horizontal"></i>
                    </button>
                  </div>
                </div>
              </div>

              <!-- Bottom navigation zone overlays the bottom area of the reel -->
              <div class="reel-bottom-navigation-zone" style="position: absolute; bottom: 0; left: 0; right: 0; height: 50px; z-index: 6; cursor: pointer;"></div>

              <!-- Bottom Center Mascot Circle -->
              <div class="reel-mascot-overlay" style="position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); width: 44px; height: 44px; border-radius: 50%; background: radial-gradient(circle, rgba(168,85,247,0.9) 0%, rgba(139,92,246,0.5) 60%, transparent 100%); display: flex; align-items: center; justify-content: center; box-shadow: 0 0 20px rgba(168,85,247,0.8); z-index: 8; cursor: pointer; border: 1.5px solid rgba(255,255,255,0.3);" title="Hi-HUBBLE Mascot">
                <img src="/hihubble-mascot-circle.png" alt="Mascot" style="width: 38px; height: 38px; border-radius: 50%; object-fit: cover;" />
              </div>

              <!-- Comments Modal -->
              <div class="story-viewer-overlay reel-comments-modal" data-reel-id="${reel._id || reel.id}">
                <div class="comments-card glass-panel" style="backdrop-filter: blur(20px); border-radius: 20px; width: 90%; max-width: 380px; max-height: 80vh; display: flex; flex-direction: column; overflow: hidden;">
                  <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; padding:16px 20px;">
                    <h3 style="margin:0; font-size:16px; font-weight:600;">Comments</h3>
                    <button class="modal-close-btn" style="background:none; border:none; cursor:pointer; font-size:18px;"><i data-lucide="x"></i></button>
                  </div>
                  <div class="comments-list" style="flex:1; overflow-y:auto; padding:16px; min-height:180px; max-height:360px;"></div>
                  <div class="comments-footer" style="display:flex; gap:10px; padding:12px 16px;">
                    <input type="text" placeholder="Add a comment..." style="flex:1; border-radius:20px; padding:8px 16px; font-size:13px; outline:none;" />
                    <button class="comment-send-btn" style="width:36px; height:36px; border-radius:50%; background:linear-gradient(135deg, #a855f7 0%, #d946ef 100%); border:none; color:white; display:flex; align-items:center; justify-content:center; cursor:pointer;"><i data-lucide="send" style="width:16px; height:16px;"></i></button>
                  </div>
                </div>
              </div>

              <!-- Share Modal -->
              <div class="story-viewer-overlay reel-share-modal" data-reel-id="${reel._id || reel.id}">
                <div class="share-card glass-panel" style="background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(20px); border-radius: 20px; border: 1px solid rgba(255,255,255,0.15); width: 90%; max-width: 360px; display: flex; flex-direction: column; overflow: hidden;">
                  <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; padding:16px 20px; border-bottom:1px solid rgba(255,255,255,0.1);">
                    <h3 style="margin:0; font-size:16px; color:white; font-weight:600;">Share Reel</h3>
                    <button class="modal-close-btn" style="background:none; border:none; color:white; cursor:pointer; font-size:18px;"><i data-lucide="x"></i></button>
                  </div>
                  <div class="share-options" style="padding: 20px; display: flex; flex-direction: column; gap: 12px;">
                    <button class="copy-link-btn" style="padding: 12px; border-radius: 12px; background: linear-gradient(135deg, #a855f7 0%, #d946ef 100%); color: white; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; font-weight: 600; font-size: 13.5px;"><i data-lucide="copy" style="width:18px; height:18px;"></i> Copy Reel Link</button>
                  </div>
                </div>
              </div>
            `;

          const video = card.querySelector('.reel-video');
          if (video) {
            video.addEventListener('error', () => {
              console.error('[HUBBING PLAYER] Saved reel ERROR reelId=' + (reel._id || reel.id), video.error);
              card.setAttribute('data-reel-failed', 'true');
              const overlay = card.querySelector('.reel-play-icon-overlay');
              if (overlay) overlay.innerHTML = '<span style="color:rgba(255,255,255,0.6);font-size:12px;">Video unavailable</span>';
            });
          }

          reelsScroller.appendChild(card);
        });
        wireReelInteractions(reelsScroller);
      }
    }

    if (window.debouncedCreateIcons) window.debouncedCreateIcons();
  }

  // Bind follow/unfollow action on user profile
  const profileFollowBtn = document.getElementById('profile-follow-btn');
  if (profileFollowBtn) {
    profileFollowBtn.addEventListener('click', async () => {
      const uid = profileFollowBtn.getAttribute('data-user-id');
      const token = localStorage.getItem('invibe_jwt_token');
      if (!token || !uid) return;

      const isFollowing = profileFollowBtn.classList.contains('followed');
      const endpoint = isFollowing ? 'unfollow' : 'follow';

      try {
        const res = await fetch(`${API_URL}/api/users/${uid}/${endpoint}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        if (endpoint === 'follow') {
          if (data.status === 'pending') {
            profileFollowBtn.classList.add('followed');
            profileFollowBtn.textContent = 'Requested';
            showToast(data.message || 'Follow request sent. ⏳');
          } else {
            profileFollowBtn.classList.add('followed');
            profileFollowBtn.textContent = 'Hubbies';
            showToast(data.message || 'Followed successfully!');
          }
        } else {
          profileFollowBtn.classList.remove('followed');
          profileFollowBtn.textContent = 'Follow';
          showToast('Unfollowed successfully.');
        }

        loadProfileStats();
        loadFollowSuggestions();
        loadUserProfile(uid);
      } catch (err) {
        showToast(err.message);
      }
    });
  }

  // ─── FOLLOWERS / FOLLOWING RELATIONS MODAL LOGIC ───
  const followersCountEl = document.getElementById('profile-followers-count');
  const followingCountEl = document.getElementById('profile-following-count');
  const relationsModal = document.getElementById('relations-list-modal');
  const relationsCloseBtn = document.getElementById('relations-list-close-btn');
  const relationsTitle = document.getElementById('relations-list-title');
  const relationsContent = document.getElementById('relations-list-content');

  if (relationsCloseBtn && relationsModal) {
    relationsCloseBtn.addEventListener('click', () => {
      relationsModal.classList.remove('active');
    });
  }

  if (relationsModal) {
    relationsModal.addEventListener('click', (e) => {
      if (e.target === relationsModal) {
        relationsModal.classList.remove('active');
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && relationsModal && relationsModal.classList.contains('active')) {
      relationsModal.classList.remove('active');
    }
  });

  async function openRelationsModal(type) {
    const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
    if (!token) return;

    const followBtn = document.getElementById('profile-follow-btn');
    const currentUserStr = localStorage.getItem('invibeUser');
    if (!currentUserStr) return;
    const currentUser = JSON.parse(currentUserStr);

    const currentUserId = (currentUser.id || currentUser._id || '').toString();
    const isMe = (!state.viewingProfileUserId || state.viewingProfileUserId === 'me' || state.viewingProfileUserId === currentUserId || state.viewingProfileUserId === currentUser.username);
    const targetUserId = isMe ? currentUserId : (state.viewingProfileUserId || followBtn?.getAttribute('data-user-id') || currentUserId);
    if (!targetUserId) return;

    if (relationsTitle) {
      relationsTitle.textContent = type === 'followers' ? 'HUBBERS' : 'HUBBIES';
    }
    if (relationsContent) {
      relationsContent.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 20px; color: var(--text-muted); text-align: center; gap: 10px;">
          <i data-lucide="loader" class="animate-spin" style="width: 28px; height: 28px; color: var(--primary);"></i>
          <span style="font-size: 13.5px; font-weight: 500;">Loading ${type === 'followers' ? 'Hubbers' : 'Hubbies'}...</span>
        </div>
      `;
    }
    if (relationsModal) {
      relationsModal.setAttribute('data-relation-type', type);
      relationsModal.setAttribute('data-target-user', targetUserId);
      relationsModal.classList.add('active');
    }
    debouncedCreateIcons();

    try {
      const res = await fetch(`${API_URL}/api/users/${encodeURIComponent(targetUserId)}/${type}-list?t=${Date.now()}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to load list');
      const users = await res.json();

      // Deduplicate users by ID to guarantee unique display
      const userMap = new Map();
      (Array.isArray(users) ? users : []).forEach(u => {
        const uid = (u._id || u.id || '').toString();
        if (uid && !userMap.has(uid)) {
          userMap.set(uid, u);
        }
      });
      const uniqueUsers = Array.from(userMap.values());

      // Synchronize profile stats directly with the real-time list length
      const realCount = uniqueUsers.length;
      if (type === 'followers') {
        if (followersCountEl) followersCountEl.textContent = formatCount(realCount);
        if (isMe) {
          const sidebarFollowers = document.getElementById('user-followers-count');
          if (sidebarFollowers) sidebarFollowers.textContent = formatCount(realCount);
        }
      } else if (type === 'following') {
        if (followingCountEl) followingCountEl.textContent = formatCount(realCount);
        if (isMe) {
          const sidebarFollowing = document.getElementById('user-following-count');
          if (sidebarFollowing) sidebarFollowing.textContent = formatCount(realCount);
        }
      }

      if (!relationsContent) return;
      relationsContent.innerHTML = '';

      if (uniqueUsers.length === 0) {
        if (type === 'followers') {
          relationsContent.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 20px; color: var(--text-muted); text-align: center; gap: 8px;">
              <i data-lucide="users" style="width: 38px; height: 38px; opacity: 0.45; margin-bottom: 4px;"></i>
              <span style="font-size: 14.5px; font-weight: 600; color: var(--text-main, #fff);">No Hubbers yet</span>
              <span style="font-size: 12.5px; color: var(--text-muted);">Users following this profile will show up here.</span>
            </div>
          `;
        } else {
          relationsContent.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 20px; color: var(--text-muted); text-align: center; gap: 8px;">
              <i data-lucide="user-plus" style="width: 38px; height: 38px; opacity: 0.45; margin-bottom: 4px;"></i>
              <span style="font-size: 14.5px; font-weight: 600; color: var(--text-main, #fff);">No Hubbies yet</span>
              <span style="font-size: 12.5px; color: var(--text-muted);">Users followed by this profile will show up here.</span>
            </div>
          `;
        }
        debouncedCreateIcons();
        return;
      }

      uniqueUsers.forEach(user => {
        const row = document.createElement('div');
        row.className = 'relation-user-item';

        const avatarSrc = user.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&h=80&q=80';
        const userDisplayName = user.fullName || user.username || 'Hubber';
        const userUsername = user.username || 'user';

        row.innerHTML = `
          <div class="person-info">
            <img src="${avatarSrc}" alt="${escapeHtml(userDisplayName)}" class="relation-avatar" onerror="this.src='https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&h=80&q=80';" />
            <div class="relation-text-col">
              <strong class="relation-name">${escapeHtml(userDisplayName)}</strong>
              <span class="relation-username">@${escapeHtml(userUsername)}</span>
            </div>
          </div>
          ${user.isMe ? '' : `
            <button class="search-follow-btn relations-follow-btn ${user.isFollowing ? 'followed' : (user.isPending ? 'requested' : '')}" data-user-id="${user._id || user.id}">
              ${user.isFollowing ? 'Hubbies' : (user.isPending ? 'Requested' : 'Follow')}
            </button>
          `}
        `;

        row.querySelector('.person-info').addEventListener('click', () => {
          relationsModal.classList.remove('active');
          switchView('profile', getUserIdentifier(user));
        });

        const rFollowBtn = row.querySelector('.relations-follow-btn');
        if (rFollowBtn) {
          rFollowBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const uid = rFollowBtn.getAttribute('data-user-id');
            const isFollowing = rFollowBtn.classList.contains('followed');
            const endpoint = isFollowing ? 'unfollow' : 'follow';

            rFollowBtn.disabled = true;

            try {
              const actionRes = await fetch(`${API_URL}/api/users/${uid}/${endpoint}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
              });
              const data = await actionRes.json();
              if (!actionRes.ok) throw new Error(data.error || 'Action failed');

              if (endpoint === 'follow') {
                if (data.status === 'pending') {
                  rFollowBtn.classList.add('requested');
                  rFollowBtn.classList.remove('followed');
                  rFollowBtn.textContent = 'Requested';
                  showToast(data.message || 'Follow request sent. ⏳');
                } else {
                  rFollowBtn.classList.add('followed');
                  rFollowBtn.classList.remove('requested');
                  rFollowBtn.textContent = 'Hubbies';
                  showToast(data.message || 'Followed successfully!');
                }
              } else {
                rFollowBtn.classList.remove('followed');
                rFollowBtn.classList.remove('requested');
                rFollowBtn.textContent = 'Follow';
                showToast('Unfollowed successfully.');
              }

              if (typeof loadProfileStats === 'function') loadProfileStats();
              if (typeof loadUserProfile === 'function') loadUserProfile(targetUserId);
            } catch (err) {
              showToast(err.message || 'Error updating status');
            } finally {
              rFollowBtn.disabled = false;
            }
          });
        }

        relationsContent.appendChild(row);
      });

      debouncedCreateIcons();
    } catch (err) {
      console.error('[Relations Modal Error]:', err);
      if (relationsContent) {
        relationsContent.innerHTML = `
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 20px; color: var(--error-color, #ef4444); text-align: center; gap: 8px;">
            <i data-lucide="alert-circle" style="width: 32px; height: 32px;"></i>
            <span style="font-size: 14px; font-weight: 600;">Unable to load ${type === 'followers' ? 'Hubbers' : 'Hubbies'}</span>
            <span style="font-size: 12px; opacity: 0.8;">Please check your connection and try again.</span>
          </div>
        `;
        debouncedCreateIcons();
      }
    }
  }

  if (followersCountEl) {
    followersCountEl.parentElement.style.cursor = 'pointer';
    followersCountEl.parentElement.addEventListener('click', () => openRelationsModal('followers'));
  }
  if (followingCountEl) {
    followingCountEl.parentElement.style.cursor = 'pointer';
    followingCountEl.parentElement.addEventListener('click', () => openRelationsModal('following'));
  }

  const sidebarFollowersEl = document.getElementById('user-followers-count');
  const sidebarFollowingEl = document.getElementById('user-following-count');
  if (sidebarFollowersEl) {
    const parent = sidebarFollowersEl.closest('.stat-item') || sidebarFollowersEl.parentElement;
    if (parent) {
      parent.style.cursor = 'pointer';
      parent.addEventListener('click', () => openRelationsModal('followers'));
    }
  }
  if (sidebarFollowingEl) {
    const parent = sidebarFollowingEl.closest('.stat-item') || sidebarFollowingEl.parentElement;
    if (parent) {
      parent.style.cursor = 'pointer';
      parent.addEventListener('click', () => openRelationsModal('following'));
    }
  }

  // --- GLOBAL USER SEARCH LOGIC ---
  const globalSearchInput = document.getElementById('global-search');
  const searchDropdown = document.getElementById('search-results-dropdown');
  const searchList = document.getElementById('search-results-list');

  if (globalSearchInput && searchDropdown && searchList) {
    let searchDebounceTimeout;

    globalSearchInput.addEventListener('input', () => {
      clearTimeout(searchDebounceTimeout);
      const query = globalSearchInput.value.trim();

      if (!query) {
        searchDropdown.style.display = 'none';
        searchList.innerHTML = '';
        return;
      }

      searchDebounceTimeout = setTimeout(async () => {
        const token = localStorage.getItem('invibe_jwt_token');
        if (!token) return;

        try {
          const res = await fetch(`${API_URL}/api/users/search?q=${encodeURIComponent(query)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (!res.ok) throw new Error('Search failed');
          const users = await res.json();

          searchList.innerHTML = '';
          if (users.length === 0) {
            searchList.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 13px;">No users found</div>';
            searchDropdown.style.display = 'block';
            return;
          }

          users.forEach(user => {
            const row = document.createElement('div');
            row.className = 'search-result-row';
            row.innerHTML = `
              <img src="${user.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&h=80&q=80'}" alt="${user.fullName}" class="search-result-avatar" />
              <div class="search-result-info">
                <h5>${user.fullName}</h5>
                <p>@${user.username}</p>
              </div>
              <button class="search-follow-btn ${user.isFollowing ? 'followed' : ''}" data-user-id="${user._id}">
                ${user.isFollowing ? 'Hubbies' : 'Follow'}
              </button>
            `;

            // Row click triggers profile navigation
            row.addEventListener('click', (e) => {
              if (e.target.closest('.search-follow-btn')) return;

              switchView('profile', getUserIdentifier(user));

              globalSearchInput.value = '';
              searchDropdown.style.display = 'none';
            });

            searchList.appendChild(row);
          });

          // Wire search result follow buttons
          const followBtns = searchList.querySelectorAll('.search-follow-btn');
          followBtns.forEach(btn => {
            btn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const uid = btn.getAttribute('data-user-id');
              const isFollowing = btn.classList.contains('followed');
              const endpoint = isFollowing ? 'unfollow' : 'follow';

              try {
                const res = await fetch(`${API_URL}/api/users/${uid}/${endpoint}`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${token}` }
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                if (endpoint === 'follow') {
                  btn.classList.add('followed');
                  btn.textContent = 'Hubbies';
                  showToast(data.message || 'Followed successfully!');
                } else {
                  btn.classList.remove('followed');
                  btn.textContent = 'Follow';
                  showToast('Unfollowed successfully.');
                }
                loadProfileStats();
                loadFollowSuggestions();
              } catch (err) {
                showToast(err.message);
              }
            });
          });

          searchDropdown.style.display = 'block';
        } catch (err) {
          console.error(err);
        }
      }, 250);
    });

    document.addEventListener('click', (e) => {
      if (!globalSearchInput.contains(e.target) && !searchDropdown.contains(e.target)) {
        searchDropdown.style.display = 'none';
      }
    });
  }

  // --- HOMEPAGE USER ACCOUNT SEARCH LOGIC ---
  const homepageSearchInput = document.getElementById('stories-search');
  const homepageSearchDropdown = document.getElementById('homepage-search-dropdown');
  const homepageSearchList = document.getElementById('homepage-search-list');

  if (homepageSearchInput && homepageSearchDropdown && homepageSearchList) {
    let homepageSearchDebounceTimeout;

    homepageSearchInput.addEventListener('input', () => {
      clearTimeout(homepageSearchDebounceTimeout);
      const query = homepageSearchInput.value.trim();

      // Maintain existing stories filtering behavior
      if (typeof window.filterStories === 'function') {
        window.filterStories(homepageSearchInput.value);
      }

      if (!query) {
        homepageSearchDropdown.style.display = 'none';
        homepageSearchList.innerHTML = '';
        return;
      }

      // Show loading state
      homepageSearchList.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 8px;"><div class="spinner" style="width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.1); border-top-color: var(--primary, #a855f7); border-radius: 50%; animation: spin 0.8s linear infinite;"></div><span>Searching...</span></div>';
      homepageSearchDropdown.style.display = 'block';

      homepageSearchDebounceTimeout = setTimeout(async () => {
        const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
        if (!token) return;

        try {
          const res = await fetch(`${API_URL}/api/users/search?q=${encodeURIComponent(query)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });

          if (!res.ok) throw new Error('Search request failed');
          const users = await res.json();

          homepageSearchList.innerHTML = '';
          if (users.length === 0) {
            homepageSearchList.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 13px;">No users found</div>';
            return;
          }

          users.forEach(user => {
            const row = document.createElement('div');
            row.className = 'search-result-row';
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.padding = '8px 12px';
            row.style.borderRadius = 'var(--radius-sm)';
            row.style.cursor = 'pointer';

            row.innerHTML = `
              <div style="display: flex; align-items: center; gap: 12px; flex-grow: 1;">
                <img src="${user.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&h=80&q=80'}" alt="${escapeHtml(user.fullName)}" class="search-result-avatar" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;" />
                <div class="search-result-info">
                  <h5 style="margin: 0; font-size: 14px; color: var(--text-main); font-weight: 600;">${escapeHtml(user.fullName)}</h5>
                  <p style="margin: 0; font-size: 12px; color: var(--text-muted);">@${escapeHtml(user.username)}</p>
                </div>
              </div>
              <button class="search-follow-btn ${user.isFollowing ? 'followed' : ''}" data-user-id="${user._id}" style="padding: 4px 12px; border-radius: 12px; font-size: 11px; font-weight: 600; cursor: pointer; border: none; flex-shrink: 0;">
                ${user.isFollowing ? 'Hubbies' : 'Connect'}
              </button>
            `;

            row.addEventListener('click', (e) => {
              if (e.target.closest('.search-follow-btn')) return;
              homepageSearchDropdown.style.display = 'none';
              homepageSearchInput.value = '';
              // Restore stories filter
              if (typeof window.filterStories === 'function') {
                window.filterStories('');
              }
              switchView('profile', getUserIdentifier(user));
            });

            const followBtn = row.querySelector('.search-follow-btn');
            if (followBtn) {
              followBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleFollowUser(user._id, followBtn);
              });
            }

            homepageSearchList.appendChild(row);
          });
        } catch (err) {
          console.error('[Homepage Search Query Error]:', err);
          homepageSearchList.innerHTML = '<div style="padding: 12px; text-align: center; color: #ef4444; font-size: 13px;">Unable to search users. Please try again.</div>';
        }
      }, 300);
    });

    // Close dropdown on click outside
    document.addEventListener('click', (e) => {
      if (!homepageSearchInput.contains(e.target) && !homepageSearchDropdown.contains(e.target)) {
        homepageSearchDropdown.style.display = 'none';
      }
    });
  }

  // ==================== DYNAMIC SUPABASE SEARCH SYSTEM ====================
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  let searchDebounceTimer = null;
  let searchRequestCounter = 0;
  let isSearchRealtimeSubscribed = false;

  async function initSearchView() {
    const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
    if (!token) return;

    const searchInput = document.getElementById('search-view-input');
    if (searchInput && searchInput.value.trim() !== '') {
      return;
    }

    try {
      const res = await fetch(`${API_URL}/api/search/initial`, {
        headers: { 'Authorization': `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) throw new Error('Failed to load initial search data');
      const data = await res.json();
      renderInitialSearchView(data);
    } catch (err) {
      console.error('[Search Initial Load Error]:', err);
    }

    setupSearchRealtimeSubscriptions();
  }

  function renderInitialSearchView(data) {
    const { recentSearches, suggestedHubbers, trendingTags, activeCount } = data;

    // 1. Active Hubbers Badge
    const activeBadge = document.getElementById('active-hubbers-count-badge');
    if (activeBadge) {
      activeBadge.textContent = `${activeCount || 0} online`;
    }

    // 2. Recent Searches Container
    const recentContainer = document.getElementById('search-recent-items-container');
    if (recentContainer) {
      recentContainer.innerHTML = '';
      if (!recentSearches || recentSearches.length === 0) {
        recentContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 13px; padding: 6px 0;">No recent searches</div>';
      } else {
        recentSearches.forEach(item => {
          const itemEl = document.createElement('div');
          itemEl.className = 'search-recent-item';
          itemEl.style.display = 'flex';
          itemEl.style.alignItems = 'center';
          itemEl.style.justifyContent = 'space-between';

          const span = document.createElement('span');
          span.textContent = item.query;
          span.style.cursor = 'pointer';
          span.addEventListener('click', () => {
            const searchInput = document.getElementById('search-view-input');
            if (searchInput) {
              searchInput.value = item.query;
              handleSearchViewInput(item.query);
            }
          });

          const removeBtn = document.createElement('button');
          removeBtn.setAttribute('aria-label', 'Remove');
          removeBtn.textContent = '×';
          removeBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await deleteRecentSearchItem(item.id);
          });

          itemEl.appendChild(span);
          itemEl.appendChild(removeBtn);
          recentContainer.appendChild(itemEl);
        });
      }
    }

    // 3. Suggested Hubbers Container
    const sugContainer = document.getElementById('search-suggested-hubbers-container');
    if (sugContainer) {
      sugContainer.innerHTML = '';
      if (!suggestedHubbers || suggestedHubbers.length === 0) {
        sugContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 13px; padding: 12px 0; text-align: center;">No suggested hubbers yet</div>';
      } else {
        suggestedHubbers.forEach(user => {
          const row = document.createElement('div');
          row.className = 'search-person-row';
          row.style.display = 'flex';
          row.style.alignItems = 'center';
          row.style.justifyContent = 'space-between';
          row.style.gap = '12px';
          row.style.padding = '8px 12px';
          row.style.borderRadius = 'var(--radius-lg)';
          row.style.background = 'rgba(255, 255, 255, 0.02)';
          row.style.margin = '6px 0';
          row.style.minWidth = '0';
          row.style.maxWidth = '100%';
          row.style.boxSizing = 'border-box';
          row.style.overflow = 'hidden';

          row.innerHTML = `
            <div class="person-info" style="display: flex; align-items: center; cursor: pointer; flex: 1; min-width: 0; overflow: hidden;">
              <img src="${user.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=100&h=100&q=80'}" alt="${escapeHtml(user.fullName)}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 12px; flex-shrink: 0;" />
              <div style="display: flex; flex-direction: column; min-width: 0; flex: 1; overflow: hidden;">
                <strong style="font-size: 14px; color: var(--text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block;">${escapeHtml(user.fullName)}</strong>
                <span style="font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block;">@${escapeHtml(user.username)}</span>
              </div>
            </div>
            <button class="connect-btn search-follow-btn ${user.isFollowing ? 'followed' : ''}" data-user-id="${user._id}" style="padding: 6px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; cursor: pointer; border: none; flex-shrink: 0;">
              ${user.isFollowing ? 'Hubbies' : (user.isRequested ? 'Requested' : 'Connect')}
            </button>
          `;

          row.querySelector('.person-info').addEventListener('click', () => {
            switchView('profile', getUserIdentifier(user));
          });

          const followBtn = row.querySelector('.search-follow-btn');
          if (followBtn) {
            followBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              toggleFollowUser(user._id, followBtn);
            });
          }

          sugContainer.appendChild(row);
        });
      }
    }

    // 4. Trending Hubs & Tags Container
    const trendingContainer = document.getElementById('search-trending-hubs-container');
    if (trendingContainer) {
      trendingContainer.innerHTML = '';
      if (!trendingTags || trendingTags.length === 0) {
        trendingContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 13px; grid-column: span 3; text-align: center; padding: 12px;">No trending hubs yet</div>';
      } else {
        trendingTags.slice(0, 3).forEach(tag => {
          const card = document.createElement('div');
          card.className = 'search-card mini-card';
          card.style.cursor = 'pointer';
          card.innerHTML = `
            <span>${escapeHtml(tag.name)}</span>
            <strong>${tag.useCount} post${tag.useCount === 1 ? '' : 's'}</strong>
          `;
          card.addEventListener('click', () => {
            const searchInput = document.getElementById('search-view-input');
            if (searchInput) {
              searchInput.value = tag.name;
              handleSearchViewInput(tag.name);
            }
          });
          trendingContainer.appendChild(card);
        });
      }
    }

    // 5. Quick Tags Chips
    const quickTagsContainer = document.getElementById('search-quick-tags-container');
    if (quickTagsContainer) {
      quickTagsContainer.innerHTML = '';
      if (trendingTags && trendingTags.length > 3) {
        trendingTags.slice(3, 8).forEach(tag => {
          const chip = document.createElement('span');
          chip.className = 'search-chip';
          chip.style.cursor = 'pointer';
          chip.textContent = tag.name;
          chip.addEventListener('click', () => {
            const searchInput = document.getElementById('search-view-input');
            if (searchInput) {
              searchInput.value = tag.name;
              handleSearchViewInput(tag.name);
            }
          });
          quickTagsContainer.appendChild(chip);
        });
      }
    }
  }

  async function saveRecentSearch(query, searchedUserId = null) {
    if (!query || !query.trim()) return;
    const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
    if (!token) return;

    try {
      await fetch(`${API_URL}/api/search/recent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ query: query.trim(), searchedUserId })
      });
    } catch (err) {
      console.error('[Save Recent Search Error]:', err);
    }
  }

  async function deleteRecentSearchItem(id) {
    const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
    if (!token) return;

    try {
      await fetch(`${API_URL}/api/search/recent/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      initSearchView();
    } catch (err) {
      console.error('[Delete Recent Search Error]:', err);
    }
  }

  async function clearAllRecentSearches() {
    const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
    if (!token) return;

    try {
      await fetch(`${API_URL}/api/search/recent`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const recentContainer = document.getElementById('search-recent-items-container');
      if (recentContainer) {
        recentContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 13px; padding: 6px 0;">No recent searches</div>';
      }
    } catch (err) {
      console.error('[Clear Recent Searches Error]:', err);
    }
  }

  const clearRecentBtn = document.getElementById('search-recent-clear-btn');
  if (clearRecentBtn) {
    clearRecentBtn.addEventListener('click', () => {
      clearAllRecentSearches();
    });
  }


  function handleSearchViewInput(query) {
    const searchGrid = document.getElementById('search-landing-grid');
    const searchContextRow = document.getElementById('search-landing-context-row');
    const resultsContainer = document.getElementById('search-view-results');
    if (!resultsContainer) return;

    const trimmed = query.trim();

    if (!trimmed) {
      if (searchGrid) searchGrid.style.display = 'grid';
      if (searchContextRow) searchContextRow.style.display = 'flex';
      resultsContainer.style.display = 'none';
      resultsContainer.innerHTML = '';
      initSearchView();
      return;
    }

    if (searchGrid) searchGrid.style.display = 'none';
    if (searchContextRow) searchContextRow.style.display = 'none';
    resultsContainer.style.display = 'block';

    resultsContainer.innerHTML = `
      <div style="padding: 30px; text-align: center; color: var(--text-muted); display: flex; align-items: center; justify-content: center; gap: 10px;">
        <div class="spinner" style="width: 20px; height: 20px; border: 2px solid rgba(255,255,255,0.1); border-top-color: var(--primary, #a855f7); border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
        <span>Searching Supabase database...</span>
      </div>
    `;

    const currentRequestId = ++searchRequestCounter;

    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(async () => {
      const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
      if (!token) return;

      try {
        let res = await fetch(`${API_URL}/api/search/query?q=${encodeURIComponent(trimmed)}`, {
          headers: {
            'Authorization': `Bearer ${token}`
          },
          cache: 'no-store'
        });

        if (currentRequestId !== searchRequestCounter) {
          return;
        }

        let data = null;
        if (res.status === 200) {
          data = await res.json();
        } else if (res.status === 304) {
          const freshRes = await fetch(`${API_URL}/api/search/query?q=${encodeURIComponent(trimmed)}&_t=${Date.now()}`, {
            headers: { 'Authorization': `Bearer ${token}` },
            cache: 'no-store'
          });
          if (freshRes.ok) {
            data = await freshRes.json();
          }
        }

        if (!data) {
          throw new Error(`Search request failed with status ${res.status}`);
        }

        saveRecentSearch(trimmed);
        renderSearchResults(data, trimmed, resultsContainer);
      } catch (err) {
        if (currentRequestId === searchRequestCounter) {
          console.error('[Search Query Error]:', err);
          resultsContainer.innerHTML = `
            <div style="padding: 24px; text-align: center; color: #ef4444;">
              Unable to complete search. Please try again.<br/>
              <span style="font-size: 11px; color: #a1a1aa; font-family: monospace; display: block; margin-top: 8px;">Error: ${escapeHtml(err.message)}</span>
            </div>
          `;
        }
      }
    }, 350);
  }

  function renderSearchResults(data, query, container) {
    const { users = [], hashtags = [], posts = [], hubs = [] } = data;
    container.innerHTML = '';

    const totalResults = users.length + hashtags.length + posts.length + hubs.length;

    if (totalResults === 0) {
      container.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; color: var(--text-muted);">
          <i data-lucide="search-x" style="width: 48px; height: 48px; stroke-width: 1.5; opacity: 0.5; margin-bottom: 12px;"></i>
          <h3 style="font-weight: 600; font-size: 16px; color: var(--text-color); margin-bottom: 4px;">No results found for "${escapeHtml(query)}"</h3>
          <p style="font-size: 13px;">Check for spelling errors or try searching for a different username or hashtag.</p>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    // 1. USERS SECTION
    const userSection = document.createElement('div');
    userSection.style.marginBottom = '24px';
    userSection.innerHTML = `<h4 style="font-size: 14px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">People</h4>`;

    if (users.length === 0) {
      userSection.innerHTML += `<div style="padding: 12px; font-size: 13px; color: var(--text-muted);">No people found</div>`;
    } else {
      users.forEach(user => {
        const row = document.createElement('div');
        row.className = 'search-person-row';
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.justifyContent = 'space-between';
        row.style.gap = '12px';
        row.style.padding = '10px 14px';
        row.style.borderRadius = 'var(--radius-lg)';
        row.style.background = 'rgba(255, 255, 255, 0.02)';
        row.style.margin = '8px 0';
        row.style.border = '1px solid rgba(255, 255, 255, 0.04)';
        row.style.minWidth = '0';
        row.style.maxWidth = '100%';
        row.style.boxSizing = 'border-box';
        row.style.overflow = 'hidden';

        row.innerHTML = `
          <div class="person-info" style="display: flex; align-items: center; cursor: pointer; flex: 1; min-width: 0; overflow: hidden;">
            <img src="${user.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=100&h=100&q=80'}" alt="${escapeHtml(user.fullName)}" style="width: 44px; height: 44px; border-radius: 50%; object-fit: cover; margin-right: 12px; flex-shrink: 0;" />
            <div style="display: flex; flex-direction: column; min-width: 0; flex: 1; overflow: hidden;">
              <strong style="font-size: 14px; color: var(--text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block;">${escapeHtml(user.fullName)}</strong>
              <span style="font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block;">@${escapeHtml(user.username)} ${user.followersCount ? `• ${user.followersCount} followers` : ''}</span>
            </div>
          </div>
          <button class="connect-btn search-follow-btn ${user.isFollowing ? 'followed' : ''}" data-user-id="${user._id}" style="padding: 6px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; cursor: pointer; border: none; flex-shrink: 0;">
            ${user.isFollowing ? 'Hubbies' : (user.isRequested ? 'Requested' : 'Connect')}
          </button>
        `;

        row.querySelector('.person-info').addEventListener('click', () => {
          const targetUid = getUserIdentifier(user);
          saveRecentSearch(query, targetUid);
          switchView('profile', targetUid);
        });

        const followBtn = row.querySelector('.search-follow-btn');
        if (followBtn) {
          followBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFollowUser(user._id, followBtn);
          });
        }

        userSection.appendChild(row);
      });
    }
    container.appendChild(userSection);

    // 2. HASHTAGS SECTION
    const tagSection = document.createElement('div');
    tagSection.style.marginBottom = '24px';
    tagSection.innerHTML = `<h4 style="font-size: 14px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">Hashtags</h4>`;

    if (hashtags.length === 0) {
      tagSection.innerHTML += `<div style="padding: 12px; font-size: 13px; color: var(--text-muted);">No hashtags found</div>`;
    } else {
      const tagGrid = document.createElement('div');
      tagGrid.style.display = 'grid';
      tagGrid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(180px, 1fr))';
      tagGrid.style.gap = '10px';

      hashtags.forEach(tag => {
        const card = document.createElement('div');
        card.className = 'search-card mini-card';
        card.style.cursor = 'pointer';
        card.style.padding = '12px 16px';
        card.style.background = 'rgba(255, 255, 255, 0.03)';
        card.style.borderRadius = '12px';
        card.style.border = '1px solid rgba(255, 255, 255, 0.05)';
        card.innerHTML = `
          <span style="font-weight: 600; color: var(--primary, #a855f7); font-size: 14px;">${escapeHtml(tag.name)}</span>
          <strong style="font-size: 12px; color: var(--text-muted); font-weight: 400; display: block; margin-top: 4px;">${tag.useCount} post${tag.useCount === 1 ? '' : 's'}</strong>
        `;

        card.addEventListener('click', () => {
          saveRecentSearch(tag.name);
          const searchInput = document.getElementById('search-view-input');
          if (searchInput) {
            searchInput.value = tag.name;
            handleSearchViewInput(tag.name);
          }
        });

        tagGrid.appendChild(card);
      });
      tagSection.appendChild(tagGrid);
    }
    container.appendChild(tagSection);

    // 3. POSTS SECTION
    const postSection = document.createElement('div');
    postSection.style.marginBottom = '24px';
    postSection.innerHTML = `<h4 style="font-size: 14px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">Posts</h4>`;

    if (posts.length === 0) {
      postSection.innerHTML += `<div style="padding: 12px; font-size: 13px; color: var(--text-muted);">No posts found</div>`;
    } else {
      posts.forEach(post => {
        if (!post) return;
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.padding = '12px';
        row.style.borderRadius = 'var(--radius-lg)';
        row.style.background = 'rgba(255, 255, 255, 0.02)';
        row.style.margin = '8px 0';
        row.style.border = '1px solid rgba(255, 255, 255, 0.04)';
        row.style.cursor = 'pointer';

        const author = post.author || {};
        const authorImage = author.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=100&h=100&q=80';
        const authorName = author.fullName || author.username || 'User';
        const authorUsername = author.username || 'user';
        const postCaption = post.caption || 'Untitled Post';
        const postLocation = post.location || '';

        row.innerHTML = `
          <img src="${authorImage}" alt="${escapeHtml(authorName)}" class="author-profile-pic" style="width: 44px; height: 44px; border-radius: 50%; object-fit: cover; margin-right: 14px; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.08); cursor: pointer;" />
          <div style="flex-grow: 1; min-width: 0; margin-right: 12px;">
            <div style="font-size: 13px; font-weight: 600; color: var(--text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(postCaption)}</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">Posted by <span class="author-profile-link" style="color: var(--primary, #a855f7); font-weight: 600; cursor: pointer;">@${escapeHtml(authorUsername)}</span>${postLocation ? ` • ${escapeHtml(postLocation)}` : ''}</div>
          </div>
          ${post.mediaUrl ? `<img src="${post.mediaUrl}" alt="Post Media" style="width: 44px; height: 44px; border-radius: 8px; object-fit: cover; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.05);" />` : ''}
        `;

        const authorIdentifier = getUserIdentifier(author);

        // Redirect to user profile on profile pic click
        const profilePic = row.querySelector('.author-profile-pic');
        if (profilePic && authorIdentifier) {
          profilePic.addEventListener('click', (e) => {
            e.stopPropagation();
            saveRecentSearch(query, authorIdentifier);
            switchView('profile', authorIdentifier);
          });
        }

        // Redirect to user profile on username click
        const profileLink = row.querySelector('.author-profile-link');
        if (profileLink && authorIdentifier) {
          profileLink.addEventListener('click', (e) => {
            e.stopPropagation();
            saveRecentSearch(query, authorIdentifier);
            switchView('profile', authorIdentifier);
          });
        }

        row.addEventListener('click', async () => {
          saveRecentSearch(query);
          try {
            const token = localStorage.getItem('invibe_jwt_token') || localStorage.getItem('invibe_token');
            const res = await fetch(`${API_URL}/api/posts/${post.id}`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
              const fullPost = await res.json();
              openProfilePostViewer(fullPost);
            } else {
              console.error('Failed to fetch post details for search redirection');
              switchView('home');
            }
          } catch (err) {
            console.error('Error fetching post details for search redirection:', err);
            switchView('home');
          }
        });

        postSection.appendChild(row);
      });
    }
    container.appendChild(postSection);

    // 4. HUBS SECTION
    const hubSection = document.createElement('div');
    hubSection.style.marginBottom = '24px';
    hubSection.innerHTML = `
      <h4 style="font-size: 14px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">Hubs</h4>
      <div style="padding: 12px; font-size: 13px; color: var(--text-muted);">No hubs found</div>
    `;
    container.appendChild(hubSection);

    if (window.lucide) window.lucide.createIcons();
  }

  function setupSearchRealtimeSubscriptions() {
    if (isSearchRealtimeSubscribed || !window.supabaseClient) return;
    isSearchRealtimeSubscribed = true;

    try {
      const channel = window.supabaseClient.channel('search-page-realtime');
      channel
        .on('postgres_changes', { event: '*', schema: 'public', table: 'recent_searches' }, () => {
          if (state.activeView === 'search') initSearchView();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => {
          if (state.activeView === 'search') initSearchView();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'online_users' }, () => {
          if (state.activeView === 'search') initSearchView();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'hashtags' }, () => {
          if (state.activeView === 'search') initSearchView();
        })
        .subscribe();
    } catch (err) {
      console.warn('[Search Realtime Subscription Warning]:', err);
    }
  }

  const searchViewInput = document.getElementById('search-view-input');
  if (searchViewInput) {
    searchViewInput.addEventListener('input', () => {
      handleSearchViewInput(searchViewInput.value);
    });
  }

  // --- PROGRESSIVE APP INITIALIZATION & DEDUPLICATED BACKGROUND LOADERS ---
  // 1. Immediately load feed posts for Home view
  loadFeedPosts();

  // Deduplication flags for secondary background tasks
  let isProfileStatsLoading = false;
  let isFollowSuggestionsLoading = false;
  let isStoriesLoading = false;
  let isActiveVibersLoading = false;
  let isNotificationsLoading = false;
  let _backgroundLoadersTimer = null;

  function scheduleBackgroundLoaders() {
    if (_backgroundLoadersTimer) {
      clearTimeout(_backgroundLoadersTimer);
    }
    _backgroundLoadersTimer = setTimeout(() => {
      _backgroundLoadersTimer = null;

      // Stagger non-critical background data loading progressively so initial app shell render is instant (< 20ms)
      if (!isProfileStatsLoading && typeof loadProfileStats === 'function') {
        isProfileStatsLoading = true;
        Promise.resolve(loadProfileStats()).finally(() => { isProfileStatsLoading = false; });
      }

      setTimeout(() => {
        if (!isFollowSuggestionsLoading && typeof loadFollowSuggestions === 'function') {
          isFollowSuggestionsLoading = true;
          Promise.resolve(loadFollowSuggestions()).finally(() => { isFollowSuggestionsLoading = false; });
        }
      }, 150);

      setTimeout(() => {
        if (!isStoriesLoading && typeof loadStories === 'function') {
          isStoriesLoading = true;
          Promise.resolve(loadStories()).finally(() => { isStoriesLoading = false; });
        }
      }, 300);

      setTimeout(() => {
        if (!isActiveVibersLoading && typeof loadActiveVibers === 'function') {
          isActiveVibersLoading = true;
          Promise.resolve(loadActiveVibers()).finally(() => { isActiveVibersLoading = false; });
        }
      }, 450);

      setTimeout(() => {
        if (!isNotificationsLoading && typeof loadNotifications === 'function') {
          isNotificationsLoading = true;
          Promise.resolve(loadNotifications()).finally(() => { isNotificationsLoading = false; });
        }
      }, 600);
    }, 100);
  }

  // Schedule background loading after home feed starts rendering
  scheduleBackgroundLoaders();

  // Custom auth reload hook
  window.updateAppUI = function () {
    const userStr = localStorage.getItem('invibeUser');
    const profileImage = localStorage.getItem('invibeProfileImage');
    if (!userStr) return;
    try {
      const user = JSON.parse(userStr);
      const userId = (user.id || user._id || '').toString();
      const currentUsername = (user.username || '').toLowerCase();

      // Instant synchronous UI DOM update from local session (< 10ms)
      const headerAvatar = document.querySelector('#header-profile-avatar img');
      if (headerAvatar && profileImage) headerAvatar.src = profileImage;
      const sidebarAvatar = document.querySelector('.profile-preview-avatar img');
      if (sidebarAvatar && profileImage) sidebarAvatar.src = profileImage;
      const createPostAvatar = document.querySelector('#create-post-user-avatar');
      if (createPostAvatar && profileImage) createPostAvatar.src = profileImage;
      const sidebarName = document.querySelector('.profile-preview-info h3');
      if (sidebarName && user.fullName) sidebarName.textContent = user.fullName;
      const sidebarUsername = document.querySelector('.profile-preview-info p');
      if (sidebarUsername && user.username) sidebarUsername.textContent = '@' + user.username;
      const storyAvatar = document.querySelector('.story-card.current-user .story-avatar-container img') || document.querySelector('#story-btn-current img');
      if (storyAvatar && profileImage) storyAvatar.src = profileImage;
      const myProfileAvatar = document.querySelector('.profile-screen-avatar');
      if (myProfileAvatar && profileImage) myProfileAvatar.src = profileImage;
      const myProfileName = document.querySelector('.profile-summary-top h3');
      if (myProfileName && user.fullName) {
        myProfileName.innerHTML = user.fullName;
        debouncedCreateIcons();
      }
      const myProfileUsername = document.querySelector('.profile-screen-handle');
      if (myProfileUsername && user.username) myProfileUsername.textContent = '@' + user.username;

      // Synchronize all live feed post author avatars and comments for current user
      if (profileImage) {
        document.querySelectorAll('#home-feed-posts .feed-card').forEach(card => {
          const avatarEl = card.querySelector('.author-avatar');
          const authorId = avatarEl?.getAttribute('data-user-id') || '';
          const handleEl = card.querySelector('.author-handle');
          const handleText = handleEl?.textContent?.replace('@', '').trim().toLowerCase() || '';

          if (avatarEl && ((userId && authorId === userId) || (currentUsername && handleText === currentUsername))) {
            avatarEl.src = profileImage;
          }
        });

        document.querySelectorAll('.comment-author-avatar').forEach(img => {
          const cAuthorId = img.getAttribute('data-user-id') || '';
          if (userId && cAuthorId === userId) {
            img.src = profileImage;
          }
        });
      }

      const bannerImage = localStorage.getItem('invibeBannerImage') || user.bannerImage || user.cover_image_url || '';
      if (bannerImage) {
        const sidebarBanner = document.querySelector('.sidebar-left .card-cover-bg');
        if (sidebarBanner) {
          sidebarBanner.style.backgroundImage = `url(${bannerImage})`;
          sidebarBanner.style.backgroundSize = 'cover';
          sidebarBanner.style.backgroundPosition = 'center';
        }
      }

      // Only update profile header banner if viewing own profile
      const activeFollowBtn = document.getElementById('profile-follow-btn');
      const isViewingOtherUser = activeFollowBtn && activeFollowBtn.style.display !== 'none';
      if (!isViewingOtherUser) {
        const profileBannerImg = document.querySelector('.profile-banner img');
        if (profileBannerImg) {
          if (bannerImage) {
            profileBannerImg.src = bannerImage;
            profileBannerImg.style.display = 'block';
            profileBannerImg.style.opacity = '1';
          } else {
            profileBannerImg.src = '';
            profileBannerImg.style.display = 'none';
          }
        }
      }

      // Schedule background updates progressively without blocking render
      scheduleBackgroundLoaders();
    } catch (e) {
      console.error(e);
    }
  };

  // ─── SCOPED REALTIME DM MESSAGES SUBSCRIBER (Phase 1) ─────────────────
  function setupDMRealtime() {
    if (!window.supabase) return;
    const currentUser = getCurrentUser();
    if (!currentUser) return;
    const currentUserId = (currentUser.id || currentUser._id || '').toString();
    if (!currentUserId) return;

    if (dmState.realtimeChannel && dmState._subscribedUserId === currentUserId) {
      return; // Already healthy and subscribed for this active user
    }

    if (dmState.realtimeChannel) {
      console.debug('[DM-RUNTIME] realtime unsubscribe:', Date.now());
      try {
        window.supabase.removeChannel(dmState.realtimeChannel);
      } catch (_) { }
      dmState.realtimeChannel = null;
    }

    dmState._subscribedUserId = currentUserId;
    console.debug('[DM-RUNTIME] realtime subscribe:', currentUserId, Date.now());

    try {
      const channel = window.supabase
        .channel(`dm-messages-realtime-${currentUserId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'messages'
        }, (payload) => {
          const newMsg = payload.new;
          if (!newMsg) return;

          console.debug('[DM-RUNTIME] realtime INSERT:', newMsg.id, newMsg.conversation_id, Date.now());

          const isFromMe = (newMsg.sender_id || '').toString() === currentUserId;
          const partnerId = isFromMe ? newMsg.recipient_id : newMsg.sender_id;
          if (!partnerId) return;

          const rawMedia = newMsg.media_url || '';
          const resolvedMediaUrl = resolveBrowserMediaUrl(newMsg);
          const rawType = (newMsg.media_type || (rawMedia ? 'image' : 'text')).toLowerCase();
          const effectiveType = rawType.includes('video') ? 'video' : rawType;

          const formattedMsg = {
            _id: newMsg.id,
            id: newMsg.id,
            conversationId: newMsg.conversation_id,
            sender: newMsg.sender_id,
            recipient: newMsg.recipient_id,
            content: newMsg.content,
            mediaUrl: resolvedMediaUrl,
            mediaType: effectiveType,
            mediaName: newMsg.media_name || (effectiveType === 'video' ? 'video.mp4' : (effectiveType === 'image' ? 'image.png' : null)),
            mediaSize: newMsg.media_size,
            replyToId: newMsg.reply_to_id,
            status: newMsg.status,
            createdAt: newMsg.created_at
          };

          // Append to active conversation if open (NO REFETCH / NO SKELETON / NO FLICKER)
          appendSingleMessage(partnerId, formattedMsg);

          // Update sidebar thread preview in-place
          updateThreadLastMessageInPlace(partnerId, formattedMsg);

          // If thread does not exist in sidebar yet, reload threads
          const threadEl = chatThreadsList?.querySelector(`.thread-item[data-thread="${partnerId}"]`);
          if (!threadEl && typeof loadChatThreads === 'function') {
            loadChatThreads(false);
          }

          // If currently in conversation with this partner, mark as read immediately
          if ((dmState.activePartnerId && dmState.activePartnerId.toString() === partnerId.toString()) ||
              (newMsg.conversation_id && dmState.activeConversationId && dmState.activeConversationId.toString() === newMsg.conversation_id.toString())) {
            markMessagesAsRead(partnerId);
          }
        })
        .subscribe();

      dmState.realtimeChannel = channel;
    } catch (rtErr) {
      console.warn('[DM-RUNTIME] Realtime Subscription Notice:', rtErr);
    }
  }

  // Initialize Realtime subscription
  setupDMRealtime();

  // ─── SCOPED REALTIME NOTIFICATIONS SUBSCRIBER ────────────────────────
  let notificationsRealtimeChannel = null;
  let notificationsSubscribedUserId = null;
  function setupNotificationsRealtime() {
    if (!window.supabase) return;
    const currentUser = getCurrentUser();
    if (!currentUser) return;
    const currentUserId = (currentUser.id || currentUser._id || '').toString();
    if (!currentUserId) return;

    if (notificationsRealtimeChannel && notificationsSubscribedUserId === currentUserId) {
      return; // Already healthy and subscribed for this active user
    }

    if (notificationsRealtimeChannel) {
      try {
        window.supabase.removeChannel(notificationsRealtimeChannel);
      } catch (_) { }
      notificationsRealtimeChannel = null;
    }

    notificationsSubscribedUserId = currentUserId;

    try {
      notificationsRealtimeChannel = window.supabase
        .channel(`notifications-realtime-${currentUserId}`)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'notifications'
        }, (payload) => {
          const newNotif = payload.new;
          const oldNotif = payload.old;
          const targetId = ((newNotif && (newNotif.recipient_id || newNotif.user_id)) || (oldNotif && (oldNotif.recipient_id || oldNotif.user_id)) || '').toString();

          if (!targetId || targetId === currentUserId) {
            loadNotifications();
            if (payload.eventType === 'INSERT' && newNotif) {
              if (newNotif.type === 'follow_request') {
                showToast(newNotif.message || '🔔 New Hubbies request received!');
              } else if (newNotif.type === 'accept_follow_request') {
                showToast(newNotif.message || '🎉 Someone accepted your Hubbies request!');
                if (typeof loadProfileStats === 'function') loadProfileStats();
                if (typeof loadFollowSuggestions === 'function') loadFollowSuggestions();
                if (suggestedVibersModal && suggestedVibersModal.classList.contains('active')) {
                  openSuggestedVibersModal();
                }
                const senderPartnerId = (newNotif.sender_id || '').toString();
                if (senderPartnerId) {
                  document.querySelectorAll(`[data-user-id="${senderPartnerId}"]`).forEach(btn => {
                    btn.classList.add('followed');
                    btn.classList.remove('requested');
                    btn.textContent = 'Hubbies';
                    btn.style.background = '#22c55e';
                    btn.style.color = '#ffffff';
                    btn.disabled = false;
                  });
                }
              }
            }
          }
        })
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'follow_requests'
        }, (payload) => {
          if (typeof loadProfileStats === 'function') loadProfileStats();
          if (typeof loadFollowSuggestions === 'function') loadFollowSuggestions();
          if (suggestedVibersModal && suggestedVibersModal.classList.contains('active')) {
            openSuggestedVibersModal();
          }
          if (relationsModal && relationsModal.classList.contains('active')) {
            const relType = relationsModal.getAttribute('data-relation-type');
            if (relType && typeof openRelationsModal === 'function') {
              openRelationsModal(relType);
            }
          }
        })
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'followers'
        }, (payload) => {
          if (typeof loadProfileStats === 'function') loadProfileStats();
          if (typeof loadFollowSuggestions === 'function') loadFollowSuggestions();
          if (relationsModal && relationsModal.classList.contains('active')) {
            const relType = relationsModal.getAttribute('data-relation-type');
            if (relType && typeof openRelationsModal === 'function') {
              openRelationsModal(relType);
            }
          }
        })
        .subscribe();
    } catch (rtErr) {
      console.warn('[NOTIF-REALTIME] Realtime Subscription Notice:', rtErr);
    }
  }

  // Initialize Notifications Realtime
  setupNotificationsRealtime();

  // ─── NOTIFICATIONS DROPDOWN AND BADGES INTERACTION SYSTEM ────────────────────
  const notifBtn = document.getElementById('notif-btn');
  const notifPanel = document.getElementById('notifications-panel');
  const notifCloseBtn = document.getElementById('notifications-panel-close-btn');
  const notifBadge = document.getElementById('header-notif-badge');
  const radialNotifBadge = document.getElementById('radial-notif-badge');

  function isNotificationsPanelOpen() {
    if (!notifPanel) return false;
    return notifPanel.style.display === 'flex' || notifPanel.style.display === 'block';
  }

  function openNotificationsPanel() {
    if (!notifPanel) return;

    const searchDropdown = document.getElementById('search-results-dropdown');
    if (searchDropdown) searchDropdown.style.display = 'none';

    notifPanel.style.display = 'flex';

    loadNotifications();

    if (typeof updateHubbleActiveState === 'function') {
      updateHubbleActiveState();
    }
  }

  function closeNotificationsPanel() {
    if (!notifPanel) return;

    notifPanel.style.display = 'none';

    if (typeof updateHubbleActiveState === 'function') {
      updateHubbleActiveState();
    }
  }

  function toggleNotificationsPanel() {
    if (isNotificationsPanelOpen()) {
      closeNotificationsPanel();
    } else {
      openNotificationsPanel();
    }
  }

  window.openNotificationsPanel = openNotificationsPanel;
  window.closeNotificationsPanel = closeNotificationsPanel;
  window.toggleNotificationsPanel = toggleNotificationsPanel;

  let _notificationsInFlightPromise = null;
  async function loadNotifications(forceRefresh = false) {
    const token = localStorage.getItem('invibe_jwt_token');
    if (!token) {
      if (notifBadge) notifBadge.style.display = 'none';
      if (radialNotifBadge) radialNotifBadge.style.display = 'none';
      return;
    }

    if (_notificationsInFlightPromise && !forceRefresh) {
      return _notificationsInFlightPromise;
    }

    _notificationsInFlightPromise = (async () => {
      try {
        const res = await fetch(`${API_URL}/api/notifications`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Failed to fetch notifications');
        const notifications = await res.json();

        // Update badges (blue diamond for unread notifications)
        const unreadCount = notifications.filter(n => n.isRead === false || n.read === false).length;
        updateNotificationBadgesUI(unreadCount);

        // Render notification items in panel
        renderNotificationsPanel(notifications);
      } catch (err) {
        console.error('Error loading notifications:', err);
      } finally {
        _notificationsInFlightPromise = null;
      }
    })();

    return _notificationsInFlightPromise;
  }

  function updateNotificationBadgesUI(unreadCount) {
    if (unreadCount > 0) {
      if (notifBadge) {
        notifBadge.className = 'badge blue-diamond';
        notifBadge.style.display = 'block';
      }
      if (radialNotifBadge) {
        radialNotifBadge.className = 'nav-icon-badge blue-diamond';
        radialNotifBadge.style.display = 'flex';
        radialNotifBadge.textContent = '';
      }
    } else {
      if (notifBadge) {
        notifBadge.className = 'badge';
        notifBadge.style.display = 'none';
      }
      if (radialNotifBadge) {
        radialNotifBadge.className = 'nav-icon-badge';
        radialNotifBadge.style.display = 'none';
      }
    }
  }

  function recalcNotificationBadges() {
    if (!notifPanel) return;
    const unreadCount = notifPanel.querySelectorAll('.notification-item.unread').length;
    updateNotificationBadgesUI(unreadCount);
  }

  function renderNotificationsPanel(notifications) {
    if (!notifPanel) return;

    const listContainer = notifPanel.querySelector('.notifications-list');
    if (!listContainer) return;

    listContainer.innerHTML = '';

    if (notifications.length === 0) {
      listContainer.innerHTML = `
        <div class="notification-empty">
          <i data-lucide="bell-off"></i>
          <p>No notifications yet</p>
        </div>
      `;
      debouncedCreateIcons();
      return;
    }

    notifications.forEach(notif => {
      const item = document.createElement('div');
      const isUnread = notif.isRead === false || notif.read === false;
      item.className = `notification-item ${isUnread ? 'unread' : ''}`;

      const sender = notif.sender || { fullName: 'User', username: 'user', profileImage: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80' };
      const senderId = sender.id || sender._id || notif.senderId || '';
      const senderAvatar = sender.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80';

      let messageText = notif.text || `<strong>@${sender.username}</strong> interacted with you.`;
      let actionButtons = '';

      if (notif.type === 'follow_request') {
        messageText = `<strong>@${sender.username}</strong> sent you a Hubbies request.`;
        actionButtons = `
          <div class="notif-action-btns" style="display: flex; gap: 6px; margin-top: 6px;">
            <button type="button" class="btn-accept-request" data-sender-id="${senderId}" data-notif-id="${notif._id || notif.id}" style="padding: 4px 12px; background: var(--primary, #a855f7); color: white; border: none; border-radius: 12px; font-size: 11.5px; font-weight: 600; cursor: pointer; transition: all 0.2s;">Accept</button>
            <button type="button" class="btn-reject-request" data-sender-id="${senderId}" data-notif-id="${notif._id || notif.id}" style="padding: 4px 12px; background: rgba(255,255,255,0.1); color: var(--text-color, white); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; font-size: 11.5px; font-weight: 600; cursor: pointer; transition: all 0.2s;">Decline</button>
          </div>
        `;
      } else if (notif.type === 'accept_follow_request') {
        messageText = `<strong>@${sender.username}</strong> accepted your Hubbies request.`;
      } else if (notif.type === 'follow') {
        messageText = `<strong>@${sender.username}</strong> started following you.`;
      } else if (notif.type === 'like') {
        messageText = `<strong>@${sender.username}</strong> liked your post.`;
      } else if (notif.type === 'comment') {
        messageText = `<strong>@${sender.username}</strong> commented on your post.`;
      } else if (notif.type === 'reel_mention') {
        messageText = `<strong>@${sender.username}</strong> tagged you in a Reel.`;
        if (notif.mentionStatus === 'pending') {
          actionButtons = `
            <div class="notif-action-btns" style="display: flex; gap: 6px; margin-top: 6px;">
              <button type="button" class="btn-accept-reel-mention" data-reel-id="${notif.reelId}" data-notif-id="${notif._id || notif.id}" style="padding: 4px 12px; background: var(--primary, #a855f7); color: white; border: none; border-radius: 12px; font-size: 11.5px; font-weight: 600; cursor: pointer; transition: all 0.2s;">Accept</button>
              <button type="button" class="btn-reject-reel-mention" data-reel-id="${notif.reelId}" data-notif-id="${notif._id || notif.id}" style="padding: 4px 12px; background: rgba(255,255,255,0.1); color: var(--text-color, white); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; font-size: 11.5px; font-weight: 600; cursor: pointer; transition: all 0.2s;">Decline</button>
            </div>
          `;
        } else if (notif.mentionStatus === 'accepted') {
          messageText += ` <span style="font-size: 11px; color: #10b981; font-weight: 600;">(Accepted)</span>`;
        } else if (notif.mentionStatus === 'rejected') {
          messageText += ` <span style="font-size: 11px; color: #ef4444; font-weight: 600;">(Declined)</span>`;
        }
      }

      const timeAgo = formatTimeAgo(new Date(notif.createdAt || notif.created_at || Date.now()));

      item.innerHTML = `
        <img src="${senderAvatar}" class="notification-avatar" alt="${sender.username}"/>
        <div class="notification-content" style="flex: 1;">
          <p>${messageText}</p>
          <span class="notification-time">${timeAgo}</span>
          ${actionButtons}
        </div>
      `;

      item.addEventListener('click', async (e) => {
        if (e.target.closest('.btn-accept-request, .btn-reject-request, .btn-accept-reel-mention, .btn-reject-reel-mention')) return;
        e.stopPropagation();

        if (item.classList.contains('unread')) {
          item.classList.remove('unread');
          recalcNotificationBadges();

          const token = localStorage.getItem('invibe_jwt_token');
          if (token && notif._id) {
            try {
              await fetch(`${API_URL}/api/notifications/${notif._id}/read`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
              });
            } catch (err) {
              console.error('Error marking notification read:', err);
            }
          }
        }

        const navTargetId = getUserIdentifier(sender) || senderId;
        if (navTargetId && navTargetId !== 'usr_unknown') {
          closeNotificationsPanel();
          switchView('profile', navTargetId);
        }
      });

      // Attach accept / reject listeners
      const acceptBtn = item.querySelector('.btn-accept-request');
      const rejectBtn = item.querySelector('.btn-reject-request');
      const actionArea = item.querySelector('.notif-action-btns');

      if (acceptBtn) {
        acceptBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const targetId = acceptBtn.getAttribute('data-sender-id') || acceptBtn.getAttribute('data-notif-id');
          const token = localStorage.getItem('invibe_jwt_token');

          if (!targetId || targetId === 'usr_unknown') {
            showToast('Unable to identify requester.');
            return;
          }

          acceptBtn.disabled = true;
          if (rejectBtn) rejectBtn.disabled = true;
          acceptBtn.textContent = 'Accepting...';

          try {
            const res = await fetch(`${API_URL}/api/users/${targetId}/accept-follow-request`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (res.ok) {
              showToast(data.message || `Accepted Hubbies request from @${sender.username}! 🎉`);
              if (actionArea) {
                actionArea.innerHTML = '<span style="color: #22c55e; font-size: 11.5px; font-weight: 600;">✓ Accepted</span>';
              }
              // Update any Follow buttons in DOM for this user
              document.querySelectorAll(`[data-user-id="${targetId}"]`).forEach(btn => {
                btn.classList.add('followed');
                btn.classList.remove('requested');
                btn.textContent = 'Hubbies';
                btn.style.background = '#22c55e';
                btn.style.color = '#ffffff';
                btn.disabled = false;
              });

              if (typeof loadProfileStats === 'function') loadProfileStats();
              if (typeof loadFollowSuggestions === 'function') loadFollowSuggestions();
              if (suggestedVibersModal && suggestedVibersModal.classList.contains('active')) {
                openSuggestedVibersModal();
              }
            } else {
              showToast(data.error || 'Failed to accept request.');
              acceptBtn.disabled = false;
              if (rejectBtn) rejectBtn.disabled = false;
              acceptBtn.textContent = 'Accept';
            }
          } catch (err) {
            console.error("Accept error:", err);
            showToast('Network error accepting request.');
            acceptBtn.disabled = false;
            if (rejectBtn) rejectBtn.disabled = false;
            acceptBtn.textContent = 'Accept';
          }
        });
      }

      if (rejectBtn) {
        rejectBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const targetId = rejectBtn.getAttribute('data-sender-id') || rejectBtn.getAttribute('data-notif-id');
          const token = localStorage.getItem('invibe_jwt_token');

          if (!targetId || targetId === 'usr_unknown') {
            showToast('Unable to identify requester.');
            return;
          }

          if (acceptBtn) acceptBtn.disabled = true;
          rejectBtn.disabled = true;
          rejectBtn.textContent = 'Declining...';

          try {
            const res = await fetch(`${API_URL}/api/users/${targetId}/reject-follow-request`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (res.ok) {
              showToast(data.message || `Declined request from @${sender.username}`);
              if (actionArea) {
                actionArea.innerHTML = '<span style="color: var(--text-muted); font-size: 11.5px;">Declined</span>';
              }
              // Reset any Follow buttons in DOM for this user
              document.querySelectorAll(`[data-user-id="${targetId}"]`).forEach(btn => {
                btn.classList.remove('followed', 'requested');
                btn.textContent = 'Follow';
                btn.style.background = 'var(--primary, #a855f7)';
                btn.style.color = '#ffffff';
                btn.disabled = false;
              });

              if (typeof loadProfileStats === 'function') loadProfileStats();
              if (typeof loadFollowSuggestions === 'function') loadFollowSuggestions();
            } else {
              showToast(data.error || 'Failed to decline request.');
              if (acceptBtn) acceptBtn.disabled = false;
              rejectBtn.disabled = false;
              rejectBtn.textContent = 'Decline';
            }
          } catch (err) {
            console.error("Decline error:", err);
            showToast('Network error declining request.');
            if (acceptBtn) acceptBtn.disabled = false;
            rejectBtn.disabled = false;
            rejectBtn.textContent = 'Decline';
          }
        });
      }

      // Attach reel mention accept / reject listeners
      const acceptReelBtn = item.querySelector('.btn-accept-reel-mention');
      const rejectReelBtn = item.querySelector('.btn-reject-reel-mention');

      if (acceptReelBtn) {
        acceptReelBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const reelId = acceptReelBtn.getAttribute('data-reel-id');
          const notifId = acceptReelBtn.getAttribute('data-notif-id');
          const token = localStorage.getItem('invibe_jwt_token');

          acceptReelBtn.disabled = true;
          if (rejectReelBtn) rejectReelBtn.disabled = true;
          acceptReelBtn.textContent = 'Accepting...';

          try {
            const res = await fetch(`${API_URL}/api/reels/mentions/accept`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({ reelId, notificationId: notifId })
            });

            if (res.ok) {
              showToast('Tagged Reel accepted successfully! 🎉');
              if (actionArea) {
                actionArea.innerHTML = '<span style="color: #22c55e; font-size: 11.5px; font-weight: 600;">✓ Tagged Accepted</span>';
              }
              const activeProfileTab = document.querySelector('.profile-content-tab.active');
              if (activeProfileTab && activeProfileTab.getAttribute('data-profile-tab') === 'tagged') {
                const currentProfileId = document.getElementById('user-profile-view')?.getAttribute('data-user-id') || 'me';
                loadUserProfile(currentProfileId);
              }
            } else {
              showToast('Failed to accept tagged Reel.');
              acceptReelBtn.disabled = false;
              if (rejectReelBtn) rejectReelBtn.disabled = false;
              acceptReelBtn.textContent = 'Accept';
            }
          } catch (err) {
            console.error("Accept reel mention error:", err);
            showToast('Network error.');
            acceptReelBtn.disabled = false;
            if (rejectReelBtn) rejectReelBtn.disabled = false;
            acceptReelBtn.textContent = 'Accept';
          }
        });
      }

      if (rejectReelBtn) {
        rejectReelBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const reelId = rejectReelBtn.getAttribute('data-reel-id');
          const notifId = rejectReelBtn.getAttribute('data-notif-id');
          const token = localStorage.getItem('invibe_jwt_token');

          if (acceptReelBtn) acceptReelBtn.disabled = true;
          rejectReelBtn.disabled = true;
          rejectReelBtn.textContent = 'Declining...';

          try {
            const res = await fetch(`${API_URL}/api/reels/mentions/reject`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({ reelId, notificationId: notifId })
            });

            if (res.ok) {
              showToast('Tagged Reel declined.');
              if (actionArea) {
                actionArea.innerHTML = '<span style="color: var(--text-muted); font-size: 11.5px;">Tagged Declined</span>';
              }
              const activeProfileTab = document.querySelector('.profile-content-tab.active');
              if (activeProfileTab && activeProfileTab.getAttribute('data-profile-tab') === 'tagged') {
                const currentProfileId = document.getElementById('user-profile-view')?.getAttribute('data-user-id') || 'me';
                loadUserProfile(currentProfileId);
              }
            } else {
              showToast('Failed to decline tagged Reel.');
              if (acceptReelBtn) acceptReelBtn.disabled = false;
              rejectReelBtn.disabled = false;
              rejectReelBtn.textContent = 'Decline';
            }
          } catch (err) {
            console.error("Decline reel mention error:", err);
            showToast('Network error.');
            if (acceptReelBtn) acceptReelBtn.disabled = false;
            rejectReelBtn.disabled = false;
            rejectReelBtn.textContent = 'Decline';
          }
        });
      }

      listContainer.appendChild(item);
    });

    debouncedCreateIcons();
  }

  // Setup click handler for toggle panel via header button
  if (notifBtn) {
    notifBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleNotificationsPanel();
    });
  }

  // Close button inside panel
  if (notifCloseBtn) {
    notifCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeNotificationsPanel();
    });
  }



  // Mobile navigation bubble redirection to toggle notifications panel
  const radialNotifBtn = document.getElementById('nav-notifications-btn');
  if (radialNotifBtn) {
    radialNotifBtn.addEventListener('click', (e) => {
      if (!navContainer || !navContainer.classList.contains('open')) {
        return;
      }
      e.stopPropagation();
      closeRadialMenu();
      toggleNotificationsPanel();
    });
  }

  // Manual mark all read button inside panel
  const markReadBtn = notifPanel ? notifPanel.querySelector('.mark-read-btn') : null;
  if (markReadBtn) {
    markReadBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const token = localStorage.getItem('invibe_jwt_token');
      if (!token) return;

      // Optimistically clear unread states and badges
      if (notifPanel) {
        notifPanel.querySelectorAll('.notification-item.unread').forEach(item => {
          item.classList.remove('unread');
        });
      }
      recalcNotificationBadges();

      try {
        await fetch(`${API_URL}/api/notifications/read`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        await loadNotifications();
      } catch (err) {
        console.error('Error marking read:', err);
      }
    });
  }

  // Click outside to close panel
  document.addEventListener('click', (e) => {
    if (isNotificationsPanelOpen()) {
      const isInsidePanel = notifPanel && notifPanel.contains(e.target);
      const isInsideNotifBtn = notifBtn && notifBtn.contains(e.target);
      const isInsideRadialBtn = e.target.closest('#nav-notifications-btn');
      if (!isInsidePanel && !isInsideNotifBtn && !isInsideRadialBtn) {
        closeNotificationsPanel();
      }
    }
  });

  // Escape key closes panel
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isNotificationsPanelOpen()) {
      closeNotificationsPanel();
    }
  });

  // Listen to auth load/changes
  window.addEventListener('auth-changed', () => {
    loadNotifications();
    setupNotificationsRealtime();
    // Only reset and re-initialize DM realtime when auth user changes
    const authUserId = (() => { try { const u = getCurrentUser(); return (u?.id || u?._id || '').toString(); } catch (_) { return ''; } })();
    if (!dmState._authUserId || dmState._authUserId !== authUserId) {
      dmState._authUserId = authUserId;
      // Reset loaded/loading state for new auth user
      dmState.messagesByConversation.clear();
      dmState.conversationIdByUser.clear();
      dmState.loadedConversations.clear();
      dmState.loadingConversations.clear();
      dmState.activeConversationId = null;
      loadChatThreads();
      setupDMRealtime();
      console.debug('[DM-RUNTIME] auth-changed: DM re-initialized for user:', authUserId);
    } else {
      // Same user – just refresh threads list
      loadChatThreads();
    }
    window.ensureIncomingCallListeners();
    loadProfileStats();
    loadFollowSuggestions();
  });

  // Initial load once
  loadNotifications();
  loadChatThreads();

  function setupVideoScrollObserver() {
    // 1. Post Media Video Observer (Isolated from Reels)
    const postObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const video = entry.target;
        if (entry.intersectionRatio < 0.5) {
          if (!video.paused) {
            video.pause();
            const container = video.closest('.post-media-container');
            if (container) {
              const overlay = container.querySelector('.video-play-overlay');
              if (overlay) {
                overlay.style.display = 'flex';
                overlay.style.opacity = '1';
                overlay.style.background = 'rgba(0,0,0,0.25)';
                const playIcon = overlay.querySelector('i');
                if (playIcon) {
                  playIcon.setAttribute('data-lucide', 'play');
                }
                debouncedCreateIcons();
              }
            }
          }
        }
      });
    }, { root: null, threshold: [0, 0.25, 0.5, 0.75, 1.0] });

    document.querySelectorAll('.post-media-video').forEach(video => {
      postObserver.observe(video);
    });

    // 2. Hubbing Reel Observer (Dedicated directly to Centralized Controller)
    const reelObserver = new IntersectionObserver((entries) => {
      if (window.hubbingPlaybackController) {
        window.hubbingPlaybackController.onVisibilityChange(entries);
      }
    }, { root: null, threshold: [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0] });

    document.querySelectorAll('.reel-video, .reel-card').forEach(el => {
      reelObserver.observe(el);
    });

    const mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const postVideos = node.querySelectorAll('.post-media-video');
            postVideos.forEach(video => postObserver.observe(video));
            if (node.classList.contains('post-media-video')) {
              postObserver.observe(node);
            }

            const reelElements = node.querySelectorAll('.reel-video, .reel-card');
            reelElements.forEach(el => reelObserver.observe(el));
            if (node.classList.contains('reel-video') || node.classList.contains('reel-card')) {
              reelObserver.observe(node);
            }
          }
        });
      });
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  function setupPostMusicScrollObserver() {
    const observerOptions = {
      root: null,
      threshold: 0.1
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const card = entry.target;
        if (entry.intersectionRatio < 0.1) {
          if (card._audio && !card._audio.paused) {
            card._audio.pause();
            const vinyl = card.querySelector('.music-vinyl-disc');
            if (vinyl) vinyl.style.animationPlayState = 'paused';
            const btn = card.querySelector('.post-music-speaker-btn');
            if (btn) {
              btn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/></svg>
              `;
            }
          }
        }
      });
    }, observerOptions);

    document.querySelectorAll('.feed-card').forEach(card => {
      observer.observe(card);
    });

    const mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList.contains('feed-card')) {
              observer.observe(node);
            }
            const cards = node.querySelectorAll('.feed-card');
            cards.forEach(card => observer.observe(card));
          }
        });
      });
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  // --- DOUBLE CLICK TO LIKE ---
  document.addEventListener('dblclick', async (e) => {
    // For Posts
    const postMediaContainer = e.target.closest('.post-media-container');
    if (postMediaContainer) {
      e.preventDefault();

      const rect = postMediaContainer.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      triggerHeartExplosion(clickX, clickY, postMediaContainer);

      const likeBtnAction = postMediaContainer.closest('article, .feed-card')
        ? postMediaContainer.closest('article, .feed-card').querySelector('.like-btn-action')
        : postMediaContainer.querySelector('.like-btn-action') || postMediaContainer.parentNode.querySelector('.like-btn-action');

      if (likeBtnAction && !likeBtnAction.classList.contains('liked')) {
        const postId = likeBtnAction.getAttribute('data-post-id');
        if (postId) {
          await togglePostLike(postId, likeBtnAction);
        }
      }
      return;
    }

    // For Reels (Hubbings)
    const reelCard = e.target.closest('.reel-card');
    if (reelCard) {
      e.preventDefault();

      const rect = reelCard.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      triggerHeartExplosion(clickX, clickY, reelCard);

      const likeBtnAction = reelCard.querySelector('.reel-like-action');
      const heartBtn = likeBtnAction ? likeBtnAction.querySelector('.heart-btn') : null;

      if (heartBtn && !heartBtn.classList.contains('liked')) {
        const reelId = likeBtnAction.getAttribute('data-reel-id');
        if (reelId) {
          await toggleReelLike(reelId, heartBtn);
        }
      }
      return;
    }
  });

  setupVideoScrollObserver();
  setupPostMusicScrollObserver();

  /* ========================================================= */
  /* DM ENHANCEMENTS LOGIC */
  /* ========================================================= */

  // --- AI Spelling Assistant ---
  const aiAssistantBtn = document.getElementById('chat-ai-assistant-btn');
  const aiPopover = document.getElementById('ai-spelling-popover');
  const aiContent = document.getElementById('ai-spelling-content');
  const aiAcceptBtn = document.getElementById('ai-spelling-accept-btn');
  const aiCancelBtn = document.getElementById('ai-spelling-cancel-btn');
  const aiActions = document.getElementById('ai-spelling-actions');

  let currentAiSuggestion = '';

  if (aiAssistantBtn) {
    aiAssistantBtn.addEventListener('click', () => {
      const text = messageInput.value.trim();
      if (!text) return;

      // Simple mock AI Spelling logic
      let suggestedText = text.replace(/\s{2,}/g, ' '); // remove double spaces
      // Mock correction example: capitalize first letter if not
      if (suggestedText.length > 0) {
        suggestedText = suggestedText.charAt(0).toUpperCase() + suggestedText.slice(1);
      }
      // Very basic spelling fix mock
      suggestedText = suggestedText.replace(/\bteh\b/g, 'the').replace(/\brecieve\b/g, 'receive');

      if (suggestedText === text) {
        aiContent.textContent = "No spelling corrections needed.";
        aiActions.style.display = 'none';
        currentAiSuggestion = '';
      } else {
        aiContent.textContent = suggestedText;
        aiActions.style.display = 'flex';
        currentAiSuggestion = suggestedText;
      }
      aiPopover.style.display = 'flex';
    });
  }
  if (aiAcceptBtn) {
    aiAcceptBtn.addEventListener('click', () => {
      if (currentAiSuggestion) {
        messageInput.value = currentAiSuggestion;
      }
      aiPopover.style.display = 'none';
    });
  }
  if (aiCancelBtn) {
    aiCancelBtn.addEventListener('click', () => {
      aiPopover.style.display = 'none';
    });
  }

  // --- Toast Notification ---
  function showDMToast(msg) {
    let toast = document.getElementById('dm-toast-notification');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'dm-toast-notification';
      toast.className = 'dm-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }

  // --- Reply & Action Menu ---
  const replyPreviewContainer = document.getElementById('chat-reply-preview-container');
  const replyPreviewSender = document.getElementById('reply-preview-sender');
  const replyPreviewText = document.getElementById('reply-preview-text');
  const replyPreviewCloseBtn = document.getElementById('reply-preview-close-btn');

  if (replyPreviewCloseBtn) {
    replyPreviewCloseBtn.addEventListener('click', () => {
      currentReplyToMessage = null;
      replyPreviewContainer.style.display = 'none';
    });
  }

  function activateReplyMode(msgId, rawText, senderName) {
    currentReplyToMessage = { id: msgId, text: rawText, senderName: senderName };
    replyPreviewSender.textContent = senderName;
    replyPreviewText.textContent = rawText;
    replyPreviewContainer.style.display = 'flex';
    messageInput.focus();
  }

  if (messagesScroll) {
    messagesScroll.addEventListener('dblclick', (e) => {
      const bubble = e.target.closest('.chat-bubble');
      if (bubble) {
        const msgId = bubble.getAttribute('data-msg-id');
        const rawText = bubble.getAttribute('data-raw-text') || 'Message';
        const senderName = bubble.getAttribute('data-sender-name') || 'User';
        activateReplyMode(msgId, rawText, senderName);
      }
    });

    messagesScroll.addEventListener('click', (e) => {
      const actionTrigger = e.target.closest('.message-action-trigger');
      if (actionTrigger) {
        const dropdown = actionTrigger.nextElementSibling;
        if (dropdown && dropdown.classList.contains('message-action-dropdown')) {
          dropdown.style.display = dropdown.style.display === 'flex' ? 'none' : 'flex';

          // Close others
          document.querySelectorAll('.message-action-dropdown').forEach(d => {
            if (d !== dropdown) d.style.display = 'none';
          });
        }
        return;
      }

      const replyBtn = e.target.closest('.action-reply');
      if (replyBtn) {
        if (window.innerWidth <= 768) {
          e.preventDefault();
          e.stopPropagation();
        }
        const wrapper = replyBtn.closest('.message-bubble-wrapper');
        const bubble = wrapper.querySelector('.chat-bubble');
        if (bubble) {
          const msgId = bubble.getAttribute('data-msg-id');
          let rawText = bubble.getAttribute('data-raw-text') || 'Message';
          
          let decodedText = rawText.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
          if (!decodedText || decodedText === '[Decryption Failed]') {
             if (bubble.querySelector('.chat-shared-file-title')) decodedText = bubble.querySelector('.chat-shared-file-title').innerText;
             else if (bubble.querySelector('img')) decodedText = 'Photo';
             else if (bubble.querySelector('video')) decodedText = 'Video';
             else if (bubble.querySelector('audio')) decodedText = 'Audio Message';
             else decodedText = 'Media Message';
          }

          const senderName = bubble.getAttribute('data-sender-name') || 'User';
          activateReplyMode(msgId, decodedText, senderName);
        }
        replyBtn.closest('.message-action-dropdown').style.display = 'none';
        return;
      }

      const copyBtn = e.target.closest('.action-copy');
      if (copyBtn) {
        if (window.innerWidth <= 768) {
          e.preventDefault();
          e.stopPropagation();
        }
        const wrapper = copyBtn.closest('.message-bubble-wrapper');
        const bubble = wrapper.querySelector('.chat-bubble');
        if (bubble) {
          let rawText = bubble.getAttribute('data-raw-text') || '';
          let textToCopy = rawText.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
          if (!textToCopy || textToCopy === '[Decryption Failed]') {
             const fileA = bubble.querySelector('a[download]');
             if (fileA) textToCopy = fileA.href;
             else {
               const img = bubble.querySelector('img');
               if (img) textToCopy = img.src;
               else {
                 const vid = bubble.querySelector('video');
                 if (vid) textToCopy = vid.src;
               }
             }
          }
          
          if (!textToCopy) textToCopy = 'Message content';

          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(textToCopy).then(() => {
              if (typeof showDMToast === 'function') showDMToast('Message copied');
            }).catch(() => {
              fallbackCopy(textToCopy);
            });
          } else {
             fallbackCopy(textToCopy);
          }
          
          function fallbackCopy(text) {
            try {
              const textArea = document.createElement("textarea");
              textArea.value = text;
              textArea.style.position = "fixed";
              document.body.appendChild(textArea);
              textArea.focus();
              textArea.select();
              document.execCommand('copy');
              document.body.removeChild(textArea);
              if (typeof showDMToast === 'function') showDMToast('Message copied');
            } catch (err) {
              if (typeof showDMToast === 'function') showDMToast('Copy failed');
            }
          }
        }
        copyBtn.closest('.message-action-dropdown').style.display = 'none';
        return;
      }

      const forwardBtn = e.target.closest('.action-forward');
      if (forwardBtn) {
        if (window.innerWidth <= 768) {
          e.preventDefault();
          e.stopPropagation();
        }
        const wrapper = forwardBtn.closest('.message-bubble-wrapper');
        const bubble = wrapper.querySelector('.chat-bubble');
        if (bubble) {
          const msgId = bubble.getAttribute('data-msg-id');
          const shareModalEl = document.getElementById('share-modal');
          if (shareModalEl && typeof openShare === 'function') {
             openShare('forward_' + msgId, shareModalEl);
             shareModalEl.classList.add('active');
          }
        }
        forwardBtn.closest('.message-action-dropdown').style.display = 'none';
        return;
      }

      const deleteBtn = e.target.closest('.action-delete');
      if (deleteBtn) {
        if (window.innerWidth <= 768) {
          e.preventDefault();
          e.stopPropagation();
        }
        const wrapper = deleteBtn.closest('.message-bubble-wrapper');
        const bubble = wrapper.querySelector('.chat-bubble');
        if (bubble) {
          openDeleteModal(bubble.getAttribute('data-msg-id'), wrapper);
        }
        deleteBtn.closest('.message-action-dropdown').style.display = 'none';
        return;
      }

      // Close dropdowns when clicking elsewhere
      document.querySelectorAll('.message-action-dropdown').forEach(d => {
        d.style.display = 'none';
      });

      // Scroll to replied message if preview box clicked
      const repliedBox = e.target.closest('.replied-message-box');
      if (repliedBox) {
        const replyId = repliedBox.getAttribute('data-reply-id');
        if (replyId) {
          const targetBubble = messagesScroll.querySelector(`.chat-bubble[data-msg-id="${replyId}"]`);
          if (targetBubble) {
            targetBubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetBubble.style.transition = 'background-color 0.5s';
            const originalBg = targetBubble.style.backgroundColor;
            targetBubble.style.backgroundColor = 'rgba(108, 59, 255, 0.3)';
            setTimeout(() => {
              targetBubble.style.backgroundColor = originalBg;
            }, 1000);
          }
        }
      }
    });
  }

  // --- Forward Modal ---
  const forwardModal = document.getElementById('forward-message-modal');
  const forwardCloseBtn = document.getElementById('forward-close-btn');
  const forwardCancelBtn = document.getElementById('forward-cancel-btn');
  const forwardSendBtn = document.getElementById('forward-send-btn');
  const forwardSearchInput = document.getElementById('forward-search-input');
  const forwardContactsList = document.getElementById('forward-contacts-list');
  let currentForwardMsgText = '';
  let selectedForwardRecipients = [];

  function openForwardModal(msgId, rawText) {
    currentForwardMsgText = rawText;
    selectedForwardRecipients = [];
    forwardSearchInput.value = '';
    forwardSendBtn.disabled = true;
    forwardModal.classList.add('active');
    populateForwardContacts();
  }

  function populateForwardContacts(query = '') {
    if (!forwardContactsList) return;
    forwardContactsList.innerHTML = '';

    // Filter chatThreads based on query
    const filtered = chatThreads.filter(t => t.user && (t.user.fullname || t.user.username).toLowerCase().includes(query.toLowerCase()));

    if (filtered.length === 0) {
      forwardContactsList.innerHTML = '<div style="color:var(--text-muted); font-size:0.9rem; text-align:center; padding:10px;">No contacts found</div>';
      return;
    }

    filtered.forEach(t => {
      const u = t.user;
      const el = document.createElement('div');
      el.className = 'forward-contact-item';
      if (selectedForwardRecipients.includes(u._id)) {
        el.classList.add('selected');
      }
      const avatarSrc = u.profilePic ? (u.profilePic.startsWith('http') ? u.profilePic : `${API_URL}${u.profilePic}`) : 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

      el.innerHTML = `
        <img src="${avatarSrc}" class="forward-contact-avatar" />
        <span class="forward-contact-name">${u.fullname || u.username}</span>
        <i data-lucide="check" class="forward-contact-check"></i>
      `;

      el.addEventListener('click', () => {
        if (selectedForwardRecipients.includes(u._id)) {
          selectedForwardRecipients = selectedForwardRecipients.filter(id => id !== u._id);
          el.classList.remove('selected');
        } else {
          selectedForwardRecipients.push(u._id);
          el.classList.add('selected');
        }
        forwardSendBtn.disabled = selectedForwardRecipients.length === 0;
      });

      forwardContactsList.appendChild(el);
    });

    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  if (forwardSearchInput) {
    forwardSearchInput.addEventListener('input', (e) => {
      populateForwardContacts(e.target.value.trim());
    });
  }

  if (forwardCloseBtn) forwardCloseBtn.addEventListener('click', () => forwardModal.classList.remove('active'));
  if (forwardCancelBtn) forwardCancelBtn.addEventListener('click', () => forwardModal.classList.remove('active'));
  if (forwardSendBtn) {
    forwardSendBtn.addEventListener('click', async () => {
      forwardSendBtn.disabled = true;
      forwardSendBtn.textContent = 'Forwarding...';

      const currentUser = getCurrentUser();
      const token = localStorage.getItem('invibe_jwt_token');
      if (!currentUser || !token) return;

      try {
        for (const recipientId of selectedForwardRecipients) {
          const secretKey = getChatSecretKey(currentUser.id || currentUser._id, recipientId);
          const encryptedText = encryptMessage(currentForwardMsgText, secretKey);

          await fetch(`${API_URL}/api/chats/message`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              recipient: recipientId,
              content: encryptedText
            })
          });
        }
        showDMToast('Message forwarded successfully');
      } catch (err) {
        console.error('Error forwarding message:', err);
        showDMToast('Failed to forward message');
      }

      forwardModal.classList.remove('active');
      forwardSendBtn.textContent = 'Forward';
      loadChatThreads();
    });
  }

  // --- Delete Modal Logic ---
  const deleteModal = document.getElementById('delete-message-modal');
  const deleteCloseBtn = document.getElementById('delete-close-btn');
  const deleteCancelBtn = document.getElementById('delete-cancel-btn');
  const deleteConfirmBtn = document.getElementById('delete-confirm-btn');

  let msgToDeleteId = null;
  let msgToDeleteWrapper = null;

  function openDeleteModal(msgId, wrapperElement) {
    msgToDeleteId = msgId;
    msgToDeleteWrapper = wrapperElement;
    deleteConfirmBtn.disabled = false;
    deleteConfirmBtn.textContent = 'Delete';
    deleteModal.classList.add('active');
  }

  function closeDeleteModal() {
    deleteModal.classList.remove('active');
    msgToDeleteId = null;
    msgToDeleteWrapper = null;
  }

  if (deleteCloseBtn) deleteCloseBtn.addEventListener('click', closeDeleteModal);
  if (deleteCancelBtn) deleteCancelBtn.addEventListener('click', closeDeleteModal);
  if (deleteConfirmBtn) {
    deleteConfirmBtn.addEventListener('click', async () => {
      if (!msgToDeleteId) return;

      deleteConfirmBtn.disabled = true;
      deleteConfirmBtn.textContent = 'Deleting...';

      const token = localStorage.getItem('invibe_jwt_token');
      if (!token) return closeDeleteModal();

      try {
        const res = await fetch(`${API_URL}/api/chats/messages/${msgToDeleteId}?forEveryone=true`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (res.ok) {
          // Remove from UI
          if (msgToDeleteWrapper) {
            msgToDeleteWrapper.remove();
          }

          // Update chatFeeds state silently
          if (state.currentChatThread && chatFeeds[state.currentChatThread]) {
            chatFeeds[state.currentChatThread] = chatFeeds[state.currentChatThread].filter(m => {
              return (m._id || m.id) !== msgToDeleteId;
            });
          }

          showDMToast('Message deleted');

          // Refresh thread list to update preview (if it was the last message)
          loadChatThreads();
        } else {
          let errData;
          try {
            errData = await res.json();
          } catch (e) {
            errData = await res.text();
          }
          const currentUser = getCurrentUser() || {};
          console.error("Supabase Error Details:", {
            error: errData,
            table: 'messages',
            message_id: msgToDeleteId,
            authenticated_user_id: currentUser.id || currentUser._id,
            response: res.status
          });
          throw new Error((errData && errData.error) || 'Failed to delete message');
        }
      } catch (err) {
        console.error('Error deleting message:', err);
        showDMToast('Failed to delete message');
      }

      closeDeleteModal();
    });
  }

});


// ==========================================
// BEFORE / AFTER SLIDER LOGIC
// ==========================================
function initBeforeAfterSlider() {
  const container = document.getElementById('ba-slider-container');
  const imageBefore = document.getElementById('ba-image-before');
  const handle = document.getElementById('ba-slider-handle');

  if (container && imageBefore && handle) {
    let isDragging = false;

    const updateSlider = (x) => {
      const rect = container.getBoundingClientRect();
      let position = x - rect.left;

      // Keep within bounds
      position = Math.max(0, Math.min(position, rect.width));

      // Calculate percentage
      const percentage = (position / rect.width) * 100;

      // Update DOM
      imageBefore.style.clipPath = `inset(0 ${100 - percentage}% 0 0)`;
      handle.style.left = `${percentage}%`;
    };

    // Mouse events
    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      e.preventDefault(); // Prevent text selection
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      updateSlider(e.clientX);
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });

    // Touch events for mobile
    handle.addEventListener('touchstart', (e) => {
      isDragging = true;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      updateSlider(e.touches[0].clientX);
    }, { passive: true });

    document.addEventListener('touchend', () => {
      isDragging = false;
    });

    // Initial setup (50%)
    imageBefore.style.clipPath = `inset(0 50% 0 0)`;
    handle.style.left = `50%`;
  }
}

window.initBeforeAfterSlider = initBeforeAfterSlider;
document.addEventListener('DOMContentLoaded', initBeforeAfterSlider);
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  initBeforeAfterSlider();
}

// =========================================================================
// CREATE HUBBS - NATIVE FILE UPLOAD & PREVIEW SYSTEM
// =========================================================================
function initCreateHubbsUpload() {
  const uploadBox = document.getElementById('ch-upload-box');
  const fileInput = document.getElementById('ch-hidden-file-input');
  const cameraBtn = document.getElementById('ch-camera-btn');
  const addMediaBtn = document.getElementById('ch-add-media-btn');
  const previewContainer = document.getElementById('ch-media-preview-container');
  const previewRow = document.getElementById('ch-media-preview-row');
  const addMoreBtn = document.getElementById('ch-add-more-media-btn');

  if (!uploadBox || !fileInput) return;

  window.chUploads = window.chUploads || [];

  // Expose file handler immediately
  window.handleCreateHubbsFiles = handleFiles;

  if (uploadBox.dataset.chUploadInitialized === 'true') {
    if (typeof window.renderMediaPreviews === 'function') {
      window.renderMediaPreviews();
    }
    return;
  }
  uploadBox.dataset.chUploadInitialized = 'true';

  // Triggers
  if (cameraBtn) {
    cameraBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof window.openCameraCapture === 'function') {
        window.openCameraCapture('hubbs');
      } else if (typeof openCameraCapture === 'function') {
        openCameraCapture('hubbs');
      }
    });
  }

  if (addMediaBtn) {
    addMediaBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.removeAttribute('capture');
      fileInput.click();
    });
  }

  uploadBox.addEventListener('click', () => {
    fileInput.removeAttribute('capture');
    fileInput.click();
  });

  if (addMoreBtn) {
    addMoreBtn.addEventListener('click', () => {
      fileInput.removeAttribute('capture');
      fileInput.click();
    });
  }

  // Drag and Drop
  uploadBox.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadBox.style.borderColor = 'var(--primary, #a855f7)';
    uploadBox.style.background = 'rgba(168, 85, 247, 0.1)';
  });

  uploadBox.addEventListener('dragleave', (e) => {
    e.preventDefault();
    uploadBox.style.borderColor = '';
    uploadBox.style.background = '';
  });

  uploadBox.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadBox.style.borderColor = '';
    uploadBox.style.background = '';
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files));
    }
    fileInput.value = ''; // Reset input to allow selecting same files again if removed
  });

  async function handleFiles(files) {
    window.handleCreateHubbsFiles = handleFiles;
    const maxSize = 100 * 1024 * 1024; // 100MB
    const toast = document.getElementById('toast-notif');

    function showMsg(msg) {
      if (window.showToast) {
        window.showToast(msg);
      } else if (toast) {
        toast.textContent = msg;
        toast.classList.add('active');
        setTimeout(() => toast.classList.remove('active'), 2500);
      } else {
        alert(msg);
      }
    }

    // Optional: show loading indicator
    uploadBox.style.opacity = '0.5';

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Validate Size
      if (file.size > maxSize) {
        showMsg("This file exceeds the maximum upload size of 100 MB.");
        continue;
      }

      // Validate Type
      if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
        showMsg("This file type is not supported.");
        continue;
      }

      // Generate Thumbnail
      let thumbUrl = '';
      let duration = 0;
      let originalWidth = 1000;
      let originalHeight = 1000;

      try {
        if (file.type.startsWith('video/')) {
          const vData = await generateVideoThumbnail(file);
          thumbUrl = vData.thumb;
          duration = vData.duration;
          originalWidth = vData.width;
          originalHeight = vData.height;
        } else {
          thumbUrl = URL.createObjectURL(file);
          const img = new Image();
          img.src = thumbUrl;
          await new Promise(r => { img.onload = r; img.onerror = r; });
          if (img.naturalWidth) {
            originalWidth = img.naturalWidth;
            originalHeight = img.naturalHeight;
          }
        }

        window.chUploads.push({
          file: file,
          type: file.type,
          thumbUrl: thumbUrl,
          duration: duration,
          originalWidth: originalWidth,
          originalHeight: originalHeight,
          name: file.name,
          size: file.size,
          editorState: {
            filter: 'original', rotation: 0, zoom: 1, panX: 0, panY: 0,
            adjustments: { brightness: 100, contrast: 100, exposure: 100, highlights: 100, shadows: 100, temperature: 0, tint: 0, saturation: 100, vibrance: 100, sharpness: 0, blur: 0, opacity: 100 },
            crop: null, layers: [], isMuted: false, musicTrack: null, selectedLocation: null
          }
        });
      } catch (err) {
        console.error("Error generating thumbnail:", err);
        showMsg("Unable to load media. Please try again.");
      }
    }

    uploadBox.style.opacity = '1';
    renderMediaPreviews();
    if (window.HubbleEditor && typeof window.HubbleEditor.updateRender === 'function') {
      window.HubbleEditor.updateRender();
    }
  }

  function generateVideoThumbnail(file) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      const url = URL.createObjectURL(file);
      video.src = url;

      video.onloadedmetadata = () => {
        // Seek to 0.1s to grab a frame, ensuring it's loaded
        video.currentTime = Math.min(0.1, video.duration > 0 ? video.duration / 2 : 0);
      };

      video.onseeked = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth || 320;
          canvas.height = video.videoHeight || 240;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          URL.revokeObjectURL(url);
          resolve({ thumb: dataUrl, duration: video.duration, width: video.videoWidth || 320, height: video.videoHeight || 240 });
        } catch (e) {
          reject(e);
        }
      };

      video.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Video load error"));
      };
    });
  }

  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  window.getEffectiveLayout = function (layoutName, uploads) {
    if (layoutName !== 'auto') return layoutName;
    if (!uploads || uploads.length === 0) return layoutName;
    const count = uploads.length;
    let portraits = 0, landscapes = 0, squares = 0;
    uploads.forEach(item => {
      const ar = (window.HubbleEditor && window.HubbleEditor.getEditedAspectRatio) ? window.HubbleEditor.getEditedAspectRatio(item) : 1;
      if (ar < 0.9) portraits++;
      else if (ar > 1.1) landscapes++;
      else squares++;
    });
    if (count === 1) return 'single';
    if (count === 2) {
      if (portraits >= 1 && landscapes === 0 && squares === 0) return 'vertical-split';
      if (portraits === 2) return 'vertical-split';
      return 'side-by-side';
    }
    return '2x2-grid';
  };

  function renderMediaPreviews() {
    // Remove existing previews and layout rows except the Add More button
    const existingItems = previewRow.querySelectorAll('.ch-layout-row, .ch-preview-item');
    existingItems.forEach(el => {
      // Ensure we don't accidentally remove the addMoreBtn if it somehow matches
      if (el.id !== 'ch-add-more-media-btn') {
        el.remove();
      }
    });

    if (window.chUploads.length === 0) {
      uploadBox.style.display = 'block';
      previewContainer.style.display = 'none';
      return;
    }

    uploadBox.style.display = 'none';
    previewContainer.style.display = 'block';

    const previewBlocks = [];

    window.chUploads.forEach((item, index) => {
      const previewEl = document.createElement('div');
      previewEl.className = 'ch-preview-item';
      previewEl.draggable = true;
      previewEl.setAttribute('data-index', index);
      // Inline styles to match original structure
      previewEl.style.cssText = 'position: relative; flex-shrink: 0; width: 100px; height: 100px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.08); transition: transform 0.2s, box-shadow 0.2s; cursor: grab; background: #1a1a1a;';

      const img = document.createElement('img');
      img.src = item.thumbUrl;
      img.style.cssText = 'width: 100%; height: 100%; object-fit: contain; object-position: center; border-radius: 10px; pointer-events: none;';
      previewEl.appendChild(img);

      if (item.type.startsWith('video/')) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: absolute; bottom: 6px; right: 6px; background: rgba(0,0,0,0.75); color: white; padding: 2px 6px; border-radius: 6px; font-size: 0.7rem; font-weight: 600; display: flex; align-items: center; gap: 4px; backdrop-filter: blur(4px); pointer-events: none;';
        overlay.innerHTML = `<i data-lucide="video" style="width: 10px; height: 10px;"></i> ${formatDuration(item.duration)}`;
        previewEl.appendChild(overlay);
      }

      const rmBtn = document.createElement('button');
      rmBtn.className = 'ch-remove-media';
      rmBtn.style.cssText = 'position: absolute; top: -6px; right: -6px; width: 22px; height: 22px; border-radius: 50%; background: #ff3b30; color: white; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.4); z-index: 10; padding: 0; transition: transform 0.2s;';
      rmBtn.innerHTML = '<i data-lucide="x" style="width: 12px; height: 12px;"></i>';
      rmBtn.onmouseover = () => { rmBtn.style.transform = 'scale(1.1)'; };
      rmBtn.onmouseout = () => { rmBtn.style.transform = 'scale(1)'; };
      rmBtn.onclick = (e) => {
        e.stopPropagation();
        previewEl.classList.add('exiting'); // Apply animation
        setTimeout(() => {
          window.chUploads.splice(index, 1);
          if (item.type.startsWith('image/')) {
            URL.revokeObjectURL(item.thumbUrl);
          }
          if (window.HubbleEditor && window.HubbleEditor.cleanupMedia) {
            window.HubbleEditor.cleanupMedia();
          }

          if (window.HubbleEditor) {
            if (window.chUploads.length === 0) {
              window.HubbleEditor.activeMediaIndex = 0;
              window.HubbleEditor.state = {
                filter: 'original', rotation: 0, zoom: 1, panX: 0, panY: 0,
                adjustments: { brightness: 100, contrast: 100, exposure: 100, highlights: 100, shadows: 100, temperature: 0, tint: 0, saturation: 100, vibrance: 100, sharpness: 0, blur: 0, opacity: 100 },
                crop: null, layers: [], isMuted: false, musicTrack: null, selectedLocation: null
              };
              window.HubbleEditor.history = [JSON.parse(JSON.stringify(window.HubbleEditor.state))];
              window.HubbleEditor.redoStack = [];
              window.HubbleEditor.activeSelectedLayerId = null;
              window.HubbleEditor.updateRender();
            } else {
              if (window.HubbleEditor.activeMediaIndex === index) {
                window.HubbleEditor.activeMediaIndex = 0;
                if (window.chUploads[0].editorState) {
                  window.HubbleEditor.state = JSON.parse(JSON.stringify(window.chUploads[0].editorState));
                }
                window.HubbleEditor.updateRender();
              } else if (window.HubbleEditor.activeMediaIndex > index) {
                window.HubbleEditor.activeMediaIndex--;
              }
            }
          }

          renderMediaPreviews();
        }, 350); // wait for animation to complete
      };
      previewEl.appendChild(rmBtn);

      // Drag and Drop Reordering Support
      previewEl.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', index);
        previewEl.style.opacity = '0.5';
      });
      previewEl.addEventListener('dragend', () => {
        previewEl.style.opacity = '1';
        previewRow.querySelectorAll('.ch-preview-item').forEach(el => el.style.border = '1px solid rgba(255,255,255,0.08)');
      });
      previewEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        previewEl.style.border = '2px solid var(--primary, #a855f7)';
      });
      previewEl.addEventListener('dragleave', () => {
        previewEl.style.border = '1px solid rgba(255,255,255,0.08)';
      });
      previewEl.addEventListener('drop', (e) => {
        e.preventDefault();
        const draggedIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (!isNaN(draggedIndex) && draggedIndex !== index) {
          // Swap logic
          const draggedItem = window.chUploads.splice(draggedIndex, 1)[0];
          window.chUploads.splice(index, 0, draggedItem);
          renderMediaPreviews();
        }
      });

      // Click to select and edit this specific media item
      previewEl.addEventListener('click', () => {
        if (window.HubbleEditor) {
          // Save current state to the previously active media
          if (window.chUploads[window.HubbleEditor.activeMediaIndex]) {
            window.chUploads[window.HubbleEditor.activeMediaIndex].editorState = JSON.parse(JSON.stringify(window.HubbleEditor.state));
          }
          // Switch active media index
          window.HubbleEditor.activeMediaIndex = index;
          // Load the state for the new media, or reset if none exists
          if (item.editorState) {
            window.HubbleEditor.state = JSON.parse(JSON.stringify(item.editorState));
          } else {
            window.HubbleEditor.state = {
              filter: 'original', rotation: 0, zoom: 1, panX: 0, panY: 0,
              adjustments: { brightness: 100, contrast: 100, exposure: 100, highlights: 100, shadows: 100, temperature: 0, tint: 0, saturation: 100, vibrance: 100, sharpness: 0, blur: 0, opacity: 100 },
              crop: null, layers: [], isMuted: false, musicTrack: null, selectedLocation: null
            };
          }
          window.HubbleEditor.updateRender();
        }

        // Highlight active preview visually
        document.querySelectorAll('.ch-preview-item').forEach(el => el.style.border = '1px solid rgba(255,255,255,0.08)');
        previewEl.style.border = '2px solid var(--primary, #a855f7)';

        if (window.showToast) window.showToast(`Editing ${item.name} 🔍`);
      });

      // Update this thumbnail to reflect any existing edits visually BEFORE grouping
      if (window.HubbleEditor && typeof window.HubbleEditor.updatePreviewThumbnail === 'function') {
        window.HubbleEditor.updatePreviewThumbnail(index, previewEl);
      }

      previewBlocks.push({ mediaItem: item, el: previewEl });
    });

    // Grouping Logic
    let layout = (window.HubbleEditor && window.HubbleEditor.activeLayout) || 'original';
    let effectiveLayout = window.getEffectiveLayout(layout, window.chUploads);

    previewBlocks.forEach(b => previewRow.insertBefore(b.el, addMoreBtn));
    // Ensure the currently active media item is highlighted
    const activeIndex = window.HubbleEditor ? window.HubbleEditor.activeMediaIndex : 0;
    const activeEl = previewRow.querySelector(`.ch-preview-item[data-index="${activeIndex}"]`);
    if (activeEl) {
      activeEl.style.border = '2px solid var(--primary, #a855f7)';
    }

    if (window.lucide) {
      window.lucide.createIcons();
    }

    // Toggle Media Layouts visibility
    const layoutsDisabledMsg = document.getElementById('ch-layouts-disabled-msg');
    const layoutsOptions = document.getElementById('ch-layouts-options');
    if (layoutsDisabledMsg && layoutsOptions) {
      if (window.chUploads.length >= 2) {
        layoutsDisabledMsg.style.display = 'none';
        layoutsOptions.style.display = 'flex';

        const btnSideBySide = document.querySelector('.ch-layout-btn[data-layout="side-by-side"]');
        const btnVerticalSplit = document.querySelector('.ch-layout-btn[data-layout="vertical-split"]');
        const btn2x2Grid = document.querySelector('.ch-layout-btn[data-layout="2x2-grid"]');

        if (window.chUploads.length === 2) {
          if (btnSideBySide) btnSideBySide.style.display = 'block';
          if (btnVerticalSplit) btnVerticalSplit.style.display = 'block';
          if (btn2x2Grid) btn2x2Grid.style.display = 'none';

          if (window.HubbleEditor && window.HubbleEditor.activeLayout === '2x2-grid') {
            window.HubbleEditor.setLayout('auto');
          }
        } else {
          if (btnSideBySide) btnSideBySide.style.display = 'none';
          if (btnVerticalSplit) btnVerticalSplit.style.display = 'none';
          if (btn2x2Grid) btn2x2Grid.style.display = 'block';

          if (window.HubbleEditor && (window.HubbleEditor.activeLayout === 'side-by-side' || window.HubbleEditor.activeLayout === 'vertical-split')) {
            window.HubbleEditor.setLayout('auto');
          }
        }
      } else {
        layoutsDisabledMsg.style.display = 'block';
        layoutsOptions.style.display = 'none';
        // Reset to original layout internally
        if (window.HubbleEditor) window.HubbleEditor.setLayout('original');
      }
    }
  }

  window.renderMediaPreviews = renderMediaPreviews;

  // Initial check
  renderMediaPreviews();
}

document.addEventListener('DOMContentLoaded', initCreateHubbsUpload);
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  initCreateHubbsUpload();
}
// =========================================================================
// REVIEW HUBBS - NAVIGATION & VALIDATION
// =========================================================================
window.toggleScheduling = function (checked) {
  const row = document.getElementById('ch-schedule-datetime-row');
  const dateInput = document.getElementById('ch-schedule-date');
  const timeInput = document.getElementById('ch-schedule-time');
  const schedTrack = document.getElementById('ch-schedule-toggle-track');
  const schedKnob = document.getElementById('ch-schedule-toggle-knob');
  const schedStatus = document.getElementById('ch-schedule-status-text');

  if (schedTrack && schedKnob && schedStatus) {
    if (checked) {
      schedTrack.style.backgroundColor = 'var(--primary)';
      schedTrack.style.boxShadow = '0 0 8px rgba(108, 59, 255, 0.5)';
      schedKnob.style.transform = 'translateX(20px)';
      schedStatus.innerText = 'Enabled';
      schedStatus.classList.add('enabled');
    } else {
      schedTrack.style.backgroundColor = '';
      schedTrack.style.boxShadow = 'none';
      schedKnob.style.transform = 'translateX(0)';
      schedStatus.innerText = 'Disabled';
      schedStatus.classList.remove('enabled');
    }
  }

  if (checked) {
    row.style.display = 'flex';
    // Small delay to allow display:flex to apply before setting opacity for transition
    setTimeout(() => {
      row.style.opacity = '1';
    }, 10);

    // Set default date/time to now + 1 hour if empty
    if (!dateInput.value || !timeInput.value) {
      const now = new Date();
      now.setHours(now.getHours() + 1);

      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      dateInput.value = `${yyyy}-${mm}-${dd}`;

      const hh = String(now.getHours()).padStart(2, '0');
      const min = String(now.getMinutes()).padStart(2, '0');
      timeInput.value = `${hh}:${min}`;
    }
  } else {
    row.style.opacity = '0';
    setTimeout(() => {
      row.style.display = 'none';
    }, 300);
  }
};

window.handleReviewNavigation = function () {
  if (!window.chUploads || window.chUploads.length === 0) {
    showValidationModal();
    return;
  }

  // Validate scheduling if enabled
  const toggle = document.getElementById('ch-schedule-toggle');
  let scheduledAtIso = null;

  if (toggle && toggle.checked) {
    const dateVal = document.getElementById('ch-schedule-date').value;
    const timeVal = document.getElementById('ch-schedule-time').value;

    if (!dateVal || !timeVal) {
      if (window.showToast) window.showToast('Please select a valid date and time for scheduling.', 'error');
      return;
    }

    const scheduledTime = new Date(`${dateVal}T${timeVal}`);
    if (isNaN(scheduledTime.getTime())) {
      if (window.showToast) window.showToast('Invalid date or time selected.', 'error');
      return;
    }

    if (scheduledTime <= new Date()) {
      if (window.showToast) window.showToast('Scheduled time must be in the future.', 'error');
      return;
    }

    scheduledAtIso = scheduledTime.toISOString();
    window.chScheduledAt = scheduledAtIso; // Store for publish

    // Update Review Page Footer
    const infoBox = document.getElementById('review-scheduled-info');
    const infoText = document.getElementById('review-scheduled-text');
    const pubText = document.getElementById('review-publish-text');
    const pubIcon = document.getElementById('review-publish-icon');

    if (infoBox && infoText && pubText && pubIcon) {
      infoBox.style.display = 'flex';
      const formattedDate = scheduledTime.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const formattedTime = scheduledTime.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      infoText.innerText = `${formattedDate} at ${formattedTime}`;

      pubText.innerText = 'Schedule HUB';
      pubIcon.setAttribute('data-lucide', 'calendar-clock');
      if (window.lucide) window.lucide.createIcons();
    }
  } else {
    window.chScheduledAt = null;

    // Reset Review Page Footer
    const infoBox = document.getElementById('review-scheduled-info');
    const pubText = document.getElementById('review-publish-text');
    const pubIcon = document.getElementById('review-publish-icon');

    if (infoBox && pubText && pubIcon) {
      infoBox.style.display = 'none';
      pubText.innerText = 'Share your HUB';
      pubIcon.setAttribute('data-lucide', 'send');
      if (window.lucide) window.lucide.createIcons();
    }
  }

  // Navigate to review view
  if (typeof window.switchView === 'function') {
    window.switchView('review-hubbs');
  } else {
    switchView('review-hubbs');
  }

  // Initialize slider with the actual uploaded media
  setTimeout(window.initReviewSlider, 50);
};

function showValidationModal() {
  if (window.showToast) {
    window.showToast('Please select at least one photo or video before continuing.', 'error');
  } else {
    alert('Please select at least one photo or video before continuing.');
  }
}

// =========================================================================
// REVIEW HUBBS - COMPARISON SLIDER & SYNC
// =========================================================================
window.initReviewSlider = function () {
  const emptyState = document.getElementById('review-empty-state');
  const sliderWrapper = document.getElementById('review-slider-wrapper');

  if (!window.chUploads || window.chUploads.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    if (sliderWrapper) sliderWrapper.style.display = 'none';
    return;
  }

  if (emptyState) emptyState.style.display = 'none';
  if (sliderWrapper) sliderWrapper.style.display = 'block';

  const beforeContainer = document.getElementById('review-before-container');
  const afterContainer = document.getElementById('review-after-container');

  if (!beforeContainer || !afterContainer) return;

  // Clear containers except for absolute labels and lines
  [beforeContainer, afterContainer].forEach(container => {
    Array.from(container.children).forEach(child => {
      if (!child.style.position.includes('absolute')) {
        if (child.tagName === 'VIDEO') {
          child.pause();
          child.removeAttribute('src');
          child.load();
        }
        child.remove();
      }
    });
  });

  const hasMultiple = window.chUploads.length >= 2;
  let layout = (window.HubbleEditor && window.HubbleEditor.activeLayout) || 'original';

  layout = window.getEffectiveLayout(layout, window.chUploads);

  const layoutClass = (hasMultiple && layout !== 'original' && layout !== 'single') ? `layout-${layout}` : '';

  const beforeWrapper = document.createElement('div');
  beforeWrapper.style.cssText = 'width: 100%; height: 100%;';
  if (layoutClass) beforeWrapper.className = layoutClass;

  const afterWrapper = document.createElement('div');
  afterWrapper.style.cssText = 'width: 100%; height: 100%;';
  if (layoutClass) afterWrapper.className = layoutClass;

  let firstVideoBefore = null;
  let firstVideoAfter = null;

  const beforeBlocks = [];
  const afterBlocks = [];

  window.chUploads.forEach((mediaItem) => {
    const url = URL.createObjectURL(mediaItem.file);
    const state = mediaItem.editorState || {
      filter: 'original', rotation: 0, zoom: 1, panX: 0, panY: 0,
      adjustments: { brightness: 100, contrast: 100, exposure: 100, highlights: 100, shadows: 100, temperature: 0, tint: 0, saturation: 100, vibrance: 100, sharpness: 0, blur: 0, opacity: 100 },
      crop: null, layers: [], isMuted: false, musicTrack: null, selectedLocation: null
    };

    const ar = (window.HubbleEditor && window.HubbleEditor.getEditedAspectRatio) ? window.HubbleEditor.getEditedAspectRatio(mediaItem) : 1;
    const beforeCell = document.createElement('div');
    beforeCell.className = 'ch-preview-item';
    beforeCell.style.cssText = `position: relative; width: 100%; height: 100%; overflow: hidden; display: flex; align-items: center; justify-content: center;`;

    const afterCell = document.createElement('div');
    afterCell.className = 'ch-preview-item';
    afterCell.style.cssText = `position: relative; width: 100%; height: 100%; overflow: hidden; display: flex; align-items: center; justify-content: center;`;

    const beforeFrame = document.createElement('div');
    beforeFrame.className = 'edited-frame';
    beforeFrame.style.cssText = `position: relative; overflow: hidden; aspect-ratio: ${ar}; border-radius: 10px; background: #1a1a1a; display: flex; align-items: center; justify-content: center; margin: auto; width: min(100cqw, calc(100cqh * ${ar})); height: min(100cqh, calc(100cqw / ${ar}));`;

    const afterFrame = document.createElement('div');
    afterFrame.className = 'edited-frame';
    afterFrame.style.cssText = `position: relative; overflow: hidden; aspect-ratio: ${ar}; border-radius: 10px; background: #1a1a1a; display: flex; align-items: center; justify-content: center; margin: auto; width: min(100cqw, calc(100cqh * ${ar})); height: min(100cqh, calc(100cqw / ${ar}));`;


    let cw = 100, ch = 100, cx = 0, cy = 0;
    if (state.crop) {
      cw = state.crop.width; ch = state.crop.height; cx = state.crop.x; cy = state.crop.y;
    }
    const cropScaleCSS = state.crop ? `position: absolute; width: ${10000 / cw}%; height: ${10000 / ch}%; left: -${(cx / cw) * 100}%; top: -${(cy / ch) * 100}%;` : `position: absolute; width: 100%; height: 100%; left: 0; top: 0;`;

    const beforeInner = document.createElement('div');
    beforeInner.style.cssText = 'position: absolute; width: 100%; height: 100%; left: 0; top: 0;';

    const afterInner = document.createElement('div');
    afterInner.style.cssText = cropScaleCSS;

    let beforeMediaNode, afterMediaNode;

    if (mediaItem.type.startsWith('video/')) {
      beforeMediaNode = document.createElement('video');
      afterMediaNode = document.createElement('video');

      [beforeMediaNode, afterMediaNode].forEach(v => {
        v.src = url;
        v.style.cssText = 'position: absolute; width: 100%; height: 100%; object-fit: contain; object-position: center;';
        v.loop = true;
        v.muted = state.isMuted || false;
        v.playsInline = true;
        v.autoplay = false;
        v.preload = 'auto';
        v.pause();
      });

      if (!firstVideoBefore) {
        firstVideoBefore = beforeMediaNode;
        firstVideoAfter = afterMediaNode;
      } else {
        // Sync secondary videos to the first one just by playing them together
        firstVideoBefore.addEventListener('play', () => beforeMediaNode.play());
        firstVideoBefore.addEventListener('pause', () => beforeMediaNode.pause());
        firstVideoBefore.addEventListener('seeking', () => beforeMediaNode.currentTime = firstVideoBefore.currentTime);
        firstVideoAfter.addEventListener('play', () => afterMediaNode.play());
        firstVideoAfter.addEventListener('pause', () => afterMediaNode.pause());
        firstVideoAfter.addEventListener('seeking', () => afterMediaNode.currentTime = firstVideoAfter.currentTime);
      }
    } else {
      beforeMediaNode = document.createElement('img');
      afterMediaNode = document.createElement('img');
      [beforeMediaNode, afterMediaNode].forEach(img => {
        img.src = url;
        img.style.cssText = 'position: absolute; width: 100%; height: 100%; object-fit: contain; object-position: center;';
      });
    }

    // Apply Edits to After node
    if (window.HubbleEditor) {
      afterMediaNode.style.filter = window.HubbleEditor.buildCSSFilterString(state.filter, state.adjustments);
    }
    const zoom = state.zoom || 1;
    afterMediaNode.style.transform = `translate(${state.panX || 0}%, ${state.panY || 0}%) rotate(${state.rotation || 0}deg) scale(${zoom})`;

    beforeInner.appendChild(beforeMediaNode);
    beforeFrame.appendChild(beforeInner);
    beforeCell.appendChild(beforeFrame);

    afterInner.appendChild(afterMediaNode);
    afterFrame.appendChild(afterInner);

    // Inject Layers (Stickers / Text)
    const interactionWrapper = document.createElement('div');
    interactionWrapper.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;';

    if (state.layers) {
      state.layers.forEach((layer) => {
        const el = document.createElement('div');
        el.style.cssText = `position: absolute; left: ${layer.x}%; top: ${layer.y}%; transform: translate(-50%, -50%) rotate(${layer.rotation}deg) scale(${layer.scale}); z-index: ${layer.zIndex}; pointer-events: none;`;
        if (layer.type === 'text') {
          el.innerHTML = `<div style="color: ${layer.styles?.color || layer.color || 'white'}; font-family: ${layer.styles?.font || layer.fontFamily || 'inherit'}; font-size: ${layer.styles?.size || layer.fontSize || 24}px; font-weight: ${(layer.styles?.bold || layer.bold) ? 'bold' : 'normal'}; font-style: ${(layer.styles?.italic || layer.italic) ? 'italic' : 'normal'}; text-shadow: ${(layer.styles?.shadow || layer.shadow) ? '0 2px 10px rgba(0,0,0,0.5)' : 'none'}; text-align: center; white-space: pre-wrap;">${layer.content || layer.text || ''}</div>`;
        } else if (layer.type === 'sticker') {
          el.innerHTML = `<div style="font-size: ${layer.styles?.size || 80}px; pointer-events: none;">${layer.content || layer.emoji || ''}</div>`;
        } else if (layer.type === 'music') {
          const track = layer.track || window.HubbleEditor.state.musicTrack || {};
          const artwork = track.artwork || layer.artwork || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=150&h=150&q=80';
          const title = track.title || layer.content || 'Music';
          const artist = track.artist || layer.artist || '';

          el.innerHTML = `
            <div class="story-music-sticker-card" style="display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: rgba(20, 20, 25, 0.85); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.2); border-radius: 24px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); color: white; min-width: 140px; max-width: 260px; user-select: none;">
              <div style="position: relative; width: 32px; height: 32px; flex-shrink: 0;">
                <img src="${artwork}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 1.5px solid rgba(255,255,255,0.4);" alt="Artwork" />
                <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.3); border-radius: 50%;">
                  <span style="font-size: 11px;">🎵</span>
                </div>
              </div>
              <div style="display: flex; flex-direction: column; min-width: 0; text-align: left;">
                <span style="font-size: 12px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2;">${title}</span>
                <span style="font-size: 10px; color: rgba(255,255,255,0.7); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px;">${artist}</span>
              </div>
            </div>
          `;
        } else if (layer.type === 'location') {
          const loc = layer.loc || window.HubbleEditor.state.selectedLocation || {};
          const locName = typeof loc === 'string' ? loc : (loc.displayName || loc.name || layer.content || 'Location');

          el.innerHTML = `
            <div class="story-location-sticker-card" style="display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; background: linear-gradient(135deg, rgba(168,85,247,0.85) 0%, rgba(126,34,206,0.9) 100%); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.25); border-radius: 20px; box-shadow: 0 6px 20px rgba(168,85,247,0.35); color: white; user-select: none;">
              <span style="font-size: 13px;">📍</span>
              <span style="font-size: 12px; font-weight: 700; color: #fff; white-space: nowrap; text-shadow: 0 1px 2px rgba(0,0,0,0.3);">${locName}</span>
            </div>
          `;
        }
        interactionWrapper.appendChild(el);
      });
    }
    afterFrame.appendChild(interactionWrapper);
    afterCell.appendChild(afterFrame);

    beforeBlocks.push({ mediaItem, el: beforeCell });
    afterBlocks.push({ mediaItem, el: afterCell });
  });

  beforeBlocks.forEach(b => beforeWrapper.appendChild(b.el));
  afterBlocks.forEach(b => afterWrapper.appendChild(b.el));

  // Audio sync and controls for the primary video
  if (firstVideoBefore) {
    firstVideoBefore.addEventListener('play', () => {
      firstVideoAfter.play();
      if (window.StoryAudioManager) {
        window.StoryAudioManager.sync(firstVideoBefore.currentTime);
        if (!window.StoryAudioManager.isMuted()) {
          window.StoryAudioManager.play('preview');
        }
      }
    });
    firstVideoBefore.addEventListener('pause', () => {
      firstVideoAfter.pause();
    });
    firstVideoBefore.addEventListener('seeking', () => {
      firstVideoAfter.currentTime = firstVideoBefore.currentTime;
      if (window.StoryAudioManager) {
        window.StoryAudioManager.sync(firstVideoBefore.currentTime);
      }
    });
    firstVideoBefore.addEventListener('seeked', () => {
      firstVideoAfter.currentTime = firstVideoBefore.currentTime;
      if (window.StoryAudioManager) {
        window.StoryAudioManager.sync(firstVideoBefore.currentTime);
      }
    });

    sliderWrapper.onclick = (e) => {
      if (e.target.id === 'review-slider-handle' || e.target.closest('#review-slider-handle') || e.target.closest('#he-speaker-btn')) return;
      if (firstVideoBefore.paused) {
        firstVideoBefore.play();
        const btn = document.getElementById('he-review-play-btn');
        if (btn) {
          btn.innerHTML = '<i data-lucide="pause" style="color: white; width: 32px; height: 32px;"></i>';
          if (window.lucide) window.lucide.createIcons();
          btn.style.opacity = '1';
          btn.style.transform = 'scale(1)';
          setTimeout(() => { btn.style.opacity = '0'; btn.style.transform = 'scale(0.9)'; }, 2000);
        }
      } else {
        firstVideoBefore.pause();
        const btn = document.getElementById('he-review-play-btn');
        if (btn) {
          btn.innerHTML = '<i data-lucide="play" style="color: white; width: 32px; height: 32px;"></i>';
          if (window.lucide) window.lucide.createIcons();
          btn.style.opacity = '1';
          btn.style.transform = 'scale(1)';
        }
      }
    };

    let reviewControls = document.getElementById('he-review-controls');
    if (reviewControls) reviewControls.remove();
    if (window.HubbleEditor) {
      reviewControls = window.HubbleEditor.buildVideoControls(sliderWrapper, firstVideoBefore, true);
    }
  } else {
    let reviewControls = document.getElementById('he-review-controls');
    if (reviewControls) reviewControls.remove();
  }

  // Insert at the beginning so they sit behind the absolute positioned labels
  beforeContainer.insertBefore(beforeWrapper, beforeContainer.firstChild);
  afterContainer.insertBefore(afterWrapper, afterContainer.firstChild);

  // Setup Draggable Handle
  const handle = document.getElementById('review-slider-handle');
  if (handle) {
    let isDragging = false;

    const updateSliderPos = (x) => {
      const rect = sliderWrapper.getBoundingClientRect();
      let position = x - rect.left;
      position = Math.max(0, Math.min(position, rect.width));
      const percentage = (position / rect.width) * 100;

      beforeContainer.style.clipPath = `inset(0 ${100 - percentage}% 0 0)`;
      handle.style.left = `${percentage}%`;
    };

    handle.onmousedown = (e) => {
      isDragging = true;
      e.preventDefault();
    };

    handle.ontouchstart = (e) => {
      isDragging = true;
    };

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      updateSliderPos(e.clientX);
    });

    document.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      updateSliderPos(e.touches[0].clientX);
    }, { passive: true });

    document.addEventListener('mouseup', () => isDragging = false);
    document.addEventListener('touchend', () => isDragging = false);

    // Initial State 50%
    beforeContainer.style.clipPath = `inset(0 50% 0 0)`;
    handle.style.left = `50%`;
  }
};

// =========================================================================
// REVIEW HUBBS - ACTIONS
// =========================================================================
window.saveReviewDraft = function (btn) {
  if (window.showToast) window.showToast('All edits saved to draft! 📝');
  const span = document.getElementById('review-draft-time');
  if (span) {
    span.textContent = 'Last saved: Just now';
  }
  btn.style.opacity = '0.5';
  btn.style.pointerEvents = 'none';
  setTimeout(() => {
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'all';
  }, 1000);
};


async function createMutedVideoBlob(fileOrBlob) {
  if (!fileOrBlob) return null;

  // 1. First attempt: Fast lossless packet-copy demux/remux with mediabunny (discards audio tracks)
  try {
    const input = new Input({
      source: new BlobSource(fileOrBlob),
      formats: ALL_FORMATS
    });
    const inputFormat = await input.getFormat();
    const isMp4 = inputFormat.name.includes('MP4') || inputFormat.name.includes('QuickTime') || inputFormat.name.includes('ISO') || (fileOrBlob.type && fileOrBlob.type.includes('mp4'));
    const outputFormat = isMp4 ? new Mp4OutputFormat() : new WebMOutputFormat();
    const target = new BufferTarget();
    const output = new Output({
      target: target,
      format: outputFormat
    });
    const conversion = await Conversion.init({
      input,
      output,
      audio: () => ({ discard: true })
    });
    if (conversion.isValid) {
      await conversion.execute();
      if (target.buffer && target.buffer.byteLength > 0) {
        const mimeType = isMp4 ? 'video/mp4' : 'video/webm';
        console.log(`[Mute Video] Successfully remuxed muted video without audio track (${mimeType}, ${target.buffer.byteLength} bytes)`);
        return new Blob([target.buffer], { type: mimeType });
      }
    }
  } catch (err) {
    console.warn('[Mute Video] Mediabunny remux notice, falling back to MediaStream capture:', err);
  }

  // 2. Fallback: Browser MediaRecorder on video-only stream
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    const videoUrl = URL.createObjectURL(fileOrBlob);
    video.src = videoUrl;

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = reject;
    });

    const stream = video.captureStream ? video.captureStream() : (video.mozCaptureStream ? video.mozCaptureStream() : null);
    if (stream && stream.getVideoTracks().length > 0) {
      const videoTrack = stream.getVideoTracks()[0];
      const mutedStream = new MediaStream([videoTrack]);
      const mimeType = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('video/mp4')) ? 'video/mp4' : 'video/webm';

      const chunks = [];
      const recorder = new MediaRecorder(mutedStream, { mimeType });
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      const recordPromise = new Promise((resolve) => {
        recorder.onstop = () => {
          resolve(new Blob(chunks, { type: mimeType }));
        };
      });

      recorder.start();
      video.currentTime = 0;
      await video.play();

      await new Promise((resolve) => {
        video.onended = resolve;
      });

      recorder.stop();
      URL.revokeObjectURL(videoUrl);
      const mutedBlob = await recordPromise;
      if (mutedBlob && mutedBlob.size > 0) {
        console.log(`[Mute Video] Fallback recorder produced muted video (${mutedBlob.type}, ${mutedBlob.size} bytes)`);
        return mutedBlob;
      }
    }
    URL.revokeObjectURL(videoUrl);
  } catch (err2) {
    console.error('[Mute Video] MediaStream fallback failed:', err2);
  }

  return fileOrBlob;
}


async function resolveMediaToDataUrl(upload) {
  if (!upload) return null;
  const isVideo = (upload.type && upload.type.startsWith('video')) || (upload.file && upload.file.type && upload.file.type.startsWith('video'));

  // Video handling: Check mute state and remove audio track if muted
  if (isVideo) {
    let fileObj = upload.file || upload.blob;
    if (!fileObj) {
      let url = upload.editedUrl || upload.url || upload.src || upload.thumbUrl || upload.base64 || upload.dataUrl;
      if (url && url.startsWith('blob:')) {
        try {
          const res = await fetch(url);
          fileObj = await res.blob();
        } catch (_) { }
      }
    }

    const isMuted = !!(
      (upload.editorState && upload.editorState.isMuted) ||
      upload.isMuted ||
      (window.HubbleEditor && window.HubbleEditor.state && window.HubbleEditor.state.isMuted)
    );

    if (fileObj) {
      let finalBlob = fileObj;
      if (isMuted) {
        console.log('[resolveMediaToDataUrl] Processing video to remove audio track (MUTE enabled)...');
        try {
          const mutedBlob = await createMutedVideoBlob(fileObj);
          if (mutedBlob) {
            finalBlob = mutedBlob;
            upload.file = mutedBlob;
            upload.blob = mutedBlob;
          }
        } catch (muteErr) {
          console.error('[resolveMediaToDataUrl] Failed to mute video:', muteErr);
        }
      }

      try {
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(finalBlob);
        });
        if (dataUrl) return dataUrl;
      } catch (e) {
        console.warn('FileReader error on video fileObj:', e);
      }
    }
  }

  // Rasterize edited image if editorState is present
  if (!isVideo && upload.editorState) {
    try {
      const state = upload.editorState;
      const img = new Image();
      img.crossOrigin = 'Anonymous';

      let sourceUrl = upload.thumbUrl;
      if (!sourceUrl && (upload.file || upload.blob)) {
        sourceUrl = URL.createObjectURL(upload.file || upload.blob);
      } else if (!sourceUrl) {
        sourceUrl = upload.editedUrl || upload.url || upload.src || upload.base64 || upload.dataUrl;
      }

      img.src = sourceUrl;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      // 1. Calculate base dimensions (incorporate rotation)
      let baseWidth = img.width;
      let baseHeight = img.height;
      const rot = state.rotation || 0;
      if (rot === 90 || rot === 270 || rot === -90 || rot === -270) {
        baseWidth = img.height;
        baseHeight = img.width;
      }

      // 2. Calculate crop dimensions
      let cropX = 0, cropY = 0, cropW = baseWidth, cropH = baseHeight;
      if (state.crop) {
        cropX = (state.crop.x / 100) * baseWidth;
        cropY = (state.crop.y / 100) * baseHeight;
        cropW = (state.crop.width / 100) * baseWidth;
        cropH = (state.crop.height / 100) * baseHeight;
      }

      // 3. Set final canvas size to cropped area
      canvas.width = cropW;
      canvas.height = cropH;

      // 4. Apply CSS Filters
      const cssFilter = window.HubbleEditor && window.HubbleEditor.buildCSSFilterString
        ? window.HubbleEditor.buildCSSFilterString(state.filter || 'original', state.adjustments || {})
        : 'none';
      ctx.filter = cssFilter !== 'none' ? cssFilter : 'none';

      // 5. Draw Image with crop, zoom, pan, and rotation
      ctx.save();
      // Translate to the center of the cropped canvas
      ctx.translate(canvas.width / 2, canvas.height / 2);

      // Apply Zoom and Pan (Pan is relative to the base dimensions)
      const zoom = state.zoom || 1;
      const panX = ((state.panX || 0) / 100) * baseWidth;
      const panY = ((state.panY || 0) / 100) * baseHeight;
      ctx.scale(zoom, zoom);
      ctx.translate(panX, panY);

      // Offset by crop center relative to base center
      const baseCenterX = baseWidth / 2;
      const baseCenterY = baseHeight / 2;
      const cropCenterX = cropX + (cropW / 2);
      const cropCenterY = cropY + (cropH / 2);
      ctx.translate(baseCenterX - cropCenterX, baseCenterY - cropCenterY);

      // Apply Rotation
      ctx.rotate((rot * Math.PI) / 180);

      // Draw the original image centered
      ctx.drawImage(img, -img.width / 2, -img.height / 2, img.width, img.height);
      ctx.restore();

      // 6. Reset filter for overlays
      ctx.filter = 'none';

      // 7. Draw Layers (Text & Stickers)
      if (state.layers && state.layers.length > 0) {
        state.layers.forEach(layer => {
          ctx.save();
          // Layers are positioned relative to the crop boundaries
          const x = (parseFloat(layer.x) / 100) * canvas.width || (canvas.width / 2);
          const y = (parseFloat(layer.y) / 100) * canvas.height || (canvas.height / 2);

          if (layer.type === 'text') {
            ctx.font = `${layer.bold ? 'bold ' : ''}${layer.italic ? 'italic ' : ''}${layer.fontSize || 32}px ${layer.fontFamily || 'Arial'}`;
            ctx.fillStyle = layer.color || '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            if (layer.shadow) {
              ctx.shadowColor = 'rgba(0,0,0,0.8)';
              ctx.shadowBlur = 5;
              ctx.shadowOffsetX = 2;
              ctx.shadowOffsetY = 2;
            }
            ctx.fillText(layer.content || layer.text || '', x, y);
          } else if (layer.type === 'sticker') {
            ctx.font = '80px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(layer.content || layer.emoji || '', x, y);
          } else if (layer.type === 'location') {
            const loc = layer.loc || state.selectedLocation || {};
            const locName = typeof loc === 'string' ? loc : (loc.displayName || loc.name || layer.content || 'Location');
            ctx.font = 'bold 24px Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const text = '📍 ' + locName;
            const metrics = ctx.measureText(text);
            const padX = 20;
            const bgW = metrics.width + padX * 2;
            const bgH = 38;
            ctx.fillStyle = 'rgba(168,85,247,0.9)';
            ctx.beginPath();
            if (ctx.roundRect) {
              ctx.roundRect(x - bgW / 2, y - bgH / 2, bgW, bgH, 19);
            } else {
              ctx.rect(x - bgW / 2, y - bgH / 2, bgW, bgH);
            }
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.fillText(text, x, y);
          } else if (layer.type === 'music') {
            const track = layer.track || state.musicTrack || {};
            const title = track.title || layer.content || 'Music';
            const artist = track.artist || layer.artist || '';
            const text = `🎵 ${title}${artist ? ' • ' + artist : ''}`;
            ctx.font = 'bold 22px Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const metrics = ctx.measureText(text);
            const padX = 20;
            const bgW = Math.min(canvas.width * 0.85, metrics.width + padX * 2);
            const bgH = 42;
            ctx.fillStyle = 'rgba(20,20,25,0.85)';
            ctx.beginPath();
            if (ctx.roundRect) {
              ctx.roundRect(x - bgW / 2, y - bgH / 2, bgW, bgH, 21);
            } else {
              ctx.rect(x - bgW / 2, y - bgH / 2, bgW, bgH);
            }
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.fillText(text, x, y);
          }
          ctx.restore();
        });
      }

      return canvas.toDataURL('image/jpeg', 0.95);
    } catch (e) {
      console.error('Canvas rasterization failed:', e);
    }
  }

  // Fallback to original file for videos or if rasterization fails
  const fileObj = upload.file || upload.blob;
  if (fileObj && (fileObj instanceof File || fileObj instanceof Blob || (typeof fileObj === 'object' && typeof fileObj.slice === 'function'))) {
    try {
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(fileObj);
      });
      if (dataUrl) return dataUrl;
    } catch (e) {
      console.warn('FileReader error on fileObj:', e);
    }
  }

  // 2. Check upload properties: editedUrl, url, src, thumbUrl, base64, dataUrl
  let url = upload.editedUrl || upload.url || upload.src || upload.thumbUrl || upload.base64 || upload.dataUrl;
  if (!url || typeof url !== 'string') return null;

  // 3. If already Data URL
  if (url.startsWith('data:')) {
    return url;
  }

  // 4. If Blob URL
  if (url.startsWith('blob:')) {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
      if (dataUrl) return dataUrl;
    } catch (e) {
      console.warn('fetch blob URL failed, trying canvas fallback:', e);
    }

    // Canvas fallback for images
    try {
      return await new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || img.width || 800;
            canvas.height = img.naturalHeight || img.height || 600;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/jpeg', 0.9));
          } catch (err) {
            resolve(null);
          }
        };
        img.onerror = () => resolve(null);
        img.src = url;
      });
    } catch (e) {
      console.warn('Canvas fallback failed:', e);
    }
  }

  return url;
}

async function generateCompositeImageBlob(uploads, layout) {
  return new Promise(async (resolve) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1080;
      canvas.height = 1920;
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let cols = 1, rows = 1;
      if (layout === '2x2-grid' || uploads.length === 4) { cols = 2; rows = 2; }
      else if (layout === 'side-by-side' || uploads.length === 2) { cols = 2; rows = 1; }
      else if (layout === 'vertical-split') { cols = 1; rows = 2; }
      else if (uploads.length >= 5) { cols = 2; rows = Math.ceil(uploads.length / 2); }
      else if (uploads.length === 3) { cols = 2; rows = 2; }

      const gap = 15;
      const totalGapX = gap * (cols - 1);
      const totalGapY = gap * (rows - 1);
      const cellW = (canvas.width - totalGapX) / cols;
      const cellH = (canvas.height - totalGapY) / rows;

      const images = [];
      for (let i = 0; i < uploads.length; i++) {
        const url = await resolveMediaToDataUrl(uploads[i]);
        if (!url) continue;

        const img = new Image();
        await new Promise((res) => {
          img.onload = res;
          img.onerror = res;
          img.src = url;
        });
        images.push(img);
      }

      images.forEach((img, idx) => {
        if (!img.width) return;
        let row, col, w, h, cx, cy;

        if (uploads.length === 3 && idx === 0) {
          col = 0; row = 0;
          w = canvas.width; h = cellH;
          cx = 0; cy = 0;
        } else if (uploads.length === 3) {
          col = idx - 1; row = 1;
          w = cellW; h = cellH;
          cx = col * (cellW + gap); cy = row * (cellH + gap);
        } else {
          col = idx % cols;
          row = Math.floor(idx / cols);
          w = cellW; h = cellH;
          cx = col * (cellW + gap); cy = row * (cellH + gap);
        }

        const imgRatio = img.width / img.height;
        const cellRatio = w / h;
        let sx, sy, sw, sh;

        if (imgRatio > cellRatio) {
          sh = img.height;
          sw = img.height * cellRatio;
          sx = (img.width - sw) / 2;
          sy = 0;
        } else {
          sw = img.width;
          sh = img.width / cellRatio;
          sx = 0;
          sy = (img.height - sh) / 2;
        }

        ctx.drawImage(img, sx, sy, sw, sh, cx, cy, w, h);
      });

      canvas.toBlob((blob) => {
        resolve(blob);
      }, 'image/jpeg', 0.95);
    } catch (e) {
      console.error('[Compositing Error]', e);
      resolve(null);
    }
  });
}

window.publishHubb = async function () {
  if (window.isPublishingHubb) {
    console.warn('[ShareHubs Publish] Publish already in progress, ignoring duplicate submission');
    return;
  }
  window.isPublishingHubb = true;

  console.log('[ShareHubs Publish] Share button clicked, initiating publishing flow');

  const captionEl = document.getElementById('ch-caption-input');
  const captionText = captionEl ? captionEl.value.trim() : '';

  if ((!window.chUploads || window.chUploads.length === 0) && !captionText) {
    if (window.showToast) window.showToast('Please upload media or enter a caption.');
    window.isPublishingHubb = false;
    return;
  }

  // Pause any active playback during upload
  const activeVideos = document.querySelectorAll('#review-slider-wrapper video, #he-media-layer video');
  activeVideos.forEach(v => {
    try { v.pause(); } catch (_) { }
  });
  if (window.HubbleEditor && window.HubbleEditor.GlobalAudio) {
    try { window.HubbleEditor.GlobalAudio.pause(); } catch (_) { }
  }

  const pubBtn = document.getElementById('review-publish-btn');
  const isScheduled = !!window.chScheduledAt;
  const scheduledIso = window.chScheduledAt;

  if (pubBtn) {
    pubBtn.disabled = true;
    pubBtn.style.pointerEvents = 'none';
    pubBtn.style.opacity = '0.7';
    pubBtn.innerHTML = `<i data-lucide="loader" class="animate-spin" style="width: 18px; height: 18px;"></i> ${isScheduled ? 'Scheduling HUB...' : 'Sharing HUB...'}`;
    if (window.lucide) window.lucide.createIcons();
  }

  try {
    const token = localStorage.getItem('invibe_jwt_token');
    if (!token) {
      console.error('[ShareHubs Publish Error] AUTHENTICATION FAILED: Missing JWT token');
      throw new Error('Please log in before sharing a HUB.');
    }

    let allSuccess = true;
    let anySuccess = false;
    let lastData = null;
    let finalMediaItems = [];

    let uploadsToProcess = window.chUploads ? [...window.chUploads] : [];

    // Check if we need to composite images
    const allImages = uploadsToProcess.length > 0 && uploadsToProcess.every(u => {
      const type = u.type || (u.file ? u.file.type : '');
      return !type.startsWith('video');
    });

    if (uploadsToProcess.length > 1 && allImages) {
      console.log('[ShareHubs Publish] Multiple images detected. Generating composite image.');
      if (pubBtn) pubBtn.innerHTML = `<i data-lucide="loader" class="animate-spin" style="width: 18px; height: 18px;"></i> Compositing...`;
      if (window.lucide) window.lucide.createIcons();

      const layout = (window.HubbleEditor && window.HubbleEditor.activeLayout) || 'original';
      const effectiveLayout = window.getEffectiveLayout ? window.getEffectiveLayout(layout, uploadsToProcess) : '2x2-grid';

      const compositeBlob = await generateCompositeImageBlob(uploadsToProcess, effectiveLayout);

      if (compositeBlob) {
        if (pubBtn) pubBtn.innerHTML = `<i data-lucide="loader" class="animate-spin" style="width: 18px; height: 18px;"></i> ${isScheduled ? 'Scheduling HUB...' : 'Sharing HUB...'}`;
        if (window.lucide) window.lucide.createIcons();

        // Wrap into single upload object format
        const compositeUpload = {
          file: compositeBlob,
          type: 'image/jpeg',
          editorState: null // Apply null because original edits are already rasterized into the composite!
        };
        uploadsToProcess = [compositeUpload];
      }
    }

    // Process ALL media items from uploadsToProcess for Stories
    if (uploadsToProcess && uploadsToProcess.length > 0) {
      for (const upload of uploadsToProcess) {
        // Ensure the editor state is attached to the upload before resolving if not already present
        if (!upload.editorState && window.HubbleEditor && window.HubbleEditor.state) {
          upload.editorState = JSON.parse(JSON.stringify(window.HubbleEditor.state));
        }

        const dataUrl = await resolveMediaToDataUrl(upload);
        if (!dataUrl) continue;

        const rawType = upload.type || (upload.file ? upload.file.type : '');
        const finalMediaType = (rawType && rawType.startsWith('video')) ? 'video' : 'image';

        finalMediaItems.push({ url: dataUrl, type: finalMediaType });
      }
    }

    if (finalMediaItems.length > 0) {
      const musicTrack = (window.HubbleEditor && window.HubbleEditor.state && window.HubbleEditor.state.musicTrack) || null;
      const selectedLocation = (window.HubbleEditor && window.HubbleEditor.state && window.HubbleEditor.state.selectedLocation) || null;
      const editorLayers = (window.HubbleEditor && window.HubbleEditor.state && window.HubbleEditor.state.layers)
        ? JSON.parse(JSON.stringify(window.HubbleEditor.state.layers))
        : (window.chUploads && window.chUploads[0]?.editorState?.layers ? JSON.parse(JSON.stringify(window.chUploads[0].editorState.layers)) : []);

      const musicPayload = musicTrack ? {
        id: musicTrack.id || musicTrack.trackId || String(Date.now()),
        trackId: musicTrack.trackId || musicTrack.id || '',
        title: musicTrack.title || 'Music',
        artist: musicTrack.artist || '',
        artwork: musicTrack.artwork || musicTrack.albumArt || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=150&h=150&q=80',
        albumArt: musicTrack.artwork || musicTrack.albumArt || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=150&h=150&q=80',
        previewUrl: musicTrack.previewUrl || musicTrack.url || '',
        url: musicTrack.previewUrl || musicTrack.url || '',
        isMuted: !!musicTrack.isMuted,
        muted: !!musicTrack.isMuted
      } : null;

      // Format payload specifically for story endpoints
      const payload = {
        mediaUrl: finalMediaItems[0].url,
        mediaType: finalMediaItems[0].type,
        mediaItems: finalMediaItems,
        caption: captionText,
        music: musicPayload,
        location: selectedLocation ? (selectedLocation.displayName || selectedLocation.name) : null,
        locationData: selectedLocation,
        layers: editorLayers,
        scheduledAt: scheduledIso || null
      };

      const API_URL = window.API_URL || '';
      const endpoint = isScheduled ? `${API_URL}/api/stories/schedule` : `${API_URL}/api/stories`;

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          lastData = await res.json();
          anySuccess = true;
          console.log(`[ShareHubs Publish] Story successfully ${isScheduled ? 'scheduled' : 'created'} with ${finalMediaItems.length} items.`);
        } else {
          const errData = await res.json().catch(() => ({}));
          console.error('[ShareHubs Publish Error] STORY API FAILED:', errData);
        }
      } catch (apiErr) {
        console.error('[ShareHubs Publish Error] API Fetch failed:', apiErr);
      }
    }

    if (!anySuccess) {
      console.error('[ShareHubs Publish Error] MEDIA UPLOAD FAILED: No valid media could be generated');
      throw new Error('No valid media could be generated for upload.');
    }

    if (anySuccess) {
      console.log(`[ShareHubs Publish] Story successfully ${isScheduled ? 'scheduled' : 'created'}:`, lastData);

      // Halt and release all media and audio instances immediately
      if (typeof window.cleanupStoryMedia === 'function') {
        window.cleanupStoryMedia();
      }

      // If we published an existing draft, remove it from drafts database
      if (window.currentDraftId) {
        try {
          if (window.DraftsDB && window.DraftsDB.deleteDraft) {
            await window.DraftsDB.deleteDraft(window.currentDraftId);
          }
        } catch (_) { }
        window.currentDraftId = null;
        window.currentDraftCreatedAt = null;
        if (typeof window.renderDraftsList === 'function') {
          window.renderDraftsList();
        }
      }

      // Clear creator state
      window.chUploads = [];
      window.chScheduledAt = null;
      if (captionEl) captionEl.value = '';
      if (window.HubbleEditor && window.HubbleEditor.state) {
        window.HubbleEditor.state.musicTrack = null;
        window.HubbleEditor.state.selectedLocation = null;
      }
      if (window.renderAttachedStoryBadges) {
        window.renderAttachedStoryBadges();
      }

      if (window.showToast) {
        window.showToast(isScheduled ? 'HUBBS Scheduled successfully! 📅🚀' : 'HUBBS Posted successfully! 🚀✨');
      }

      // Return to home feed and reload stories
      if (window.switchView) {
        window.switchView('home');
      }

      // Trigger story refresh in stories section
      if (typeof window.loadHubbStories === 'function') {
        await window.loadHubbStories();
      } else if (typeof window.loadStories === 'function') {
        await window.loadStories();
      }
    }
  } catch (err) {
    console.error('[ShareHubs Publish Error] PUBLISH FAILED:', err.message || err);
    if (window.showToast) {
      window.showToast(err.message || 'Unable to share HUB. Please try again.', 'error');
    } else {
      alert(err.message || 'Unable to share HUB. Please try again.');
    }
  } finally {
    window.isPublishingHubb = false;
    if (pubBtn) {
      pubBtn.disabled = false;
      pubBtn.style.pointerEvents = 'auto';
      pubBtn.style.opacity = '1';
      pubBtn.innerHTML = '<span id="review-publish-text">Share the HUB</span> <i id="review-publish-icon" data-lucide="send" style="width: 18px; height: 18px;"></i>';
      if (window.lucide) window.lucide.createIcons();
    }
  }
};

window.loadHubbStories = async function () {
  if (typeof window.loadStories === 'function') {
    await window.loadStories();
  }
};

document.addEventListener('DOMContentLoaded', () => {
  if (window.loadHubbStories) window.loadHubbStories();
});
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  if (window.loadHubbStories) window.loadHubbStories();
}

window.openPublishedStory = function (card) {
  const dataNode = card.querySelector('.story-data');
  if (!dataNode) return;
  const data = JSON.parse(dataNode.innerHTML);

  const modal = document.getElementById('story-viewer-modal');
  if (!modal) return;

  const avatar = document.getElementById('story-viewer-avatar');
  if (avatar) avatar.src = 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=150&h=150&q=80';

  const name = document.getElementById('story-viewer-name');
  if (name) name.innerText = 'Your HUBBs';

  const time = document.getElementById('story-viewer-time');
  if (time) time.innerText = 'Just now';

  const contentBox = document.getElementById('story-viewer-content-box');
  if (!contentBox) return;
  contentBox.innerHTML = '';

  let mediaDataList = data.allMedia;
  if (!mediaDataList) {
    // Fallback for old single media posts
    mediaDataList = [{
      url: data.url, type: data.type, filter: data.filter,
      rotation: data.rotation, zoom: data.zoom, panX: 0, panY: 0,
      crop: data.crop, layers: data.layers, ar: 1
    }];
  }

  const hasMultiple = mediaDataList.length >= 2;
  const layout = data.layout || 'single';
  const layoutClass = (hasMultiple && layout !== 'original' && layout !== 'single') ? `layout-${layout}` : '';

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'width: 100%; height: 100%;';
  if (layoutClass) wrapper.className = layoutClass;
  // Apply Review specific layout CSS
  // Actually, we made the CSS target #story-viewer-content-box. We don't need to spoof the ID.
  contentBox.style.padding = '0';
  contentBox.style.overflow = 'hidden';

  mediaDataList.forEach((mData) => {
    const cell = document.createElement('div');
    cell.className = 'ch-preview-item';
    cell.style.cssText = `position: relative; width: 100%; height: 100%; overflow: hidden; display: flex; align-items: center; justify-content: center;`;

    const frame = document.createElement('div');
    frame.className = 'edited-frame';
    frame.style.cssText = `position: relative; overflow: hidden; aspect-ratio: ${mData.ar}; border-radius: 10px; background: #1a1a1a; display: flex; align-items: center; justify-content: center; margin: auto; width: min(100cqw, calc(100cqh * ${mData.ar})); height: min(100cqh, calc(100cqw / ${mData.ar}));`;

    let cw = 100, ch = 100, cx = 0, cy = 0;
    if (mData.crop) {
      cw = mData.crop.width; ch = mData.crop.height; cx = mData.crop.x; cy = mData.crop.y;
    }
    const cropScaleCSS = mData.crop ? `position: absolute; width: ${10000 / cw}%; height: ${10000 / ch}%; left: -${(cx / cw) * 100}%; top: -${(cy / ch) * 100}%;` : `position: absolute; width: 100%; height: 100%; left: 0; top: 0;`;

    const inner = document.createElement('div');
    inner.style.cssText = cropScaleCSS;

    let mediaNode;
    if (mData.type.startsWith('video/')) {
      mediaNode = document.createElement('video');
      mediaNode.src = mData.url;
      mediaNode.loop = true;
      mediaNode.muted = true;
      mediaNode.playsInline = true;
      mediaNode.autoplay = false;
      mediaNode.preload = 'auto';
      mediaNode.pause();
    } else {
      mediaNode = document.createElement('img');
      mediaNode.src = mData.url;
    }
    mediaNode.style.cssText = 'position: absolute; width: 100%; height: 100%; object-fit: contain; object-position: center;';
    mediaNode.style.filter = mData.filter || '';
    mediaNode.style.transform = `translate(${mData.panX || 0}%, ${mData.panY || 0}%) rotate(${mData.rotation || 0}deg) scale(${mData.zoom || 1})`;

    inner.appendChild(mediaNode);
    frame.appendChild(inner);

    if (mData.layers) {
      const interactionWrapper = document.createElement('div');
      interactionWrapper.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;';
      mData.layers.forEach((layer) => {
        const el = document.createElement('div');
        el.style.cssText = `position: absolute; left: ${layer.x}%; top: ${layer.y}%; transform: translate(-50%, -50%) rotate(${layer.rotation}deg) scale(${layer.scale}); z-index: ${layer.zIndex}; pointer-events: none;`;
        if (layer.type === 'text') {
          el.innerHTML = `<div style="color: ${layer.styles?.color || layer.color || 'white'}; font-family: ${layer.styles?.font || layer.fontFamily || 'inherit'}; font-size: ${layer.styles?.size || layer.fontSize || 24}px; font-weight: ${(layer.styles?.bold || layer.bold) ? 'bold' : 'normal'}; font-style: ${(layer.styles?.italic || layer.italic) ? 'italic' : 'normal'}; text-shadow: ${(layer.styles?.shadow || layer.shadow) ? '0 2px 10px rgba(0,0,0,0.5)' : 'none'}; text-align: center; white-space: pre-wrap;">${layer.content || layer.text || ''}</div>`;
        } else if (layer.type === 'sticker') {
          el.innerHTML = `<div style="font-size: ${layer.styles?.size || 80}px; pointer-events: none;">${layer.content || layer.emoji || ''}</div>`;
        } else if (layer.type === 'music') {
          const track = layer.track || window.HubbleEditor.state.musicTrack || {};
          const artwork = track.artwork || layer.artwork || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=150&h=150&q=80';
          const title = track.title || layer.content || 'Music';
          const artist = track.artist || layer.artist || '';

          el.innerHTML = `
            <div class="story-music-sticker-card" style="display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: rgba(20, 20, 25, 0.85); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.2); border-radius: 24px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); color: white; min-width: 140px; max-width: 260px; user-select: none;">
              <div style="position: relative; width: 32px; height: 32px; flex-shrink: 0;">
                <img src="${artwork}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 1.5px solid rgba(255,255,255,0.4);" alt="Artwork" />
                <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.3); border-radius: 50%;">
                  <span style="font-size: 11px;">🎵</span>
                </div>
              </div>
              <div style="display: flex; flex-direction: column; min-width: 0; text-align: left;">
                <span style="font-size: 12px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2;">${title}</span>
                <span style="font-size: 10px; color: rgba(255,255,255,0.7); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px;">${artist}</span>
              </div>
            </div>
          `;
        } else if (layer.type === 'location') {
          const loc = layer.loc || window.HubbleEditor.state.selectedLocation || {};
          const locName = typeof loc === 'string' ? loc : (loc.displayName || loc.name || layer.content || 'Location');

          el.innerHTML = `
            <div class="story-location-sticker-card" style="display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; background: linear-gradient(135deg, rgba(168,85,247,0.85) 0%, rgba(126,34,206,0.9) 100%); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.25); border-radius: 20px; box-shadow: 0 6px 20px rgba(168,85,247,0.35); color: white; user-select: none;">
              <span style="font-size: 13px;">📍</span>
              <span style="font-size: 12px; font-weight: 700; color: #fff; white-space: nowrap; text-shadow: 0 1px 2px rgba(0,0,0,0.3);">${locName}</span>
            </div>
          `;
        }
        interactionWrapper.appendChild(el);
      });
      frame.appendChild(interactionWrapper);
    }

    cell.appendChild(frame);
    wrapper.appendChild(cell);
  });

  contentBox.appendChild(wrapper);


  modal.style.display = 'flex';
  requestAnimationFrame(() => modal.style.opacity = '1');
};

// =========================================================================
// HIHUBBLE ADVANCED STORY EDITOR ENGINE
// =========================================================================

window.HubbleEditor = {
  activeMediaIndex: 0,
  state: {
    filter: 'original',
    rotation: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    adjustments: {
      brightness: 100, contrast: 100, exposure: 100, highlights: 100, shadows: 100,
      temperature: 0, tint: 0, saturation: 100, vibrance: 100, sharpness: 0, blur: 0, opacity: 100
    },
    crop: null, // { x, y, width, height, aspect }
    layers: [], // { id, type, content, x, y, rotation, scale, zIndex, styles }
    isMuted: false,
    musicTrack: null, // { url, title, artist }
    selectedLocation: null // { displayName, type, lat, lon }
  },
  history: [],
  redoStack: [],

  // Initialization
  init() {
    this.injectEditorUI();
    this.bindToolButtons();
  },

  injectEditorUI() {
    // We inject a floating editor canvas that appears when tools are active
    if (!document.getElementById('he-canvas-modal')) {
      const isMobile = window.innerWidth <= 768;
      const modal = document.createElement('div');
      modal.id = 'he-canvas-modal';
      modal.style.cssText = isMobile 
        ? 'position: fixed; inset: 0; width: 100%; height: 100dvh; margin: 0; padding: 0; box-sizing: border-box; background: var(--bg-app, #111); z-index: 9990; display: none; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.3s; flex-direction: column;'
        : 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: var(--bg-app, #111); backdrop-filter: blur(12px); z-index: 9990; display: none; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.3s;';

      const toolbarStyle = isMobile
        ? 'position: relative; top: 0; left: 0; right: 0; width: 100%; box-sizing: border-box; padding: 12px 8px; display: flex; justify-content: space-between; align-items: center; z-index: 9995; flex-shrink: 0;'
        : 'position: absolute; top: 20px; left: 20px; right: 20px; display: flex; justify-content: space-between; align-items: center; z-index: 9995;';

      const workspaceStyle = isMobile
        ? 'position: relative; width: 100%; height: auto; flex: 1 1 auto; max-width: none; max-height: none; margin: 0; display: flex; align-items: center; justify-content: center;'
        : 'position: relative; width: 80%; height: 80%; max-width: 1000px; display: flex; align-items: center; justify-content: center;';

      modal.innerHTML = `
        <div id="he-top-toolbar" style="${toolbarStyle}">
          <div style="display: flex; gap: 6px; flex-shrink: 0;">
            <button onclick="HubbleEditor.undo()" id="he-undo-btn" class="ch-premium-tool-btn" style="width: 40px !important; height: 40px !important; border-radius: 12px; background: var(--card-bg, rgba(255,255,255,0.1)); color: var(--text-main, white); border: none; cursor: pointer; opacity: 0.5; pointer-events: none; display: flex; align-items: center; justify-content: center; flex-shrink: 0;"><i data-lucide="undo" style="width: 18px; height: 18px;"></i></button>
            <button onclick="HubbleEditor.redo()" id="he-redo-btn" class="ch-premium-tool-btn" style="width: 40px !important; height: 40px !important; border-radius: 12px; background: var(--card-bg, rgba(255,255,255,0.1)); color: var(--text-main, white); border: none; cursor: pointer; opacity: 0.5; pointer-events: none; display: flex; align-items: center; justify-content: center; flex-shrink: 0;"><i data-lucide="redo" style="width: 18px; height: 18px;"></i></button>
          </div>
          
          <div style="position: relative; display: flex; border-radius: 12px; background: var(--card-bg, rgba(255,255,255,0.1)); box-shadow: 0 4px 12px rgba(0,0,0,0.2); flex-shrink: 0; white-space: nowrap;">
            <button onclick="HubbleEditor.pushHistory(); HubbleEditor.state.rotation = (HubbleEditor.state.rotation + 90) % 360; HubbleEditor.updateRender();" class="ch-premium-tool-btn he-rotate-btn" style="width: auto !important; overflow: visible !important; padding: 0 10px; height: 40px; border-radius: 12px 0 0 12px; background: transparent; color: var(--text-main, white); border: none; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px; flex-shrink: 0; white-space: nowrap;"><i data-lucide="rotate-cw" style="width: 16px; height: 16px;"></i> <span class="he-rotate-text" style="flex-shrink: 0; white-space: nowrap;">Rotate</span></button>
            <div style="width: 1px; background: var(--border-color, rgba(255,255,255,0.1)); margin: 6px 0;"></div>
            <button onclick="HubbleEditor.toggleManualRotate()" class="ch-premium-tool-btn" style="width: 36px !important; height: 40px !important; border-radius: 0 12px 12px 0; background: transparent; color: var(--text-main, white); border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;"><i data-lucide="chevron-down" style="width: 16px; height: 16px;"></i></button>
            
            <div id="he-manual-rotate-panel" class="he-manual-rotate-panel" style="display: none; position: absolute; top: 52px; right: 0; width: 280px; background: var(--card-bg, rgba(20,20,25,0.85)); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); z-index: 9996; flex-direction: column;">
               <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                 <span style="font-size: 0.95rem; font-weight: 600; color: white;">Manual Rotate</span>
                 <span id="he-manual-rotate-val" style="font-size: 0.85rem; color: var(--primary); font-weight: bold; background: rgba(168,85,247,0.15); padding: 4px 10px; border-radius: 8px; font-variant-numeric: tabular-nums;">0&deg;</span>
               </div>
               <input type="range" id="he-manual-rotate-slider" class="he-custom-slider" min="-180" max="180" value="0" oninput="HubbleEditor.onManualRotate(this.value)">
               <div style="display: flex; gap: 12px; margin-top: 24px;">
                 <button class="he-glass-btn he-cancel-btn" onclick="HubbleEditor.resetManualRotate()">Reset</button>
                 <button class="he-premium-apply-btn" onclick="HubbleEditor.applyManualRotate()">Apply</button>
               </div>
            </div>
          </div>
          <button onclick="HubbleEditor.closeCanvas()" class="ch-premium-tool-btn" style="width: auto !important; overflow: visible !important; padding: 0 12px; height: 40px; border-radius: 12px; background: linear-gradient(135deg, var(--primary) 0%, #a855f7 100%); color: white; border: none; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; flex-shrink: 0; white-space: nowrap;"><i data-lucide="check" style="width: 16px; height: 16px;"></i> Done Editing</button>
        </div>
        
        <div id="he-workspace" style="${workspaceStyle}">
          <div id="he-render-container" style="position: relative; box-shadow: 0 20px 50px rgba(0,0,0,0.5); overflow: hidden; display: flex; align-items: center; justify-content: center;">
            <div id="he-media-layer" style="position: absolute; width: 100%; height: 100%; transition: transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);"></div>
            <div id="he-interaction-layer" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;"></div>
            <div id="he-crop-overlay" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; display: none;">
               <!-- Crop Grid generated dynamically -->
            </div>
          </div>
        </div>
        
        <!-- Floating Tool Panels -->
        <div id="he-panels-container" style="position: absolute; left: 24px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 16px; z-index: 9995;">
           <!-- Panels injected here dynamically based on active tool -->
        </div>
      `;
      document.body.appendChild(modal);
      if (window.lucide) window.lucide.createIcons();

      const overlay = document.getElementById('he-crop-overlay');
      const container = document.getElementById('he-render-container');

      if (overlay) overlay.style.cursor = 'move';

      if (container && !container.dataset.zoomPanBound) {
        container.dataset.zoomPanBound = "true";

        // Mouse Wheel Zoom
        container.addEventListener('wheel', (e) => {
          if (e.target.closest('#he-video-controls') || e.target.closest('#he-review-controls') || e.target.closest('.he-delete-btn') || e.target.closest('.ch-premium-tool-btn')) return;
          e.preventDefault();
          const rect = container.getBoundingClientRect();

          const mouseX = ((e.clientX - rect.left) / rect.width * 100) - 50;
          const mouseY = ((e.clientY - rect.top) / rect.height * 100) - 50;

          const oldZoom = HubbleEditor.state.zoom || 1;
          const zoomDelta = e.deltaY > 0 ? -0.05 : 0.05;
          let newZoom = Math.max(0.5, Math.min(3, oldZoom + zoomDelta));

          if (newZoom !== oldZoom) {
            HubbleEditor.state.panX = (HubbleEditor.state.panX || 0) - (mouseX - (HubbleEditor.state.panX || 0)) * (newZoom / oldZoom - 1);
            HubbleEditor.state.panY = (HubbleEditor.state.panY || 0) - (mouseY - (HubbleEditor.state.panY || 0)) * (newZoom / oldZoom - 1);
            HubbleEditor.setCropZoom(newZoom);
          }
        }, { passive: false });

        // Mouse Drag Pan
        let isMousePanning = false;
        let mousePanStartX, mousePanStartY, mouseInitialPanX, mouseInitialPanY;

        container.addEventListener('mousedown', (e) => {
          if (e.target.closest('#he-video-controls') || e.target.closest('#he-review-controls') || e.target.closest('.he-delete-btn') || e.target.closest('.ch-premium-tool-btn')) return;
          if ((HubbleEditor.state.zoom || 1) <= 1) return;
          isMousePanning = true;
          mousePanStartX = e.clientX;
          mousePanStartY = e.clientY;
          mouseInitialPanX = HubbleEditor.state.panX || 0;
          mouseInitialPanY = HubbleEditor.state.panY || 0;
        });

        window.addEventListener('mousemove', (e) => {
          if (isMousePanning) {
            e.preventDefault();
            const rect = container.getBoundingClientRect();
            const dx = ((e.clientX - mousePanStartX) / rect.width) * 100;
            const dy = ((e.clientY - mousePanStartY) / rect.height) * 100;

            HubbleEditor.state.panX = mouseInitialPanX + dx;
            HubbleEditor.state.panY = mouseInitialPanY + dy;
            HubbleEditor.enforcePanConstraints();
            HubbleEditor.updateRender();
          }
        });

        window.addEventListener('mouseup', () => { isMousePanning = false; });

        // Touch Zoom and Pan
        let initialPinchDist = null;
        let initialZoom = 1;
        let initialPanX = 0, initialPanY = 0;
        let initialPinchCenter = null;
        let isTouchPanning = false;
        let touchPanStartX, touchPanStartY;

        container.addEventListener('touchstart', (e) => {
          if (e.target.closest('#he-video-controls') || e.target.closest('#he-review-controls') || e.target.closest('.he-delete-btn') || e.target.closest('.ch-premium-tool-btn')) return;
          if (e.touches.length === 2) {
            e.preventDefault();
            isTouchPanning = false;
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            initialPinchDist = Math.sqrt(dx * dx + dy * dy);
            initialZoom = HubbleEditor.state.zoom || 1;
            initialPanX = HubbleEditor.state.panX || 0;
            initialPanY = HubbleEditor.state.panY || 0;
            initialPinchCenter = {
              x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
              y: (e.touches[0].clientY + e.touches[1].clientY) / 2
            };
          } else if (e.touches.length === 1) {
            if ((HubbleEditor.state.zoom || 1) <= 1) return;
            isTouchPanning = true;
            touchPanStartX = e.touches[0].clientX;
            touchPanStartY = e.touches[0].clientY;
            initialPanX = HubbleEditor.state.panX || 0;
            initialPanY = HubbleEditor.state.panY || 0;
          }
        }, { passive: false });

        container.addEventListener('touchmove', (e) => {
          if (e.touches.length === 2 && initialPinchDist) {
            e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const scale = dist / initialPinchDist;
            let newZoom = Math.max(0.5, Math.min(3, initialZoom * scale));

            const rect = container.getBoundingClientRect();

            const currentCenterX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const currentCenterY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

            const panDeltaX = ((currentCenterX - initialPinchCenter.x) / rect.width) * 100;
            const panDeltaY = ((currentCenterY - initialPinchCenter.y) / rect.height) * 100;

            const mouseX = ((initialPinchCenter.x - rect.left) / rect.width * 100) - 50;
            const mouseY = ((initialPinchCenter.y - rect.top) / rect.height * 100) - 50;

            HubbleEditor.state.panX = initialPanX - (mouseX - initialPanX) * (newZoom / initialZoom - 1) + panDeltaX;
            HubbleEditor.state.panY = initialPanY - (mouseY - initialPanY) * (newZoom / initialZoom - 1) + panDeltaY;
            HubbleEditor.setCropZoom(newZoom);
          } else if (e.touches.length === 1 && isTouchPanning) {
            e.preventDefault();
            const rect = container.getBoundingClientRect();
            const dx = ((e.touches[0].clientX - touchPanStartX) / rect.width) * 100;
            const dy = ((e.touches[0].clientY - touchPanStartY) / rect.height) * 100;

            HubbleEditor.state.panX = initialPanX + dx;
            HubbleEditor.state.panY = initialPanY + dy;
            HubbleEditor.enforcePanConstraints();
            HubbleEditor.updateRender();
          }
        }, { passive: false });

        container.addEventListener('touchend', (e) => {
          if (e.touches.length < 2) initialPinchDist = null;
          if (e.touches.length === 0) isTouchPanning = false;
        });
      }
    }
  },

  bindToolButtons() {
    const buttons = document.querySelectorAll('.ch-image-tools .ch-premium-tool-btn');
    buttons.forEach((btn, index) => {
      btn.onclick = (e) => {
        e.preventDefault();

        // Music Tool Button
        if (btn.id === 'ch-tool-music-btn' || btn.classList.contains('ch-tool-music')) {
          if (typeof window.openStoryMusicPicker === 'function') {
            window.openStoryMusicPicker();
          } else if (typeof window.openMusicPicker === 'function') {
            window.openMusicPicker();
          }
          return;
        }

        // Location Tool Button
        if (btn.id === 'ch-tool-location-btn' || btn.classList.contains('ch-tool-location')) {
          if (typeof window.openStoryLocationPicker === 'function') {
            window.openStoryLocationPicker();
          } else if (typeof window.openLocationPicker === 'function') {
            window.openLocationPicker();
          }
          return;
        }

        if (!window.chUploads || window.chUploads.length === 0) {
          if (window.showToast) window.showToast('Please upload media first.');
          return;
        }

        const tools = ['filters', 'crop', 'rotate', 'adjust', 'stickers', 'text'];

        // Remove active class from canvas-editing tools only (0-5)
        buttons.forEach((b, i) => {
          if (i < 6) {
            b.classList.remove('active');
            b.style.background = 'rgba(255,255,255,0.05)';
            b.style.borderColor = 'rgba(255,255,255,0.1)';
            b.style.boxShadow = 'none';
            b.style.color = 'var(--text-main)';
            const span = b.nextElementSibling;
            if (span) {
              span.style.color = 'var(--text-muted)';
              span.style.fontWeight = 'normal';
              span.style.textShadow = 'none';
            }
          }
        });

        // Add active to current canvas tool
        btn.classList.add('active');
        btn.style.background = 'rgba(168, 85, 247, 0.2)';
        btn.style.borderColor = 'rgba(168, 85, 247, 0.5)';
        btn.style.boxShadow = '0 4px 15px rgba(168, 85, 247, 0.4), inset 0 0 10px rgba(168, 85, 247, 0.2)';
        btn.style.color = 'var(--primary)';
        const activeSpan = btn.nextElementSibling;
        if (activeSpan) {
          activeSpan.style.color = 'var(--primary)';
          activeSpan.style.fontWeight = '600';
          activeSpan.style.textShadow = '0 0 10px rgba(168, 85, 247, 0.3)';
        }

        if (tools[index] === 'text' && HubbleEditor.activeSelectedLayerId) {
          this.openTextTool(HubbleEditor.activeSelectedLayerId);
        } else if (tools[index]) {
          this.openTool(tools[index]);
        }
      };
    });
  },

  // Live Text Editor State
  textState: { text: '', color: '#ffffff', font: 'inherit', bold: false, italic: false, layerId: null },

  openTextTool(layerId = null) {
    if (layerId) {
      const layer = this.state.layers.find(l => l.id === layerId);
      if (layer) {
        this.textState = {
          text: layer.content,
          color: layer.styles.color || '#ffffff',
          font: layer.styles.font || 'inherit',
          bold: !!layer.styles.bold,
          italic: !!layer.styles.italic,
          layerId: layer.id
        };
      }
    } else {
      this.textState = { text: '', color: '#ffffff', font: 'inherit', bold: false, italic: false, layerId: null };
    }

    const buttons = document.querySelectorAll('.ch-image-tools .ch-premium-tool-btn');
    buttons.forEach((b, i) => {
      if (i === 5) {
        b.classList.add('active');
        b.style.background = 'rgba(168, 85, 247, 0.2)';
        b.style.borderColor = 'rgba(168, 85, 247, 0.5)';
        b.style.boxShadow = '0 4px 15px rgba(168, 85, 247, 0.4), inset 0 0 10px rgba(168, 85, 247, 0.2)';
        b.style.color = 'var(--primary)';
        const activeSpan = b.nextElementSibling;
        if (activeSpan) {
          activeSpan.style.color = 'var(--primary)';
          activeSpan.style.fontWeight = '600';
          activeSpan.style.textShadow = '0 0 10px rgba(168, 85, 247, 0.3)';
        }
      } else {
        b.classList.remove('active');
        b.style.background = 'rgba(255,255,255,0.05)';
        b.style.borderColor = 'rgba(255,255,255,0.1)';
        b.style.boxShadow = 'none';
        b.style.color = 'var(--text-main)';
        const span = b.nextElementSibling;
        if (span) {
          span.style.color = 'var(--text-muted)';
          span.style.fontWeight = 'normal';
          span.style.textShadow = 'none';
        }
      }
    });

    this.openTool('text');
  },

  updateLiveTextColor(color) {
    this.textState.color = color;
    this.updateLiveText();

    const colorInput = document.getElementById('he-text-color-picker');
    if (colorInput) colorInput.value = color;

    const hiddenInput = document.getElementById('he-text-color');
    if (hiddenInput) hiddenInput.value = color;

    const swatches = document.querySelectorAll('.he-color-swatch');
    swatches.forEach(s => {
      if (s.dataset.color.toLowerCase() === color.toLowerCase()) {
        s.style.border = '2px solid var(--primary, #a855f7)';
      } else {
        s.style.border = '2px solid rgba(255,255,255,0.1)';
      }
    });
  },

  toggleTextFormat(type) {
    if (type === 'bold') {
      this.textState.bold = !this.textState.bold;
      const btn = document.getElementById('he-text-bold');
      if (btn) {
        btn.style.border = this.textState.bold ? '1px solid var(--primary, #a855f7)' : '1px solid rgba(255,255,255,0.1)';
        btn.style.background = this.textState.bold ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.05)';
      }
    }
    if (type === 'italic') {
      this.textState.italic = !this.textState.italic;
      const btn = document.getElementById('he-text-italic');
      if (btn) {
        btn.style.border = this.textState.italic ? '1px solid var(--primary, #a855f7)' : '1px solid rgba(255,255,255,0.1)';
        btn.style.background = this.textState.italic ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.05)';
      }
    }
    this.updateLiveText();
  },

  updateLiveText() {
    const input = document.getElementById('he-text-input');
    const font = document.getElementById('he-text-font');

    if (!input || !font) return;

    this.textState.text = input.value;
    this.textState.font = font.value;

    let layerToUpdate = null;
    let shouldRender = false;

    if (this.textState.text.trim() !== '') {
      if (this.textState.layerId) {
        const layer = this.state.layers.find(l => l.id === this.textState.layerId);
        if (layer) {
          layer.content = this.textState.text;
          layer.styles = { ...layer.styles, color: this.textState.color, font: this.textState.font, bold: this.textState.bold, italic: this.textState.italic };
          layerToUpdate = layer;
        }
      } else {
        const id = Date.now();
        this.textState.layerId = id;
        this.state.layers.push({
          id, type: 'text', content: this.textState.text, x: 50, y: 50, rotation: 0, scale: 1, zIndex: this.state.layers.length + 10,
          styles: { color: this.textState.color, font: this.textState.font, bold: this.textState.bold, italic: this.textState.italic, size: 32 }
        });
        this.activeSelectedLayerId = id;
        shouldRender = true;
      }
    } else {
      if (this.textState.layerId) {
        this.state.layers = this.state.layers.filter(l => l.id !== this.textState.layerId);
        this.textState.layerId = null;
        this.activeSelectedLayerId = null;
        shouldRender = true;
      }
    }

    if (shouldRender) {
      this.updateRender();
    } else if (layerToUpdate) {
      // Fast DOM update for color, font, typing
      const interactionLayer = document.getElementById('he-interaction-layer');
      if (interactionLayer) {
        const el = Array.from(interactionLayer.children).find(child => child.dataset.layerId == layerToUpdate.id);
        if (el && el.firstElementChild) {
          const textDiv = el.firstElementChild;
          textDiv.style.color = layerToUpdate.styles.color || 'white';
          textDiv.style.fontFamily = layerToUpdate.styles.font || 'inherit';
          textDiv.style.fontWeight = layerToUpdate.styles.bold ? 'bold' : 'normal';
          textDiv.style.fontStyle = layerToUpdate.styles.italic ? 'italic' : 'normal';
          textDiv.textContent = layerToUpdate.content;
        }
      }
    }

    const btn = document.getElementById('he-text-add-btn');
    if (btn) {
      const hasText = this.textState.text.trim().length > 0;
      btn.style.background = hasText ? 'linear-gradient(135deg, var(--primary, #a855f7) 0%, #7e22ce 100%)' : 'rgba(255,255,255,0.1)';
      btn.style.boxShadow = hasText ? '0 8px 20px rgba(168,85,247,0.3)' : 'none';
      btn.style.color = hasText ? 'white' : 'rgba(255,255,255,0.4)';
      btn.style.cursor = hasText ? 'pointer' : 'not-allowed';
      btn.style.pointerEvents = hasText ? 'all' : 'none';
      const isExisting = this.textState.layerId && this.history && this.history.length > 0 && this.history.some(h => h.layers.some(l => l.id === this.textState.layerId));
      btn.innerText = isExisting ? 'Update Text' : 'Add Text';
    }
  },

  commitLiveText() {
    if (!this.textState.text.trim()) return;
    this.pushHistory();
    this.textState = { text: '', color: '#ffffff', font: 'inherit', bold: false, italic: false, layerId: null };
    this.renderPanels('text');
  },

  toggleManualRotate() {
    const panel = document.getElementById('he-manual-rotate-panel');
    if (!panel) return;
    if (panel.style.display === 'none') {
      let r = this.state.rotation % 360;
      if (r > 180) r -= 360;
      else if (r < -180) r += 360;

      const slider = document.getElementById('he-manual-rotate-slider');
      if (slider) slider.value = r;

      const valEl = document.getElementById('he-manual-rotate-val');
      if (valEl) valEl.innerText = Math.round(r) + '°';

      panel.style.display = 'flex';
      panel.style.opacity = '0';
      panel.style.transform = 'scale(0.95) translateY(-10px)';
      requestAnimationFrame(() => {
        panel.style.transition = 'all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)';
        panel.style.opacity = '1';
        panel.style.transform = 'scale(1) translateY(0)';
      });
    } else {
      panel.style.opacity = '0';
      panel.style.transform = 'scale(0.95) translateY(-10px)';
      setTimeout(() => { panel.style.display = 'none'; }, 200);
    }
  },

  onManualRotate(val) {
    this.state.rotation = parseFloat(val);
    const valEl = document.getElementById('he-manual-rotate-val');
    if (valEl) valEl.innerText = Math.round(val) + '°';
    this.updateRender();
  },

  resetManualRotate() {
    this.state.rotation = 0;
    const slider = document.getElementById('he-manual-rotate-slider');
    if (slider) slider.value = 0;
    const valEl = document.getElementById('he-manual-rotate-val');
    if (valEl) valEl.innerText = '0°';
    this.updateRender();
  },

  applyManualRotate() {
    this.pushHistory();
    const panel = document.getElementById('he-manual-rotate-panel');
    if (panel) {
      panel.style.opacity = '0';
      panel.style.transform = 'scale(0.95) translateY(-10px)';
      setTimeout(() => { panel.style.display = 'none'; }, 200);
    }
  },

  openTool(toolName) {
    if (toolName === 'text' && (!this.textState || this.textState.layerId === null)) {
      this.textState = { text: '', color: '#ffffff', font: 'inherit', bold: false, italic: false, layerId: null };
    }
    this.openCanvas();
    this.renderPanels(toolName);

    if (toolName === 'crop') {
      this.enterCropMode();
    }
  },


  enterCropMode() {
    this.tempCrop = this.state.crop ? JSON.parse(JSON.stringify(this.state.crop)) : { x: 10, y: 10, width: 80, height: 80, aspect: 'Free' };
    const overlay = document.getElementById('he-crop-overlay');
    if (overlay) {
      overlay.style.display = 'block';
      overlay.style.pointerEvents = 'all';
    }
    // Also disable layer dragging during crop
    const layers = document.getElementById('he-interaction-layer');
    if (layers) layers.style.pointerEvents = 'none';

    this.renderCropHandles();
  },

  exitCropMode(save) {
    if (save && this.tempCrop) {
      this.pushHistory();
      this.state.crop = JSON.parse(JSON.stringify(this.tempCrop));
      this.updateRender();
    }
    this.tempCrop = null;
    const overlay = document.getElementById('he-crop-overlay');
    if (overlay) {
      overlay.style.display = 'none';
      overlay.style.pointerEvents = 'none';
    }
    const layers = document.getElementById('he-interaction-layer');
    if (layers) layers.style.pointerEvents = 'none';

    // Close the panel
    this.closeCanvas();
  },

  setCropAspect(ratio) {
    if (!this.tempCrop) return;
    this.tempCrop.aspect = ratio;

    // Reset to center 80% if changing aspect
    if (ratio === 'Free') {
      this.tempCrop.width = 80; this.tempCrop.height = 80;
    } else {
      const [w, h] = ratio.split(':').map(Number);
      const container = document.getElementById('he-render-container');
      const rect = container.getBoundingClientRect();
      const containerAspect = rect.width / rect.height;
      const targetAspect = w / h;

      if (targetAspect > containerAspect) {
        this.tempCrop.width = 80;
        this.tempCrop.height = 80 * (containerAspect / targetAspect);
      } else {
        this.tempCrop.height = 80;
        this.tempCrop.width = 80 * (targetAspect / containerAspect);
      }
    }

    this.tempCrop.x = (100 - this.tempCrop.width) / 2;
    this.tempCrop.y = (100 - this.tempCrop.height) / 2;
    this.renderCropHandles();
    this.renderPanels('crop'); // update buttons
  },

  enforcePanConstraints() {
    let crop = this.tempCrop || this.state.crop || { x: 0, y: 0, width: 100, height: 100 };
    let z = this.state.zoom || 1;
    let { x, y, width, height } = crop;

    let minPanX = x + width - 50 - 50 * z;
    let maxPanX = x - 50 + 50 * z;
    if (minPanX > maxPanX) {
      this.state.panX = (minPanX + maxPanX) / 2;
    } else {
      this.state.panX = Math.max(minPanX, Math.min(maxPanX, this.state.panX || 0));
    }

    let minPanY = y + height - 50 - 50 * z;
    let maxPanY = y - 50 + 50 * z;
    if (minPanY > maxPanY) {
      this.state.panY = (minPanY + maxPanY) / 2;
    } else {
      this.state.panY = Math.max(minPanY, Math.min(maxPanY, this.state.panY || 0));
    }
  },

  setCropZoom(val) {
    let z = Math.max(0.5, Math.min(3, val));
    this.state.zoom = z;

    this.enforcePanConstraints();

    const slider = document.getElementById('he-zoom-slider');
    if (slider) slider.value = z;
    const valEl = document.getElementById('he-zoom-val');
    if (valEl) valEl.innerText = Math.round(z * 100) + '%';

    this.updateRender();
  },

  renderCropHandles() {
    const overlay = document.getElementById('he-crop-overlay');
    if (!overlay) return;

    overlay.innerHTML = '';

    const box = document.createElement('div');
    box.id = 'he-crop-box';
    box.style.cssText = `
      position: absolute;
      left: ${this.tempCrop.x}%;
      top: ${this.tempCrop.y}%;
      width: ${this.tempCrop.width}%;
      height: ${this.tempCrop.height}%;
      border: 2px solid white;
      box-shadow: 0 0 0 9999px rgba(0,0,0,0.7);
      pointer-events: none;
    `;

    const handlePositions = [
      { top: '-6px', left: '-6px', cursor: 'nwse-resize', id: 'tl' },
      { top: '-6px', left: 'calc(50% - 6px)', cursor: 'ns-resize', id: 'tc' },
      { top: '-6px', right: '-6px', cursor: 'nesw-resize', id: 'tr' },
      { top: 'calc(50% - 6px)', left: '-6px', cursor: 'ew-resize', id: 'ml' },
      { top: 'calc(50% - 6px)', right: '-6px', cursor: 'ew-resize', id: 'mr' },
      { bottom: '-6px', left: '-6px', cursor: 'nesw-resize', id: 'bl' },
      { bottom: '-6px', left: 'calc(50% - 6px)', cursor: 'ns-resize', id: 'bc' },
      { bottom: '-6px', right: '-6px', cursor: 'nwse-resize', id: 'br' }
    ];

    handlePositions.forEach(pos => {
      const h = document.createElement('div');
      h.style.cssText = `
        position: absolute;
        width: 12px; height: 12px;
        background: white; border-radius: 50%;
        cursor: ${pos.cursor};
        pointer-events: all;
        ${pos.top ? `top: ${pos.top};` : ''}
        ${pos.bottom ? `bottom: ${pos.bottom};` : ''}
        ${pos.left ? `left: ${pos.left};` : ''}
        ${pos.right ? `right: ${pos.right};` : ''}
      `;
      this.bindCropDrag(h, pos.id);
      box.appendChild(h);
    });

    overlay.appendChild(box);
  },

  bindCropDrag(element, type) {
    element.onmousedown = (e) => {
      e.stopPropagation();
      let isDragging = true;
      let startX = e.clientX;
      let startY = e.clientY;
      const startCrop = JSON.parse(JSON.stringify(this.tempCrop));
      const startPanX = this.state.panX || 0;
      const startPanY = this.state.panY || 0;

      const move = (ev) => {
        if (!isDragging) return;
        const container = document.getElementById('he-render-container');
        const rect = container.getBoundingClientRect();

        const dx = ((ev.clientX - startX) / rect.width) * 100;
        const dy = ((ev.clientY - startY) / rect.height) * 100;

        let { x, y, width, height, aspect } = startCrop;

        if (type.includes('l')) { x += dx; width -= dx; }
        if (type.includes('r')) { width += dx; }
        if (type.includes('t')) { y += dy; height -= dy; }
        if (type.includes('b')) { height += dy; }

        if (aspect !== 'Free') {
          const [wRatio, hRatio] = aspect.split(':').map(Number);
          const targetRatio = wRatio / hRatio;
          const containerRatio = rect.width / rect.height;

          if (type.includes('l') || type.includes('r')) {
            height = width * (containerRatio / targetRatio);
            if (type.includes('t')) y = startCrop.y - (height - startCrop.height);
          } else {
            width = height * (targetRatio / containerRatio);
            if (type.includes('l')) x = startCrop.x - (width - startCrop.width);
          }
        }

        // Clamp bounds
        if (x < 0) x = 0;
        if (y < 0) y = 0;
        if (x + width > 100) { width = 100 - x; }
        if (y + height > 100) { height = 100 - y; }

        width = Math.max(10, width);
        height = Math.max(10, height);

        this.tempCrop = { ...this.tempCrop, x, y, width, height };

        const box = document.getElementById('he-crop-box');
        if (box) {
          box.style.left = `${this.tempCrop.x}%`;
          box.style.top = `${this.tempCrop.y}%`;
          box.style.width = `${this.tempCrop.width}%`;
          box.style.height = `${this.tempCrop.height}%`;
        }
      };

      const up = () => {
        isDragging = false;
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };

      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    };
  },

  openCanvas() {
    const modal = document.getElementById('he-canvas-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.style.opacity = '1');

    if (this.history.length === 0) {
      this.pushHistory(); // Initial state
    }

    this.updateRender();
    const currentVideo = document.querySelector('#he-media-layer video');
    if (currentVideo) {
      currentVideo.pause();
    }
  },

  cleanupMedia() {
    if (typeof window.cleanupStoryMedia === 'function') {
      window.cleanupStoryMedia();
    }
  },

  closeCanvas() {
    const overlay = document.getElementById('he-crop-overlay');
    if (overlay && overlay.style.display !== 'none') {
      overlay.style.display = 'none';
      overlay.style.pointerEvents = 'none';
    }
    const modal = document.getElementById('he-canvas-modal');
    if (!modal) return;

    // HALT Editor Video & Audio
    this.cleanupMedia();

    // Sync state one final time
    if (window.chUploads && window.chUploads[this.activeMediaIndex]) {
      window.chUploads[this.activeMediaIndex].editorState = JSON.parse(JSON.stringify(this.state));
    }

    modal.style.opacity = '0';
    setTimeout(() => {
      modal.style.display = 'none';
      document.getElementById('he-panels-container').innerHTML = '';

      // Also update the tiny thumbnails to reflect changes visually
      if (typeof window.initCreateHubbsUpload === 'function') {
        const thumbs = document.querySelectorAll('.ch-preview-item img, .ch-preview-item video');
        if (thumbs[this.activeMediaIndex]) {
          thumbs[this.activeMediaIndex].style.filter = this.buildCSSFilterString();
          thumbs[this.activeMediaIndex].style.transform = `rotate(${this.state.rotation}deg)`;
        }
      }
    }, 300);
  },

  pushHistory() {
    this.history.push(JSON.parse(JSON.stringify(this.state)));
    this.redoStack = []; // Clear redo stack on new action
    this.updateUndoRedoUI();
  },

  undo() {
    if (this.history.length > 1) {
      this.redoStack.push(JSON.parse(JSON.stringify(this.state)));
      this.history.pop(); // Remove current state
      this.state = JSON.parse(JSON.stringify(this.history[this.history.length - 1]));
      this.updateRender();
      this.updateUndoRedoUI();
    }
  },

  redo() {
    if (this.redoStack.length > 0) {
      this.history.push(JSON.parse(JSON.stringify(this.state)));
      this.state = JSON.parse(JSON.stringify(this.redoStack.pop()));
      this.updateRender();
      this.updateUndoRedoUI();
    }
  },

  updateUndoRedoUI() {
    const undoBtn = document.getElementById('he-undo-btn');
    const redoBtn = document.getElementById('he-redo-btn');
    if (undoBtn) {
      undoBtn.style.opacity = this.history.length > 1 ? '1' : '0.5';
      undoBtn.style.pointerEvents = this.history.length > 1 ? 'all' : 'none';
    }
    if (redoBtn) {
      redoBtn.style.opacity = this.redoStack.length > 0 ? '1' : '0.5';
      redoBtn.style.pointerEvents = this.redoStack.length > 0 ? 'all' : 'none';
    }
  },

  getEditedAspectRatio(item) {
    if (!item) return 1;
    let w = item.originalWidth || 1000;
    let h = item.originalHeight || 1000;

    // First, apply crop
    if (item.editorState && item.editorState.crop) {
      w = w * (item.editorState.crop.width / 100);
      h = h * (item.editorState.crop.height / 100);
    }

    // Then rotation
    if (item.editorState && item.editorState.rotation) {
      const r = Math.abs(item.editorState.rotation) % 180;
      if (r === 90) {
        const temp = w;
        w = h;
        h = temp;
      }
    }
    return w / h;
  },

  buildCSSFilterString(overrideFilter = null, overrideAdjustments = null) {
    const activeFilter = overrideFilter !== null ? overrideFilter : this.state.filter;
    const adj = overrideAdjustments !== null ? overrideAdjustments : this.state.adjustments;

    const filterPresets = {
      'original': {},
      'bright': { brightness: 10, contrast: 10, saturation: 10 },
      'warm': { temperature: 30, saturation: 10 },
      'cool': { temperature: -30, tint: 10 },
      'vintage': { saturation: -20, temperature: 40, shadows: 20, contrast: -10, exposure: 10 },
      'black & white': { saturation: -100, contrast: 20 },
      'hdr': { contrast: 20, sharpness: 40, shadows: 30, highlights: -20, saturation: 15 },
      'cinematic': { saturation: -15, contrast: 10, temperature: 10, tint: -10, shadows: -10 },
      'soft': { contrast: -15, sharpness: -20, brightness: 5 },
      'dream': { brightness: 10, saturation: 15, blur: 2, contrast: -10 },
      'purple glow': { tint: 40, temperature: 20, saturation: 20 },
      'cool blue': { temperature: -30, shadows: 15, contrast: 10 },
      'sepia': { temperature: 50, tint: 15, saturation: -40 },
      'vivid': { saturation: 40, contrast: 10 },
      'mono': { saturation: -100, contrast: 15 }
    };

    const preset = filterPresets[activeFilter] || {};

    const getVal = (key, defaultVal) => {
      const manualVal = adj[key] !== undefined ? Number(adj[key]) : defaultVal;
      const manualDelta = manualVal - defaultVal;
      const presetDelta = preset[key] || 0;
      return defaultVal + presetDelta + manualDelta;
    };

    const p = {
      brightness: getVal('brightness', 100),
      contrast: getVal('contrast', 100),
      exposure: getVal('exposure', 100),
      highlights: getVal('highlights', 100),
      shadows: getVal('shadows', 100),
      temperature: getVal('temperature', 0),
      tint: getVal('tint', 0),
      saturation: getVal('saturation', 100),
      vibrance: getVal('vibrance', 100),
      sharpness: getVal('sharpness', 0),
      blur: getVal('blur', 0),
      opacity: getVal('opacity', 100)
    };

    const totalSaturate = Math.max(0, p.saturation + (p.vibrance - 100) * 0.5);

    let tableValuesStr = "";
    for (let i = 0; i <= 15; i++) {
      let x = i / 15.0;
      let y = x * (p.exposure / 100);

      let shadowDelta = (p.shadows - 100) / 100;
      if (x < 0.5) y += shadowDelta * (0.5 - x);

      let highlightDelta = (p.highlights - 100) / 100;
      if (x > 0.5) y += highlightDelta * (x - 0.5);

      y += (p.brightness - 100) / 100;
      y = (y - 0.5) * (p.contrast / 100) + 0.5;

      y = Math.max(0, Math.min(1, y));
      tableValuesStr += y.toFixed(3) + " ";
    }
    let tableValues = tableValuesStr.trim();

    let temp = p.temperature / 100;
    let tint = p.tint / 100;

    let rMult = 1 + temp * 0.2 + tint * 0.1;
    let gMult = 1 - tint * 0.2;
    let bMult = 1 - temp * 0.2 + tint * 0.1;

    let colorMatrix = `
       ${rMult} 0 0 0 0
       0 ${gMult} 0 0 0
       0 0 ${bMult} 0 0
       0 0 0 1 0
    `;

    let s = p.sharpness / 100;
    s = Math.max(-0.5, Math.min(2, s));
    let center = 1 + 4 * s;
    let edge = -s;
    let kernelMatrix = `
       0 ${edge} 0
       ${edge} ${center} ${edge}
       0 ${edge} 0
    `;

    let svg = `
       <svg xmlns="http://www.w3.org/2000/svg">
          <filter id="f">
             <feComponentTransfer>
                <feFuncR type="table" tableValues="${tableValues}" />
                <feFuncG type="table" tableValues="${tableValues}" />
                <feFuncB type="table" tableValues="${tableValues}" />
             </feComponentTransfer>
             <feColorMatrix type="matrix" values="${colorMatrix}" />
             ${s !== 0 ? `<feConvolveMatrix order="3" kernelMatrix="${kernelMatrix}" preserveAlpha="true" />` : ''}
          </filter>
       </svg>
    `;

    const encodedSvg = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace(/\s+/g, ' ').trim());

    return `url("${encodedSvg}#f") saturate(${totalSaturate}%) blur(${p.blur}px) opacity(${p.opacity}%)`;
  },
  addLayer(type, content, styles = {}) {
    this.pushHistory();
    const id = Date.now();
    this.state.layers.push({
      id,
      type,
      content,
      x: 50, // Center %
      y: 50, // Center %
      rotation: 0,
      scale: 1,
      zIndex: this.state.layers.length + 10,
      styles
    });
    this.updateRender();
  },

  deleteLayer(layerId) {
    this.pushHistory();
    const layer = this.state.layers.find(l => l.id === layerId);
    if (!layer) return;
    this.state.layers = this.state.layers.filter(l => l.id !== layerId);

    if (layer.type === 'music') {
      this.state.musicTrack = null;
      if (window.StoryAudioManager) window.StoryAudioManager.destroy();
      if (window.chUploads && window.chUploads[this.activeMediaIndex]?.editorState) {
        window.chUploads[this.activeMediaIndex].editorState.musicTrack = null;
        if (window.chUploads[this.activeMediaIndex].editorState.layers) {
          window.chUploads[this.activeMediaIndex].editorState.layers = window.chUploads[this.activeMediaIndex].editorState.layers.filter(l => l.type !== 'music');
        }
      }
      const indicator = document.getElementById('ch-music-selected-indicator');
      if (indicator) indicator.style.display = 'none';
      if (window.showToast) window.showToast('Music removed.');
    } else if (layer.type === 'location') {
      this.state.selectedLocation = null;
      if (window.chUploads && window.chUploads[this.activeMediaIndex]?.editorState) {
        window.chUploads[this.activeMediaIndex].editorState.selectedLocation = null;
        if (window.chUploads[this.activeMediaIndex].editorState.layers) {
          window.chUploads[this.activeMediaIndex].editorState.layers = window.chUploads[this.activeMediaIndex].editorState.layers.filter(l => l.type !== 'location');
        }
      }
      const indicator = document.getElementById('ch-location-selected-indicator');
      if (indicator) indicator.style.display = 'none';
      if (window.showToast) window.showToast('Location removed.');
    }

    if (this.textState && this.textState.layerId === layerId) {
      this.textState = { text: '', color: '#ffffff', font: 'inherit', bold: false, italic: false, layerId: null };
      this.renderPanels('text');
    }
    this.activeSelectedLayerId = null;
    this.updateRender();
    if (window.renderAttachedStoryBadges) window.renderAttachedStoryBadges();
    if (window.saveCurrentDraft) window.saveCurrentDraft(true);
  },

  createDeleteButton(layer) {
    const deleteBtn = document.createElement('div');
    deleteBtn.className = 'he-delete-btn';
    deleteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    deleteBtn.style.cssText = 'position: absolute; top: -14px; right: -14px; background: rgba(255,59,48,0.95); border-radius: 50%; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; cursor: pointer; pointer-events: all; box-shadow: 0 4px 12px rgba(0,0,0,0.4); z-index: 102; transition: transform 0.15s ease;';
    deleteBtn.title = 'Remove';
    deleteBtn.onmouseenter = () => { deleteBtn.style.transform = 'scale(1.1)'; };
    deleteBtn.onmouseleave = () => { deleteBtn.style.transform = 'scale(1)'; };
    deleteBtn.onmousedown = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.deleteLayer(layer.id);
    };
    return deleteBtn;
  },

  addLayerControls(el, layer, interactionLayer) {
    const corners = [
      { class: 'he-resize-nw', cursor: 'nwse-resize', top: '-6px', left: '-6px' },
      { class: 'he-resize-ne', cursor: 'nesw-resize', top: '-6px', right: '-6px' },
      { class: 'he-resize-sw', cursor: 'nesw-resize', bottom: '-6px', left: '-6px' },
      { class: 'he-resize-se', cursor: 'nwse-resize', bottom: '-6px', right: '-6px' }
    ];

    corners.forEach(c => {
      const handle = document.createElement('div');
      handle.className = `he-resize-handle ${c.class}`;
      handle.style.cssText = `position: absolute; width: 14px; height: 14px; background: white; border: 2px solid #a855f7; border-radius: 50%; z-index: 100; cursor: ${c.cursor}; box-shadow: 0 2px 5px rgba(0,0,0,0.3); pointer-events: all; ${c.top ? `top: ${c.top};` : ''} ${c.bottom ? `bottom: ${c.bottom};` : ''} ${c.left ? `left: ${c.left};` : ''} ${c.right ? `right: ${c.right};` : ''}`;

      handle.onmousedown = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.pushHistory();

        const rect = interactionLayer.getBoundingClientRect();
        // The layer center in absolute viewport coords
        const centerX = rect.left + (layer.x / 100) * rect.width;
        const centerY = rect.top + (layer.y / 100) * rect.height;

        const startDist = Math.hypot(ev.clientX - centerX, ev.clientY - centerY);
        const startScale = layer.scale || 1;

        const onMouseMove = (moveEv) => {
          const currentDist = Math.hypot(moveEv.clientX - centerX, moveEv.clientY - centerY);
          let newScale = startScale * (currentDist / startDist);
          if (newScale < 0.2) newScale = 0.2;
          if (newScale > 6) newScale = 6;

          layer.scale = Math.round(newScale * 100) / 100;
          el.style.transform = `translate(-50%, -50%) rotate(${layer.rotation || 0}deg) scale(${layer.scale})`;
        };

        const onMouseUp = () => {
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
          this.updateRender();
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      };
      el.appendChild(handle);
    });

    // Rotate Stalk & Handle
    const rotateStalk = document.createElement('div');
    rotateStalk.className = 'he-rotate-stalk';
    rotateStalk.style.cssText = 'position: absolute; top: -22px; left: 50%; transform: translateX(-50%); width: 1.5px; height: 18px; background: rgba(168,85,247,0.8); pointer-events: none; z-index: 99;';
    el.appendChild(rotateStalk);

    const rotateHandle = document.createElement('div');
    rotateHandle.className = 'he-rotate-handle';
    rotateHandle.style.cssText = 'position: absolute; top: -30px; left: 50%; transform: translateX(-50%); width: 14px; height: 14px; background: #a855f7; border: 2px solid white; border-radius: 50%; z-index: 100; cursor: grab; box-shadow: 0 2px 6px rgba(0,0,0,0.4); pointer-events: all;';
    rotateHandle.title = 'Rotate';

    rotateHandle.onmousedown = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.pushHistory();

      const rect = interactionLayer.getBoundingClientRect();
      const centerX = rect.left + (layer.x / 100) * rect.width;
      const centerY = rect.top + (layer.y / 100) * rect.height;

      const onMouseMove = (moveEv) => {
        const rad = Math.atan2(moveEv.clientY - centerY, moveEv.clientX - centerX);
        let deg = (rad * (180 / Math.PI)) + 90; // offset so top handle is 0
        while (deg < 0) deg += 360;
        while (deg >= 360) deg -= 360;

        // Snap to 0, 90, 180, 270 degrees
        const snapAngles = [0, 90, 180, 270, 360];
        snapAngles.forEach(snap => {
          if (Math.abs(deg - snap) < 5) deg = (snap === 360) ? 0 : snap;
        });

        layer.rotation = Math.round(deg);
        el.style.transform = `translate(-50%, -50%) rotate(${layer.rotation}deg) scale(${layer.scale || 1})`;
      };

      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        this.updateRender();
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    };
    el.appendChild(rotateHandle);

    // Mute / Unmute Toggle on Music Sticker Selection
    if (layer.type === 'music') {
      const isMuted = layer.isMuted || false;
      const muteToggle = document.createElement('div');
      muteToggle.className = 'he-mute-badge-btn';
      muteToggle.style.cssText = 'position: absolute; bottom: -28px; left: 50%; transform: translateX(-50%); background: rgba(20,20,25,0.92); border: 1px solid rgba(255,255,255,0.25); border-radius: 14px; padding: 3px 10px; display: flex; align-items: center; gap: 5px; cursor: pointer; pointer-events: all; box-shadow: 0 4px 12px rgba(0,0,0,0.4); z-index: 100; font-size: 10px; color: white; white-space: nowrap; user-select: none; backdrop-filter: blur(8px);';
      muteToggle.innerHTML = isMuted
        ? '<span style="font-size: 12px;">🔇</span> <span style="font-weight: 600;">Unmute</span>'
        : '<span style="font-size: 12px;">🔊</span> <span style="font-weight: 600;">Mute</span>';

      muteToggle.onmousedown = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        layer.isMuted = !layer.isMuted;
        if (HubbleEditor.state.musicTrack) {
          HubbleEditor.state.musicTrack.isMuted = layer.isMuted;
        }
        if (window.StoryAudioManager) {
          if (layer.isMuted) {
            window.StoryAudioManager.mute();
          } else {
            window.StoryAudioManager.unmute();
          }
        }
        HubbleEditor.updateRender();
        if (window.saveCurrentDraft) window.saveCurrentDraft(true);
        if (window.showToast) window.showToast(layer.isMuted ? 'Music muted 🔇' : 'Music unmuted 🔊');
      };
      el.appendChild(muteToggle);
    }
  },

  updateRender() {
    if (!window.chUploads || window.chUploads.length === 0) return;

    const media = window.chUploads[this.activeMediaIndex];
    if (!media) return;

    const container = document.getElementById('he-render-container');
    const mediaLayer = document.getElementById('he-media-layer');
    const interactionLayer = document.getElementById('he-interaction-layer');

    if (!container || !mediaLayer || !interactionLayer) return;

    // Set Aspect Ratio based on media
    const isMobile = window.innerWidth <= 768;
    container.style.width = isMobile ? '100%' : '400px';
    container.style.maxWidth = isMobile ? '100%' : '400px';
    container.style.height = isMobile ? '100%' : 'auto';
    container.style.maxHeight = isMobile ? '100%' : 'none';
    container.style.aspectRatio = '9/16';
    container.style.background = 'var(--bg-app, transparent)';
    container.style.borderRadius = '16px';

    // Render Media Node
    if (!mediaLayer.firstChild || mediaLayer.firstChild.dataset.url !== media.thumbUrl) {
      if (mediaLayer.firstChild && mediaLayer.firstChild.tagName === 'VIDEO') {
        mediaLayer.firstChild.pause();
        mediaLayer.firstChild.removeAttribute('src');
        mediaLayer.firstChild.load();
      }
      mediaLayer.innerHTML = '';
      let node;
      if (media.type.startsWith('video/')) {
        node = document.createElement('video');
        node.src = URL.createObjectURL(media.file);
        node.loop = true;
        node.muted = window.HubbleEditor.state.isMuted;
        node.autoplay = false;
        node.playsInline = true;
        node.preload = 'auto';

        // Sync Audio timestamp if media is scrubbing/playing
        node.addEventListener('play', () => {
          if (window.StoryAudioManager) {
            window.StoryAudioManager.sync(node.currentTime);
            if (!window.StoryAudioManager.isMuted()) {
              window.StoryAudioManager.play('editor');
            }
          }
        });
        node.addEventListener('seeking', () => {
          if (window.StoryAudioManager) window.StoryAudioManager.sync(node.currentTime);
        });
        node.addEventListener('seeked', () => {
          if (window.StoryAudioManager) window.StoryAudioManager.sync(node.currentTime);
        });

      } else {
        node = document.createElement('img');
        node.src = media.thumbUrl;
      }
      node.dataset.url = media.thumbUrl;
      node.style.cssText = 'width: 100%; height: 100%; object-fit: contain; transform-origin: center center; transition: all 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);';
      node.draggable = false;
      mediaLayer.appendChild(node);
      if (node.tagName === 'VIDEO') {
        node.pause();
      }
    }

    // Ensure we have a reference to the active media node
    const activeMediaNode = mediaLayer.firstChild;

    // Video Controls overlay
    let videoControls = document.getElementById('he-video-controls');
    if (media.type.startsWith('video/')) {
      if (!videoControls) {
        videoControls = this.buildVideoControls(container, activeMediaNode, false);
      } else {
        videoControls.remove();
        videoControls = this.buildVideoControls(container, activeMediaNode, false);
      }
    } else {
      if (videoControls) {
        videoControls.remove();
      }
    }

    // Apply Transforms, Filters & Zoom
    activeMediaNode.style.filter = this.buildCSSFilterString();
    activeMediaNode.style.transform = `translate(${this.state.panX || 0}%, ${this.state.panY || 0}%) rotate(${this.state.rotation}deg) scale(${this.state.zoom || 1})`;

    // Apply Crop Clip-Path to Media and Interaction Layers (but NOT the crop overlay)
    if (this.state.crop) {
      const { x, y, width, height } = this.state.crop;
      const clipPathStr = `inset(${y}% ${100 - (x + width)}% ${100 - (y + height)}% ${x}%)`;
      mediaLayer.style.clipPath = clipPathStr;
      interactionLayer.style.clipPath = clipPathStr;
    } else {
      mediaLayer.style.clipPath = 'none';
      interactionLayer.style.clipPath = 'none';
    }

    // Render Interaction Layers (Stickers / Text / Music / Location)
    interactionLayer.innerHTML = '';
    this.state.layers.forEach((layer, idx) => {
      const el = document.createElement('div');
      el.dataset.layerId = layer.id;
      el.style.cssText = `position: absolute; left: ${layer.x}%; top: ${layer.y}%; transform: translate(-50%, -50%) rotate(${layer.rotation || 0}deg) scale(${layer.scale || 1}); z-index: ${layer.zIndex || 10}; pointer-events: all; cursor: grab;`;

      if (layer.type === 'text') {
        el.innerHTML = `<div style="color: ${layer.styles?.color || layer.color || 'white'}; font-family: ${layer.styles?.font || layer.fontFamily || 'inherit'}; font-size: ${layer.styles?.size || layer.fontSize || 24}px; font-weight: ${(layer.styles?.bold || layer.bold) ? 'bold' : 'normal'}; font-style: ${(layer.styles?.italic || layer.italic) ? 'italic' : 'normal'}; text-shadow: ${(layer.styles?.shadow || layer.shadow) ? '0 2px 10px rgba(0,0,0,0.5)' : 'none'}; text-align: center; white-space: pre-wrap;">${layer.content || layer.text || ''}</div>`;
      } else if (layer.type === 'sticker') {
        el.innerHTML = `<div style="font-size: ${layer.styles?.size || 80}px; pointer-events: none;">${layer.content || layer.emoji || ''}</div>`;
      } else if (layer.type === 'music') {
        const track = layer.track || window.HubbleEditor.state.musicTrack || {};
        const artwork = track.artwork || layer.artwork || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=150&h=150&q=80';
        const title = track.title || layer.content || 'Music';
        const artist = track.artist || layer.artist || '';
        const isMuted = layer.isMuted || false;

        el.innerHTML = `
          <div class="story-music-sticker-card" style="display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: rgba(20, 20, 25, 0.85); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.2); border-radius: 24px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); color: white; min-width: 140px; max-width: 260px; user-select: none;">
            <div style="position: relative; width: 32px; height: 32px; flex-shrink: 0;">
              <img src="${artwork}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 1.5px solid rgba(255,255,255,0.4); ${isMuted ? '' : 'animation: rotateDisc 8s linear infinite;'}" alt="Artwork" />
              <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.3); border-radius: 50%;">
                <span style="font-size: 11px;">${isMuted ? '🔇' : '🎵'}</span>
              </div>
            </div>
            <div style="display: flex; flex-direction: column; min-width: 0; text-align: left;">
              <span style="font-size: 12px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2;">${title}</span>
              <span style="font-size: 10px; color: rgba(255,255,255,0.7); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px;">${artist}</span>
            </div>
          </div>
        `;
      } else if (layer.type === 'location') {
        const loc = layer.loc || window.HubbleEditor.state.selectedLocation || {};
        const locName = typeof loc === 'string' ? loc : (loc.displayName || loc.name || layer.content || 'Location');

        el.innerHTML = `
          <div class="story-location-sticker-card" style="display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; background: linear-gradient(135deg, rgba(168,85,247,0.85) 0%, rgba(126,34,206,0.9) 100%); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.25); border-radius: 20px; box-shadow: 0 6px 20px rgba(168,85,247,0.35); color: white; user-select: none;">
            <span style="font-size: 13px;">📍</span>
            <span style="font-size: 12px; font-weight: 700; color: #fff; white-space: nowrap; text-shadow: 0 1px 2px rgba(0,0,0,0.3);">${locName}</span>
          </div>
        `;
      }

      // Boundary check: dim if dragged far off-canvas, but maintain active state
      if (layer.x < -10 || layer.x > 110 || layer.y < -10 || layer.y > 110) {
        el.style.opacity = '0.2';
      } else {
        el.style.opacity = '1';
      }

      const isActive = HubbleEditor.activeSelectedLayerId === layer.id;
      if (isActive) {
        el.style.border = '2px dashed rgba(255,255,255,0.85)';
        el.style.padding = '8px';
        el.style.borderRadius = '12px';
        el.appendChild(HubbleEditor.createDeleteButton(layer));
        HubbleEditor.addLayerControls(el, layer, interactionLayer);
      } else {
        el.style.border = 'none';
        el.style.padding = '0';
        el.style.borderRadius = '0';
      }

      el.ondblclick = (e) => {
        e.stopPropagation();
        if (layer.type === 'text') {
          HubbleEditor.openTextTool(layer.id);
        }
      };

      // Drag Logic
      el.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        let isDragging = true;
        HubbleEditor.activeSelectedLayerId = layer.id;

        // Fast active state DOM update
        Array.from(interactionLayer.children).forEach(child => {
          if (child.dataset.layerId == layer.id) {
            child.style.border = '2px dashed rgba(255,255,255,0.85)';
            child.style.padding = '8px';
            child.style.borderRadius = '12px';
            if (!child.querySelector('.he-delete-btn')) {
              child.appendChild(HubbleEditor.createDeleteButton(layer));
              HubbleEditor.addLayerControls(child, layer, interactionLayer);
            }
          } else {
            child.style.border = 'none';
            child.style.padding = '0';
            child.style.borderRadius = '0';
            const dBtn = child.querySelector('.he-delete-btn');
            if (dBtn) dBtn.remove();
            child.querySelectorAll('.he-resize-handle, .he-rotate-handle, .he-rotate-stalk, .he-mute-badge-btn').forEach(h => h.remove());
          }
        });

        if (layer.type === 'text') {
          const isTextToolOpen = document.getElementById('he-text-input') !== null;
          if (isTextToolOpen && HubbleEditor.textState && HubbleEditor.textState.layerId !== layer.id) {
            HubbleEditor.openTextTool(layer.id);
          }
        }

        let startX = e.clientX;
        let startY = e.clientY;
        const startLeft = layer.x;
        const startTop = layer.y;

        // Bring to front
        layer.zIndex = Math.max(10, ...this.state.layers.map(l => l.zIndex || 10)) + 1;
        el.style.zIndex = layer.zIndex;

        const move = (ev) => {
          if (!isDragging) return;
          const rect = interactionLayer.getBoundingClientRect();
          const dx = ((ev.clientX - startX) / rect.width) * 100;
          const dy = ((ev.clientY - startY) / rect.height) * 100;
          let newX = startLeft + dx;
          let newY = startTop + dy;

          // Safe area snapping to horizontal center (50%) and vertical center (50%)
          if (Math.abs(newX - 50) < 2) newX = 50;
          if (Math.abs(newY - 50) < 2) newY = 50;

          layer.x = Math.round(newX * 10) / 10;
          layer.y = Math.round(newY * 10) / 10;

          requestAnimationFrame(() => {
            el.style.left = layer.x + '%';
            el.style.top = layer.y + '%';
            if (layer.x < -10 || layer.x > 110 || layer.y < -10 || layer.y > 110) {
              el.style.opacity = '0.2';
            } else {
              el.style.opacity = '1';
            }
          });
        };
        const up = () => {
          isDragging = false;
          HubbleEditor.pushHistory(); // push history on drop
          HubbleEditor.updateRender(); // Sync state to chUploads
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      };

      interactionLayer.appendChild(el);
    });

    if (!interactionLayer.dataset.clickBound) {
      interactionLayer.addEventListener('mousedown', (e) => {
        if (e.target === interactionLayer) {
          if (HubbleEditor.activeSelectedLayerId) {
            HubbleEditor.activeSelectedLayerId = null;
            Array.from(interactionLayer.children).forEach(child => {
              child.style.border = 'none';
              child.style.padding = '0';
              child.style.borderRadius = '0';
              const dBtn = child.querySelector('.he-delete-btn');
              if (dBtn) dBtn.remove();
              child.querySelectorAll('.he-resize-handle, .he-rotate-handle, .he-rotate-stalk, .he-mute-badge-btn').forEach(h => h.remove());
            });
          }
        }
      });
      interactionLayer.dataset.clickBound = "true";
    }

    // Sync state to chUploads so it's always up to date
    if (window.chUploads && window.chUploads[this.activeMediaIndex]) {
      window.chUploads[this.activeMediaIndex].editorState = JSON.parse(JSON.stringify(this.state));
    }
    // Update live preview thumbnail
    if (typeof this.updatePreviewThumbnail === 'function') {
      this.updatePreviewThumbnail(this.activeMediaIndex);
    }
  },

  activeLayout: 'original',

  setLayout(layoutName) {
    let effectiveLayoutName = window.getEffectiveLayout(layoutName, window.chUploads);

    this.activeLayout = layoutName;
    const previewRow = document.getElementById('ch-media-preview-row');
    if (!previewRow) return;

    // Remove existing layout classes
    previewRow.className = 'ch-media-preview-row';

    // Add new layout class if not original/single default
    if (effectiveLayoutName !== 'original' && effectiveLayoutName !== 'single') {
      previewRow.classList.add(`layout-${effectiveLayoutName}`);
    }

    // Update active button state
    document.querySelectorAll('.ch-layout-btn').forEach(btn => {
      btn.classList.remove('ch-layout-btn-active');
      if (btn.dataset.layout === layoutName) {
        btn.classList.add('ch-layout-btn-active');
      }
    });

    // Flatten DOM (remove layout row wrappers)
    const items = Array.from(previewRow.querySelectorAll('.ch-preview-item'));
    if (items.length > 0) {
      items.sort((a, b) => parseInt(a.dataset.index) - parseInt(b.dataset.index));

      previewRow.querySelectorAll('.ch-layout-row').forEach(el => el.remove());
      const addMoreBtn = document.getElementById('ch-add-more-media-btn');

      items.forEach(item => {
        previewRow.insertBefore(item, addMoreBtn);
      });

      // Update active aspect ratios
      for (let i = 0; i < window.chUploads.length; i++) {
        this.updatePreviewThumbnail(i);
      }
    }
  },

  updatePreviewThumbnail(index, passedEl = null) {
    if (!window.chUploads || !window.chUploads[index]) return;
    const item = window.chUploads[index];
    const previewEl = passedEl || document.querySelector(`.ch-preview-item[data-index="${index}"]`);
    if (!previewEl) return;

    let state = item.editorState;
    if (index === this.activeMediaIndex) state = this.state;
    if (!state) return; // No edits, just keep original

    // Keep only the remove button and duration overlay
    const rmBtn = previewEl.querySelector('.ch-remove-media');
    let overlay = null;
    if (item.type.startsWith('video/')) {
      const divs = previewEl.querySelectorAll('div');
      divs.forEach(d => {
        if (d.innerHTML.includes('lucide="video"')) overlay = d;
      });
    }

    const ar = this.getEditedAspectRatio(item);
    previewEl.style.aspectRatio = '';
    previewEl.style.removeProperty('--ar');
    previewEl.innerHTML = '';

    // Containment frame
    const miniContainer = document.createElement('div');
    miniContainer.className = 'edited-frame';
    miniContainer.style.cssText = `position: relative; overflow: hidden; aspect-ratio: ${ar}; border-radius: 10px; background: #1a1a1a; display: flex; align-items: center; justify-content: center; margin: auto; width: min(100cqw, calc(100cqh * ${ar})); height: min(100cqh, calc(100cqw / ${ar}));`;

    // innerWrapper to handle crop scaling/translating
    const innerWrapper = document.createElement('div');
    if (state.crop) {
      const cw = state.crop.width;
      const ch = state.crop.height;
      const cx = state.crop.x;
      const cy = state.crop.y;
      innerWrapper.style.cssText = `position: absolute; width: ${10000 / cw}%; height: ${10000 / ch}%; left: -${(cx / cw) * 100}%; top: -${(cy / ch) * 100}%;`;
    } else {
      innerWrapper.style.cssText = 'position: absolute; width: 100%; height: 100%; left: 0; top: 0;';
    }

    // Media layer
    const miniMediaLayer = document.createElement('div');
    miniMediaLayer.style.cssText = 'position: absolute; width: 100%; height: 100%;';

    // Interaction layer
    const miniInteractionLayer = document.createElement('div');
    miniInteractionLayer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;';

    // Media Node (Thumbnails are always images to avoid heavy video playback in previews unless hovered/needed)
    const node = document.createElement('img');
    node.src = item.thumbUrl;
    node.style.cssText = 'width: 100%; height: 100%; object-fit: contain; transform-origin: center center;';

    // Apply Edits
    node.style.filter = this.buildCSSFilterString(state.filter, state.adjustments);
    node.style.transform = `translate(${state.panX || 0}%, ${state.panY || 0}%) rotate(${state.rotation || 0}deg) scale(${state.zoom || 1})`;

    miniMediaLayer.appendChild(node);

    // Interactions
    if (state.layers) {
      state.layers.forEach((layer) => {
        const el = document.createElement('div');
        el.style.cssText = `position: absolute; left: ${layer.x}%; top: ${layer.y}%; transform: translate(-50%, -50%) rotate(${layer.rotation}deg) scale(${layer.scale}); z-index: ${layer.zIndex}; pointer-events: none;`;
        if (layer.type === 'text') {
          el.innerHTML = `<div style="color: ${layer.styles.color || 'white'}; font-family: ${layer.styles.font || 'inherit'}; font-size: ${layer.styles.size || 24}px; font-weight: ${layer.styles.bold ? 'bold' : 'normal'}; font-style: ${layer.styles.italic ? 'italic' : 'normal'}; text-shadow: ${layer.styles.shadow ? '0 2px 10px rgba(0,0,0,0.5)' : 'none'}; text-align: center; white-space: pre-wrap;">${layer.content}</div>`;
        } else if (layer.type === 'sticker') {
          el.innerHTML = `<div style="font-size: ${layer.styles.size || 80}px; pointer-events: none;">${layer.content}</div>`;
        }
        // Scale down layers for miniature preview based on actual width
        // Use ResizeObserver for accurate sizing or assume default 100px if hidden
        const actualWidth = previewEl.clientWidth > 0 ? previewEl.clientWidth : 100;
        const scaleFactor = actualWidth / 400; // 400 is the main canvas width
        el.style.transform += ` scale(${scaleFactor})`;
        miniInteractionLayer.appendChild(el);
      });
    }

    innerWrapper.appendChild(miniMediaLayer);
    innerWrapper.appendChild(miniInteractionLayer);
    miniContainer.appendChild(innerWrapper);

    previewEl.appendChild(miniContainer);
    if (overlay) previewEl.appendChild(overlay);
    if (rmBtn) previewEl.appendChild(rmBtn);
  },

  renderPanels(activeTool) {
    const container = document.getElementById('he-panels-container');
    if (!container) return;

    // Generate glassmorphism panel
    let html = `<div class="story-mobile-tool-panel" style="background: var(--card-bg, rgba(15,15,20,0.85)); backdrop-filter: blur(20px); border: 1px solid var(--border-color, rgba(255,255,255,0.1)); border-radius: 20px; padding: 20px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); color: var(--text-main, white);">`;

    if (activeTool === 'filters') {
      html += `<h4 style="margin: 0 0 16px 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;"><i data-lucide="aperture" style="width: 18px; height: 18px; color: var(--primary);"></i> Filters</h4>`;
      html += `<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; max-height: 400px; overflow-y: auto; padding-right: 8px;" class="custom-scrollbar">`;

      const filters = ['Original', 'Bright', 'Warm', 'Cool', 'Vintage', 'Black & White', 'HDR', 'Cinematic', 'Soft', 'Dream', 'Purple Glow', 'Cool Blue', 'Sepia', 'Vivid', 'Mono'];

      const defaultAdjustments = {
        brightness: 100, contrast: 100, exposure: 100, highlights: 100, shadows: 100,
        temperature: 0, tint: 0, saturation: 100, vibrance: 100, sharpness: 0, blur: 0, opacity: 100
      };

      const media = window.chUploads[this.activeMediaIndex];
      const mediaUrl = media.thumbUrl || URL.createObjectURL(media.file);

      filters.forEach(f => {
        const id = f.toLowerCase();
        const active = this.state.filter === id ? 'border: 2px solid var(--primary); transform: scale(1.05);' : 'border: 2px solid transparent;';
        const cssFilter = this.buildCSSFilterString(id, defaultAdjustments);

        html += `
          <div onclick="HubbleEditor.pushHistory(); HubbleEditor.state.filter = '${id}'; HubbleEditor.updateRender(); HubbleEditor.renderPanels('filters');" style="display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; transition: all 0.2s; ${active}">
            <div style="width: 100%; aspect-ratio: 1; border-radius: 12px; background: url('${mediaUrl}') center/cover; filter: ${cssFilter}; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1);"></div>
            <span style="font-size: 0.7rem; font-weight: 500;">${f}</span>
          </div>
        `;
      });
      html += `</div>`;
    }
    else if (activeTool === 'adjust') {
      html += `<h4 style="margin: 0 0 16px 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;"><i data-lucide="sliders" style="width: 18px; height: 18px; color: var(--primary);"></i> Adjust</h4>`;
      html += `<div style="display: flex; flex-direction: column; gap: 16px; max-height: 400px; overflow-y: auto; padding-right: 12px;" class="custom-scrollbar">`;

      const sliders = [
        { id: 'brightness', label: 'Brightness', min: 0, max: 200 },
        { id: 'contrast', label: 'Contrast', min: 0, max: 200 },
        { id: 'exposure', label: 'Exposure', min: 0, max: 200 },
        { id: 'highlights', label: 'Highlights', min: 0, max: 200 },
        { id: 'shadows', label: 'Shadows', min: 0, max: 200 },
        { id: 'temperature', label: 'Temperature', min: -100, max: 100 },
        { id: 'tint', label: 'Tint', min: -100, max: 100 },
        { id: 'saturation', label: 'Saturation', min: 0, max: 200 },
        { id: 'vibrance', label: 'Vibrance', min: 0, max: 200 },
        { id: 'sharpness', label: 'Sharpness', min: 0, max: 100 },
        { id: 'blur', label: 'Blur', min: 0, max: 20 },
        { id: 'opacity', label: 'Opacity', min: 0, max: 100 }
      ];

      sliders.forEach(s => {
        const val = this.state.adjustments[s.id];
        html += `
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; justify-content: space-between; font-size: 0.8rem;">
              <span>${s.label}</span>
              <span style="color: var(--primary); font-weight: 600;">${val}</span>
            </div>
            <input type="range" min="${s.min}" max="${s.max}" value="${val}" 
              oninput="HubbleEditor.state.adjustments['${s.id}'] = Number(this.value); HubbleEditor.updateRender(); this.previousElementSibling.lastElementChild.innerText = this.value;"
              onchange="HubbleEditor.pushHistory();"
              style="width: 100%; accent-color: var(--primary);">
          </div>
        `;
      });

      html += `<button onclick="HubbleEditor.pushHistory(); HubbleEditor.state.filter = 'original'; HubbleEditor.state.adjustments = { brightness: 100, contrast: 100, exposure: 100, highlights: 100, shadows: 100, temperature: 0, tint: 0, saturation: 100, vibrance: 100, sharpness: 0, blur: 0, opacity: 100 }; HubbleEditor.updateRender(); HubbleEditor.renderPanels('adjust');" style="margin-top: 12px; padding: 10px; border-radius: 8px; background: rgba(255,255,255,0.05); color: white; border: 1px solid rgba(255,255,255,0.1); cursor: pointer;">Reset All</button>`;
      html += `</div>`;
    }
    else if (activeTool === 'rotate') {
      html += `<h4 style="margin: 0 0 16px 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;"><i data-lucide="rotate-cw" style="width: 18px; height: 18px; color: var(--primary);"></i> Rotate</h4>`;
      html += `<div style="text-align: center; color: rgba(255,255,255,0.7); font-size: 0.9rem;">Rotated ${this.state.rotation}°</div>`;
    }
    else if (activeTool === 'crop') {
      html += `<h4 style="margin: 0 0 16px 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;"><i data-lucide="crop" style="width: 18px; height: 18px; color: var(--primary);"></i> Crop & Aspect</h4>`;
      html += `<div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 24px;">`;
      const ratios = ['Free', '1:1', '4:5', '3:4', '16:9', '9:16', '1080:1920'];
      const labels = ['Free', '1:1', '4:5', '3:4', '16:9', '9:16', 'Story'];
      ratios.forEach((r, i) => {
        const active = this.tempCrop && this.tempCrop.aspect === r ? 'border: 2px solid var(--primary); background: rgba(168,85,247,0.1); color: var(--primary);' : 'border: 1px solid var(--border-color, rgba(255,255,255,0.1)); background: var(--card-bg, rgba(255,255,255,0.05)); color: var(--text-main, white);';
        html += `<button onclick="HubbleEditor.setCropAspect('${r}');" style="padding: 12px; border-radius: 12px; font-weight: 600; font-size: 0.9rem; cursor: pointer; ${active}">${labels[i]}</button>`;
      });
      html += `</div>`;

      const currentZoom = this.state.zoom || 1;
      const zoomPct = Math.round(currentZoom * 100);
      html += `
        <div class="he-zoom-panel" style="margin-bottom: 24px; background: var(--bg-surface, rgba(255,255,255,0.05)); border: 1px solid var(--border-color, rgba(255,255,255,0.1)); padding: 16px; border-radius: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <span style="font-size: 0.9rem; color: var(--text-main, rgba(255,255,255,0.8)); font-weight: 600;"><i data-lucide="zoom-in" style="width: 14px; height: 14px; vertical-align: middle; margin-right: 6px;"></i>Zoom</span>
            <span id="he-zoom-val" style="font-size: 0.85rem; color: var(--primary); font-weight: bold; background: rgba(168,85,247,0.15); padding: 4px 10px; border-radius: 8px; font-variant-numeric: tabular-nums;">${zoomPct}%</span>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <button onclick="HubbleEditor.setCropZoom((HubbleEditor.state.zoom || 1) - 0.1)" style="width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--border-color, rgba(255,255,255,0.2)); background: var(--card-bg, rgba(255,255,255,0.1)); color: var(--text-main, white); cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: transform 0.1s;" onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'"><i data-lucide="minus" style="width: 14px; height: 14px;"></i></button>
            <input type="range" id="he-zoom-slider" class="he-custom-slider" min="0.5" max="3" step="0.01" value="${currentZoom}" oninput="HubbleEditor.setCropZoom(parseFloat(this.value))">
            <button onclick="HubbleEditor.setCropZoom((HubbleEditor.state.zoom || 1) + 0.1)" style="width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--border-color, rgba(255,255,255,0.2)); background: var(--card-bg, rgba(255,255,255,0.1)); color: var(--text-main, white); cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: transform 0.1s;" onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'"><i data-lucide="plus" style="width: 14px; height: 14px;"></i></button>
          </div>
        </div>
      `;

      html += `<div style="display: flex; flex-direction: column; gap: 12px;">`;
      html += `<div style="display: flex; gap: 12px;">
                 <button class="he-glass-btn" onclick="HubbleEditor.state.zoom = 1; HubbleEditor.state.panX = 0; HubbleEditor.state.panY = 0; HubbleEditor.tempCrop = { x: 0, y: 0, width: 100, height: 100, aspect: 'Free' }; HubbleEditor.renderCropHandles(); HubbleEditor.renderPanels('crop'); HubbleEditor.updateRender();">Reset</button>
                 <button class="he-premium-apply-btn" onclick="HubbleEditor.exitCropMode(true)">Apply Crop</button>
               </div>`;
      html += `<button class="he-glass-btn he-cancel-btn" onclick="HubbleEditor.exitCropMode(false)">Cancel</button>`;
      html += `</div>`;
    }
    else if (activeTool === 'stickers') {
      html += `<h4 style="margin: 0 0 16px 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;"><i data-lucide="sticker" style="width: 18px; height: 18px; color: var(--primary);"></i> Stickers</h4>`;
      html += `<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; max-height: 400px; overflow-y: auto;" class="custom-scrollbar">`;

      const emojiStickers = ['🔥', '✨', '❤️', '🎉', '🚀', '💯', '😂', '😍', '🎂', '✈️', '🌴', '💎', '👑', '🌈', '⚡️', '🌟'];

      emojiStickers.forEach(e => {
        html += `<div onclick="HubbleEditor.addLayer('text', '${e}', { size: 80 });" style="font-size: 32px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.2)'" onmouseout="this.style.transform='scale(1)'">${e}</div>`;
      });

      html += `</div>`;
    }
    else if (activeTool === 'text') {
      html += `<h4 style="margin: 0 0 16px 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;"><i data-lucide="type" style="width: 18px; height: 18px; color: var(--primary);"></i> Text</h4>`;

      const colors = ['#ffffff', '#000000', '#888888', '#ff3b30', '#ff9500', '#ffcc00', '#4cd964', '#5ac8fa', '#007aff', '#5856d6', '#ff2d55'];
      let currentColor = HubbleEditor.textState ? HubbleEditor.textState.color : '#ffffff';
      let currentFont = HubbleEditor.textState ? HubbleEditor.textState.font : 'inherit';
      let isBold = HubbleEditor.textState ? HubbleEditor.textState.bold : false;
      let isItalic = HubbleEditor.textState ? HubbleEditor.textState.italic : false;
      let textValue = HubbleEditor.textState ? HubbleEditor.textState.text : '';
      let isExisting = HubbleEditor.textState && HubbleEditor.textState.layerId && HubbleEditor.history && HubbleEditor.history.length > 0 && HubbleEditor.history.some(h => h.layers.some(l => l.id === HubbleEditor.textState.layerId));

      html += `
        <div style="display: flex; flex-direction: column; gap: 16px;">
          <input type="text" id="he-text-input" placeholder="Enter text..." value="${textValue.replace(/"/g, '&quot;')}" oninput="HubbleEditor.updateLiveText()" style="width: 100%; padding: 14px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.3); color: white; outline: none; font-size: 1rem;">
          
          <div style="display: flex; flex-direction: column; gap: 8px;">
             <span style="font-size: 0.8rem; color: rgba(255,255,255,0.7);">Color</span>
             <div style="display: flex; gap: 10px; overflow-x: auto; padding-bottom: 4px;" class="custom-scrollbar">
               <input type="color" id="he-text-color-picker" value="${currentColor}" oninput="HubbleEditor.updateLiveTextColor(this.value)" style="width: 32px; height: 32px; flex-shrink: 0; border: 2px solid rgba(255,255,255,0.3); border-radius: 50%; cursor: pointer; background: transparent; padding: 0;">
               ${colors.map(c => `<div class="he-color-swatch" data-color="${c}" onclick="HubbleEditor.updateLiveTextColor('${c}')" style="width: 32px; height: 32px; flex-shrink: 0; border-radius: 50%; background: ${c}; border: 2px solid ${currentColor === c ? 'var(--primary, #a855f7)' : 'rgba(255,255,255,0.1)'}; cursor: pointer; transition: all 0.2s;"></div>`).join('')}
             </div>
             <input type="hidden" id="he-text-color" value="${currentColor}">
          </div>
          
          <div style="display: flex; gap: 8px;">
            <button onclick="HubbleEditor.toggleTextFormat('bold')" id="he-text-bold" style="flex: 1; padding: 10px; border-radius: 8px; border: 1px solid ${isBold ? 'var(--primary, #a855f7)' : 'rgba(255,255,255,0.1)'}; background: ${isBold ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.05)'}; color: white; font-weight: bold; cursor: pointer; transition: all 0.2s;">B</button>
            <button onclick="HubbleEditor.toggleTextFormat('italic')" id="he-text-italic" style="flex: 1; padding: 10px; border-radius: 8px; border: 1px solid ${isItalic ? 'var(--primary, #a855f7)' : 'rgba(255,255,255,0.1)'}; background: ${isItalic ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.05)'}; color: white; font-style: italic; cursor: pointer; transition: all 0.2s;">I</button>
            
            <div style="flex: 2; position: relative;">
               <select id="he-text-font" onchange="HubbleEditor.updateLiveText()" style="width: 100%; height: 100%; padding: 0 12px; appearance: none; -webkit-appearance: none; background: var(--input-bg, rgba(255,255,255,0.05)); border: var(--input-border, 1px solid rgba(255,255,255,0.1)); border-radius: 8px; color: var(--text-main, #fff); cursor: pointer; outline: none; font-size: 0.9rem;">
                  <option value="inherit" style="background: var(--card-bg, #151515); color: var(--text-main, #fff);" ${currentFont === 'inherit' ? 'selected' : ''}>Default</option>
                  <option value="'Inter', sans-serif" style="background: var(--card-bg, #151515); color: var(--text-main, #fff);" ${currentFont === "'Inter', sans-serif" ? 'selected' : ''}>Inter</option>
                  <option value="'Poppins', sans-serif" style="background: var(--card-bg, #151515); color: var(--text-main, #fff);" ${currentFont === "'Poppins', sans-serif" ? 'selected' : ''}>Poppins</option>
                  <option value="'Montserrat', sans-serif" style="background: var(--card-bg, #151515); color: var(--text-main, #fff);" ${currentFont === "'Montserrat', sans-serif" ? 'selected' : ''}>Montserrat</option>
                  <option value="'Roboto', sans-serif" style="background: var(--card-bg, #151515); color: var(--text-main, #fff);" ${currentFont === "'Roboto', sans-serif" ? 'selected' : ''}>Roboto</option>
                  <option value="'Open Sans', sans-serif" style="background: var(--card-bg, #151515); color: var(--text-main, #fff);" ${currentFont === "'Open Sans', sans-serif" ? 'selected' : ''}>Open Sans</option>
                  <option value="'Lato', sans-serif" style="background: var(--card-bg, #151515); color: var(--text-main, #fff);" ${currentFont === "'Lato', sans-serif" ? 'selected' : ''}>Lato</option>
                  <option value="'Nunito', sans-serif" style="background: var(--card-bg, #151515); color: var(--text-main, #fff);" ${currentFont === "'Nunito', sans-serif" ? 'selected' : ''}>Nunito</option>
                  <option value="'Playfair Display', serif" style="background: var(--card-bg, #151515); color: var(--text-main, #fff);" ${currentFont === "'Playfair Display', serif" ? 'selected' : ''}>Playfair Display</option>
                  <option value="'Merriweather', serif" style="background: var(--card-bg, #151515); color: var(--text-main, #fff);" ${currentFont === "'Merriweather', serif" ? 'selected' : ''}>Merriweather</option>
                  <option value="'Bebas Neue', sans-serif" style="background: var(--card-bg, #151515); color: var(--text-main, #fff);" ${currentFont === "'Bebas Neue', sans-serif" ? 'selected' : ''}>Bebas Neue</option>
                  <option value="'Oswald', sans-serif" style="background: var(--card-bg, #151515); color: var(--text-main, #fff);" ${currentFont === "'Oswald', sans-serif" ? 'selected' : ''}>Oswald</option>
                  <option value="'Raleway', sans-serif" style="background: var(--card-bg, #151515); color: var(--text-main, #fff);" ${currentFont === "'Raleway', sans-serif" ? 'selected' : ''}>Raleway</option>
                  <option value="'Ubuntu', sans-serif" style="background: var(--card-bg, #151515); color: var(--text-main, #fff);" ${currentFont === "'Ubuntu', sans-serif" ? 'selected' : ''}>Ubuntu</option>
                  <option value="'Quicksand', sans-serif" style="background: var(--card-bg, #151515); color: var(--text-main, #fff);" ${currentFont === "'Quicksand', sans-serif" ? 'selected' : ''}>Quicksand</option>
               </select>
               <div style="position: absolute; right: 12px; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--text-main, #fff); font-size: 10px;">▼</div>
            </div>
          </div>

          <button id="he-text-add-btn" onclick="HubbleEditor.commitLiveText()" style="margin-top: 8px; padding: 14px; border-radius: 12px; background: ${textValue.trim() ? 'linear-gradient(135deg, var(--primary, #a855f7) 0%, #7e22ce 100%)' : 'rgba(255,255,255,0.1)'}; box-shadow: ${textValue.trim() ? '0 8px 20px rgba(168,85,247,0.3)' : 'none'}; border: 1px solid rgba(255,255,255,0.1); color: ${textValue.trim() ? 'white' : 'rgba(255,255,255,0.4)'}; font-weight: 600; cursor: ${textValue.trim() ? 'pointer' : 'not-allowed'}; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); pointer-events: ${textValue.trim() ? 'all' : 'none'};">${isExisting ? 'Update Text' : 'Add Text'}</button>
        </div>
      `;
    }
    html += `</div>`;
    container.innerHTML = html;
    if (window.lucide) window.lucide.createIcons();
  },

  GlobalAudio: {
    get audio() {
      return window.StoryAudioManager ? window.StoryAudioManager.audio : null;
    },
    init() {
      if (window.StoryAudioManager) window.StoryAudioManager.init();
    },
    play() {
      if (window.StoryAudioManager) window.StoryAudioManager.play('editor');
    },
    pause() {
      if (window.StoryAudioManager) window.StoryAudioManager.pause();
    },
    resume() {
      if (window.StoryAudioManager) window.StoryAudioManager.resume();
    },
    setTrack(trackUrl) {
      if (window.StoryAudioManager) window.StoryAudioManager.load(trackUrl, 'editor');
    },
    sync(time) {
      if (window.StoryAudioManager) window.StoryAudioManager.sync(time);
    },
    stop() {
      if (window.StoryAudioManager) window.StoryAudioManager.stop();
    },
    destroy() {
      if (window.StoryAudioManager) window.StoryAudioManager.destroy();
    }
  },

  openLocationSelector() {
    if (window.openStoryLocationPicker) {
      window.openStoryLocationPicker();
    }
  },

  selectLocation(id, displayName, subText) {
    if (window.selectStoryLocation) {
      window.selectStoryLocation({ id, name: displayName, displayName, subText });
    } else {
      this.state.selectedLocation = { id, displayName, subText };
    }
  },

  removeLocation() {
    if (window.removeStoryLocation) {
      window.removeStoryLocation();
    } else {
      this.state.selectedLocation = null;
    }
  },

  openMusicSelector() {
    if (window.openStoryMusicPicker) {
      window.openStoryMusicPicker();
    }
  },

  removeMusic() {
    if (window.removeStoryMusic) {
      window.removeStoryMusic();
    } else {
      this.state.musicTrack = null;
      if (window.StoryAudioManager) window.StoryAudioManager.destroy();
    }
  },

  toggleSpeaker(e, forceMute = null) {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }

    if (window.HubbleEditor._isTogglingSpeaker) return;
    window.HubbleEditor._isTogglingSpeaker = true;
    setTimeout(() => { window.HubbleEditor._isTogglingSpeaker = false; }, 150);

    const state = window.HubbleEditor.state;
    if (forceMute !== null) {
      state.isMuted = forceMute;
    } else {
      state.isMuted = !state.isMuted;
    }

    // Sync isMuted to current active item in window.chUploads
    const activeIdx = window.HubbleEditor.activeMediaIndex || 0;
    if (window.chUploads && window.chUploads[activeIdx]) {
      if (!window.chUploads[activeIdx].editorState) {
        window.chUploads[activeIdx].editorState = {};
      }
      window.chUploads[activeIdx].editorState.isMuted = state.isMuted;
      window.chUploads[activeIdx].isMuted = state.isMuted;
    }

    // Smooth Mute: Update volume to 0/1 to prevent decoder stutter on some browsers
    const videos = [
      document.querySelector('#he-media-layer video'),
      ...document.querySelectorAll('#review-slider-wrapper video')
    ];

    videos.forEach(v => {
      if (v) {
        v.muted = state.isMuted;
        v.volume = state.isMuted ? 0 : 1;
      }
    });

    // Update speaker UI efficiently
    const mutedIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>';
    const unmutedIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';

    document.querySelectorAll('.he-speaker-icon').forEach(icon => {
      icon.innerHTML = state.isMuted ? mutedIcon : unmutedIcon;
    });
  },

  buildVideoControls(container, videoNode, isReview = false) {
    const controlsId = isReview ? 'he-review-controls' : 'he-video-controls';
    let controls = document.createElement('div');
    controls.id = controlsId;
    controls.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1000; display: flex; flex-direction: column; justify-content: flex-end; padding-bottom: 24px;';

    const playBtn = document.createElement('div');
    playBtn.id = isReview ? 'he-review-play-btn' : 'he-play-btn';
    playBtn.style.cssText = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.9); width: 64px; height: 64px; border-radius: 50%; background: rgba(0,0,0,0.4); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; pointer-events: all; cursor: pointer; transition: all 0.3s; opacity: 0; box-shadow: 0 8px 32px rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1);';
    playBtn.innerHTML = '<i data-lucide="pause" style="color: white; width: 32px; height: 32px;"></i>';

    let hideTimeout;
    const showPlayBtn = (icon) => {
      playBtn.innerHTML = `<i data-lucide="${icon}" style="color: white; width: 32px; height: 32px;"></i>`;
      if (window.lucide) window.lucide.createIcons();
      playBtn.style.opacity = '1';
      playBtn.style.transform = 'scale(1)';
      clearTimeout(hideTimeout);
      if (icon === 'pause') {
        hideTimeout = setTimeout(() => {
          playBtn.style.opacity = '0';
          playBtn.style.transform = 'scale(0.9)';
        }, 2000);
      }
    };

    const togglePlay = (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      const vid = videoNode;
      if (!vid) return;
      if (vid.paused) {
        vid.play();
        showPlayBtn('pause');
      } else {
        vid.pause();
        showPlayBtn('play');
      }
    };

    playBtn.onclick = togglePlay;
    container.addEventListener('mousemove', () => {
      if (videoNode && !videoNode.paused) {
        showPlayBtn('pause');
      }
    });

    showPlayBtn(videoNode && !videoNode.paused ? 'pause' : 'play'); // Set initial state

    const bottomRow = document.createElement('div');
    bottomRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 0 20px; pointer-events: all; gap: 16px; margin-top: auto; width: 100%; box-sizing: border-box;';

    // Timeline container
    const timelineContainer = document.createElement('div');
    timelineContainer.id = isReview ? 'he-review-timeline' : 'he-timeline';
    timelineContainer.style.cssText = 'flex-grow: 1; display: flex; flex-direction: column; gap: 8px; cursor: pointer; position: relative; padding: 10px 0;';

    const timeText = document.createElement('div');
    timeText.id = isReview ? 'he-review-time-text' : 'he-time-text';
    timeText.style.cssText = 'color: white; font-size: 11px; font-weight: 600; font-family: monospace; text-shadow: 0 1px 4px rgba(0,0,0,0.8); display: flex; justify-content: space-between; opacity: 0.9;';
    timeText.innerHTML = '<span>00:00</span><span>00:00</span>';

    const track = document.createElement('div');
    track.style.cssText = 'width: 100%; height: 6px; border-radius: 4px; background: rgba(255,255,255,0.3); backdrop-filter: blur(4px); position: relative; overflow: hidden;';

    const fill = document.createElement('div');
    fill.id = isReview ? 'he-review-timeline-fill' : 'he-timeline-fill';
    fill.style.cssText = 'position: absolute; top: 0; left: 0; height: 100%; width: 0%; background: var(--primary, #a855f7); box-shadow: 0 0 10px rgba(168,85,247,0.5); border-radius: 4px; transition: width 0.1s linear;';

    track.appendChild(fill);
    timelineContainer.appendChild(track);
    timelineContainer.appendChild(timeText);

    // Controls right side (Volume + Speaker)
    const rightControls = document.createElement('div');
    rightControls.style.cssText = 'display: flex; align-items: center; gap: 12px;';

    // Volume Slider
    const volumeSlider = document.createElement('input');
    volumeSlider.type = 'range';
    volumeSlider.min = '0';
    volumeSlider.max = '1';
    volumeSlider.step = '0.01';
    volumeSlider.value = this.state.isMuted ? '0' : (this.state.volume || '1');
    volumeSlider.id = isReview ? 'he-review-volume' : 'he-volume';
    volumeSlider.className = 'he-glass-slider';

    volumeSlider.oninput = (e) => {
      const val = parseFloat(e.target.value);
      this.state.volume = val;

      const videos = [
        document.querySelector('#he-media-layer video'),
        ...document.querySelectorAll('#review-slider-wrapper video')
      ];
      videos.forEach(v => {
        if (v) {
          v.volume = val;
          if (val > 0 && v.muted) v.muted = false;
        }
      });

      if (this.GlobalAudio && this.GlobalAudio.audio) {
        this.GlobalAudio.audio.volume = val;
      }

      if (val === 0 && !this.state.isMuted) {
        this.toggleSpeaker(null, true);
      } else if (val > 0 && this.state.isMuted) {
        this.toggleSpeaker(null, false);
      }
    };

    // Speaker btn
    const speakerBtn = document.createElement('div');
    speakerBtn.id = 'he-speaker-btn';
    speakerBtn.className = 'he-speaker-icon';
    speakerBtn.style.cssText = 'width: 44px; height: 44px; border-radius: 50%; background: rgba(168,85,247,0.25); backdrop-filter: blur(12px); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s cubic-bezier(0.2, 0.8, 0.2, 1); box-shadow: 0 4px 15px rgba(168,85,247,0.4), inset 0 0 10px rgba(168,85,247,0.2); border: 1px solid rgba(168,85,247,0.5); color: white; flex-shrink: 0;';
    speakerBtn.innerHTML = this.state.isMuted ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>' : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';

    speakerBtn.onclick = (e) => {
      this.toggleSpeaker(e);
      if (this.state.isMuted) {
        volumeSlider.value = '0';
      } else {
        volumeSlider.value = this.state.volume || '1';

        const videos = [
          document.querySelector('#he-media-layer video'),
          ...document.querySelectorAll('#review-slider-wrapper video')
        ];
        videos.forEach(v => { if (v) v.volume = parseFloat(volumeSlider.value); });
      }
    };

    rightControls.appendChild(volumeSlider);
    rightControls.appendChild(speakerBtn);

    bottomRow.appendChild(timelineContainer);
    bottomRow.appendChild(rightControls);

    controls.appendChild(playBtn);
    controls.appendChild(bottomRow);
    container.appendChild(controls);

    if (window.lucide) window.lucide.createIcons();

    // Timeline Drag Logic
    const updateTimeline = (e) => {
      const rect = timelineContainer.getBoundingClientRect();
      let pos = (e.clientX - rect.left) / rect.width;
      pos = Math.max(0, Math.min(pos, 1));

      if (videoNode && videoNode.duration) {
        videoNode.currentTime = pos * videoNode.duration;
      }
    };

    let isDragging = false;
    timelineContainer.onmousedown = (e) => {
      isDragging = true;
      updateTimeline(e);
    };
    window.addEventListener('mousemove', (e) => {
      if (isDragging) updateTimeline(e);
    });
    window.addEventListener('mouseup', () => {
      isDragging = false;
    });

    // RAF Update Loop for UI
    const formatTime = (time) => {
      if (isNaN(time)) return '00:00';
      const m = Math.floor(time / 60).toString().padStart(2, '0');
      const s = Math.floor(time % 60).toString().padStart(2, '0');
      return `${m}:${s}`;
    };

    const updateUI = () => {
      if (!controls.parentElement) return; // Cleanup when unmounted

      if (videoNode && videoNode.duration) {
        const perc = (videoNode.currentTime / videoNode.duration) * 100;
        fill.style.width = `${perc}%`;
        timeText.innerHTML = `<span>${formatTime(videoNode.currentTime)}</span><span>${formatTime(videoNode.duration)}</span>`;
      }

      if (this.state.isMuted && volumeSlider.value !== '0') {
        volumeSlider.value = '0';
      }

      requestAnimationFrame(updateUI);
    };
    requestAnimationFrame(updateUI);

    return controls;
  }
};

// Initialize GlobalAudio once on startup
window.HubbleEditor.GlobalAudio.init();

// Initialize after DOM loads
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(() => window.HubbleEditor.init(), 500);
} else {
  document.addEventListener('DOMContentLoaded', () => setTimeout(() => window.HubbleEditor.init(), 500));
}



document.addEventListener('DOMContentLoaded', () => {
  const api = (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '[::1]' ||
    window.location.hostname === '::1'
  ) ? `${window.location.protocol}//${window.location.hostname}:3000`
    : window.location.origin;

  initVideoEditor(api, window.showToast, window.loadFeedReels || window.loadFeed);
  if (typeof window.loadFeedPosts === 'function') {
    window.loadFeedPosts();
  }
  if (typeof window.loadFeedReels === 'function') {
    window.loadFeedReels();
  }

  // Check for deep-linked Reel on load
  const urlParams = new URLSearchParams(window.location.search);
  const reelId = urlParams.get('reelId');
  if (reelId) {
    setTimeout(() => {
      if (typeof window.navigateToPost === 'function') {
        window.navigateToPost(reelId, 'reel');
      }
    }, 1000);
  }
});

// Screen Time Tracker
(function initScreenTimeTracker() {
  if (window._screenTimeInterval) clearInterval(window._screenTimeInterval);

  function getUid() {
    try {
      const userStr = localStorage.getItem('invibe_user') || localStorage.getItem('invibeUser');
      if (userStr) {
        const u = JSON.parse(userStr);
        return u.id || u._id || 'guest';
      }
    } catch (e) { }
    return 'guest';
  }

  const storageKey = `hihubble_screen_time_${getUid()}`;
  let screenTimeSeconds = parseInt(localStorage.getItem(storageKey) || '0', 10);

  function updateScreenTimeUI() {
    const box = document.getElementById('screen-time-box');
    if (box) {
      const hours = Math.floor(screenTimeSeconds / 3600);
      const minutes = Math.floor((screenTimeSeconds % 3600) / 60);
      const hStr = hours.toString().padStart(2, '0');
      const mStr = minutes.toString().padStart(2, '0');
      box.textContent = `Screen Time: ${hStr}h ${mStr}m`;
    }
  }

  // Update immediately on load
  updateScreenTimeUI();

  window._screenTimeInterval = setInterval(() => {
    // Only count active application time
    if (document.visibilityState === 'visible') {
      screenTimeSeconds++;

      // Persist occasionally so we don't spam localStorage, but keep it accurate
      if (screenTimeSeconds % 5 === 0) {
        localStorage.setItem(storageKey, screenTimeSeconds.toString());
      }

      updateScreenTimeUI();
    }
  }, 1000);

  // Save precisely when leaving the tab
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      localStorage.setItem(storageKey, screenTimeSeconds.toString());
    }
  });
})();

// --- CONDITIONAL MOBILE COMMENTS RENDERING LOGIC ---
window.activeCommentPostId = null;

window.getCommentsSectionHTML = function(post, currentUserId, currentUser, localUserAvatar) {
    let commentsHTML = '';
    (post.comments || []).forEach(comment => {
      const commentAuthorId = window.getUserIdentifier ? window.getUserIdentifier(comment.author) || comment.author_id || '' : comment.author_id || '';
      const commentUsername = (comment.author?.username || '').toLowerCase();
      const isCommentMe = !!(currentUserId && (currentUserId.toString() === commentAuthorId.toString() || (currentUser?.username && currentUser.username.toLowerCase() === commentUsername)));
      const resolvedCommentAvatar = (isCommentMe && localUserAvatar)
        ? localUserAvatar
        : (comment.author?.profileImage || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&h=80&q=80');

      commentsHTML += `
        <div class="comment-item" style="display: flex; gap: 8px; margin-bottom: 8px; font-size: 13px;">
          <img src="${resolvedCommentAvatar}" alt="" class="comment-author-avatar" data-user-id="${commentAuthorId}" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover; cursor: pointer;" />
          <div>
            <strong class="comment-author-name" data-user-id="${commentAuthorId}" style="color: var(--text-color); margin-right: 4px; cursor: pointer;">${comment.author?.username || 'user'}</strong>
            <span style="color: var(--text-muted);">${comment.text}</span>
          </div>
        </div>
      `;
    });

    return `
      <div class="comments-section mobile-comments-dynamic" style="margin-top: 12px; border-top: 1px solid var(--border-color); padding-top: 12px; animation: fadeInComments 0.2s ease-out;">
        <div class="comments-list" id="comments-list-${post._id}" style="max-height: 250px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--text-muted, rgba(148,163,184,0.5)) transparent; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">
          ${commentsHTML}
        </div>
        
        <div class="post-comment-input-area" style="display: flex; align-items: center; gap: 8px; margin-top: 12px; position: relative;">
          <input type="text" placeholder="Write a comment..." class="comment-input-field" id="comment-input-${post._id}" style="flex:1; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 20px; padding: 8px 40px 8px 16px; color: var(--text-color); font-size: 13px;" />
          <button class="comment-post-btn" data-post-id="${post._id}" style="position: absolute; right: 8px; background: none; border: none; color: var(--primary, #a855f7); cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 6px; transition: transform 0.2s;"><i data-lucide="send" style="width: 16px; height: 16px;"></i></button>
        </div>
      </div>
    `;
};

document.addEventListener('click', (e) => {
  if (window.innerWidth <= 768) {
    const commentBtnAction = e.target.closest('.comment-btn-action');
    const commentsSection = e.target.closest('.comments-section');
    
    if (commentBtnAction) {
      const postId = commentBtnAction.getAttribute('data-post-id');
      
      // Close previously open comment section
      if (window.activeCommentPostId && window.activeCommentPostId !== postId) {
        const oldPostId = window.activeCommentPostId;
        const oldContainer = document.querySelector(`.feed-card[data-post-id="${oldPostId}"] .comments-section`) || document.getElementById(`post-${oldPostId}`)?.querySelector('.comments-section') || document.querySelector(`.comments-list#comments-list-${oldPostId}`)?.closest('.comments-section');
        if (oldContainer) {
          oldContainer.outerHTML = `<div class="comments-section-placeholder" id="comments-placeholder-${oldPostId}"></div>`;
        }
      }

      // Toggle current section
      const isAlreadyOpen = window.activeCommentPostId === postId;
      window.activeCommentPostId = isAlreadyOpen ? null : postId;
      
      const postCard = commentBtnAction.closest('article.feed-card') || document.getElementById(`post-${postId}`) || commentBtnAction.closest('.post-card');
      
      if (postCard) {
         if (window.activeCommentPostId) {
             const post = (window.feedPosts && window.feedPosts.find(p => p._id === postId)) || (window.currentProfilePosts && window.currentProfilePosts.find(p => p._id === postId));
             if (post) {
                const currentUserStr = localStorage.getItem('invibeUser');
                const currentUser = currentUserStr ? JSON.parse(currentUserStr) : null;
                const currentUserId = currentUser ? (currentUser.id || currentUser._id) : null;
                const localUserAvatar = localStorage.getItem('invibeProfileImage') || currentUser?.profileImage;

                const newHTML = window.getCommentsSectionHTML(post, currentUserId, currentUser, localUserAvatar);
                const placeholder = postCard.querySelector('.comments-section-placeholder');
                if (placeholder) {
                   placeholder.outerHTML = newHTML;
                   if (typeof lucide !== 'undefined') lucide.createIcons();
                }
             }
         } else {
             const sec = postCard.querySelector('.comments-section');
             if (sec) {
                sec.outerHTML = `<div class="comments-section-placeholder" id="comments-placeholder-${postId}"></div>`;
             }
         }
      }
    } else if (!commentsSection) {
      if (window.activeCommentPostId) {
         const oldPostId = window.activeCommentPostId;
         const oldContainer = document.querySelector(`.feed-card[data-post-id="${oldPostId}"] .comments-section`) || document.getElementById(`post-${oldPostId}`)?.querySelector('.comments-section') || document.querySelector(`.comments-list#comments-list-${oldPostId}`)?.closest('.comments-section');
         if (oldContainer) {
            oldContainer.outerHTML = `<div class="comments-section-placeholder" id="comments-placeholder-${oldPostId}"></div>`;
         }
         window.activeCommentPostId = null;
      }
    }
  }
});
