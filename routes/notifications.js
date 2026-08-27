import express from 'express';
import { supabase } from '../supabase.js';
import { authenticateToken } from '../utils.js';

const router = express.Router();

router.get('/api/notifications', authenticateToken, async (req, res) => {
  if (!req.user) return res.json([]);
  try {
    const userId = req.user.id;
    const { data: notificationsData, error } = await supabase
      .from('notifications')
      .select('*')
      .or(`recipient_id.eq.${userId},user_id.eq.${userId}`)
      .order('created_at', { ascending: false });

    if (error) {
      console.warn("Notifications query warning:", error.message);
      return res.json([]);
    }

    const items = notificationsData || [];
    const senderIds = [...new Set(items.map(n => n.sender_id).filter(Boolean))];
    const profilesMap = {};
    if (senderIds.length > 0) {
      const { data: profs, error: pErr } = await supabase
        .from('profiles')
        .select('id, full_name, username, profile_image_url')
        .in('id', senderIds);
      if (!pErr && profs) {
        profs.forEach(p => {
          profilesMap[p.id] = p;
        });
      }
    }

    // Fetch mention status for reel_mention notifications
    const reelNotifs = items.filter(n => n.type === 'reel_mention');
    const reelMentionStatuses = {};
    if (reelNotifs.length > 0) {
      const reelIds = reelNotifs.map(n => n.reel_id).filter(Boolean);
      const { data: mentionsData, error: mErr } = await supabase
        .from('mentions')
        .select('reel_id, user_id, status')
        .in('reel_id', reelIds)
        .eq('user_id', userId);
      if (!mErr && mentionsData) {
        mentionsData.forEach(m => {
          reelMentionStatuses[m.reel_id] = m.status;
        });
      }
    }

    res.json(mapNotifications(items, profilesMap, reelMentionStatuses));
  } catch (err) {
    console.error("Notifications error:", err);
    res.json([]);
  }
});

function mapNotifications(items, profilesMap = {}, reelMentionStatuses = {}) {
  return items.map(item => {
    const senderId = item.sender_id;
    const sender = (senderId && profilesMap[senderId]) || item.sender_profile || {};
    const username = sender.username || 'user';
    const fullName = sender.full_name || username;
    const profileImage = sender.profile_image_url || '';

    let text = `${fullName} interacted with you.`;
    switch (item.type) {
      case 'follow':
        text = `${fullName} (@${username}) started following you.`;
        break;
      case 'follow_request':
        text = `${fullName} (@${username}) sent you a Hubbies request.`;
        break;
      case 'accept_follow_request':
        text = `${fullName} (@${username}) accepted your Hubbies request.`;
        break;
      case 'like':
        text = `${fullName} (@${username}) liked your post.`;
        break;
      case 'comment':
        text = `${fullName} (@${username}) commented on your post.`;
        break;
      case 'reply':
        text = `${fullName} (@${username}) replied to your comment.`;
        break;
      case 'comment_like':
        text = `${fullName} (@${username}) liked your comment.`;
        break;
      case 'mention':
        text = `${fullName} (@${username}) mentioned you in a comment.`;
        break;
      case 'reel_mention':
        text = `${fullName} (@${username}) tagged you in a Reel.`;
        break;
    }

    return {
      _id: item.id,
      id: item.id,
      type: item.type,
      text,
      createdAt: item.created_at || item.createdAt,
      isRead: item.is_read || item.read || false,
      senderId: senderId || sender.id || null,
      reelId: item.reel_id || null,
      mentionStatus: item.type === 'reel_mention' ? (reelMentionStatuses[item.reel_id] || 'pending') : null,
      sender: {
        _id: sender.id || senderId || 'usr_unknown',
        id: sender.id || senderId || 'usr_unknown',
        fullName,
        username,
        profileImage
      }
    };
  });
}

router.post('/api/notifications/read', authenticateToken, async (req, res) => {
  if (!req.user) return res.json({ success: false });
  try {
    try {
      await supabase.from('notifications').update({ is_read: true }).eq('recipient_id', req.user.id);
    } catch (_) {}
    try {
      await supabase.from('notifications').update({ is_read: true }).eq('user_id', req.user.id);
    } catch (_) {}
    try {
      await supabase.from('notifications').update({ read: true }).eq('recipient', req.user.id);
    } catch (_) {}
      
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/notifications/:id/read', authenticateToken, async (req, res) => {
  if (!req.user) return res.json({ success: false });
  try {
    const notifId = req.params.id;
    try {
      await supabase.from('notifications').update({ is_read: true }).eq('id', notifId).eq('recipient_id', req.user.id);
    } catch (_) {}
    try {
      await supabase.from('notifications').update({ is_read: true }).eq('id', notifId).eq('user_id', req.user.id);
    } catch (_) {}
    try {
      await supabase.from('notifications').update({ read: true }).eq('id', notifId).eq('recipient', req.user.id);
    } catch (_) {}
      
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
