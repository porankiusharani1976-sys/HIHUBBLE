import { videoState } from './video.state.js';
import { videoWebRTC } from './video.webrtc.js';

export const videoUI = {
  initAudioContext() {
    if (!videoState.audioCtx) {
      videoState.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (videoState.audioCtx.state === 'suspended') {
      videoState.audioCtx.resume();
    }
  },

  playTone(freq, type, duration, gainValue = 0.1) {
    try {
      this.initAudioContext();
      const osc = videoState.audioCtx.createOscillator();
      const gain = videoState.audioCtx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, videoState.audioCtx.currentTime);

      gain.gain.setValueAtTime(gainValue, videoState.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, videoState.audioCtx.currentTime + duration);

      osc.connect(gain);
      gain.connect(videoState.audioCtx.destination);

      osc.start();
      osc.stop(videoState.audioCtx.currentTime + duration);
    } catch (e) {
      console.error("[Video UI] Audio Context Tone Error:", e);
    }
  },

  startIncomingRingtone() {
    this.stopAudioFeedback();
    let noteIndex = 0;
    const notes = [523.25, 659.25, 783.99, 1046.50];
    videoState.ringToneInterval = setInterval(() => {
      this.playTone(notes[noteIndex % notes.length], 'triangle', 0.6, 0.12);
      noteIndex++;
    }, 350);
  },

  startOutgoingRingback() {
    this.stopAudioFeedback();
    videoState.ringToneInterval = setInterval(() => {
      this.playTone(440, 'sine', 1.5, 0.04);
      this.playTone(480, 'sine', 1.5, 0.04);
    }, 4000);
  },

  playCallEndBeep() {
    this.stopAudioFeedback();
    this.playTone(250, 'sine', 0.4, 0.08);
  },

  stopAudioFeedback() {
    if (videoState.ringToneInterval) {
      clearInterval(videoState.ringToneInterval);
      videoState.ringToneInterval = null;
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
    if (name) name.textContent = `${callerName} is calling you (Video)...`;
    if (title) title.textContent = 'Incoming Video Call';

    if (modal) modal.style.display = 'flex';
    this.startIncomingRingtone();

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

  showActiveCallUI(partnerName, onEndCall) {
    this.stopAudioFeedback();

    document.getElementById('video-call-outgoing-screen').style.display = 'none';
    document.getElementById('video-call-active-screen').style.display = 'block';
    document.getElementById('video-call-controls').style.display = 'block';

    const camBtn = document.getElementById('call-cam-btn');
    const shareBtn = document.getElementById('call-share-btn');
    if (camBtn) camBtn.style.display = 'flex';
    if (shareBtn) shareBtn.style.display = 'flex';

    const remoteContainer = document.getElementById('remote-video-container');
    const localFrame = document.getElementById('video-call-local-frame');
    const audioContainer = document.getElementById('audio-call-active-container');

    if (remoteContainer) remoteContainer.style.display = 'block';
    if (localFrame) localFrame.style.display = 'block';
    if (audioContainer) audioContainer.style.display = 'none';

    document.getElementById('video-call-remote-name').textContent = partnerName;

    const callTimerDisplay = document.getElementById('call-timer-display');
    if (callTimerDisplay) callTimerDisplay.textContent = 'Connecting...';

    this.bindControls(onEndCall);
  },

  startCallTimer() {
    this.stopCallTimer();
    videoState.callSeconds = 0;
    const callTimerDisplay = document.getElementById('call-timer-display');
    if (callTimerDisplay) callTimerDisplay.textContent = '00:00:00';

    videoState.callTimerInterval = setInterval(() => {
      videoState.callSeconds++;
      if (callTimerDisplay) {
        callTimerDisplay.textContent = this.formatCallTime(videoState.callSeconds);
      }
    }, 1000);
  },

  stopCallTimer() {
    if (videoState.callTimerInterval) {
      clearInterval(videoState.callTimerInterval);
      videoState.callTimerInterval = null;
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
        if (videoState.localStream) {
          videoState.localStream.getAudioTracks().forEach(track => {
            track.enabled = !isMuted;
          });
        }
        if (window.showToast) {
          window.showToast(isMuted ? 'Microphone Muted 🔇' : 'Microphone Active 🎙️');
        }
      };
    }

    const camBtn = document.getElementById('call-cam-btn');
    const localFrame = document.getElementById('video-call-local-frame');
    if (camBtn) {
      camBtn.onclick = () => {
        camBtn.classList.toggle('active');
        const isCamOff = camBtn.classList.contains('active');
        if (videoState.localStream) {
          videoState.localStream.getVideoTracks().forEach(track => {
            track.enabled = !isCamOff;
          });
        }
        if (localFrame) {
          localFrame.style.opacity = isCamOff ? '0.2' : '1';
        }
        if (window.showToast) {
          window.showToast(isCamOff ? 'Camera Off 📷' : 'Camera Active 📹');
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

    const shareBtn = document.getElementById('call-share-btn');
    if (shareBtn) {
      shareBtn.onclick = async () => {
        if (!shareBtn.classList.contains('active')) {
          const success = await videoWebRTC.startScreenShare();
          if (success) {
            shareBtn.classList.add('active');
            if (window.showToast) window.showToast('Screen sharing initialized! 🖥️');
          } else {
            if (window.showToast) window.showToast('Could not share screen 🖥️');
          }
        } else {
          await videoWebRTC.stopScreenShare();
          shareBtn.classList.remove('active');
          if (window.showToast) window.showToast('Screen sharing stopped.');
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

    const localFrame = document.getElementById('video-call-local-frame');
    if (localFrame) {
      localFrame.style.opacity = '1';
    }

    const remoteContainer = document.getElementById('remote-video-container');
    const localFramePanel = document.getElementById('video-call-local-frame');
    const audioContainer = document.getElementById('audio-call-active-container');
    if (remoteContainer) remoteContainer.style.display = 'block';
    if (localFramePanel) localFramePanel.style.display = 'block';
    if (audioContainer) audioContainer.style.display = 'none';

    if (window.switchChatModeGlobal) {
      window.switchChatModeGlobal('chat');
    }
  }
};
