import express from 'express';
import { supabase } from '../supabase.js';
import { authenticateToken } from '../utils.js';

const router = express.Router();

// --- HELPER FOR ROBUST USER RESOLUTION ---
async function resolveProfile(targetId) {
  if (!targetId) return null;
  const cleanId = String(targetId).trim().replace(/^@/, '');
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId);

  let query = supabase.from('profiles').select('id, username, full_name, profile_image_url, is_online, last_active_at');
  if (isUuid) query = query.eq('id', cleanId);
  else query = query.eq('username', cleanId);

  const { data: profile } = await query.maybeSingle();
  return profile;
}

// Helper to reliably compute canonical direct conversation user ordering using string comparison
function getCanonicalUserOrder(userA, userB) {
  const strA = String(userA);
  const strB = String(userB);
  const isALessOrEqual = strA.localeCompare(strB) <= 0;
  return {
    direct_user1_id: isALessOrEqual ? strA : strB,
    direct_user2_id: isALessOrEqual ? strB : strA
  };
}

// Helper to find all shared direct conversation IDs between userA and userB
async function getAllSharedDirectConversationIds(userA_id, userB_id) {
  if (!userA_id || !userB_id) return [];
  const { direct_user1_id, direct_user2_id } = getCanonicalUserOrder(userA_id, userB_id);

  const { data: convByDirect } = await supabase
    .from('conversations')
    .select('id')
    .eq('type', 'direct')
    .or(`and(direct_user1_id.eq.${direct_user1_id},direct_user2_id.eq.${direct_user2_id}),and(direct_user1_id.eq.${direct_user2_id},direct_user2_id.eq.${direct_user1_id})`);

  const { data: memA } = await supabase
    .from('conversation_members')
    .select('conversation_id')
    .eq('user_id', userA_id);

  const convIdsA = (memA || []).map(m => m.conversation_id);
  let sharedConvIds = [];
  if (convIdsA.length > 0) {
    const { data: memB } = await supabase
      .from('conversation_members')
      .select('conversation_id')
      .eq('user_id', userB_id)
      .in('conversation_id', convIdsA);
    sharedConvIds = (memB || []).map(m => m.conversation_id);
  }

  return Array.from(new Set([
    ...(convByDirect || []).map(c => c.id),
    ...sharedConvIds
  ]));
}

// Helper to reliably check if a user is a member of a conversation
export async function isUserConversationMember(conversationId, userId) {
  if (!conversationId || !userId) return false;

  // Check direct_user1_id / direct_user2_id on conversations table
  const { data: conv } = await supabase
    .from('conversations')
    .select('id, type, direct_user1_id, direct_user2_id, created_by')
    .eq('id', conversationId)
    .maybeSingle();

  if (!conv) return false;

  if (conv.type === 'direct') {
    if (conv.direct_user1_id === userId || conv.direct_user2_id === userId) {
      return true;
    }
  }

  // Check conversation_members table
  const { data: member } = await supabase
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();

  return !!member;
}

// Helper to find the canonical direct conversation between userA and userB
async function findDirectConversation(userA_id, userB_id) {
  if (!userA_id || !userB_id) return null;
  const { direct_user1_id, direct_user2_id } = getCanonicalUserOrder(userA_id, userB_id);

  const allCandidateIds = await getAllSharedDirectConversationIds(userA_id, userB_id);
  if (allCandidateIds.length === 0) return null;

  // Fetch all candidates and pick the one with latest message
  const { data: candidates } = await supabase
    .from('conversations')
    .select('id, type, direct_user1_id, direct_user2_id, last_message_at')
    .in('id', allCandidateIds)
    .eq('type', 'direct');

  if (!candidates || candidates.length === 0) return null;

  let bestCandidate = candidates[0];
  let latestTime = 0;

  for (const c of candidates) {
    const t = c.last_message_at ? new Date(c.last_message_at).getTime() : 0;
    if (t >= latestTime) {
      latestTime = t;
      bestCandidate = c;
    }
  }

  // Ensure member records exist for both participants in the chosen conversation
  try {
    await supabase.from('conversation_members').upsert([
      { conversation_id: bestCandidate.id, user_id: userA_id, role: 'member' },
      { conversation_id: bestCandidate.id, user_id: userB_id, role: 'member' }
    ], { onConflict: 'conversation_id,user_id' });
  } catch (_) {}

  // Backfill direct_user1_id and direct_user2_id if missing
  if (!bestCandidate.direct_user1_id || !bestCandidate.direct_user2_id) {
    try {
      await supabase.from('conversations')
        .update({ direct_user1_id, direct_user2_id })
        .eq('id', bestCandidate.id);
    } catch (_) {}
  }

  return bestCandidate;
}

