import express from 'express';
import { supabase } from '../supabase.js';
import { authenticateToken } from '../utils.js';
import { isUserConversationMember } from './chats.js';

const router = express.Router();

// =========================================================
// 1. INITIATE A VOICE / VIDEO CALL
// =========================================================
router.post('/api/calls/initiate', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;

  try {
    const { conversationId, isVideo } = req.body;
    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required.' });
    }

    // Strict BOLA check: Ensure initiating user is a member of the conversation
    const isMember = await isUserConversationMember(conversationId, currentUserId);
    if (!isMember) {
      return res.status(403).json({ error: 'Forbidden: You are not a member of this conversation.' });
    }

    const nowIso = new Date().toISOString();

    // Mark previous ringing calls for this conversation as ended
    await supabase.from('calls')
      .update({ status: 'ended', ended_at: nowIso })
      .eq('conversation_id', conversationId)
      .in('status', ['initiating', 'ringing']);

    // Create new call record adhering to verified schema
    const { data: newCall, error } = await supabase
      .from('calls')
      .insert([{
        conversation_id: conversationId,
        initiator_id: currentUserId,
        status: 'ringing',
        is_video: !!isVideo,
        started_at: nowIso,
        created_at: nowIso
      }])
      .select()
      .single();

    if (error) throw error;

    // Log call initiation in call_history
    try {
      await supabase.from('call_history').insert([{
        call_id: newCall.id,
        user_id: currentUserId,
        event_type: 'initiated',
        created_at: nowIso
      }]);
    } catch (_) {}

    res.status(201).json({
      _id: newCall.id,
      id: newCall.id,
      conversation_id: newCall.conversation_id,
      initiator_id: newCall.initiator_id,
      status: newCall.status,
      is_video: newCall.is_video,
      created_at: newCall.created_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// 2. CHECK FOR INCOMING CALLS
// =========================================================
router.get('/api/calls/incoming', authenticateToken, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  if (!req.user) return res.json(null);
  const currentUserId = req.user.id;

  try {
    // 1. Get user's conversation IDs
    const { data: userMems } = await supabase
      .from('conversation_members')
      .select('conversation_id')
      .eq('user_id', currentUserId);

    const convIds = (userMems || []).map(m => m.conversation_id);
    if (convIds.length === 0) return res.json(null);

    // 2. Find active ringing calls in user's conversations initiated by someone else
    const { data: incomingCall, error } = await supabase
      .from('calls')
      .select(`
        id, conversation_id, initiator_id, status, is_video, created_at,
        initiator:profiles!initiator_id(id, full_name, username, profile_image_url)
      `)
      .in('conversation_id', convIds)
      .eq('status', 'ringing')
      .neq('initiator_id', currentUserId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !incomingCall) return res.json(null);

    res.json({
      _id: incomingCall.id,
      id: incomingCall.id,
      conversationId: incomingCall.conversation_id,
      initiator: incomingCall.initiator,
      isVideo: incomingCall.is_video,
      status: incomingCall.status,
      createdAt: incomingCall.created_at
    });
  } catch (err) {
    res.json(null);
  }
});

// =========================================================
// 3. ACCEPT CALL
// =========================================================
router.post('/api/calls/accept', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;
  const { callId } = req.body;

  if (!callId) return res.status(400).json({ error: 'callId is required.' });

  try {
    // Strict BOLA check: Ensure call exists and user is a participant
    const { data: call, error: callErr } = await supabase
      .from('calls')
      .select('id, conversation_id, initiator_id')
      .eq('id', callId)
      .maybeSingle();

    if (callErr || !call) return res.status(404).json({ error: 'Call not found.' });

    const isMember = await isUserConversationMember(call.conversation_id, currentUserId);
    if (!isMember) {
      return res.status(403).json({ error: 'Forbidden: You are not a participant in this call.' });
    }

    const nowIso = new Date().toISOString();
    const { data: updatedCall, error } = await supabase
      .from('calls')
      .update({ status: 'in_progress', started_at: nowIso })
      .eq('id', callId)
      .select()
      .single();

    if (error) throw error;

    // Log call acceptance in call_history
    try {
      await supabase.from('call_history').insert([{
        call_id: callId,
        user_id: currentUserId,
        event_type: 'accepted',
        created_at: nowIso
      }]);
    } catch (_) {}

    res.json({ success: true, call: updatedCall });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// 4. DECLINE CALL
// =========================================================
router.post('/api/calls/decline', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;
  const { callId } = req.body;

  if (!callId) return res.status(400).json({ error: 'callId is required.' });

  try {
    // Strict BOLA check
    const { data: call, error: callErr } = await supabase
      .from('calls')
      .select('id, conversation_id, initiator_id')
      .eq('id', callId)
      .maybeSingle();

    if (callErr || !call) return res.status(404).json({ error: 'Call not found.' });

    const isMember = await isUserConversationMember(call.conversation_id, currentUserId);
    if (!isMember) {
      return res.status(403).json({ error: 'Forbidden: You are not a participant in this call.' });
    }

    const nowIso = new Date().toISOString();
    await supabase.from('calls')
      .update({ status: 'rejected', ended_at: nowIso })
      .eq('id', callId);

    try {
      await supabase.from('call_history').insert([{
        call_id: callId,
        user_id: currentUserId,
        event_type: 'rejected',
        created_at: nowIso
      }]);
    } catch (_) {}

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// 5. END CALL
// =========================================================
router.post('/api/calls/end', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;
  const { callId, durationSeconds } = req.body;

  if (!callId) return res.status(400).json({ error: 'callId is required.' });

  try {
    // Strict BOLA check
    const { data: call, error: callErr } = await supabase
      .from('calls')
      .select('id, conversation_id, initiator_id')
      .eq('id', callId)
      .maybeSingle();

    if (callErr || !call) return res.status(404).json({ error: 'Call not found.' });

    const isMember = await isUserConversationMember(call.conversation_id, currentUserId);
    if (!isMember) {
      return res.status(403).json({ error: 'Forbidden: You are not a participant in this call.' });
    }

    const nowIso = new Date().toISOString();
    await supabase.from('calls')
      .update({
        status: 'ended',
        duration_seconds: durationSeconds || 0,
        ended_at: nowIso
      })
      .eq('id', callId);

    try {
      await supabase.from('call_history').insert([{
        call_id: callId,
        user_id: currentUserId,
        event_type: 'ended',
        created_at: nowIso
      }]);
    } catch (_) {}

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// 6. GET CALL STATE
// =========================================================
router.get('/api/calls/:callId/state', authenticateToken, async (req, res) => {
  try {
    const { data: call, error } = await supabase
      .from('calls')
      .select('id, conversation_id, initiator_id, status, is_video, duration_seconds, started_at, ended_at, created_at')
      .eq('id', req.params.callId)
      .maybeSingle();

    if (error || !call) return res.status(404).json({ error: 'Call not found.' });

    // Strict BOLA check: Ensure requesting user is a participant of the call's conversation
    const isMember = await isUserConversationMember(call.conversation_id, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: 'Forbidden: You are not authorized to view this call.' });
    }

    res.json({
      _id: call.id,
      id: call.id,
      conversationId: call.conversation_id,
      initiatorId: call.initiator_id,
      status: call.status,
      isVideo: call.is_video,
      startedAt: call.started_at,
      endedAt: call.ended_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// 7. ICE SERVERS FOR WEBRTC
// =========================================================
router.get('/api/calls/ice-servers', authenticateToken, async (req, res) => {
  try {
    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ];
    if (process.env.TURN_URL) {
      iceServers.push({
        urls: process.env.TURN_URL,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_PASSWORD
      });
    }
    res.json({ iceServers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
