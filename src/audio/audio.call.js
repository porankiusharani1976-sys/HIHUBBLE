import { audioState } from './audio.state.js';
import { audioSignaling } from './audio.signaling.js';
import { audioWebRTC } from './audio.webrtc.js';
import { audioUI } from './audio.ui.js';

let callTimeout = null;

function getHeaders() {
  const token = localStorage.getItem('invibe_jwt_token');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
}

export async function initiateAudioCall(recipientId, conversationId, recipientName, recipientAvatar) {
  if (audioState.isCallActive) return;
  audioState.isCallActive = true;
  audioState.currentRecipientId = recipientId;

  console.log(`[Audio Call] Initiating call to ${recipientName} (${recipientId}) in conv ${conversationId}`);
  audioUI.showOutgoingUI(recipientName, recipientAvatar, endAudioCall);

  try {
    // 1. Request microphone permission upfront
    await audioWebRTC.startLocalStream();

    let resolvedConvId = conversationId;
    if (!resolvedConvId || resolvedConvId === recipientId) {
      console.log('[Audio Call] conversationId is missing or matches recipientId. Resolving from backend...');
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
          console.log('[Audio Call] Successfully resolved conversationId:', resolvedConvId);
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
        isVideo: false
      })
    });

    if (!res.ok) {
      throw new Error('Server rejected call initiation.');
    }

    const data = await res.json();
    const callId = data._id || data.id;
    audioState.currentCallId = callId;

    // 3. Join call signaling channel and listen for accept/decline/ringing/ICE candidates
    audioSignaling.subscribeToSignalingChannel(callId, (signal) => {
      handleCallerSignal(signal, recipientName, recipientAvatar);
    });

    // 4. Send initial broadcast invite to recipient
    const currentUserId = localStorage.getItem('invibe_user_id') || 'caller';
    audioSignaling.sendInitialCallInvite(recipientId, callId, currentUserId);

    // 5. Start call unanswered timeout (15 seconds)
    // If no ringing response is received, we consider User offline/unavailable
    if (callTimeout) clearTimeout(callTimeout);
    callTimeout = setTimeout(() => {
      console.log('[Audio Call] Timeout: call went unanswered.');
      if (window.showToast) window.showToast('User unavailable 🔇');
      endAudioCall();
    }, 15000);

  } catch (err) {
    console.error('[Audio Call] Error during initiation:', err);
    if (window.showToast) window.showToast('Failed to start call: ' + err.message);
    audioWebRTC.cleanup();
    audioUI.resetUI();
  }
}

async function handleCallerSignal(signal, partnerName, partnerAvatar) {
  if (!audioState.isCallActive) return;

  if (signal.type === 'ringing') {
    console.log('[Audio Call] Recipient is ringing!');
    audioUI.updateOutgoingStatus('Ringing...');
    audioUI.startOutgoingRingback();

    // Reset/extend timeout since recipient is online and ringing (give them 30 more seconds to answer)
    if (callTimeout) clearTimeout(callTimeout);
    callTimeout = setTimeout(() => {
      console.log('[Audio Call] Timeout: recipient did not answer.');
      if (window.showToast) window.showToast('Call unanswered 🔇');
      endAudioCall();
    }, 30000);

  } else if (signal.type === 'accept') {
    console.log('[Audio Call] Call accepted by recipient!');
    if (callTimeout) clearTimeout(callTimeout);

    audioUI.showActiveCallUI(partnerName, partnerAvatar, endAudioCall, 'Connecting...');

    try {
      await audioWebRTC.setupPeerConnection(
        audioState.currentCallId, 
        true,
        () => {
          console.log('[Audio Call] WebRTC connection established!');
          audioUI.updateActiveCallStatus('Call Connected');
          audioUI.startCallTimer();
        },
        () => {
          console.warn('[Audio Call] WebRTC connection failed.');
          if (window.showToast) window.showToast('Call connection failed.');
          endAudioCall();
        }
      );
      await audioWebRTC.createOffer(audioState.currentCallId);
    } catch (err) {
      console.error('[Audio Call] Peer connection setup failed:', err);
      endAudioCall();
    }
  } else if (signal.type === 'decline') {
    console.log('[Audio Call] Call declined by recipient.');
    if (window.showToast) window.showToast('Call Declined 📞');
    audioUI.playCallEndBeep();
    audioWebRTC.cleanup();
    audioUI.resetUI();
  } else if (signal.type === 'answer') {
    await audioWebRTC.setRemoteAnswer(signal.sdp);
  } else if (signal.type === 'candidate' && signal.role === 'recipient') {
    audioWebRTC.addRemoteCandidate(signal.candidate);
  }
}

