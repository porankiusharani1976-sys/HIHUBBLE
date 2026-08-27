import { videoState } from './video.state.js';
import { videoSignaling } from './video.signaling.js';

export const videoWebRTC = {
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
          videoState.activeRtcConfig = { iceServers: data.iceServers };
          console.log('[Video WebRTC] ICE Servers loaded successfully.');
        }
      }
    } catch (e) {
      console.warn("[Video WebRTC] Could not fetch TURN/STUN servers, using defaults:", e);
    }
  },

  async startLocalStream() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('WebRTC/Camera access is not supported on this connection (requires HTTPS or localhost).');
      }
      videoState.localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      console.log('[Video WebRTC] Acquired local camera + microphone stream.');

      // Render local preview feed
      const localVideo = document.getElementById('video-call-local-feed');
      const localFrame = document.getElementById('video-call-local-frame');
      if (localVideo) {
        localVideo.srcObject = videoState.localStream;
        localVideo.muted = true;
        if (localFrame) localFrame.style.display = 'block';
        localVideo.play().catch(e => console.warn('[Video WebRTC] local play error:', e));
      }

      return videoState.localStream;
    } catch (err) {
      console.error('[Video WebRTC] Failed to get local media stream:', err);
      throw err;
    }
  },

  async setupPeerConnection(callId, isInitiator, onConnectedCallback, onFailedCallback) {
    await this.fetchIceServers();

    const pc = new RTCPeerConnection(videoState.activeRtcConfig);
    videoState.peerConnection = pc;

    // Add local tracks to peer connection
    if (videoState.localStream) {
      videoState.localStream.getTracks().forEach(track => {
        pc.addTrack(track, videoState.localStream);
      });
    }

    // ICE gathering handler
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        videoSignaling.sendSignal(callId, {
          type: 'candidate',
          candidate: event.candidate,
          role: isInitiator ? 'caller' : 'recipient'
        });
      }
    };

    // Remote track handler
    pc.ontrack = (event) => {
      console.log('[Video WebRTC] Received remote track:', event.streams[0]);
      const remoteVideo = document.getElementById('video-call-remote-feed');
      if (remoteVideo && event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
        remoteVideo.muted = false;
        remoteVideo.play().catch(e => console.warn("[Video WebRTC] Remote play error:", e));
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[Video WebRTC] Connection state changed:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        if (onConnectedCallback) onConnectedCallback();
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (onFailedCallback) onFailedCallback();
      }
    };

    return pc;
  },

  async createOffer(callId) {
    const pc = videoState.peerConnection;
    if (!pc) return;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    videoSignaling.sendSignal(callId, {
      type: 'offer',
      sdp: offer.sdp
    });
  },

  async createAnswer(callId, offerSdp) {
    const pc = videoState.peerConnection;
    if (!pc) return;

    await pc.setRemoteDescription(new RTCSessionDescription({
      type: 'offer',
      sdp: offerSdp
    }));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    videoSignaling.sendSignal(callId, {
      type: 'answer',
      sdp: answer.sdp
    });
  },

  async setRemoteAnswer(answerSdp) {
    const pc = videoState.peerConnection;
    if (!pc || pc.signalingState !== 'have-local-offer') return;

    await pc.setRemoteDescription(new RTCSessionDescription({
      type: 'answer',
      sdp: answerSdp
    }));
    console.log('[Video WebRTC] Remote answer applied.');
  },

  addRemoteCandidate(candidate) {
    const pc = videoState.peerConnection;
    if (pc) {
      pc.addIceCandidate(new RTCIceCandidate(candidate))
        .catch(err => console.error('[Video WebRTC] Error adding ICE candidate:', err));
    }
  },

  async startScreenShare() {
    const pc = videoState.peerConnection;
    if (!pc) return;

    try {
      videoState.localScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = videoState.localScreenStream.getVideoTracks()[0];

      const senders = pc.getSenders();
      const videoSender = senders.find(sender => sender.track && sender.track.kind === 'video');
      if (videoSender) {
        await videoSender.replaceTrack(screenTrack);
      }

      screenTrack.onended = () => {
        this.stopScreenShare();
      };
      
      return true;
    } catch (err) {
      console.error('[Video WebRTC] Screen share failed:', err);
      return false;
    }
  },

  async stopScreenShare() {
    if (videoState.localScreenStream) {
      videoState.localScreenStream.getTracks().forEach(track => track.stop());
      videoState.localScreenStream = null;
    }

    const pc = videoState.peerConnection;
    const localStream = videoState.localStream;
    if (pc && localStream) {
      const cameraTrack = localStream.getVideoTracks()[0];
      const senders = pc.getSenders();
      const videoSender = senders.find(sender => sender.track && sender.track.kind === 'video');
      if (videoSender && cameraTrack) {
        await videoSender.replaceTrack(cameraTrack);
      }
    }
  },

  cleanup() {
    if (videoState.localStream) {
      videoState.localStream.getTracks().forEach(track => track.stop());
    }
    if (videoState.localScreenStream) {
      videoState.localScreenStream.getTracks().forEach(track => track.stop());
    }
    if (videoState.peerConnection) {
      videoState.peerConnection.close();
    }

    const localVideo = document.getElementById('video-call-local-feed');
    if (localVideo) {
      localVideo.srcObject = null;
    }
    const remoteVideo = document.getElementById('video-call-remote-feed');
    if (remoteVideo) {
      remoteVideo.srcObject = null;
    }

    videoState.reset();
    console.log('[Video WebRTC] Cleanup completed.');
  }
};