// =========================================================
// 1. GET INBOX CONVERSATION THREADS
// =========================================================
router.get('/api/chats/threads', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;

  try {
    // 1. Find all conversations the user is a member of
    const { data: userMemberships, error: memErr } = await supabase
      .from('conversation_members')
      .select('conversation_id, unread_count, last_read_at, role, muted, archived, pinned')
      .eq('user_id', currentUserId);

    if (memErr) throw memErr;

    const convIds = (userMemberships || []).map(m => m.conversation_id);
    const unreadMap = new Map((userMemberships || []).map(m => [m.conversation_id, m.unread_count || 0]));

    // Fetch active online user IDs within 90-second TTL
    const ninetySecAgo = new Date(Date.now() - 90 * 1000).toISOString();
    const { data: activeOnlineRows } = await supabase
      .from('online_users')
      .select('user_id')
      .eq('status', 'online')
      .gte('last_seen', ninetySecAgo);
    const activeOnlineSet = new Set((activeOnlineRows || []).map(r => r.user_id));

    // If user has no conversations yet, suggest recent connections / active users as empty threads
    if (convIds.length === 0) {
      const { data: followsData } = await supabase
        .from('follows')
        .select('follower_id, following_id')
        .or(`follower_id.eq.${currentUserId},following_id.eq.${currentUserId}`);

      const connectedUserIds = new Set();
      (followsData || []).forEach(f => {
        if (f.follower_id && f.follower_id !== currentUserId) connectedUserIds.add(f.follower_id);
        if (f.following_id && f.following_id !== currentUserId) connectedUserIds.add(f.following_id);
      });

      let suggestedProfiles = [];
      const connIdsArr = Array.from(connectedUserIds);

      if (connIdsArr.length > 0) {
        const { data: connProfs } = await supabase
          .from('profiles')
          .select('id, username, full_name, profile_image_url, is_online, last_active_at')
          .in('id', connIdsArr)
          .not('username', 'ilike', 'search_test_%');
        suggestedProfiles = connProfs || [];
      }

      if (suggestedProfiles.length === 0) {
        const { data: allRealProfiles } = await supabase
          .from('profiles')
          .select('id, username, full_name, profile_image_url, is_online, last_active_at')
          .neq('id', currentUserId)
          .not('username', 'ilike', 'search_test_%')
          .limit(20);
        suggestedProfiles = allRealProfiles || [];
      }

      const emptyThreads = (suggestedProfiles || []).map(p => ({
        conversationId: null,
        type: 'direct',
        user: {
          _id: p.id,
          fullName: p.full_name || p.username,
          username: p.username,
          profileImage: p.profile_image_url || '',
          isOnline: activeOnlineSet.has(p.id),
          lastSeen: p.last_active_at
        },
        lastMessage: null,
        unreadCount: 0
      }));
      return res.json(emptyThreads);
    }

    // 2. Fetch conversations using verified schema columns
    const { data: conversations, error: convErr } = await supabase
      .from('conversations')
      .select('id, type, title, name, description, group_avatar, group_image_url, created_by, last_message_at, direct_user1_id, direct_user2_id, created_at, updated_at')
      .in('id', convIds)
      .order('last_message_at', { ascending: false });

    if (convErr) throw convErr;

    // 3. Fetch members for these conversations
    const { data: allMembers, error: allMemErr } = await supabase
      .from('conversation_members')
      .select('conversation_id, user_id, profile:profiles(id, username, full_name, profile_image_url, is_online, last_active_at)')
      .in('conversation_id', convIds);

    if (allMemErr) throw allMemErr;

    // 4. Fetch latest message & typing status for each thread
    const threadResults = await Promise.all(
      (conversations || []).map(async (conv) => {
        const { data: lastMsg } = await supabase
          .from('messages')
          .select('id, conversation_id, sender_id, recipient_id, content, media_url, media_type, status, is_read, is_deleted, deleted_for_everyone, created_at')
          .eq('conversation_id', conv.id)
          .eq('deleted_for_everyone', false)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        const { data: typingData } = await supabase
          .from('typing_status')
          .select('user_id, is_typing, profile:profiles(username)')
          .eq('conversation_id', conv.id)
          .eq('is_typing', true)
          .neq('user_id', currentUserId)
          .maybeSingle();

        if (conv.type === 'direct') {
          const otherMember = (allMembers || []).find(m => m.conversation_id === conv.id && m.user_id !== currentUserId);
          let p = otherMember?.profile;

          // Fallback to direct_user1_id / direct_user2_id lookup if profile join incomplete
          if (!p) {
            const otherUserId = conv.direct_user1_id === currentUserId ? conv.direct_user2_id : conv.direct_user1_id;
            if (otherUserId) {
              const { data: fetchedProfile } = await supabase
                .from('profiles')
                .select('id, username, full_name, profile_image_url, is_online, last_active_at')
                .eq('id', otherUserId)
                .maybeSingle();
              p = fetchedProfile;
            }
          }

          if (!p || (p.username && p.username.startsWith('search_test_'))) return null;

          return {
            conversationId: conv.id,
            type: 'direct',
            user: {
              _id: p.id,
              fullName: p.full_name || p.username,
              username: p.username,
              profileImage: p.profile_image_url || '',
              isOnline: activeOnlineSet.has(p.id),
              lastSeen: p.last_active_at
            },
            lastMessage: lastMsg ? {
              _id: lastMsg.id,
              content: lastMsg.content,
              mediaUrl: lastMsg.media_url,
              mediaType: lastMsg.media_type,
              sender: lastMsg.sender_id,
              createdAt: lastMsg.created_at,
              status: lastMsg.status
            } : null,
            unreadCount: unreadMap.get(conv.id) || 0,
            isTyping: !!typingData,
            typingUsername: typingData?.profile?.username || null
          };
        } else {
          return {
            conversationId: conv.id,
            type: 'group',
            groupName: conv.name || conv.title || 'Group Chat',
            groupImageUrl: conv.group_image_url || conv.group_avatar || '',
            user: {
              _id: conv.id,
              fullName: conv.name || conv.title || 'Group Chat',
              username: 'group',
              profileImage: conv.group_image_url || conv.group_avatar || '',
              isOnline: false
            },
            lastMessage: lastMsg ? {
              _id: lastMsg.id,
              content: lastMsg.content,
              mediaUrl: lastMsg.media_url,
              mediaType: lastMsg.media_type,
              sender: lastMsg.sender_id,
              createdAt: lastMsg.created_at,
              status: lastMsg.status
            } : null,
            unreadCount: unreadMap.get(conv.id) || 0,
            isTyping: !!typingData,
            typingUsername: typingData?.profile?.username || null
          };
        }
      })
    );

    const filtered = (threadResults || []).filter(Boolean);
    const seenDirectUserIds = new Set();
    const deduplicatedThreads = [];

    for (const thread of filtered) {
      if (thread.type === 'direct') {
        const targetUserId = thread.user?._id;
        if (targetUserId && seenDirectUserIds.has(targetUserId.toString())) {
          continue; // Skip duplicate direct thread for same partner
        }
        if (targetUserId) seenDirectUserIds.add(targetUserId.toString());
      }
      deduplicatedThreads.push(thread);
    }

    res.json(deduplicatedThreads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// 2. OPEN OR CREATE 1-ON-1 DIRECT CONVERSATION
// =========================================================
router.post('/api/chats/direct/:targetId', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;
  const targetParam = req.params.targetId;

  try {
    const targetProfile = await resolveProfile(targetParam);
    if (!targetProfile) return res.status(404).json({ error: 'Target user profile not found.' });
    if (targetProfile.id === currentUserId) return res.status(400).json({ error: 'Cannot open chat with yourself.' });

    const targetUserId = targetProfile.id;

    // Check live online presence from online_users table (90s TTL)
    const ninetySecAgo = new Date(Date.now() - 90 * 1000).toISOString();
    const { data: activeOnlineRow } = await supabase
      .from('online_users')
      .select('status, last_seen')
      .eq('user_id', targetUserId)
      .eq('status', 'online')
      .gte('last_seen', ninetySecAgo)
      .maybeSingle();
    const isTargetOnline = !!activeOnlineRow;

    // 1. Check existing direct conversation via canonical helper (handles legacy data)
    const existingConv = await findDirectConversation(currentUserId, targetUserId);

    if (existingConv) {
      return res.json({
        conversationId: existingConv.id,
        targetUser: {
          _id: targetProfile.id,
          fullName: targetProfile.full_name || targetProfile.username,
          username: targetProfile.username,
          profileImage: targetProfile.profile_image_url || '',
          isOnline: isTargetOnline,
          lastSeen: targetProfile.last_active_at
        }
      });
    }

    // 2. Create new direct conversation storing direct_user1_id and direct_user2_id
    const { direct_user1_id, direct_user2_id } = getCanonicalUserOrder(currentUserId, targetUserId);
    const nowIso = new Date().toISOString();
    const { data: newConv, error: createErr } = await supabase
      .from('conversations')
      .insert([{
        type: 'direct',
        created_by: currentUserId,
        direct_user1_id,
        direct_user2_id,
        last_message_at: nowIso
      }])
      .select()
      .single();

    if (createErr) throw createErr;

    // Add both member records
    await supabase.from('conversation_members').insert([
      { conversation_id: newConv.id, user_id: currentUserId, role: 'member' },
      { conversation_id: newConv.id, user_id: targetUserId, role: 'member' }
    ]);

    res.status(201).json({
      conversationId: newConv.id,
      targetUser: {
        _id: targetProfile.id,
        fullName: targetProfile.full_name || targetProfile.username,
        username: targetProfile.username,
        profileImage: targetProfile.profile_image_url || '',
        isOnline: isTargetOnline,
        lastSeen: targetProfile.last_active_at
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper to resolve Supabase Storage URLs
function resolveStoragePublicUrl(storagePathOrUrl, bucketName = 'chat-media') {
  if (!storagePathOrUrl || typeof storagePathOrUrl !== 'string') return '';
  const trimmed = storagePathOrUrl.trim();
  if (!trimmed) return '';

  // If already an HTTP(S) URL or base64 data URL
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('data:')) {
    return trimmed;
  }

  // Hub keys like "story_...", "reel_...", "post_..." are logical reference IDs, NOT storage paths
  if (trimmed.startsWith('story_') || trimmed.startsWith('reel_') || trimmed.startsWith('post_') || trimmed.startsWith('reel')) {
    return trimmed;
  }

  // If it's a relative storage path (e.g. "chat-media/convId/..." or "convId/userId/filename.png")
  const cleanPath = trimmed.replace(/^\/?(chat-media|chat-attachments)\//, '');
  const { data } = supabase.storage.from(bucketName).getPublicUrl(cleanPath);
  return data?.publicUrl || trimmed;
}

// =========================================================
// 3. FETCH MESSAGES FOR CONVERSATION
// =========================================================
router.get('/api/chats/messages/:convId', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;
  const convId = req.params.convId;

  try {
    let conversationId = convId;
    let targetUserId = null;
    let allConvIds = [];
    const isConvUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(convId);

    if (isConvUuid) {
      const { data: convCheck } = await supabase
        .from('conversations')
        .select('id, type, direct_user1_id, direct_user2_id')
        .eq('id', convId)
        .maybeSingle();

      if (convCheck) {
        // Strict BOLA check: Ensure requesting user is a member of this conversation
        const isMember = await isUserConversationMember(convCheck.id, currentUserId);
        if (!isMember) {
          return res.status(403).json({ error: 'Forbidden: You are not authorized to view messages in this conversation.' });
        }

        conversationId = convCheck.id;
        if (convCheck.type === 'direct') {
          targetUserId = convCheck.direct_user1_id === currentUserId ? convCheck.direct_user2_id : convCheck.direct_user1_id;
          if (!targetUserId) {
            const { data: members } = await supabase
              .from('conversation_members')
              .select('user_id')
              .eq('conversation_id', convCheck.id)
              .neq('user_id', currentUserId);
            if (members && members.length > 0) targetUserId = members[0].user_id;
          }
        }
      } else {
        // Param is a target user UUID — resolve to profile
        const targetProfile = await resolveProfile(convId);
        if (targetProfile) {
          targetUserId = targetProfile.id;
          const directConv = await findDirectConversation(currentUserId, targetProfile.id);
          if (directConv) conversationId = directConv.id;
        }
      }
    } else {
      // Param is a username — resolve to profile
      const targetProfile = await resolveProfile(convId);
      if (targetProfile) {
        targetUserId = targetProfile.id;
        const directConv = await findDirectConversation(currentUserId, targetProfile.id);
        if (directConv) conversationId = directConv.id;
      }
    }

    if (targetUserId) {
      allConvIds = await getAllSharedDirectConversationIds(currentUserId, targetUserId);
    }
    if (conversationId && !allConvIds.includes(conversationId)) {
      allConvIds.push(conversationId);
    }

    if (allConvIds.length === 0) {
      res.setHeader('X-Conversation-Id', '');
      return res.json([]);
    }

    // Verify current user has access to each conversation in allConvIds
    for (const cId of allConvIds) {
      const allowed = await isUserConversationMember(cId, currentUserId);
      if (!allowed) {
        return res.status(403).json({ error: 'Forbidden: You are not authorized to view messages in this conversation.' });
      }
    }

    const primaryConvId = conversationId || allConvIds[0];
    res.setHeader('X-Conversation-Id', primaryConvId);

    // Fetch messages across all linked conversation IDs
    const { data: messages, error } = await supabase
      .from('messages')
      .select(`
        id, conversation_id, sender_id, recipient_id, content, media_url, media_type, media_name, media_size,
        reply_to_id, status, is_read, is_deleted, is_pinned, is_starred, is_edited, deleted_for_everyone, created_at, updated_at,
        sender:profiles!sender_id(id, username, full_name, profile_image_url)
      `)
      .in('conversation_id', allConvIds)
      .eq('deleted_for_everyone', false)
      .order('created_at', { ascending: true });

    if (error) throw error;

    const msgIds = (messages || []).map(m => m.id);

    // Fetch message_attachments for these messages
    let attachmentsMap = new Map();
    if (msgIds.length > 0) {
      const { data: attData } = await supabase
        .from('message_attachments')
        .select('id, message_id, storage_path, file_name, mime_type, file_size, file_type')
        .in('message_id', msgIds);

      (attData || []).forEach(att => {
        if (!attachmentsMap.has(att.message_id)) attachmentsMap.set(att.message_id, att);
      });
    }

    // Fetch reactions for these messages
    let reactionsMap = new Map();
    if (msgIds.length > 0) {
      const { data: rxData } = await supabase
        .from('message_reactions')
        .select('id, message_id, user_id, emoji, created_at')
        .in('message_id', msgIds);

      (rxData || []).forEach(rx => {
        if (!reactionsMap.has(rx.message_id)) reactionsMap.set(rx.message_id, []);
        reactionsMap.get(rx.message_id).push(rx);
      });
    }

    // Mark messages as read for current user across all linked conversations
    await supabase.from('messages')
      .update({ status: 'read', is_read: true })
      .in('conversation_id', allConvIds)
      .neq('sender_id', currentUserId);

    await supabase.from('conversation_members')
      .update({ unread_count: 0, last_read_at: new Date().toISOString() })
      .in('conversation_id', allConvIds)
      .eq('user_id', currentUserId);

    // Record read status in message_reads
    if (msgIds.length > 0) {
      const readRows = msgIds.map(mId => ({
        message_id: mId,
        user_id: currentUserId,
        read_at: new Date().toISOString()
      }));
      await supabase.from('message_reads').upsert(readRows, { onConflict: 'message_id,user_id', ignoreDuplicates: true });
    }

    const formattedMessages = (messages || []).map(m => {
      const att = attachmentsMap.get(m.id);
      const rawPath = att?.storage_path || m.media_url || '';
      const resolvedMediaUrl = resolveStoragePublicUrl(rawPath);
      const effectiveType = m.media_type || att?.file_type || (rawPath ? 'image' : 'text');

      return {
        _id: m.id,
        id: m.id,
        conversationId: m.conversation_id,
        sender: m.sender ? {
          _id: m.sender.id,
          fullName: m.sender.full_name || m.sender.username,
          username: m.sender.username,
          profileImage: m.sender.profile_image_url || ''
        } : m.sender_id,
        recipient: m.recipient_id,
        content: m.content,
        mediaUrl: resolvedMediaUrl,
        mediaType: effectiveType,
        mediaName: m.media_name || att?.file_name || (effectiveType === 'image' ? 'image.png' : null),
        mediaSize: m.media_size || att?.file_size || null,
        durationSeconds: att?.duration_seconds || null,
        attachment: att ? {
          id: att.id,
          storagePath: att.storage_path,
          fileName: att.file_name,
          mimeType: att.mime_type,
          fileSize: att.file_size,
          durationSeconds: att.duration_seconds || null
        } : null,
        replyToId: m.reply_to_id,
        status: m.status,
        isPinned: !!m.is_pinned,
        isStarred: !!m.is_starred,
        isEdited: !!m.is_edited,
        reactions: reactionsMap.get(m.id) || [],
        createdAt: m.created_at
      };
    });

    res.json(formattedMessages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// SEARCH INSIDE MESSAGES
// =========================================================
router.get('/api/chats/search', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;
  const queryText = (req.query.q || '').trim();

  if (!queryText) return res.json([]);

  try {
    const { data: memberships } = await supabase
      .from('conversation_members')
      .select('conversation_id')
      .eq('user_id', currentUserId);

    const convIds = (memberships || []).map(m => m.conversation_id);

    const { data: searchResults, error: searchErr } = await supabase
      .from('messages')
      .select('id, conversation_id, sender_id, recipient_id, content, media_url, media_type, created_at')
      .ilike('content', `%${queryText}%`)
      .order('created_at', { ascending: false })
      .limit(50);

    if (searchErr) throw searchErr;

    const userMessages = (searchResults || []).filter(msg => {
      if (msg.sender_id === currentUserId || msg.recipient_id === currentUserId) return true;
      if (convIds.includes(msg.conversation_id)) return true;
      return false;
    });

    res.json(userMessages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// 4. SEND MESSAGE (TEXT, MEDIA, VOICE NOTES, ATTACHMENTS)
// =========================================================
router.post('/api/chats/message', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;

  try {
    const { conversationId, recipient, recipientId, content, mediaUrl, mediaType, mediaName, mediaSize, replyToId, duration, waveform, isStoryReply } = req.body;
    let targetConvId = conversationId;
    let targetRecipientId = recipientId || recipient;

    let targetProfile = null;
    if (targetRecipientId) {
      targetProfile = await resolveProfile(targetRecipientId);
      if (targetProfile) targetRecipientId = targetProfile.id;
    }

    // Auto-create/resolve conversation if conversationId missing
    if (!targetConvId && targetRecipientId) {
      const existingConv = await findDirectConversation(currentUserId, targetRecipientId);

      if (existingConv) {
        targetConvId = existingConv.id;
      } else {
        const { direct_user1_id, direct_user2_id } = getCanonicalUserOrder(currentUserId, targetRecipientId);
        const { data: newConv, error: createConvErr } = await supabase
          .from('conversations')
          .insert([{
            type: 'direct',
            created_by: currentUserId,
            direct_user1_id,
            direct_user2_id,
            last_message_at: new Date().toISOString()
          }])
          .select()
          .single();

        if (createConvErr) throw createConvErr;

        await supabase.from('conversation_members').insert([
          { conversation_id: newConv.id, user_id: currentUserId, role: 'member' },
          { conversation_id: newConv.id, user_id: targetRecipientId, role: 'member' }
        ]);

        targetConvId = newConv.id;
      }
    }

    if (!targetConvId) return res.status(400).json({ error: 'Conversation or Recipient ID is required.' });

    // Strict BOLA check: Ensure sender is a participant of targetConvId
    const isMember = await isUserConversationMember(targetConvId, currentUserId);
    if (!isMember) {
      return res.status(403).json({ error: 'Forbidden: You are not authorized to send messages to this conversation.' });
    }

    const nowIso = new Date().toISOString();

    // If mediaUrl is a base64 data URL, upload to Supabase Storage 'chat-media' bucket
    let finalMediaUrl = mediaUrl || null;
    let finalMediaType = mediaType || 'text';
    let finalMimeType = 'image/jpeg';
    let calculatedSize = typeof mediaSize === 'number' ? mediaSize : 0;

    // Rule 1: Reject temporary browser blob URLs immediately
    if (typeof finalMediaUrl === 'string' && finalMediaUrl.trim().toLowerCase().startsWith('blob:')) {
      return res.status(400).json({ error: 'Browser blob URLs cannot be persisted in messages.' });
    }

    // If content contains legacy embedded HTML tags, extract mediaUrl and mediaType
    let cleanContent = content || '';
    if (!finalMediaUrl && typeof cleanContent === 'string') {
      const imgMatch = cleanContent.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
      const videoMatch = cleanContent.match(/<video[^>]+src=["']([^"']+)["'][^>]*>/i);
      if (imgMatch) {
        finalMediaUrl = imgMatch[1];
        finalMediaType = 'image';
        cleanContent = '';
      } else if (videoMatch) {
        finalMediaUrl = videoMatch[1];
        finalMediaType = 'video';
        cleanContent = '';
      }
    }

    if (typeof finalMediaUrl === 'string' && finalMediaUrl.startsWith('data:')) {
      try {
        const commaIdx = finalMediaUrl.indexOf(',');
        if (commaIdx > 0) {
          const metaPart = finalMediaUrl.substring(0, commaIdx);
          const base64Data = finalMediaUrl.substring(commaIdx + 1);
          const mimeMatch = metaPart.match(/^data:([^;,]+)/i);
          const rawMime = mimeMatch ? mimeMatch[1].trim() : (req.body.mimeType || 'image/jpeg');
          finalMimeType = rawMime;
          const cleanMime = rawMime.split(';')[0].trim().toLowerCase();

          const buffer = Buffer.from(base64Data, 'base64');
          calculatedSize = buffer.length;

          const isVideo = cleanMime.startsWith('video/') || finalMediaType === 'video' || (mediaType === 'video');
          const isAudio = cleanMime.startsWith('audio/') || finalMediaType === 'voice' || finalMediaType === 'audio';

          let ext = 'jpg';
          if (isVideo) {
            ext = cleanMime.includes('mp4') ? 'mp4' : 'webm';
          } else if (isAudio) {
            ext = cleanMime.includes('mp3') ? 'mp3' : (cleanMime.includes('ogg') ? 'ogg' : 'webm');
          } else {
            ext = cleanMime.split('/')[1]?.split('+')[0] || 'jpg';
          }

          const filename = `${targetConvId}/${currentUserId}/${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;

          const { error: uploadErr } = await supabase.storage
            .from('chat-media')
            .upload(filename, buffer, { contentType: cleanMime, upsert: true });

          if (uploadErr) {
            console.error('[Chat Storage Upload Error]:', uploadErr.message);
            return res.status(500).json({ error: `Failed to upload chat media: ${uploadErr.message}` });
          }

          const { data: publicUrlData } = supabase.storage.from('chat-media').getPublicUrl(filename);
          if (!publicUrlData?.publicUrl) {
            return res.status(500).json({ error: 'Failed to retrieve public URL for chat media.' });
          }

          finalMediaUrl = publicUrlData.publicUrl;
          finalMediaType = isAudio ? 'audio' : (isVideo ? 'video' : (cleanMime.startsWith('image/') ? 'image' : (finalMediaType || 'file')));
        }
      } catch (err) {
        console.error('Error during chat media upload processing:', err);
        return res.status(500).json({ error: 'Failed to process chat media.' });
      }
    }

    const isVideoMsg = finalMediaType === 'video' || finalMimeType.startsWith('video/');
    const isAudioMsg = finalMediaType === 'audio' || finalMediaType === 'voice' || finalMimeType.startsWith('audio/');
    const defaultMediaName = isAudioMsg ? 'voice_message.webm' : (isVideoMsg ? 'video.mp4' : (finalMediaType === 'image' ? 'image.png' : 'file'));
    const messageMediaType = isAudioMsg ? 'audio' : finalMediaType;

    // Insert Message using verified columns
    const { data: newMsg, error: msgErr } = await supabase
      .from('messages')
      .insert([{
        conversation_id: targetConvId,
        sender_id: currentUserId,
        recipient_id: targetRecipientId,
        content: cleanContent || '',
        media_url: finalMediaUrl,
        media_type: messageMediaType,
        media_name: mediaName || defaultMediaName,
        media_size: calculatedSize || null,
        reply_to_id: replyToId || null,
        status: 'sent',
        created_at: nowIso,
        updated_at: nowIso
      }])
      .select()
      .single();

    if (msgErr) {
      console.error('Message insert error:', msgErr);
      return res.status(500).json({ error: 'Message could not be sent.' });
    }

    // Insert Attachment Record if image/video/audio/media present
    if (finalMediaUrl && finalMediaType && finalMediaType !== 'text') {
      try {
        const fileTypeEnum = isAudioMsg ? 'audio' : (isVideoMsg ? 'video' : (finalMediaType === 'image' || finalMimeType.startsWith('image/') ? 'image' : 'document'));

        await supabase.from('message_attachments').insert([{
          message_id: newMsg.id,
          conversation_id: targetConvId,
          sender_id: currentUserId,
          storage_path: finalMediaUrl,
          file_name: mediaName || defaultMediaName,
          mime_type: finalMimeType,
          file_size: calculatedSize,
          duration_seconds: req.body.durationSeconds ? parseInt(req.body.durationSeconds) : (req.body.duration ? parseInt(req.body.duration) : null),
          file_type: fileTypeEnum,
          created_at: nowIso
        }]);
      } catch (attErr) {
        console.error('Attachment record insert error:', attErr);
      }
    }

    // Update conversation last_message_at
    await supabase.from('conversations')
      .update({ last_message_at: nowIso, updated_at: nowIso })
      .eq('id', targetConvId);

    // Increment unread count for other members
    const { data: otherMembers } = await supabase
      .from('conversation_members')
      .select('user_id, unread_count')
      .eq('conversation_id', targetConvId)
      .neq('user_id', currentUserId);

    for (const mem of (otherMembers || [])) {
      await supabase.from('conversation_members')
        .update({ unread_count: (mem.unread_count || 0) + 1 })
        .eq('conversation_id', targetConvId)
        .eq('user_id', mem.user_id);
    }

    // Notification for offline recipient
    if (targetRecipientId) {
      try {
        const { data: recOnline } = await supabase.from('online_users').select('status').eq('user_id', targetRecipientId).maybeSingle();
        const isOnline = recOnline?.status === 'online';
        if (!isOnline) {
          const { data: senderProf } = await supabase.from('profiles').select('username').eq('id', currentUserId).maybeSingle();
          const senderName = senderProf?.username || 'Someone';
          const notifMessage = isStoryReply
            ? `@${senderName} replied to your HUBB`
            : `@${senderName} sent you a message: "${content ? content.slice(0, 30) : 'Attachment'}"`;
          await supabase.from('notifications').insert([{
            user_id: targetRecipientId,
            recipient_id: targetRecipientId,
            sender_id: currentUserId,
            type: 'chat_message',
            message: notifMessage,
            is_read: false,
            created_at: nowIso
          }]);
        }
      } catch (_) {}
    }

    res.status(201).json({
      _id: newMsg.id,
      id: newMsg.id,
      conversationId: targetConvId,
      sender: currentUserId,
      recipient: targetRecipientId,
      content: newMsg.content,
      mediaUrl: newMsg.media_url,
      mediaType: newMsg.media_type,
      mediaName: newMsg.media_name,
      mediaSize: newMsg.media_size,
      durationSeconds: req.body.durationSeconds ? parseInt(req.body.durationSeconds) : null,
      replyToId: newMsg.reply_to_id,
      status: newMsg.status,
      createdAt: newMsg.created_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// 5. TYPING INDICATOR STATUS
// =========================================================
router.post('/api/chats/typing', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;
  const { conversationId, isTyping } = req.body;

  if (!conversationId) return res.status(400).json({ error: 'Conversation ID required.' });

  try {
    // Strict BOLA check
    const isMember = await isUserConversationMember(conversationId, currentUserId);
    if (!isMember) {
      return res.status(403).json({ error: 'Forbidden: You are not a participant in this conversation.' });
    }

    await supabase.from('typing_status').upsert({
      conversation_id: conversationId,
      user_id: currentUserId,
      is_typing: !!isTyping,
      updated_at: new Date().toISOString()
    }, { onConflict: 'conversation_id,user_id' });

    res.json({ success: true, isTyping: !!isTyping });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// 6. READ RECEIPTS
// =========================================================
router.post('/api/chats/read', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;
  const { conversationId } = req.body;

  if (!conversationId) return res.status(400).json({ error: 'Conversation ID required.' });

  try {
    // Strict BOLA check
    const isMember = await isUserConversationMember(conversationId, currentUserId);
    if (!isMember) {
      return res.status(403).json({ error: 'Forbidden: You are not a participant in this conversation.' });
    }

    await supabase.from('messages')
      .update({ status: 'read', is_read: true })
      .eq('conversation_id', conversationId)
      .neq('sender_id', currentUserId);

    await supabase.from('conversation_members')
      .update({ unread_count: 0, last_read_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .eq('user_id', currentUserId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/chats/:targetUserId/read', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;
  const targetUserId = req.params.targetUserId;

  try {
    const targetProfile = await resolveProfile(targetUserId);
    const resolvedTargetId = targetProfile ? targetProfile.id : targetUserId;

    // Find all direct conversation IDs between current user and target user
    const { direct_user1_id, direct_user2_id } = getCanonicalUserOrder(currentUserId, resolvedTargetId);

    const { data: convs } = await supabase
      .from('conversations')
      .select('id')
      .eq('type', 'direct')
      .or(`and(direct_user1_id.eq.${direct_user1_id},direct_user2_id.eq.${direct_user2_id}),and(direct_user1_id.eq.${direct_user2_id},direct_user2_id.eq.${direct_user1_id})`);

    const { data: memA } = await supabase
      .from('conversation_members')
      .select('conversation_id')
      .eq('user_id', currentUserId);

    const convIdsA = (memA || []).map(m => m.conversation_id);
    let sharedConvIds = [];
    if (convIdsA.length > 0) {
      const { data: memB } = await supabase
        .from('conversation_members')
        .select('conversation_id')
        .eq('user_id', resolvedTargetId)
        .in('conversation_id', convIdsA);
      sharedConvIds = (memB || []).map(m => m.conversation_id);
    }

    const allConvIds = Array.from(new Set([
      ...(convs || []).map(c => c.id),
      ...sharedConvIds
    ]));

    if (allConvIds.length > 0) {
      await supabase.from('messages')
        .update({ status: 'read', is_read: true })
        .in('conversation_id', allConvIds)
        .neq('sender_id', currentUserId);

      await supabase.from('conversation_members')
        .update({ unread_count: 0, last_read_at: new Date().toISOString() })
        .in('conversation_id', allConvIds)
        .eq('user_id', currentUserId);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// 7. EMOJI REACTIONS
// =========================================================
router.post('/api/chats/messages/:msgId/reaction', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;
  const msgId = req.params.msgId;
  const { emoji } = req.body;

  if (!emoji) return res.status(400).json({ error: 'Emoji is required.' });

  try {
    const { data: msg } = await supabase.from('messages').select('id, conversation_id').eq('id', msgId).maybeSingle();
    if (!msg) return res.status(404).json({ error: 'Message not found.' });

    // Strict BOLA check
    const isMember = await isUserConversationMember(msg.conversation_id, currentUserId);
    if (!isMember) {
      return res.status(403).json({ error: 'Forbidden: You are not a participant in this conversation.' });
    }

    const { data: existing } = await supabase
      .from('message_reactions')
      .select('id')
      .eq('message_id', msgId)
      .eq('user_id', currentUserId)
      .eq('emoji', emoji)
      .maybeSingle();

    if (existing) {
      await supabase.from('message_reactions').delete().eq('id', existing.id);
      return res.json({ success: true, action: 'removed', emoji });
    }

    const { data: rx } = await supabase
      .from('message_reactions')
      .insert([{ message_id: msgId, user_id: currentUserId, emoji }])
      .select()
      .single();

    res.json({ success: true, action: 'added', reaction: rx });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// 8. DELETE MESSAGE
// =========================================================
router.delete('/api/chats/messages/:msgId', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const msgId = req.params.msgId;
  const currentUserId = req.user.id;
  const forEveryone = req.query.forEveryone === 'true';

  try {
    const { data: msg } = await supabase.from('messages').select('id, sender_id, conversation_id').eq('id', msgId).maybeSingle();
    if (!msg) return res.status(404).json({ error: 'Message not found.' });

    // Strict BOLA check
    const isMember = await isUserConversationMember(msg.conversation_id, currentUserId);
    if (!isMember) {
      return res.status(403).json({ error: 'Forbidden: You are not a participant in this conversation.' });
    }

    if (forEveryone) {
      if (msg.sender_id !== currentUserId) return res.status(403).json({ error: 'You can only delete your own messages for everyone.' });
      await supabase.from('messages').update({ deleted_for_everyone: true, is_deleted: true, content: 'This message was deleted' }).eq('id', msgId);
      return res.json({ success: true, mode: 'everyone' });
    } else {
      await supabase.from('messages').update({ is_deleted: true }).eq('id', msgId).eq('sender_id', currentUserId);
      return res.json({ success: true, mode: 'me' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// 9. GROUP CHAT CREATION
// =========================================================
router.post('/api/chats/groups', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;
  const { name, description, groupImageUrl, memberIds } = req.body;

  if (!name) return res.status(400).json({ error: 'Group name is required.' });

  try {
    const nowIso = new Date().toISOString();
    const { data: groupConv, error: groupErr } = await supabase
      .from('conversations')
      .insert([{
        type: 'group',
        name,
        title: name,
        description: description || null,
        group_image_url: groupImageUrl || null,
        group_avatar: groupImageUrl || null,
        created_by: currentUserId,
        last_message_at: nowIso
      }])
      .select()
      .single();

    if (groupErr) throw groupErr;

    const uniqueMembers = Array.from(new Set([currentUserId, ...(memberIds || [])]));
    const memberRows = uniqueMembers.map(uid => ({
      conversation_id: groupConv.id,
      user_id: uid,
      role: uid === currentUserId ? 'admin' : 'member'
    }));

    await supabase.from('conversation_members').insert(memberRows);

    res.status(201).json({
      success: true,
      conversationId: groupConv.id,
      group: groupConv
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