export function listenForIncomingAudioCalls(currentUserId) {
  audioSignaling.subscribeToUserInviteChannel(currentUserId, async (invite) => {
    // If we're already on a call, auto decline and ignore
    if (audioState.isCallActive || (window.videoState && window.videoState.isCallActive)) {
      console.log('[Audio Call] Already in active session. Auto-declining incoming call ID:', invite.callId);
      audioSignaling.sendInitialCallInvite(invite.initiatorId, invite.callId, currentUserId);
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
      if (!verifiedCall || verifiedCall.status !== 'ringing' || verifiedCall.isVideo) return;

      audioState.isCallActive = true;
      audioState.currentCallId = verifiedCall._id || verifiedCall.id;
      audioState.currentRecipientId = invite.initiatorId;

      // Populate conversationIdByUser so selectConversation knows how to load messages
      if (window.dmState && window.dmState.conversationIdByUser) {
        window.dmState.conversationIdByUser.set(invite.initiatorId, verifiedCall.conversationId);
      }

      const callerName = verifiedCall.initiator?.full_name || verifiedCall.initiator?.username || 'User';
      const callerAvatar = verifiedCall.initiator?.profile_image_url || '';

      // Subscribe to signal updates
      audioSignaling.subscribeToSignalingChannel(audioState.currentCallId, (signal) => {
        handleRecipientSignal(signal);
      });

      // Immediately send "ringing" signal back to caller to confirm receipt
      audioSignaling.sendSignal(audioState.currentCallId, { type: 'ringing' });

      audioUI.showIncomingUI(callerName, callerAvatar, 
        () => acceptAudioCall(audioState.currentCallId, callerName, callerAvatar),
        () => declineAudioCall(audioState.currentCallId)
      );

    } catch (err) {
      console.error('[Audio Call] Error verifying incoming call:', err);
      audioWebRTC.cleanup();
      audioUI.resetUI();
    }
  });
}

function handleRecipientSignal(signal) {
  if (!audioState.isCallActive) return;

  if (signal.type === 'cancel') {
    console.log('[Audio Call] Caller cancelled the call.');
    if (window.showToast) window.showToast('Call Cancelled 📞');
    audioUI.hideIncomingUI();
    audioWebRTC.cleanup();
    audioUI.resetUI();
  } else if (signal.type === 'offer') {
    audioWebRTC.setupPeerConnection(
      audioState.currentCallId, 
      false,
      () => {
        console.log('[Audio Call] WebRTC connection established!');
        audioUI.updateActiveCallStatus('Call Connected');
        audioUI.startCallTimer();
      },
      () => {
        console.warn('[Audio Call] WebRTC connection failed.');
        if (window.showToast) window.showToast('Call connection failed.');
        endAudioCall();
      }
    )
    .then(() => audioWebRTC.createAnswer(audioState.currentCallId, signal.sdp))
    .catch(err => {
      console.error('[Audio Call] Failed to setup recipient WebRTC:', err);
      endAudioCall();
    });
  } else if (signal.type === 'candidate' && signal.role === 'caller') {
    audioWebRTC.addRemoteCandidate(signal.candidate);
  }
}

async function acceptAudioCall(callId, callerName, callerAvatar) {
  console.log('[Audio Call] Accepting call ID:', callId);
  try {
    const api_url = window.API_URL || '';
    const res = await fetch(`${api_url}/api/calls/accept`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ callId })
    });

    if (!res.ok) throw new Error('Backend failed to accept call.');

    // Notify caller
    audioSignaling.sendSignal(callId, { type: 'accept' });
    
    // Switch views to make the calling interface visible for User B
    const callerId = audioState.currentRecipientId;
    if (callerId) {
      if (window.switchView) window.switchView('chats');
      if (window.selectConversationGlobal) window.selectConversationGlobal(callerId);
    }
    if (window.switchChatModeGlobal) window.switchChatModeGlobal('voice-call');

    // Acquire stream and show UI
    await audioWebRTC.startLocalStream();
    audioUI.showActiveCallUI(callerName, callerAvatar, endAudioCall, 'Connecting...');

  } catch (err) {
    console.error('[Audio Call] Error accepting call:', err);
    if (window.showToast) window.showToast('Failed to accept call.');
    declineAudioCall(callId);
  }
}

async function declineAudioCall(callId) {
  console.log('[Audio Call] Declining call ID:', callId);
  try {
    const api_url = window.API_URL || '';
    await fetch(`${api_url}/api/calls/decline`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ callId })
    });

    audioSignaling.sendSignal(callId, { type: 'decline' });
  } catch (err) {
    console.error('[Audio Call] Error sending decline status:', err);
  }

  audioUI.hideIncomingUI();
  audioWebRTC.cleanup();
  audioUI.resetUI();
}

export async function endAudioCall() {
  if (callTimeout) clearTimeout(callTimeout);

  audioState.isCallActive = false;

  const callId = audioState.currentCallId;
  console.log('[Audio Call] Ending call ID:', callId);

  if (callId) {
    try {
      const api_url = window.API_URL || '';
      await fetch(`${api_url}/api/calls/end`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          callId,
          durationSeconds: audioState.callSeconds
        })
      });

      audioSignaling.sendSignal(callId, { type: 'cancel' });
    } catch (e) {
      console.warn('[Audio Call] Network request to end call failed:', e);
    }
  }

  audioSignaling.unsubscribeFromSignalingChannel();
  audioUI.playCallEndBeep();
  audioWebRTC.cleanup();
  audioUI.resetUI();
}
