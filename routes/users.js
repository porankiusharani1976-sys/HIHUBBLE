import express from 'express';
import { supabase } from '../supabase.js';
import { authenticateToken } from '../utils.js';

const router = express.Router();

router.post('/api/users/profile', authenticateToken, async (req, res) => {
  const { profileImage, bio, fullName, username, phoneNumber } = req.body;
  try {
    const userId = req.user.id;
    let newProfileImageUrl = null;

    // 1. If there is a profile image in base64, upload it to Supabase Storage
    if (profileImage && profileImage.startsWith('data:image')) {
      const matches = profileImage.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        const ext = matches[1];
        const base64Data = matches[2];
        const buffer = Buffer.from(base64Data, 'base64');
        const filename = `${userId}/avatar-${Date.now()}.${ext}`;

        const { error: uploadErr } = await supabase.storage
          .from('profile-images')
          .upload(filename, buffer, {
            contentType: `image/${ext}`,
            upsert: true
          });

        if (uploadErr) {
          console.error('[Storage Upload Error]:', uploadErr.message);
          throw new Error(uploadErr.message || 'Failed to upload profile image to storage.');
        }

        const { data: publicUrlData } = supabase.storage
          .from('profile-images')
          .getPublicUrl(filename);

        if (publicUrlData?.publicUrl) {
          newProfileImageUrl = publicUrlData.publicUrl;
        }
      } else if (profileImage.startsWith('http')) {
        newProfileImageUrl = profileImage;
      }
    } else if (profileImage && profileImage.startsWith('http')) {
      newProfileImageUrl = profileImage;
    }

    // 2. Prepare updates for the PostgreSQL `profiles` table
    const updates = {
      updated_at: new Date().toISOString()
    };
    if (newProfileImageUrl) updates.profile_image_url = newProfileImageUrl;
    if (bio !== undefined) updates.bio = bio;
    if (fullName !== undefined) updates.full_name = fullName;
    
    // Check username uniqueness if provided
    if (username !== undefined) {
      const trimmedUsername = username.trim().toLowerCase();
      const { data: existingUser, error: checkErr } = await supabase
        .from('profiles')
        .select('id')
        .eq('username', trimmedUsername)
        .neq('id', userId)
        .maybeSingle();

      if (!checkErr && existingUser) {
        return res.status(400).json({ error: 'Username already taken.' });
      }
      updates.username = trimmedUsername;
    }

    if (phoneNumber !== undefined) {
      let targetNumber = phoneNumber.trim().replace(/\s+/g, '');
      if (targetNumber && !targetNumber.startsWith('+')) {
        if (targetNumber.length === 10) targetNumber = '+91' + targetNumber;
        else return res.status(400).json({ error: "Phone number must include a country code starting with '+' (e.g. +919347712945)" });
      }
      updates.phone_number = targetNumber || null;
    }

    // 3. Update the profile in PostgreSQL
    const { data: updatedUser, error: updateErr } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select('id, full_name, email, username, profile_image_url, bio, phone_number')
      .single();

    if (updateErr || !updatedUser) {
      console.error('[Profile Update DB Error]:', updateErr);
      throw new Error(updateErr?.message || 'Failed to update profile in database.');
    }

    // Return the updated user mapped to the camelCase fields expected by frontend
    res.json({
      success: true,
      message: 'Profile updated successfully.',
      user: {
        id: updatedUser.id,
        fullName: updatedUser.full_name,
        email: updatedUser.email,
        username: updatedUser.username,
        profileImage: updatedUser.profile_image_url,
        bio: updatedUser.bio,
        phoneNumber: updatedUser.phone_number
      }
    });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- PRESENCE HEARTBEAT ---
const handlePresenceHeartbeat = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const userId = req.user.id;
  const socketId = req.body.socketId || null;
  const nowIso = new Date().toISOString();

  try {
    const { error } = await supabase
      .from('online_users')
      .upsert({
        user_id: userId,
        socket_id: socketId,
        status: 'online',
        last_seen: nowIso,
        updated_at: nowIso
      }, { onConflict: 'user_id' });

    if (error) throw error;

    // Keep profiles table timestamp fresh
    supabase.from('profiles').update({ last_active_at: nowIso }).eq('id', userId).catch(() => {});

    res.json({ success: true, status: 'online' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

router.post('/api/users/presence', authenticateToken, handlePresenceHeartbeat);
router.post('/api/presence/heartbeat', authenticateToken, handlePresenceHeartbeat);

router.post('/api/users/logout-presence', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const userId = req.user.id;
  const nowIso = new Date().toISOString();

  try {
    await supabase
      .from('online_users')
      .update({
        status: 'offline',
        last_seen: nowIso,
        updated_at: nowIso
      })
      .eq('user_id', userId);

    res.json({ success: true, status: 'offline' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET ONLINE USERS (ACTIVE HUBBERS) ---
const handleGetOnlineUsers = async (req, res) => {
  if (!req.user) return res.json({ onlineCount: 0, users: [], onlineUserIds: [] });
  try {
    const currentUserId = req.user.id;
    // Heartbeat threshold: 90 seconds
    const ninetySecAgo = new Date(Date.now() - 90 * 1000).toISOString();

    // 1. Auto-cleanup stale online records (older than 90 seconds)
    try {
      await supabase
        .from('online_users')
        .update({ status: 'offline' })
        .eq('status', 'online')
        .lt('last_seen', ninetySecAgo);
    } catch (_) {}

    // 2. Fetch active online users
    const { data: onlineRecords, error: onlineErr } = await supabase
      .from('online_users')
      .select(`
        user_id,
        status,
        last_seen,
        profile:profiles!user_id(id, full_name, username, profile_image_url)
      `)
      .eq('status', 'online')
      .gte('last_seen', ninetySecAgo);

    if (onlineErr || !onlineRecords) {
      return res.json({ onlineCount: 0, users: [], onlineUserIds: [] });
    }

    const allOnlineUserIds = onlineRecords.map(r => r.user_id);

    const onlineUsers = onlineRecords
      .filter(r => r.profile && r.user_id !== currentUserId && !r.profile.username?.toLowerCase().startsWith('test_runner_'))
      .map(r => ({
        _id: r.profile.id,
        fullName: r.profile.full_name || r.profile.username,
        username: r.profile.username,
        profileImage: r.profile.profile_image_url || '',
        status: r.status,
        lastSeen: r.last_seen
      }));

    res.json({
      onlineCount: onlineUsers.length,
      users: onlineUsers.slice(0, 5),
      onlineUserIds: allOnlineUserIds
    });
  } catch (err) {
    res.json({ onlineCount: 0, users: [], onlineUserIds: [] });
  }
};

router.get('/api/online-users', authenticateToken, handleGetOnlineUsers);
router.get('/api/users/active', authenticateToken, handleGetOnlineUsers);

// --- SUGGESTED HUBBERS WIDGET ---
router.get('/api/users/suggestions', authenticateToken, async (req, res) => {
  if (!req.user) return res.json([]);
  try {
    const currentUserId = req.user.id;
    const limitVal = parseInt(req.query.limit) || 50;

    // 1. Get IDs of users already followed
    const { data: followedRecords } = await supabase
      .from('followers')
      .select('following_id')
      .eq('follower_id', currentUserId);
    const followedIds = (followedRecords || []).map(f => f.following_id);

    // 2. Get IDs of users with pending follow requests
    const { data: pendingRecords } = await supabase
      .from('follow_requests')
      .select('receiver_id')
      .eq('sender_id', currentUserId)
      .eq('status', 'pending');
    const pendingIds = (pendingRecords || []).map(r => r.receiver_id);

    const excludeIds = new Set([currentUserId, ...followedIds, ...pendingIds]);

    // 3. Query profiles ordered by newly joined (created_at DESC)
    const { data: profilesData, error } = await supabase
      .from('profiles')
      .select('id, full_name, username, profile_image_url, bio, follower_count, following_count, post_count, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    let filteredSuggestions = (profilesData || [])
      .filter(p => !excludeIds.has(p.id) && !p.username?.toLowerCase().startsWith('test_runner_') && !p.username?.toLowerCase().startsWith('test_'));

    if (filteredSuggestions.length === 0) {
      filteredSuggestions = (profilesData || [])
        .filter(p => p.id !== currentUserId && !p.username?.toLowerCase().startsWith('test_runner_') && !p.username?.toLowerCase().startsWith('test_'));
    }

    const suggestions = filteredSuggestions
      .slice(0, limitVal)
      .map(u => ({
        _id: u.id,
        fullName: u.full_name || u.username,
        username: u.username,
        profileImage: u.profile_image_url || '',
        bio: u.bio || '',
        followersCount: u.follower_count || 0,
        followingCount: u.following_count || 0,
        postsCount: u.post_count || 0,
        followStatus: followedIds.includes(u.id) ? 'following' : (pendingIds.includes(u.id) ? 'pending' : 'none')
      }));

    res.json(suggestions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- HELPER FOR ROBUST PROFILE LOOKUP (UUID OR USERNAME) ---
async function resolveProfileByIdOrUsername(targetId) {
  if (!targetId) return null;
  const cleanId = String(targetId).trim().replace(/^@/, '');
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId);

  const filterColumn = isUuid ? 'id' : 'username';
  console.log(`[Database Query Executed] SELECT id, username, full_name, profile_image_url, is_private FROM profiles WHERE ${filterColumn} = '${cleanId}'`);

  let query = supabase.from('profiles').select('id, username, full_name, profile_image_url, is_private');
  if (isUuid) {
    query = query.eq('id', cleanId);
  } else {
    query = query.eq('username', cleanId);
  }

  const { data: profile, error } = await query.maybeSingle();
  console.log(`[Database Query Result] Found Profile:`, profile, `Error:`, error ? error.message : null);

  if (error) {
    console.error(`[User Lookup Error] Target: '${targetId}', isUuid: ${isUuid}, error:`, error.message);
    return null;
  }
  return profile;
}

// --- HELPER TO RECALCULATE PROFILE COUNTS RELIABLY ---
async function updateProfileCounts(userId) {
  try {
    // 1. Count active followers (where following_id = userId)
    const { count: followersCount } = await supabase
      .from('followers')
      .select('*', { count: 'exact', head: true })
      .eq('following_id', userId);

    // 2. Count active following (where follower_id = userId)
    const { count: followingCount } = await supabase
      .from('followers')
      .select('*', { count: 'exact', head: true })
      .eq('follower_id', userId);

    // 3. Count pending sent requests (where sender_id = userId AND status = 'pending')
    const { count: pendingCount } = await supabase
      .from('follow_requests')
      .select('*', { count: 'exact', head: true })
      .eq('sender_id', userId)
      .eq('status', 'pending');

    const totalFollowing = (followingCount || 0) + (pendingCount || 0);

    // Update the profile columns
    await supabase
      .from('profiles')
      .update({
        follower_count: followersCount || 0,
        following_count: totalFollowing
      })
      .eq('id', userId);
  } catch (err) {
    console.error(`[updateProfileCounts Error] User: ${userId}, error:`, err.message);
  }
}

// --- FOLLOW ACTION (CREATES FOLLOW RELATION OR PENDING REQUEST) ---
router.post('/api/users/:id/follow', authenticateToken, async (req, res) => {
  console.log('==================================================');
  console.log('BACKEND DEBUG - FOLLOW REQUEST RECEIVED');
  console.log('==================================================');
  console.log('1. req.params:', req.params);
  console.log('4. Authenticated User ID (req.user.id):', req.user ? req.user.id : 'UNAUTHENTICATED');

  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const rawParam = req.params.id;
  const currentUserId = req.user.id;

  try {
    const targetProfile = await resolveProfileByIdOrUsername(rawParam);
    if (!targetProfile) {
      return res.status(404).json({ error: `User '${rawParam}' not found.` });
    }

    const targetUserId = targetProfile.id;

    if (targetUserId === currentUserId) {
      return res.status(400).json({ error: 'You cannot follow yourself.' });
    }

    // Check if already following
    const { data: existingFollow } = await supabase
      .from('followers')
      .select('follower_id')
      .eq('follower_id', currentUserId)
      .eq('following_id', targetUserId)
      .maybeSingle();

    if (existingFollow) {
      return res.json({ success: true, status: 'following', isFollowing: true, message: `Already following @${targetProfile.username}.` });
    }

    // Check if request is already pending
    const { data: existingPending } = await supabase
      .from('follow_requests')
      .select('status')
      .eq('sender_id', currentUserId)
      .eq('receiver_id', targetUserId)
      .eq('status', 'pending')
      .maybeSingle();

    if (existingPending) {
      return res.json({ success: true, status: 'pending', isFollowing: false, message: `Follow request is already pending with @${targetProfile.username}.` });
    }

    const { data: senderProf } = await supabase.from('profiles').select('username').eq('id', currentUserId).maybeSingle();
    const senderName = senderProf?.username || 'Someone';

    // All follow requests now go to pending status by default
    const { error: reqErr } = await supabase
      .from('follow_requests')
      .upsert([{
        sender_id: currentUserId,
        receiver_id: targetUserId,
        status: 'pending',
        created_at: new Date().toISOString()
      }], { onConflict: 'sender_id,receiver_id' });

    if (reqErr) throw reqErr;

    // Create follow_request notification
    try {
      await supabase.from('notifications').insert([{
        user_id: targetUserId,
        recipient_id: targetUserId,
        sender_id: currentUserId,
        type: 'follow_request',
        message: `@${senderName} requested to follow you.`,
        is_read: false,
        created_at: new Date().toISOString()
      }]);
    } catch (nErr) {
      console.warn("Notification insert notice:", nErr.message);
    }

    // Recalculate counts (A's following count will increase because of the pending request)
    await updateProfileCounts(currentUserId);
    await updateProfileCounts(targetUserId);

    return res.json({
      success: true,
      status: 'pending',
      isFollowing: false,
      message: `Follow request sent to @${targetProfile.username}. ⏳`
    });
  } catch (err) {
    console.error("Follow route error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- ACCEPT FOLLOW REQUEST ---
router.post('/api/users/:id/accept-follow-request', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const rawParam = String(req.params.id || '').trim();
  const currentUserId = req.user.id; // Receiver (User B)

  if (!rawParam) {
    return res.status(400).json({ error: 'Invalid user or request identifier.' });
  }

  try {
    let followReq = null;
    let senderId = null;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawParam);

    if (isUuid) {
      // 1. Check if rawParam is the follow request's primary key (id)
      const { data: byReqId } = await supabase
        .from('follow_requests')
        .select('*')
        .eq('id', rawParam)
        .eq('receiver_id', currentUserId)
        .maybeSingle();

      if (byReqId) {
        followReq = byReqId;
        senderId = byReqId.sender_id;
      }

      // 2. Next check if rawParam is sender_id directly
      if (!followReq) {
        const { data: bySenderId } = await supabase
          .from('follow_requests')
          .select('*')
          .eq('sender_id', rawParam)
          .eq('receiver_id', currentUserId)
          .eq('status', 'pending')
          .maybeSingle();

        if (bySenderId) {
          followReq = bySenderId;
          senderId = bySenderId.sender_id;
        }
      }
    }

    // 3. Resolve profile by username or id if not found yet
    if (!followReq) {
      const senderProfile = await resolveProfileByIdOrUsername(rawParam);
      if (senderProfile) {
        senderId = senderProfile.id;
        const { data: byProfId } = await supabase
          .from('follow_requests')
          .select('*')
          .eq('sender_id', senderId)
          .eq('receiver_id', currentUserId)
          .eq('status', 'pending')
          .maybeSingle();

        if (byProfId) {
          followReq = byProfId;
        }
      }
    }

    // 4. Fallback check without strict status filter if senderId is known
    if (!followReq && senderId) {
      const { data: anyReq } = await supabase
        .from('follow_requests')
        .select('*')
        .eq('sender_id', senderId)
        .eq('receiver_id', currentUserId)
        .maybeSingle();

      if (anyReq) {
        followReq = anyReq;
      }
    }

    if (!followReq || !senderId) {
      return res.status(400).json({ error: 'No pending follow request found from this user.' });
    }

    // 1. Mark request as accepted in follow_requests
    if (followReq.id) {
      await supabase
        .from('follow_requests')
        .update({ status: 'accepted' })
        .eq('id', followReq.id);
    } else {
      await supabase
        .from('follow_requests')
        .update({ status: 'accepted' })
        .eq('sender_id', senderId)
        .eq('receiver_id', currentUserId);
    }

    // 2. Insert mutual follower relationships (both become Hubbies)
    await supabase.from('followers').upsert([
      { follower_id: senderId, following_id: currentUserId },
      { follower_id: currentUserId, following_id: senderId }
    ], { onConflict: 'follower_id,following_id' });

    // Clean up any pending request from B to A if one exists
    await supabase
      .from('follow_requests')
      .delete()
      .eq('sender_id', currentUserId)
      .eq('receiver_id', senderId);

    // 3. Send notification to requester (User A)
    const { data: receiverProf } = await supabase.from('profiles').select('username, full_name').eq('id', currentUserId).maybeSingle();
    const receiverName = receiverProf?.full_name || receiverProf?.username || 'User';

    try {
      await supabase.from('notifications').insert([{
        user_id: senderId,
        recipient_id: senderId,
        sender_id: currentUserId,
        type: 'accept_follow_request',
        message: `@${receiverProf?.username || receiverName} accepted your Hubbies request.`,
        is_read: false,
        created_at: new Date().toISOString()
      }]);
    } catch (nErr) {
      console.warn("Notification insert notice:", nErr.message);
    }

    // 4. Update profile counts for both users
    await updateProfileCounts(senderId);
    await updateProfileCounts(currentUserId);

    // 5. Clean up receiver's follow_request notification
    await supabase
      .from('notifications')
      .delete()
      .eq('user_id', currentUserId)
      .eq('sender_id', senderId)
      .eq('type', 'follow_request');

    const { data: senderProf } = await supabase.from('profiles').select('username, full_name').eq('id', senderId).maybeSingle();
    const senderDisplay = senderProf?.username || 'user';

    res.json({
      success: true,
      status: 'following',
      message: `Accepted Hubbies request from @${senderDisplay}! 🎉`
    });
  } catch (err) {
    console.error("Accept follow request error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- REJECT FOLLOW REQUEST ---
router.post('/api/users/:id/reject-follow-request', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const rawParam = String(req.params.id || '').trim();
  const currentUserId = req.user.id; // Receiver (User B)

  if (!rawParam) {
    return res.status(400).json({ error: 'Invalid user or request identifier.' });
  }

  try {
    let followReq = null;
    let senderId = null;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawParam);

    if (isUuid) {
      // 1. Check if rawParam is the follow request's primary key (id)
      const { data: byReqId } = await supabase
        .from('follow_requests')
        .select('*')
        .eq('id', rawParam)
        .eq('receiver_id', currentUserId)
        .maybeSingle();

      if (byReqId) {
        followReq = byReqId;
        senderId = byReqId.sender_id;
      }

      // 2. Check if rawParam is sender_id directly
      if (!followReq) {
        const { data: bySenderId } = await supabase
          .from('follow_requests')
          .select('*')
          .eq('sender_id', rawParam)
          .eq('receiver_id', currentUserId)
          .eq('status', 'pending')
          .maybeSingle();

        if (bySenderId) {
          followReq = bySenderId;
          senderId = bySenderId.sender_id;
        }
      }
    }

    // 3. Resolve profile by username or id
    if (!followReq) {
      const senderProfile = await resolveProfileByIdOrUsername(rawParam);
      if (senderProfile) {
        senderId = senderProfile.id;
        const { data: byProfId } = await supabase
          .from('follow_requests')
          .select('*')
          .eq('sender_id', senderId)
          .eq('receiver_id', currentUserId)
          .eq('status', 'pending')
          .maybeSingle();

        if (byProfId) {
          followReq = byProfId;
        }
      }
    }

    if (!followReq && !senderId) {
      return res.status(400).json({ error: 'No pending follow request found from this user.' });
    }

    // Delete the follow request
    if (followReq?.id) {
      await supabase.from('follow_requests').delete().eq('id', followReq.id);
    } else if (senderId) {
      await supabase.from('follow_requests').delete().eq('sender_id', senderId).eq('receiver_id', currentUserId);
    }

    // Clean up follow request notification
    if (senderId) {
      await supabase
        .from('notifications')
        .delete()
        .eq('user_id', currentUserId)
        .eq('sender_id', senderId)
        .eq('type', 'follow_request');

      await updateProfileCounts(senderId);
    }
    await updateProfileCounts(currentUserId);

    res.json({ success: true, message: 'Follow request declined.' });
  } catch (err) {
    console.error("Reject follow request error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- UNFOLLOW ---
router.post('/api/users/:id/unfollow', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const rawParam = req.params.id;
  const currentUserId = req.user.id;

  try {
    const targetProfile = await resolveProfileByIdOrUsername(rawParam);
    if (!targetProfile) return res.status(404).json({ error: 'User to unfollow not found.' });
    const targetUserId = targetProfile.id;

    await supabase.from('followers').delete().eq('follower_id', currentUserId).eq('following_id', targetUserId);
    await supabase.from('follow_requests').delete().eq('sender_id', currentUserId).eq('receiver_id', targetUserId);

    // Recalculate counts
    await updateProfileCounts(currentUserId);
    await updateProfileCounts(targetUserId);

    res.json({ success: true, message: 'Unfollowed user.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET RELATIONS COUNT ---
router.get('/api/users/:id/relations', async (req, res) => {
  const userId = req.params.id;
  try {
    const { count: followersCount } = await supabase.from('followers').select('*', { count: 'exact', head: true }).eq('following_id', userId);
    const { count: followingCount } = await supabase.from('followers').select('*', { count: 'exact', head: true }).eq('follower_id', userId);
    const { count: pendingCount } = await supabase.from('follow_requests').select('*', { count: 'exact', head: true }).eq('sender_id', userId).eq('status', 'pending');

    res.json({
      followersCount: followersCount || 0,
      followingCount: (followingCount || 0) + (pendingCount || 0)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/users/search', authenticateToken, async (req, res) => {
  const query = req.query.q || '';
  if (!query.trim()) return res.json([]);
  if (!req.user) return res.json([]);

  try {
    const { data: matchingUsers, error } = await supabase.from('profiles')
      .select('id, full_name, username, profile_image_url, bio')
      .neq('id', req.user.id)
      .or(`username.ilike.%${query}%,full_name.ilike.%${query}%`);

    if (error) throw error;

    const { data: myFollowing } = await supabase.from('followers').select('following_id').eq('follower_id', req.user.id);
    const myFollowingSet = new Set(myFollowing ? myFollowing.map(f => f.following_id) : []);

    const results = (matchingUsers || []).map(u => ({
      _id: u.id,
      fullName: u.full_name || u.username,
      username: u.username,
      profileImage: u.profile_image_url || '',
      bio: u.bio || '',
      isFollowing: myFollowingSet.has(u.id)
    }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/users/mention-suggestions', authenticateToken, async (req, res) => {
  const query = req.query.q || '';
  if (!req.user) return res.json([]);

  try {
    const currentUserId = req.user.id;

    // 1. Fetch followers
    const { data: followersData, error: followersErr } = await supabase
      .from('followers')
      .select('follower_id')
      .eq('following_id', currentUserId);

    if (followersErr) throw followersErr;

    // 2. Fetch following
    const { data: followingData, error: followingErr } = await supabase
      .from('followers')
      .select('following_id')
      .eq('follower_id', currentUserId);

    if (followingErr) throw followingErr;

    // 3. Form a unique union of user IDs, excluding self
    const userIdsSet = new Set();
    if (followersData) followersData.forEach(r => userIdsSet.add(r.follower_id));
    if (followingData) followingData.forEach(r => userIdsSet.add(r.following_id));
    userIdsSet.delete(currentUserId);

    const userIds = Array.from(userIdsSet);
    if (userIds.length === 0) return res.json([]);

    // 4. Query matching profiles
    let queryBuilder = supabase
      .from('profiles')
      .select('id, full_name, username, profile_image_url')
      .in('id', userIds);

    if (query.trim()) {
      queryBuilder = queryBuilder.or(`username.ilike.%${query}%,full_name.ilike.%${query}%`);
    }

    const { data: matchingUsers, error: profilesErr } = await queryBuilder.limit(15);
    if (profilesErr) throw profilesErr;

    const results = (matchingUsers || []).map(u => ({
      id: u.id,
      _id: u.id,
      username: u.username,
      fullName: u.full_name || u.username,
      profileImage: u.profile_image_url || ''
    }));

    res.json(results);
  } catch (err) {
    console.error('[Mention Suggestions Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const optionalAuth = (req, res, next) => {
  authenticateToken(req, {
    status: () => ({ json: () => next() })
  }, (err) => {
    if (err) return next(err);
    next();
  });
};

router.get('/api/users/:id/profile', optionalAuth, async (req, res) => {
  let targetId = req.params.id;
  if (!targetId || targetId === 'me' || targetId === 'undefined' || targetId === 'null') {
    targetId = req.user ? (req.user.id || req.user.username) : null;
  }
  if (!targetId) return res.status(401).json({ error: 'Unauthorized user.' });

  const currentUserId = req.user ? req.user.id : null;

  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId);
    let profileQuery = supabase
      .from('profiles')
      .select('id, full_name, username, profile_image_url, bio, created_at');

    if (isUuid) {
      profileQuery = profileQuery.eq('id', targetId);
    } else {
      profileQuery = profileQuery.eq('username', targetId);
    }

    const { data: userProfile, error: userError } = await profileQuery.maybeSingle();

    if (userError || !userProfile) {
      console.warn(`[Profile Debug] User profile lookup failed for targetId '${targetId}':`, userError?.message);
      return res.status(404).json({ error: 'User not found.' });
    }

    const resolvedUserId = userProfile.id;

    // Parallelize follower counts, posts and reels lookup
    const [
      { count: followersCount },
      { count: followingCount },
      { count: pendingCount },
      { data: postsData },
      { data: reelsData }
    ] = await Promise.all([
      supabase.from('followers').select('*', { count: 'exact', head: true }).eq('following_id', resolvedUserId),
      supabase.from('followers').select('*', { count: 'exact', head: true }).eq('follower_id', resolvedUserId),
      supabase.from('follow_requests').select('*', { count: 'exact', head: true }).eq('sender_id', resolvedUserId).eq('status', 'pending'),
      supabase.from('posts').select('*, author_profile:profiles!author_id(id, full_name, username, profile_image_url), media:post_media(media_url, media_type)').eq('author_id', resolvedUserId).order('created_at', { ascending: false }).limit(30),
      supabase.from('reels').select('*, author:profiles!author_id(id, full_name, username, profile_image_url), reel_likes(user_id), reel_comments(id), saved_reels(user_id)').eq('author_id', resolvedUserId).order('created_at', { ascending: false }).limit(30)
    ]);

    console.log(`[PROFILE DEBUG] Target: ${targetId}, Resolved: ${resolvedUserId}, Posts: ${postsData ? postsData.length : 0}, Reels: ${reelsData ? reelsData.length : 0}`);

    const postsList = [];
    if (postsData && postsData.length > 0) {
      const postIds = postsData.map(p => p.id);

      const [{ data: allComments }, { data: allLikes }] = await Promise.all([
        supabase.from('comments').select('*, author_profile:profiles!author_id(id, full_name, username, profile_image_url)').in('post_id', postIds).order('created_at', { ascending: true }),
        supabase.from('likes').select('post_id, user_id').in('post_id', postIds)
      ]);

      const commentsByPost = {};
      (allComments || []).forEach(c => {
        if (!commentsByPost[c.post_id]) commentsByPost[c.post_id] = [];
        commentsByPost[c.post_id].push({
          _id: c.id,
          text: c.content,
          createdAt: c.created_at,
          postId: c.post_id,
          parentCommentId: c.parent_comment_id || null,
          likeCount: c.like_count || 0,
          replyCount: c.reply_count || 0,
          author: {
            _id: c.author_profile?.id || c.author_id,
            fullName: c.author_profile?.full_name || c.author_profile?.username || 'User',
            username: c.author_profile?.username || 'user',
            profileImage: c.author_profile?.profile_image_url || ''
          }
        });
      });

      const likesByPost = {};
      (allLikes || []).forEach(l => {
        if (!likesByPost[l.post_id]) likesByPost[l.post_id] = [];
        likesByPost[l.post_id].push(l.user_id);
      });

      const authorObj = {
        _id: userProfile.id,
        fullName: userProfile.full_name || userProfile.username,
        username: userProfile.username,
        profileImage: userProfile.profile_image_url || ''
      };

      for (const p of postsData) {
        const mappedComments = commentsByPost[p.id] || [];
        const mappedLikes = likesByPost[p.id] || [];

        postsList.push({
          _id: p.id,
          author: authorObj,
          caption: p.caption || '',
          mediaUrl: p.media && p.media.length > 0 ? p.media[0].media_url : '',
          mediaType: p.media && p.media.length > 0 ? p.media[0].media_type : 'image',
          mediaItems: (p.media || []).map(m => ({ url: m.media_url, type: m.media_type })),
          location: p.location || '',
          createdAt: p.created_at,
          likes: mappedLikes,
          comments: mappedComments
        });
      }
    }

    const reelsList = (reelsData || []).map(r => {
      const rawLikes = Array.isArray(r.reel_likes) ? r.reel_likes.map(l => l.user_id) : [];
      const isLiked = currentUserId ? rawLikes.includes(currentUserId) : false;
      const isSaved = currentUserId && Array.isArray(r.saved_reels) ? r.saved_reels.some(s => s.user_id === currentUserId) : false;
      return {
        _id: r.id,
        id: r.id,
        videoUrl: r.video_url,
        thumbnailUrl: r.thumbnail_url || '',
        caption: r.caption || '',
        audioTrackName: r.audio_track_name || '',
        durationSeconds: r.duration_seconds || 0,
        viewCount: r.view_count || 0,
        likeCount: r.like_count || rawLikes.length,
        commentCount: r.comment_count || (Array.isArray(r.reel_comments) ? r.reel_comments.length : 0),
        likes: rawLikes,
        isLiked: !!isLiked,
        isSaved: !!isSaved,
        createdAt: r.created_at
      };
    });

    let isFollowing = false;
    let isPending = false;

    if (currentUserId) {
      const { count: followCount } = await supabase.from('followers').select('*', { count: 'exact', head: true }).eq('follower_id', currentUserId).eq('following_id', resolvedUserId);
      isFollowing = (followCount || 0) > 0;

      const { count: reqCount } = await supabase.from('follow_requests').select('*', { count: 'exact', head: true }).eq('sender_id', currentUserId).eq('receiver_id', resolvedUserId).eq('status', 'pending');
      isPending = (reqCount || 0) > 0;
    }

    // Fetch accepted tagged reels for this profile
    const { data: taggedMentionsData, error: taggedErr } = await supabase
      .from('mentions')
      .select('reel_id, reel:reels(*, author:profiles!author_id(id, full_name, username, profile_image_url), reel_likes(user_id), reel_comments(id), saved_reels(user_id))')
      .eq('user_id', resolvedUserId)
      .eq('target_type', 'reel')
      .eq('status', 'accepted');

    if (taggedErr) console.error("Error fetching tagged reels in profile:", taggedErr.message);

    const taggedReelsList = (taggedMentionsData || [])
      .filter(m => m.reel)
      .map(m => {
        const r = m.reel;
        const rawLikes = Array.isArray(r.reel_likes) ? r.reel_likes.map(l => l.user_id) : [];
        const isLiked = currentUserId ? rawLikes.includes(currentUserId) : false;
        const isSaved = currentUserId && Array.isArray(r.saved_reels) ? r.saved_reels.some(s => s.user_id === currentUserId) : false;
        return {
          _id: r.id,
          id: r.id,
          author: r.author ? {
            _id: r.author.id,
            fullName: r.author.full_name || r.author.username || 'Hubble User',
            username: r.author.username || 'hubble_user',
            profileImage: r.author.profile_image_url || ''
          } : {
            _id: r.author_id,
            fullName: 'Hubble User',
            username: 'hubble_user',
            profileImage: ''
          },
          videoUrl: r.video_url,
          thumbnailUrl: r.thumbnail_url || '',
          caption: r.caption || '',
          audioTrackName: r.audio_track_name || '',
          durationSeconds: r.duration_seconds || 0,
          viewCount: r.view_count || 0,
          likeCount: r.like_count || rawLikes.length,
          commentCount: r.comment_count || (Array.isArray(r.reel_comments) ? r.reel_comments.length : 0),
          likes: rawLikes,
          isLiked: !!isLiked,
          isSaved: !!isSaved,
          createdAt: r.created_at,
          location: r.location || '',
          locationData: r.location_data || null
        };
      });

    res.json({
      user: {
        _id: userProfile.id,
        fullName: userProfile.full_name || userProfile.username,
        username: userProfile.username,
        profileImage: userProfile.profile_image_url || '',
        bannerImage: userProfile.cover_image_url || '',
        bio: userProfile.bio || '',
        isPrivate: userProfile.is_private || false,
        followersCount: followersCount || 0,
        followingCount: (followingCount || 0) + (pendingCount || 0),
        postsCount: postsList.length,
        isFollowing,
        isPending
      },
      posts: postsList,
      reels: reelsList,
      taggedReels: taggedReelsList
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SEARCH INITIAL DATA (RECENT SEARCHES, SUGGESTED HUBBERS, TRENDING TAGS, ACTIVE HUBBERS) ---
router.get('/api/search/initial', authenticateToken, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;

  try {
    // 1. Fetch recent searches for authenticated user
    const { data: recentData } = await supabase
      .from('recent_searches')
      .select('id, search_query, searched_user_id, created_at, searched_user:profiles!searched_user_id(id, full_name, username, profile_image_url)')
      .eq('user_id', currentUserId)
      .order('created_at', { ascending: false })
      .limit(10);

    const recentSearches = (recentData || []).map(item => ({
      id: item.id,
      query: item.search_query,
      createdAt: item.created_at,
      searchedUser: item.searched_user ? {
        id: item.searched_user.id,
        fullName: item.searched_user.full_name || item.searched_user.username,
        username: item.searched_user.username,
        profileImage: item.searched_user.profile_image_url || ''
      } : null
    }));

    // 2. Fetch suggested hubbers (real profiles excluding self, followed, pending, blocked)
    const { data: followedRecords } = await supabase.from('followers').select('following_id').eq('follower_id', currentUserId);
    const followedIds = (followedRecords || []).map(f => f.following_id);

    const { data: pendingRecords } = await supabase.from('follow_requests').select('receiver_id').eq('sender_id', currentUserId).eq('status', 'pending');
    const pendingIds = (pendingRecords || []).map(r => r.receiver_id);

    const { data: blockedRecords } = await supabase.from('blocked_users').select('blocked_id').eq('blocker_id', currentUserId);
    const blockedIds = (blockedRecords || []).map(b => b.blocked_id);

    const excludeIds = new Set([currentUserId, ...followedIds, ...pendingIds, ...blockedIds]);

    const { data: profilesData } = await supabase
      .from('profiles')
      .select('id, full_name, username, profile_image_url, follower_count, following_count, created_at')
      .order('created_at', { ascending: false })
      .limit(50);

    const suggestedHubbers = (profilesData || [])
      .filter(p => !excludeIds.has(p.id) && !p.username?.toLowerCase().startsWith('test_runner_') && !p.username?.toLowerCase().startsWith('test_'))
      .slice(0, 5)
      .map(u => ({
        _id: u.id,
        fullName: u.full_name || u.username,
        username: u.username,
        profileImage: u.profile_image_url || '',
        followersCount: u.follower_count || 0,
        followingCount: u.following_count || 0,
        isFollowing: false,
        isRequested: false
      }));

    // 3. Fetch trending hashtags
    const { data: hashtagsData } = await supabase
      .from('hashtags')
      .select('id, name, use_count')
      .order('use_count', { ascending: false })
      .limit(6);

    const trendingTags = (hashtagsData || []).map(h => ({
      id: h.id,
      name: h.name.startsWith('#') ? h.name : `#${h.name}`,
      useCount: h.use_count || 0
    }));

    // 4. Fetch active online hubbers
    const ninetySecAgo = new Date(Date.now() - 90 * 1000).toISOString();
    const { data: onlineRecords } = await supabase
      .from('online_users')
      .select('user_id, status, last_seen, profile:profiles!user_id(id, full_name, username, profile_image_url)')
      .gte('last_seen', ninetySecAgo);

    const activeUsers = (onlineRecords || [])
      .filter(r => r.profile && r.user_id !== currentUserId && !r.profile.username?.toLowerCase().startsWith('test_runner_'))
      .map(r => ({
        _id: r.profile.id,
        fullName: r.profile.full_name || r.profile.username,
        username: r.profile.username,
        profileImage: r.profile.profile_image_url || ''
      }));

    res.json({
      recentSearches,
      suggestedHubbers,
      trendingTags,
      activeCount: activeUsers.length,
      activeHubbers: activeUsers.slice(0, 5)
    });
  } catch (err) {
    console.error('[Search Initial Error]:', err);
    res.status(500).json({ error: 'Failed to fetch search initial state.' });
  }
});

// --- DYNAMIC SEARCH QUERY ENDPOINT (USERS, HASHTAGS, POSTS, HUBS) ---
router.get('/api/search/query', authenticateToken, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const rawQuery = String(req.query.q || '').trim();
  if (!rawQuery) {
    return res.json({ users: [], hashtags: [], posts: [], hubs: [] });
  }

  const currentUserId = req.user.id;
  const cleanUserQuery = rawQuery.replace(/^@/, '').trim();
  const cleanTagQuery = rawQuery.replace(/^#/, '').trim();

  try {
    // 1. Search Users
    const { data: blockedData } = await supabase.from('blocked_users').select('blocked_id').eq('blocker_id', currentUserId);
    const blockedSet = new Set((blockedData || []).map(b => b.blocked_id));

    const { data: matchingUsers, error: userErr } = await supabase
      .from('profiles')
      .select('id, full_name, username, profile_image_url, bio, follower_count')
      .neq('id', currentUserId)
      .or(`username.ilike.%${cleanUserQuery}%,full_name.ilike.%${cleanUserQuery}%`)
      .limit(10);

    let users = [];
    if (!userErr && matchingUsers) {
      const { data: myFollowing } = await supabase.from('followers').select('following_id').eq('follower_id', currentUserId);
      const followingSet = new Set((myFollowing || []).map(f => f.following_id));

      const { data: myPending } = await supabase.from('follow_requests').select('receiver_id').eq('sender_id', currentUserId).eq('status', 'pending');
      const pendingSet = new Set((myPending || []).map(p => p.receiver_id));

      users = matchingUsers
        .filter(u => !blockedSet.has(u.id) && !u.username?.toLowerCase().startsWith('test_runner_'))
        .map(u => ({
          _id: u.id,
          fullName: u.full_name || u.username,
          username: u.username,
          profileImage: u.profile_image_url || '',
          bio: u.bio || '',
          followersCount: u.follower_count || 0,
          isFollowing: followingSet.has(u.id),
          isRequested: pendingSet.has(u.id)
        }));
    }

    // 2. Search Hashtags
    const { data: matchingTags } = await supabase
      .from('hashtags')
      .select('id, name, use_count')
      .ilike('name', `%${cleanTagQuery}%`)
      .order('use_count', { ascending: false })
      .limit(10);

    const hashtags = (matchingTags || []).map(h => ({
      id: h.id,
      name: h.name.startsWith('#') ? h.name : `#${h.name}`,
      useCount: h.use_count || 0
    }));

    // 3. Search Posts
    const { data: matchingPosts } = await supabase
      .from('posts')
      .select('id, caption, location, created_at, author:profiles!author_id(id, full_name, username, profile_image_url), media:post_media(media_url, media_type)')
      .or(`caption.ilike.%${rawQuery}%,location.ilike.%${rawQuery}%`)
      .order('created_at', { ascending: false })
      .limit(10);

    const posts = (matchingPosts || [])
      .filter(p => p.author && !blockedSet.has(p.author.id))
      .map(p => ({
        id: p.id,
        caption: p.caption || '',
        location: p.location || '',
        createdAt: p.created_at,
        author: {
          id: p.author.id,
          fullName: p.author.full_name || p.author.username,
          username: p.author.username,
          profileImage: p.author.profile_image_url || ''
        },
        mediaUrl: p.media && p.media.length > 0 ? p.media[0].media_url : ''
      }));

    // 4. Hubs (No backend entity exists, so return empty array)
    const hubs = [];

    res.json({ users, hashtags, posts, hubs });
  } catch (err) {
    console.error('[Search Query Error]:', err);
    res.status(500).json({ error: 'Unable to complete search. Please try again.' });
  }
});

// --- SAVE RECENT SEARCH ---
router.post('/api/search/recent', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;
  const { query, searchedUserId } = req.body;
  const cleanQuery = String(query || '').trim();

  if (!cleanQuery) {
    return res.status(400).json({ error: 'Search query is required.' });
  }

  try {
    // Delete existing duplicate search query for this user to keep newest on top
    await supabase
      .from('recent_searches')
      .delete()
      .eq('user_id', currentUserId)
      .eq('search_query', cleanQuery);

    const { data: newSearch, error } = await supabase
      .from('recent_searches')
      .insert([{
        user_id: currentUserId,
        search_query: cleanQuery,
        searched_user_id: searchedUserId || null,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) throw error;
    res.json(newSearch);
  } catch (err) {
    console.error('[Save Recent Search Error]:', err);
    res.status(500).json({ error: 'Failed to save recent search.' });
  }
});

// --- DELETE SINGLE RECENT SEARCH ---
router.delete('/api/search/recent/:id', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;
  const searchId = req.params.id;

  try {
    const { error } = await supabase
      .from('recent_searches')
      .delete()
      .eq('id', searchId)
      .eq('user_id', currentUserId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('[Delete Recent Search Error]:', err);
    res.status(500).json({ error: 'Failed to delete recent search.' });
  }
});

// --- CLEAR ALL RECENT SEARCHES FOR USER ---
router.delete('/api/search/recent', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const currentUserId = req.user.id;

  try {
    const { error } = await supabase
      .from('recent_searches')
      .delete()
      .eq('user_id', currentUserId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('[Clear Recent Searches Error]:', err);
    res.status(500).json({ error: 'Failed to clear recent searches.' });
  }
});

// --- GET FOLLOWERS LIST ---
router.get('/api/users/:id/followers-list', authenticateToken, async (req, res) => {
  const targetUserId = req.params.id;
  const currentUserId = req.user.id;

  try {
    const targetProfile = await resolveProfileByIdOrUsername(targetUserId);
    if (!targetProfile) return res.status(404).json({ error: 'User not found.' });

    const { data: followerRecords, error: err } = await supabase
      .from('followers')
      .select(`
        follower_id,
        follower_profile:profiles!follower_id(id, username, full_name, profile_image_url)
      `)
      .eq('following_id', targetProfile.id);

    if (err) throw err;

    const { data: myFollowing } = await supabase
      .from('followers')
      .select('following_id')
      .eq('follower_id', currentUserId);
    
    const myFollowingSet = new Set((myFollowing || []).map(f => f.following_id));

    const list = (followerRecords || [])
      .filter(r => r.follower_profile)
      .map(r => ({
        _id: r.follower_profile.id,
        username: r.follower_profile.username,
        fullName: r.follower_profile.full_name || r.follower_profile.username,
        profileImage: r.follower_profile.profile_image_url || '',
        isFollowing: myFollowingSet.has(r.follower_profile.id),
        isMe: r.follower_profile.id === currentUserId
      }));

    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET FOLLOWING LIST ---
router.get('/api/users/:id/following-list', authenticateToken, async (req, res) => {
  const targetUserId = req.params.id;
  const currentUserId = req.user.id;

  try {
    const targetProfile = await resolveProfileByIdOrUsername(targetUserId);
    if (!targetProfile) return res.status(404).json({ error: 'User not found.' });

    const { data: followingRecords, error: err } = await supabase
      .from('followers')
      .select(`
        following_id,
        following_profile:profiles!following_id(id, username, full_name, profile_image_url)
      `)
      .eq('follower_id', targetProfile.id);

    if (err) throw err;

    const { data: myFollowing } = await supabase
      .from('followers')
      .select('following_id')
      .eq('follower_id', currentUserId);
    
    const myFollowingSet = new Set((myFollowing || []).map(f => f.following_id));

    const list = (followingRecords || [])
      .filter(r => r.following_profile)
      .map(r => ({
        _id: r.following_profile.id,
        username: r.following_profile.username,
        fullName: r.following_profile.full_name || r.following_profile.username,
        profileImage: r.following_profile.profile_image_url || '',
        isFollowing: myFollowingSet.has(r.following_profile.id),
        isMe: r.following_profile.id === currentUserId
      }));

    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
