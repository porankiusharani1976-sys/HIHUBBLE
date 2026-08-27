import { videoState } from './video.state.js';
import { videoSignaling } from './video.signaling.js';
import { videoWebRTC } from './video.webrtc.js';
import { videoUI } from './video.ui.js';

let callTimeout = null;

function getHeaders() {
  const token = localStorage.getItem('invibe_jwt_token');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
}

export async function initiateVideoCall(recipientId, conversationId, recipientName, recipientAvatar) {
  if (videoState.isCallActive) return;
  videoState.isCallActive = true;
  videoState.currentRecipientId = recipientId;

  console.log(`[Video Call] Initiating call to ${recipientName} (${recipientId}) in conv ${conversationId}`);
  videoUI.showOutgoingUI(recipientName, recipientAvatar, endVideoCall);

  try {
    // 1. Request local video/audio streams upfront
    await videoWebRTC.startLocalStream();

    let resolvedConvId = conversationId;
    if (!resolvedConvId || resolvedConvId === recipientId) {
      console.log('[Video Call] conversationId is missing or matches recipientId. Resolving from backend...');
      const token = localStorage.getItem('invibe_jwt_token');
      const api_url = window.API_URL || '';
      const resConv = await fetch(`${api_url}/api/chats/direct/${recipientId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });
      if (resConv.ok) {
        const convData = await resConv.json();
        resolvedConvId = convData.conversationId || convData.id || convData._id;
        if (resolvedConvId) {
          console.log('[Video Call] Successfully resolved conversationId:', resolvedConvId);
          if (window.dmState && window.dmState.conversationIdByUser) {
            window.dmState.conversationIdByUser.set(recipientId, resolvedConvId);
          }
        }
      }
    }

    if (!resolvedConvId) {
      throw new Error('Conversation ID could not be verified or resolved.');
    }

    // 2. Register call with Express backend
    const api_url = window.API_URL || '';
    const res = await fetch(`${api_url}/api/calls/initiate`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        conversationId: resolvedConvId,
        isVideo: true
      })
    });

    if (!res.ok) {
      throw new Error('Server rejected call initiation.');
    }

    const data = await res.json();
    const callId = data._id || data.id;
    videoState.currentCallId = callId;

    // 3. Join call signaling channel and listen for accept/decline/ringing/ICE candidates
    videoSignaling.subscribeToSignalingChannel(callId, (signal) => {
      handleCallerSignal(signal, recipientName, recipientAvatar);
    });

    // 4. Send initial broadcast invite to recipient
    const currentUserId = localStorage.getItem('invibe_user_id') || 'caller';
    videoSignaling.sendInitialCallInvite(recipientId, callId, currentUserId);

    // 5. Start call unanswered timeout (15 seconds)
    // If no ringing response is received, we consider User offline/unavailable
    if (callTimeout) clearTimeout(callTimeout);
    callTimeout = setTimeout(() => {
      console.log('[Video Call] Timeout: call went unanswered.');
      if (window.showToast) window.showToast('User unavailable 🔇');
      endVideoCall();
    }, 15000);

  } catch (err) {
    console.error('[Video Call] Error during initiation:', err);
    if (window.showToast) window.showToast('Failed to start call: ' + err.message);
    videoWebRTC.cleanup();
    videoUI.resetUI();
  }
}

async function handleCallerSignal(signal, partnerName, partnerAvatar) {
  if (!videoState.isCallActive) return;

  if (signal.type === 'ringing') {
    console.log('[Video Call] Recipient is ringing!');
    videoUI.updateOutgoingStatus('Ringing...');
    videoUI.startOutgoingRingback();

    // Reset/extend timeout since recipient is online and ringing (give them 30 more seconds to answer)
    if (callTimeout) clearTimeout(callTimeout);
    callTimeout = setTimeout(() => {
      console.log('[Video Call] Timeout: recipient did not answer.');
      if (window.showToast) window.showToast('Call unanswered 🔇');
      endVideoCall();
    }, 30000);

  } else if (signal.type === 'accept') {
    console.log('[Video Call] Call accepted by recipient!');
    if (callTimeout) clearTimeout(callTimeout);

    videoUI.showActiveCallUI(partnerName, endVideoCall);

    try {
      await videoWebRTC.setupPeerConnection(
        videoState.currentCallId, 
        true,
        () => {
          console.log('[Video Call] WebRTC connection established!');
          videoUI.startCallTimer();
        },
        () => {
          console.warn('[Video Call] WebRTC connection failed.');
          if (window.showToast) window.showToast('Call connection failed.');
          endVideoCall();
        }
      );
      await videoWebRTC.createOffer(videoState.currentCallId);
    } catch (err) {
      console.error('[Video Call] Peer connection setup failed:', err);
      endVideoCall();
    }
  } else if (signal.type === 'decline') {
    console.log('[Video Call] Call declined by recipient.');
    if (window.showToast) window.showToast('Call Declined 📞');
    videoUI.playCallEndBeep();
    videoWebRTC.cleanup();
    videoUI.resetUI();
  } else if (signal.type === 'answer') {
    await videoWebRTC.setRemoteAnswer(signal.sdp);
  } else if (signal.type === 'candidate' && signal.role === 'recipient') {
    videoWebRTC.addRemoteCandidate(signal.candidate);
  }
}

export function listenForIncomingVideoCalls(currentUserId) {
  videoSignaling.subscribeToUserInviteChannel(currentUserId, async (invite) => {
    // If we're already on a call, auto decline and ignore
    if (videoState.isCallActive || (window.audioState && window.audioState.isCallActive)) {
      console.log('[Video Call] Already in active session. Auto-declining incoming call ID:', invite.callId);
      videoSignaling.sendInitialCallInvite(invite.initiatorId, invite.callId, currentUserId);
      return;
    }

    try {
      // Securely pull call details from incoming endpoint to verify authentication
      const api_url = window.API_URL || '';
      const res = await fetch(`${api_url}/api/calls/incoming`, {
        headers: getHeaders()
      });

      if (!res.ok) return;
      const verifiedCall = await res.json();
      if (!verifiedCall || verifiedCall.status !== 'ringing' || !verifiedCall.isVideo) return;

      videoState.isCallActive = true;
      videoState.currentCallId = verifiedCall._id || verifiedCall.id;
      videoState.currentRecipientId = invite.initiatorId;

      // Populate conversationIdByUser so selectConversation knows how to load messages
      if (window.dmState && window.dmState.conversationIdByUser) {
        window.dmState.conversationIdByUser.set(invite.initiatorId, verifiedCall.conversationId);
      }

      const callerName = verifiedCall.initiator?.full_name || verifiedCall.initiator?.username || 'User';
      const callerAvatar = verifiedCall.initiator?.profile_image_url || '';

      // Subscribe to signal updates
      videoSignaling.subscribeToSignalingChannel(videoState.currentCallId, (signal) => {
        handleRecipientSignal(signal);
      });

      // Immediately send "ringing" signal back to caller to confirm receipt
      videoSignaling.sendSignal(videoState.currentCallId, { type: 'ringing' });

      videoUI.showIncomingUI(callerName, callerAvatar, 
        () => acceptVideoCall(videoState.currentCallId, callerName, callerAvatar),
        () => declineVideoCall(videoState.currentCallId)
      );

    } catch (err) {
      console.error('[Video Call] Error verifying incoming call:', err);
      videoWebRTC.cleanup();
      videoUI.resetUI();
    }
  });
}

function handleRecipientSignal(signal) {
  if (!videoState.isCallActive) return;

  if (signal.type === 'cancel') {
    console.log('[Video Call] Caller cancelled the call.');
    if (window.showToast) window.showToast('Call Cancelled 📞');
    videoUI.hideIncomingUI();
    videoWebRTC.cleanup();
    videoUI.resetUI();
  } else if (signal.type === 'offer') {
    videoWebRTC.setupPeerConnection(
      videoState.currentCallId, 
      false,
      () => {
        console.log('[Video Call] WebRTC connection established!');
        videoUI.startCallTimer();
      },
      () => {
        console.warn('[Video Call] WebRTC connection failed.');
        if (window.showToast) window.showToast('Call connection failed.');
        endVideoCall();
      }
    )
    .then(() => videoWebRTC.createAnswer(videoState.currentCallId, signal.sdp))
    .catch(err => {
      console.error('[Video Call] Failed to setup recipient WebRTC:', err);
      endVideoCall();
    });
  } else if (signal.type === 'candidate' && signal.role === 'caller') {
    videoWebRTC.addRemoteCandidate(signal.candidate);
  }
}

async function acceptVideoCall(callId, callerName, callerAvatar) {
  console.log('[Video Call] Accepting call ID:', callId);
  try {
    const api_url = window.API_URL || '';
    const res = await fetch(`${api_url}/api/calls/accept`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ callId })
    });

    if (!res.ok) throw new Error('Backend failed to accept call.');

    // Notify caller
    videoSignaling.sendSignal(callId, { type: 'accept' });
    
    // Switch views to make the calling interface visible for User B
    const callerId = videoState.currentRecipientId;
    if (callerId) {
      if (window.switchView) window.switchView('chats');
      if (window.selectConversationGlobal) window.selectConversationGlobal(callerId);
    }
    if (window.switchChatModeGlobal) window.switchChatModeGlobal('call');

    // Acquire stream and show UI
    await videoWebRTC.startLocalStream();
    videoUI.showActiveCallUI(callerName, endVideoCall);

  } catch (err) {
    console.error('[Video Call] Error accepting call:', err);
    if (window.showToast) window.showToast('Failed to accept call.');
    declineVideoCall(callId);
  }
}

async function declineVideoCall(callId) {
  console.log('[Video Call] Declining call ID:', callId);
  try {
    const api_url = window.API_URL || '';
    await fetch(`${api_url}/api/calls/decline`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ callId })
    });

    videoSignaling.sendSignal(callId, { type: 'decline' });
  } catch (err) {
    console.error('[Video Call] Error sending decline status:', err);
  }

  videoUI.hideIncomingUI();
  videoWebRTC.cleanup();
  videoUI.resetUI();
}

export async function endVideoCall() {
  if (callTimeout) clearTimeout(callTimeout);

  videoState.isCallActive = false;

  const callId = videoState.currentCallId;
  console.log('[Video Call] Ending call ID:', callId);

  if (callId) {
    try {
      const api_url = window.API_URL || '';
      await fetch(`${api_url}/api/calls/end`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          callId,
          durationSeconds: videoState.callSeconds
        })
      });

      videoSignaling.sendSignal(callId, { type: 'cancel' });
    } catch (e) {
      console.warn('[Video Call] Network request to end call failed:', e);
    }
  }

  videoSignaling.unsubscribeFromSignalingChannel();
  videoUI.playCallEndBeep();
  videoWebRTC.cleanup();
  videoUI.resetUI();
}
