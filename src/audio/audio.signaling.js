import { supabase } from '../auth.js';

let activeChannel = null;
let inviteChannel = null;

export const audioSignaling = {
  subscribeToSignalingChannel(callId, onSignal) {
    this.unsubscribeFromSignalingChannel();

    const channelName = `call-signaling-${callId}`;
    console.log(`[Audio Signaling] Joining broadcast channel: ${channelName}`);
    
    activeChannel = supabase.channel(channelName, {
      config: {
        broadcast: { self: false }
      }
    });

    activeChannel
      .on('broadcast', { event: 'signal' }, ({ payload }) => {
        console.log('[Audio Signaling] Received signal broadcast:', payload);
        onSignal(payload);
      })
      .subscribe((status) => {
        console.log(`[Audio Signaling] Channel status for ${channelName}: ${status}`);
      });
  },

  sendSignal(callId, signalPayload) {
    if (!activeChannel) {
      console.warn('[Audio Signaling] No active signaling channel to send signal.');
      return;
    }
    console.log('[Audio Signaling] Sending signal:', signalPayload);
    activeChannel.send({
      type: 'broadcast',
      event: 'signal',
      payload: signalPayload
    });
  },

  unsubscribeFromSignalingChannel() {
    if (activeChannel) {
      console.log('[Audio Signaling] Leaving signaling channel.');
      supabase.removeChannel(activeChannel);
      activeChannel = null;
    }
  },

  sendInitialCallInvite(recipientUserId, callId, initiatorId) {
    const inviteChannelName = `user-calls-signaling-${recipientUserId}`;
    console.log(`[Audio Signaling] Dispatching initial invite to: ${inviteChannelName}`);
    
    const chan = supabase.channel(inviteChannelName, {
      config: {
        broadcast: { self: false }
      }
    });

    chan.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        chan.send({
          type: 'broadcast',
          event: 'incoming_call',
          payload: {
            callId,
            initiatorId,
            isVideo: false
          }
        });
        // Remove channel after short delay to allow delivery
        setTimeout(() => {
          supabase.removeChannel(chan);
        }, 1500);
      }
    });
  },

  subscribeToUserInviteChannel(userId, onInvite) {
    if (inviteChannel) {
      supabase.removeChannel(inviteChannel);
    }

    const inviteChannelName = `user-calls-signaling-${userId}`;
    console.log(`[Audio Signaling] Subscribing to user invite channel: ${inviteChannelName}`);
    
    inviteChannel = supabase.channel(inviteChannelName, {
      config: {
        broadcast: { self: false }
      }
    });

    inviteChannel
      .on('broadcast', { event: 'incoming_call' }, ({ payload }) => {
        if (payload && payload.isVideo === false) {
          console.log('[Audio Signaling] Received incoming call invite event:', payload);
          onInvite(payload);
        }
      })
      .subscribe((status, err) => {
        console.log(`[Audio Signaling] Invite Channel subscription status: ${status}`, err || '');
      });
  },

  unsubscribeFromUserInviteChannel() {
    if (inviteChannel) {
      supabase.removeChannel(inviteChannel);
      inviteChannel = null;
    }
  }
};
