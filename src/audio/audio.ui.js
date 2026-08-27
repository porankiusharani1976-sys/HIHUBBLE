import { audioState } from './audio.state.js';

export const audioUI = {
  initAudioContext() {
    if (!audioState.audioCtx) {
      audioState.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioState.audioCtx.state === 'suspended') {
      audioState.audioCtx.resume();
    }
  },

  playTone(freq, type, duration, gainValue = 0.1) {
    try {
      this.initAudioContext();
      const osc = audioState.audioCtx.createOscillator();
      const gain = audioState.audioCtx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioState.audioCtx.currentTime);

      gain.gain.setValueAtTime(gainValue, audioState.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioState.audioCtx.currentTime + duration);

      osc.connect(gain);
      gain.connect(audioState.audioCtx.destination);

      osc.start();
      osc.stop(audioState.audioCtx.currentTime + duration);
    } catch (e) {
      console.error("[Audio UI] Audio Context Tone Error:", e);
    }
  },

  startIncomingRingtone() {
    this.stopAudioFeedback();
    let noteIndex = 0;
    const notes = [523.25, 659.25, 783.99, 1046.50];
    audioState.ringToneInterval = setInterval(() => {
      this.playTone(notes[noteIndex % notes.length], 'triangle', 0.6, 0.12);
      noteIndex++;
    }, 350);
  },

  startOutgoingRingback() {
    this.stopAudioFeedback();
    audioState.ringToneInterval = setInterval(() => {
      this.playTone(440, 'sine', 1.5, 0.04);
      this.playTone(480, 'sine', 1.5, 0.04);
    }, 4000);
  },

  playCallEndBeep() {
    this.stopAudioFeedback();
    this.playTone(250, 'sine', 0.4, 0.08);
  },

  stopAudioFeedback() {
    if (audioState.ringToneInterval) {
      clearInterval(audioState.ringToneInterval);
      audioState.ringToneInterval = null;
    }
  },

  showOutgoingUI(recipientName, recipientAvatar, onCancel) {
    document.getElementById('video-call-active-screen').style.display = 'none';
    document.getElementById('video-call-outgoing-screen').style.display = 'flex';
    document.getElementById('video-call-controls').style.display = 'none';

    document.getElementById('video-call-outgoing-name').textContent = recipientName;
    document.getElementById('video-call-outgoing-avatar').src = recipientAvatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80';
    document.getElementById('video-call-outgoing-status').textContent = 'Calling...';

    const cancelBtn = document.getElementById('cancel-outgoing-call-btn');
    if (cancelBtn) {
      cancelBtn.onclick = (e) => {
        e.stopPropagation();
        onCancel();
      };
    }
  },

  updateOutgoingStatus(statusText) {
    const statusEl = document.getElementById('video-call-outgoing-status');
    if (statusEl) {
      statusEl.textContent = statusText;
    }
  },

  showIncomingUI(callerName, callerAvatar, onAccept, onDecline) {
    const modal = document.getElementById('incoming-call-modal');
    const avatar = document.getElementById('incoming-call-avatar');
    const name = document.getElementById('incoming-call-name');
    const title = document.getElementById('incoming-call-title');

    if (avatar) avatar.src = callerAvatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80';
    if (name) name.textContent = `${callerName} is calling you (Audio)...`;
    if (title) title.textContent = 'Incoming Audio Call';

    if (modal) modal.style.display = 'flex';
    this.startIncomingRingtone();

    // Bind Accept/Decline action buttons
    const acceptBtn = document.getElementById('accept-call-btn');
    const declineBtn = document.getElementById('decline-call-btn');

    if (acceptBtn) {
      acceptBtn.onclick = () => {
        this.hideIncomingUI();
        onAccept();
      };
    }
    if (declineBtn) {
      declineBtn.onclick = () => {
        this.hideIncomingUI();
        onDecline();
      };
    }
  },

  hideIncomingUI() {
    const modal = document.getElementById('incoming-call-modal');
    if (modal) modal.style.display = 'none';
    this.stopAudioFeedback();
  },

  showActiveCallUI(partnerName, partnerAvatar, onEndCall, initialStatus = 'Connecting...') {
    this.stopAudioFeedback();

    // Show panel
    document.getElementById('video-call-outgoing-screen').style.display = 'none';
    document.getElementById('video-call-active-screen').style.display = 'block';
    document.getElementById('video-call-controls').style.display = 'block';

    // Disable camera / screen share button for Audio calls
    const camBtn = document.getElementById('call-cam-btn');
    const shareBtn = document.getElementById('call-share-btn');
    if (camBtn) camBtn.style.display = 'none';
    if (shareBtn) shareBtn.style.display = 'none';

    // Show audio specific feeds
    const remoteContainer = document.getElementById('remote-video-container');
    const localFrame = document.getElementById('video-call-local-frame');
    const audioContainer = document.getElementById('audio-call-active-container');

    if (remoteContainer) remoteContainer.style.display = 'none';
    if (localFrame) localFrame.style.display = 'none';

    if (audioContainer) {
      audioContainer.style.display = 'flex';
      const activeAvatar = document.getElementById('audio-call-active-avatar');
      const activeName = document.getElementById('audio-call-active-name');
      if (activeAvatar) activeAvatar.src = partnerAvatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80';
      if (activeName) activeName.textContent = partnerName;

      // Update call status label inside active screen
      const statusLabel = audioContainer.querySelector('.audio-status-label');
      if (statusLabel) {
        statusLabel.textContent = initialStatus;
      }
    }

    const callTimerDisplay = document.getElementById('call-timer-display');
    if (callTimerDisplay) callTimerDisplay.textContent = 'Connecting...';

    this.bindControls(onEndCall);
  },

  updateActiveCallStatus(statusText) {
    const audioContainer = document.getElementById('audio-call-active-container');
    if (audioContainer) {
      const statusLabel = audioContainer.querySelector('.audio-status-label');
      if (statusLabel) {
        statusLabel.textContent = statusText;
      }
    }
  },

  startCallTimer() {
    this.stopCallTimer();
    audioState.callSeconds = 0;
    const callTimerDisplay = document.getElementById('call-timer-display');
    if (callTimerDisplay) callTimerDisplay.textContent = '00:00:00';

    audioState.callTimerInterval = setInterval(() => {
      audioState.callSeconds++;
      if (callTimerDisplay) {
        callTimerDisplay.textContent = this.formatCallTime(audioState.callSeconds);
      }
    }, 1000);
  },

  stopCallTimer() {
    if (audioState.callTimerInterval) {
      clearInterval(audioState.callTimerInterval);
      audioState.callTimerInterval = null;
    }
  },

  formatCallTime(totalSec) {
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const h = hrs < 10 ? '0' + hrs : hrs;
    const m = mins < 10 ? '0' + mins : mins;
    const s = secs < 10 ? '0' + secs : secs;
    return `${h}:${m}:${s}`;
  },

  bindControls(onEndCall) {
    const muteBtn = document.getElementById('call-mute-btn');
    if (muteBtn) {
      muteBtn.onclick = () => {
        muteBtn.classList.toggle('active');
        const isMuted = muteBtn.classList.contains('active');
        if (audioState.localStream) {
          audioState.localStream.getAudioTracks().forEach(track => {
            track.enabled = !isMuted;
          });
        }
        if (window.showToast) {
          window.showToast(isMuted ? 'Microphone Muted 🔇' : 'Microphone Active 🎙️');
        }
      };
    }

    const speakerBtn = document.getElementById('call-speaker-btn');
    if (speakerBtn) {
      speakerBtn.onclick = () => {
        speakerBtn.classList.toggle('active');
        const isSpeakerOff = speakerBtn.classList.contains('active');
        const remoteVideo = document.getElementById('video-call-remote-feed');
        if (remoteVideo) {
          remoteVideo.muted = isSpeakerOff;
        }
        if (window.showToast) {
          window.showToast(isSpeakerOff ? 'Speaker Output: Muted 🔕' : 'Speaker Output: Loud 🔊');
        }
      };
    }

    const cancelBtn = document.getElementById('cancel-outgoing-call-btn');
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        onEndCall();
      };
    }

    const endBtn = document.getElementById('end-call-btn');
    if (endBtn) {
      endBtn.onclick = () => {
        onEndCall();
      };
    }
  },

  resetUI() {
    this.stopAudioFeedback();
    this.stopCallTimer();

    const muteBtn = document.getElementById('call-mute-btn');
    const camBtn = document.getElementById('call-cam-btn');
    const speakerBtn = document.getElementById('call-speaker-btn');
    const shareBtn = document.getElementById('call-share-btn');
    
    if (muteBtn) muteBtn.classList.remove('active');
    if (camBtn) {
      camBtn.classList.remove('active');
      camBtn.style.display = 'flex';
    }
    if (speakerBtn) speakerBtn.classList.remove('active');
    if (shareBtn) {
      shareBtn.classList.remove('active');
      shareBtn.style.display = 'flex';
    }

    const remoteContainer = document.getElementById('remote-video-container');
    const localFrame = document.getElementById('video-call-local-frame');
    const audioContainer = document.getElementById('audio-call-active-container');
    if (remoteContainer) remoteContainer.style.display = 'block';
    if (localFrame) localFrame.style.display = 'block';
    if (audioContainer) audioContainer.style.display = 'none';

    if (window.switchChatModeGlobal) {
      window.switchChatModeGlobal('chat');
    }
  }
};
