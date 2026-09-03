import { supabase } from '../auth.js';

let activeChannel = null;
let inviteChannel = null;

export const videoSignaling = {
  subscribeToSignalingChannel(callId, onSignal) {
    this.unsubscribeFromSignalingChannel();

    const channelName = `call-signaling-${callId}`;
    console.log(`[Video Signaling] Joining broadcast channel: ${channelName}`);
    
    activeChannel = supabase.channel(channelName, {
      config: {
        broadcast: { self: false }
      }
    });

    activeChannel
      .on('broadcast', { event: 'signal' }, ({ payload }) => {
        console.log('[Video Signaling] Received signal broadcast:', payload);
        onSignal(payload);
      })
      .subscribe((status) => {
        console.log(`[Video Signaling] Channel status for ${channelName}: ${status}`);
      });
  },

  sendSignal(callId, signalPayload) {
    if (!activeChannel) {
      console.warn('[Video Signaling] No active signaling channel to send signal.');
      return;
    }
    console.log('[Video Signaling] Sending signal:', signalPayload);
    activeChannel.send({
      type: 'broadcast',
      event: 'signal',
      payload: signalPayload
    });
  },

  unsubscribeFromSignalingChannel() {
    if (activeChannel) {
      console.log('[Video Signaling] Leaving signaling channel.');
      supabase.removeChannel(activeChannel);
      activeChannel = null;
    }
  },

  sendInitialCallInvite(recipientUserId, callId, initiatorId) {
    const inviteChannelName = `user-video-calls-signaling-${recipientUserId}`;
    console.log(`[Video Signaling] Dispatching initial invite to: ${inviteChannelName}`);
    
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
            isVideo: true
          }
        });
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

    const inviteChannelName = `user-video-calls-signaling-${userId}`;
    console.log(`[Video Signaling] Subscribing to user invite channel: ${inviteChannelName}`);
    
    inviteChannel = supabase.channel(inviteChannelName, {
      config: {
        broadcast: { self: false }
      }
    });

    inviteChannel
      .on('broadcast', { event: 'incoming_call' }, ({ payload }) => {
        if (payload && payload.isVideo === true) {
          console.log('[Video Signaling] Received incoming call invite event:', payload);
          onInvite(payload);
        }
      })
      .subscribe((status, err) => {
        console.log(`[Video Signaling] Invite Channel subscription status: ${status}`, err || '');
      });
  },

  unsubscribeFromUserInviteChannel() {
    if (inviteChannel) {
      supabase.removeChannel(inviteChannel);
      inviteChannel = null;
    }
  }
};
