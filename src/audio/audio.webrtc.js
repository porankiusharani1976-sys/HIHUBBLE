import { audioState } from './audio.state.js';
import { audioSignaling } from './audio.signaling.js';

export const audioWebRTC = {
  async fetchIceServers() {
    try {
      const token = localStorage.getItem('invibe_jwt_token');
      const api_url = window.API_URL || '';
      const res = await fetch(`${api_url}/api/calls/ice-servers`, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.iceServers) {
          audioState.activeRtcConfig = { iceServers: data.iceServers };
          console.log('[Audio WebRTC] ICE Servers loaded successfully.');
        }
      }
    } catch (e) {
      console.warn("[Audio WebRTC] Could not fetch TURN/STUN servers, using defaults:", e);
    }
  },

  async startLocalStream() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('WebRTC/Microphone access is not supported on this connection (requires HTTPS or localhost).');
      }
      audioState.localStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: true
      });
      console.log('[Audio WebRTC] Acquired local microphone stream.');
      return audioState.localStream;
    } catch (err) {
      console.error('[Audio WebRTC] Failed to get local microphone:', err);
      throw err;
    }
  },

  async setupPeerConnection(callId, isInitiator, onConnectedCallback, onFailedCallback) {
    await this.fetchIceServers();

    const pc = new RTCPeerConnection(audioState.activeRtcConfig);
    audioState.peerConnection = pc;

    // Add local tracks
    if (audioState.localStream) {
      audioState.localStream.getTracks().forEach(track => {
        pc.addTrack(track, audioState.localStream);
      });
    }

    // ICE gathering handler
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        audioSignaling.sendSignal(callId, {
          type: 'candidate',
          candidate: event.candidate,
          role: isInitiator ? 'caller' : 'recipient'
        });
      }
    };

    // Remote track handler
    pc.ontrack = (event) => {
      console.log('[Audio WebRTC] Received remote track:', event.streams[0]);
      const remoteVideo = document.getElementById('video-call-remote-feed');
      if (remoteVideo && event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
        remoteVideo.muted = false;
        remoteVideo.play().catch(e => console.warn("[Audio WebRTC] Remote play error:", e));
      }
    };

    // Connection state listeners
    pc.onconnectionstatechange = () => {
      console.log('[Audio WebRTC] Connection state changed:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        if (onConnectedCallback) onConnectedCallback();
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (onFailedCallback) onFailedCallback();
      }
    };

    return pc;
  },

  async createOffer(callId) {
    const pc = audioState.peerConnection;
    if (!pc) return;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    audioSignaling.sendSignal(callId, {
      type: 'offer',
      sdp: offer.sdp
    });
  },

  async createAnswer(callId, offerSdp) {
    const pc = audioState.peerConnection;
    if (!pc) return;

    await pc.setRemoteDescription(new RTCSessionDescription({
      type: 'offer',
      sdp: offerSdp
    }));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    audioSignaling.sendSignal(callId, {
      type: 'answer',
      sdp: answer.sdp
    });
  },

  async setRemoteAnswer(answerSdp) {
    const pc = audioState.peerConnection;
    if (!pc || pc.signalingState !== 'have-local-offer') return;

    await pc.setRemoteDescription(new RTCSessionDescription({
      type: 'answer',
      sdp: answerSdp
    }));
    console.log('[Audio WebRTC] Remote answer applied.');
  },

  addRemoteCandidate(candidate) {
    const pc = audioState.peerConnection;
    if (pc) {
      pc.addIceCandidate(new RTCIceCandidate(candidate))
        .catch(err => console.error('[Audio WebRTC] Error adding ICE candidate:', err));
    }
  },

  cleanup() {
    if (audioState.localStream) {
      audioState.localStream.getTracks().forEach(track => track.stop());
    }
    if (audioState.peerConnection) {
      audioState.peerConnection.close();
    }
    audioState.reset();
    console.log('[Audio WebRTC] Cleanup completed.');
  }
};
