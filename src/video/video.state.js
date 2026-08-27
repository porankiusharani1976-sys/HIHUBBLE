export const videoState = {
  localStream: null,
  localScreenStream: null,
  peerConnection: null,
  currentCallId: null,
  isCallActive: false,
  currentRecipientId: null,
  callSeconds: 0,
  callTimerInterval: null,
  ringToneInterval: null,
  audioCtx: null,
  activeRtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ]
  },
  iceCandidateSendPromise: Promise.resolve(),

  reset() {
    this.localStream = null;
    this.localScreenStream = null;
    this.peerConnection = null;
    this.currentCallId = null;
    this.isCallActive = false;
    this.currentRecipientId = null;
    this.callSeconds = 0;
    if (this.callTimerInterval) {
      clearInterval(this.callTimerInterval);
      this.callTimerInterval = null;
    }
    if (this.ringToneInterval) {
      clearInterval(this.ringToneInterval);
      this.ringToneInterval = null;
    }
    this.iceCandidateSendPromise = Promise.resolve();
  }
};

window.videoState = videoState;
