import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { supabase } from '../supabase.js';
import { authenticateToken } from '../utils.js';

const router = express.Router();

// Helper to map DB story object to frontend format
function mapStoryToFrontend(s, likes = [], reqUserId = null) {
  if (!s) return null;
  const author = s.author || {};
  const createdAtIso = s.created_at || new Date().toISOString();
  const likeUserIds = Array.isArray(likes) ? likes : [];
  const isLiked = reqUserId ? likeUserIds.some(uid => uid && uid.toString() === reqUserId.toString()) : false;

  let captionText = s.caption || '';
  let musicData = s.music || null;
  let locationData = s.location || null;
  let layersData = s.layers || [];

  if (typeof s.link_url === 'string' && s.link_url.startsWith('{') && s.link_url.endsWith('}')) {
    try {
      const parsed = JSON.parse(s.link_url);
      if (parsed.music) musicData = parsed.music;
      if (parsed.location || parsed.locationData) locationData = parsed.locationData || parsed.location;
      if (parsed.layers) layersData = parsed.layers;
    } catch (_) {}
  } else if (typeof captionText === 'string' && captionText.startsWith('{') && captionText.endsWith('}')) {
    try {
      const parsed = JSON.parse(captionText);
      captionText = parsed.text !== undefined ? parsed.text : (parsed.caption || '');
      if (parsed.music) musicData = parsed.music;
      if (parsed.location || parsed.locationData) locationData = parsed.locationData || parsed.location;
      if (parsed.layers) layersData = parsed.layers;
    } catch (_) {}
  }

  const cleanMediaUrl = (s.media_url && !s.media_url.trim().toLowerCase().startsWith('blob:')) ? s.media_url : '';
  const rawItems = (s.mediaItems && s.mediaItems.length > 0) ? s.mediaItems : [{
    id: s.id,
    mediaUrl: cleanMediaUrl,
    mediaType: s.media_type || 'image',
    displayOrder: 1
  }];
  const cleanItems = rawItems.filter(item => item && item.mediaUrl && !item.mediaUrl.trim().toLowerCase().startsWith('blob:'));

  return {
    _id: s.id,
    id: s.id,
    author: {
      _id: author.id || s.author_id,
      id: author.id || s.author_id,
      fullName: author.full_name || author.username || 'User',
      username: author.username || 'user',
      profileImage: author.profile_image_url || ''
    },
    mediaUrl: cleanMediaUrl,
    mediaType: s.media_type || 'image',
    mediaItems: cleanItems.length > 0 ? cleanItems : [{
      id: s.id,
      mediaUrl: cleanMediaUrl,
      mediaType: s.media_type || 'image',
      displayOrder: 1
    }],
    caption: captionText,
    music: musicData,
    musicTrack: musicData,
    location: typeof locationData === 'string' ? locationData : (locationData ? (locationData.displayName || locationData.name) : null),
    locationData: locationData,
    layers: layersData,
    createdAt: createdAtIso,
    created_at: createdAtIso,
    updatedAt: s.updated_at || createdAtIso,
    updated_at: s.updated_at || createdAtIso,
    isScheduled: s.isScheduled || false,
    scheduledAt: s.scheduledAt || null,
    status: s.status || 'published',
    likes: likeUserIds,
    likesCount: likeUserIds.length,
    isLiked: isLiked
  };
}

// Helper to upload media item (base64 or URL) to permanent Supabase Storage
async function uploadMediaItem(userId, mediaUrl, mediaType, prefix = 'story') {
  if (!mediaUrl) return { url: '', type: 'image', storagePath: null, bucket: null };

  // Rule 1: Reject temporary browser blob URLs immediately
  if (typeof mediaUrl === 'string' && mediaUrl.trim().toLowerCase().startsWith('blob:')) {
    throw new Error('Browser blob URLs cannot be persisted. Please provide raw base64 or a durable storage URL.');
  }

  let finalMediaUrl = mediaUrl;
  let finalType = mediaType || 'image';
  let storagePath = null;
  let bucketName = null;

  if (typeof mediaUrl === 'string' && mediaUrl.startsWith('data:')) {
    const matches = mediaUrl.match(/^data:([a-zA-Z0-9\/\-+.]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      throw new Error('Malformed base64 data URL.');
    }

    const mimeType = matches[1].toLowerCase();
    const isVideo = mimeType.startsWith('video');
    const isAudio = mimeType.startsWith('audio');
    finalType = isVideo ? 'video' : (isAudio ? 'audio' : 'image');

    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length === 0) {
      throw new Error('Media payload is empty.');
    }

    let ext = mimeType.split('/')[1]?.split('+')[0] || (isVideo ? 'mp4' : (isAudio ? 'mp3' : 'jpeg'));
    if (ext === 'quicktime') ext = 'mov';
    if (ext === 'octet-stream') ext = isVideo ? 'mp4' : 'jpeg';

    bucketName = isVideo ? 'post-videos' : 'post-images';
    storagePath = `${userId}/${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from(bucketName)
      .upload(storagePath, buffer, { contentType: mimeType, upsert: true });

    if (uploadErr) {
      console.error(`[Story Storage Upload Error in ${bucketName}]:`, uploadErr.message);
      throw new Error(`Failed to upload story media to storage: ${uploadErr.message}`);
    }

    const { data: publicUrlData } = supabase.storage.from(bucketName).getPublicUrl(storagePath);
    if (!publicUrlData?.publicUrl) {
      throw new Error('Failed to retrieve public storage URL for story media.');
    }

    finalMediaUrl = publicUrlData.publicUrl;
  } else if (typeof mediaUrl === 'string') {
    if (!mediaUrl.startsWith('http://') && !mediaUrl.startsWith('https://')) {
      throw new Error('Invalid media URL scheme. Only secure HTTP/HTTPS URLs are allowed.');
    }
  }

  return { url: finalMediaUrl, type: finalType, storagePath, bucket: bucketName };
}

router.post('/api/stories', authenticateToken, async (req, res) => {
  const { mediaUrl: rawMediaUrl, mediaType: rawMediaType, mediaItems: rawMediaItems, isDraft, caption } = req.body;
  
  const items = (rawMediaItems && rawMediaItems.length > 0) ? rawMediaItems : [{ url: rawMediaUrl, type: rawMediaType }];
  if (!items[0] || !items[0].url) return res.status(400).json({ error: 'Media URL is required.' });

  const userId = req.user.id;
  const nowIso = new Date().toISOString();
  const processedItems = [];

  try {
    // 1. Process and upload all media items to permanent storage FIRST
    for (const item of items) {
      if (!item.url) continue;
      const result = await uploadMediaItem(userId, item.url, item.type, 'story');
      processedItems.push({
        url: result.url,
        type: isDraft ? `draft-${result.type || 'image'}` : (result.type || 'image'),
        storagePath: result.storagePath,
        bucket: result.bucket
      });
    }

    if (processedItems.length === 0) {
      return res.status(400).json({ error: 'No valid media items provided.' });
    }

    const primaryItem = processedItems[0];
    
    let metaPayload = null;
    if (req.body.music || req.body.location || req.body.locationData || (req.body.layers && req.body.layers.length > 0)) {
      metaPayload = JSON.stringify({
        music: req.body.music || null,
        location: req.body.location || null,
        locationData: req.body.locationData || null,
        layers: req.body.layers || []
      });
    }

    // 2. Insert into stories table
    const { data: newStory, error } = await supabase.from('stories').insert([{
      author_id: userId,
      media_url: primaryItem.url,
      media_type: primaryItem.type,
      caption: caption || '',
      link_url: metaPayload || req.body.linkUrl || null,
      status: 'published',
      isScheduled: false,
      scheduledAt: null,
      created_at: nowIso
    }]).select('*, author:profiles!author_id(id, full_name, username, profile_image_url)').single();
    
    if (error || !newStory) {
      // Compensating storage cleanup
      for (const item of processedItems) {
        if (item.storagePath && item.bucket) {
          try { await supabase.storage.from(item.bucket).remove([item.storagePath]); } catch (_) {}
        }
      }
      return res.status(500).json({ error: error?.message || 'Failed to create story record.' });
    }

    // 3. Insert into story_media
    if (processedItems.length > 0) {
      const mediaRecords = processedItems.map((item, idx) => ({
        story_id: newStory.id,
        media_url: item.url,
        media_type: item.type,
        display_order: idx + 1
      }));
      const { error: smErr } = await supabase.from('story_media').insert(mediaRecords);
      if (smErr) {
        console.warn('story_media insert warning:', smErr.message);
      }
      newStory.mediaItems = mediaRecords.map(r => ({
        id: r.id || newStory.id,
        mediaUrl: r.media_url,
        mediaType: r.media_type,
        displayOrder: r.display_order
      }));
    }

    console.log(`[BACKEND POST /api/stories SUCCESS] StoryId: ${newStory.id} | created_at: ${newStory.created_at} | items: ${processedItems.length}`);
    return res.status(201).json(mapStoryToFrontend(newStory, []));
  } catch (err) {
    console.error('Error creating story:', err.message);
    // Compensating storage cleanup
    for (const item of processedItems) {
      if (item.storagePath && item.bucket) {
        try { await supabase.storage.from(item.bucket).remove([item.storagePath]); } catch (_) {}
      }
    }
    return res.status(400).json({ error: err.message || 'Failed to publish story.' });
  }
});

router.post('/api/stories/schedule', authenticateToken, async (req, res) => {
  const { mediaUrl: rawMediaUrl, mediaType: rawMediaType, mediaItems: rawMediaItems, scheduledAt, caption } = req.body;
  
  const items = (rawMediaItems && rawMediaItems.length > 0) ? rawMediaItems : [{ url: rawMediaUrl, type: rawMediaType }];
  if (!items[0] || !items[0].url) return res.status(400).json({ error: 'Media URL is required.' });
  if (!scheduledAt) return res.status(400).json({ error: 'Scheduled time is required.' });

  const userId = req.user.id;
  const scheduledIso = new Date(scheduledAt).toISOString();
  const nowIso = new Date().toISOString();
  const isDue = new Date(scheduledIso).getTime() <= Date.now();
  const processedItems = [];

  try {
    // 1. Process and upload all media items to permanent storage FIRST
    for (const item of items) {
      if (!item.url) continue;
      const result = await uploadMediaItem(userId, item.url, item.type, 'story_sched');
      processedItems.push({
        url: result.url,
        type: result.type || 'image',
        storagePath: result.storagePath,
        bucket: result.bucket
      });
    }

    if (processedItems.length === 0) {
      return res.status(400).json({ error: 'No valid media items provided.' });
    }

    const primaryItem = processedItems[0];

    let metaPayload = null;
    if (req.body.music || req.body.location || req.body.locationData || (req.body.layers && req.body.layers.length > 0)) {
      metaPayload = JSON.stringify({
        music: req.body.music || null,
        location: req.body.location || null,
        locationData: req.body.locationData || null,
        layers: req.body.layers || []
      });
    }

    // 2. Insert into stories table
    const { data: newStory, error: insertErr } = await supabase.from('stories').insert([{
      author_id: userId,
      media_url: primaryItem.url,
      media_type: primaryItem.type,
      caption: caption || '',
      link_url: metaPayload || req.body.linkUrl || null,
      status: isDue ? 'published' : 'scheduled',
      isScheduled: !isDue,
      scheduledAt: scheduledIso,
      created_at: nowIso
    }]).select('*, author:profiles!author_id(id, full_name, username, profile_image_url)').single();

    if (insertErr || !newStory) {
      console.error('Supabase story schedule insert error:', insertErr);
      for (const item of processedItems) {
        if (item.storagePath && item.bucket) {
          try { await supabase.storage.from(item.bucket).remove([item.storagePath]); } catch (_) {}
        }
      }
      return res.status(500).json({ error: insertErr?.message || 'Failed to schedule story.' });
    }

    // 3. Insert into story_media
    if (processedItems.length > 0) {
      const mediaRecords = processedItems.map((item, idx) => ({
        story_id: newStory.id,
        media_url: item.url,
        media_type: item.type,
        display_order: idx + 1
      }));
      await supabase.from('story_media').insert(mediaRecords);
      newStory.mediaItems = mediaRecords.map(r => ({
        id: r.id || newStory.id,
        mediaUrl: r.media_url,
        mediaType: r.media_type,
        displayOrder: r.display_order
      }));
    }

    console.log(`[BACKEND POST /api/stories/schedule SUCCESS] StoryId: ${newStory.id} | scheduledAt: ${scheduledIso} | items: ${processedItems.length}`);
    return res.status(201).json(mapStoryToFrontend(newStory, []));
  } catch (err) {
    console.error('Error scheduling story:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/stories', authenticateToken, async (req, res) => {
  try {
    const nowIso = new Date().toISOString();

    // Auto-publish any scheduled stories whose target time has arrived
    try {
      await supabase
        .from('stories')
        .update({ status: 'published', isScheduled: false })
        .eq('status', 'scheduled')
        .lte('scheduledAt', nowIso);
    } catch (_) {}

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: storiesData, error } = await supabase.from('stories')
      .select('*, author:profiles!author_id(id, full_name, username, profile_image_url)')
      .gt('created_at', twentyFourHoursAgo)
      .order('created_at', { ascending: false });
      
    if (error) throw error;

    const stories = [];
    if (storiesData && storiesData.length > 0) {
      const storyIds = storiesData.map(s => s.id);
      const { data: storyMediaData } = await supabase.from('story_media').select('*').in('story_id', storyIds).order('display_order', { ascending: true });

      for (const s of storiesData) {
        if (s.media_type && s.media_type.startsWith('draft-')) continue;

        if (storyMediaData) {
          const mediaForStory = storyMediaData.filter(m => m.story_id === s.id);
          if (mediaForStory.length > 0) {
            s.mediaItems = mediaForStory.map(m => ({
              id: m.id || s.id,
              mediaUrl: m.media_url,
              mediaType: m.media_type,
              displayOrder: m.display_order
            }));
          }
        }

        const schedTime = s.scheduledAt || s.scheduled_at;
        const isScheduled = s.status === 'scheduled' || s.isScheduled || s.is_scheduled;

        // If it is scheduled and the scheduled time is still in the future, do NOT return it as an active story
        if (isScheduled && schedTime && new Date(schedTime).getTime() > Date.now()) {
          continue;
        }
        
        const { data: likes } = await supabase.from('story_reactions').select('user_id').eq('story_id', s.id);
        const likeUserIds = likes ? likes.map(l => l.user_id) : [];
        const isLikedByMe = req.user ? likeUserIds.some(uid => uid && uid.toString() === req.user.id.toString()) : false;
        
        let isViewedByMe = false;
        let viewsCount = 0;
        if (req.user?.id) {
          const { data: viewRow } = await supabase
            .from('story_views')
            .select('id')
            .eq('story_id', s.id)
            .eq('user_id', req.user.id)
            .maybeSingle();
          if (viewRow) isViewedByMe = true;
          
          if (req.user.id.toString() === s.author_id.toString()) {
            const { count: vCount } = await supabase.from('story_views').select('id', { count: 'exact', head: true }).eq('story_id', s.id);
            viewsCount = vCount || 0;
          }
        }

        const storyObj = mapStoryToFrontend(s, likeUserIds, req.user?.id);
        storyObj.likesCount = likeUserIds.length;
        storyObj.isLiked = isLikedByMe;
        storyObj.isViewed = isViewedByMe;
        storyObj.viewsCount = viewsCount;
        stories.push(storyObj);
      }
    }

    res.json(stories);
  } catch (err) {
    console.error('Error getting stories:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/stories/drafts', authenticateToken, async (req, res) => {
  try {
    const { data: drafts, error } = await supabase.from('stories')
      .select('*, author:profiles!author_id(id, full_name, username, profile_image_url)')
      .like('media_type', 'draft-%')
      .eq('author_id', req.user.id)
      .order('created_at', { ascending: false });
      
    if (error) throw error;

    if (drafts && drafts.length > 0) {
      const draftIds = drafts.map(d => d.id);
      const { data: storyMediaData } = await supabase.from('story_media').select('*').in('story_id', draftIds).order('display_order', { ascending: true });

      for (const d of drafts) {
        if (storyMediaData) {
          const mediaForDraft = storyMediaData.filter(m => m.story_id === d.id);
          if (mediaForDraft.length > 0) {
            d.mediaItems = mediaForDraft.map(m => ({
              id: m.id || d.id,
              mediaUrl: m.media_url,
              mediaType: m.media_type,
              displayOrder: m.display_order
            }));
          }
        }
      }
    }

    res.json((drafts || []).map(d => mapStoryToFrontend(d, [])));
  } catch (err) {
    console.error('Error getting drafts:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/stories/:id/publish', authenticateToken, async (req, res) => {
  const storyId = req.params.id;
  try {
    const { data: story, error: fetchError } = await supabase.from('stories').select('author_id, media_type').eq('id', storyId).single();
    if (fetchError || !story) return res.status(404).json({ error: 'Story not found.' });
    if (story.author_id !== req.user.id) return res.status(403).json({ error: 'Unauthorized.' });

    const newMediaType = story.media_type ? story.media_type.replace('draft-', '') : 'image';
    const { data: updatedStory, error: updateError } = await supabase.from('stories')
      .update({ media_type: newMediaType, created_at: new Date().toISOString() })
      .eq('id', storyId)
      .select('*, author:profiles!author_id(id, full_name, username, profile_image_url)')
      .single();
      
    if (updateError) throw updateError;
    res.json(mapStoryToFrontend(updatedStory, []));
  } catch (err) {
    console.error('Error publishing draft story:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/stories/:id', authenticateToken, async (req, res) => {
  const storyId = req.params.id;
  try {
    const { data: story, error: fetchError } = await supabase.from('stories').select('author_id').eq('id', storyId).single();
    if (fetchError || !story) return res.status(404).json({ error: 'Story not found.' });
    if (story.author_id !== req.user.id) return res.status(403).json({ error: 'Unauthorized.' });

    const { error: deleteError } = await supabase.from('stories').delete().eq('id', storyId);
    if (deleteError) throw deleteError;
    
    res.json({ message: 'Story deleted successfully.' });
  } catch (err) {
    console.error('Error deleting story:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/stories/:id/like', authenticateToken, async (req, res) => {
  const storyId = req.params.id;
  const userId = req.user.id;

  try {
    const { data: story, error: storyError } = await supabase.from('stories').select('author_id').eq('id', storyId).single();
    if (storyError || !story) return res.status(404).json({ error: 'Story not found.' });

    const { data: existingLike } = await supabase.from('story_reactions').select('id, user_id').eq('story_id', storyId).eq('user_id', userId).maybeSingle();
    const isLiked = !existingLike;

    console.log(`[BACKEND POST /like] StoryId: ${storyId} | UserId: ${userId} | Current isLiked: ${!!existingLike} -> Next isLiked: ${isLiked}`);

    if (isLiked) {
      await supabase.from('story_reactions').insert([{ story_id: storyId, user_id: userId, reaction_emoji: '❤️' }]);
      if (story.author_id && story.author_id !== userId) {
        try {
          await supabase.from('notifications').delete().eq('recipient_id', story.author_id).eq('sender_id', userId).eq('type', 'like_story').eq('story_id', storyId);
          await supabase.from('notifications').insert([{
            recipient_id: story.author_id,
            sender_id: userId,
            type: 'like_story',
            story_id: storyId,
            message: 'liked your Hub story'
          }]);
        } catch (notifErr) {
          console.error("Failed to create story like notification:", notifErr);
        }
      }
    } else {
      await supabase.from('story_reactions').delete().eq('story_id', storyId).eq('user_id', userId);
    }

    const { data: updatedLikes } = await supabase.from('story_reactions').select('user_id').eq('story_id', storyId);
    const updatedLikeIds = updatedLikes ? updatedLikes.map(l => l.user_id) : [];
    const likesCount = updatedLikeIds.length;

    console.log(`[BACKEND POST /like SUCCESS] StoryId: ${storyId} | New likesCount: ${likesCount} | isLiked: ${isLiked} | likeUserIds:`, updatedLikeIds);

    res.json({
      likesCount,
      isLiked,
      likes: updatedLikeIds
    });
  } catch (err) {
    console.error('Error liking story:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/stories/:id/view', authenticateToken, async (req, res) => {
  const storyId = req.params.id;
  const userId = req.user?.id;
  if (!storyId) return res.status(400).json({ error: 'Story ID required' });

  try {
    if (userId) {
      // Upsert into story_views to prevent duplicate errors
      const { error: viewErr } = await supabase
        .from('story_views')
        .upsert(
          { story_id: storyId, user_id: userId },
          { onConflict: 'story_id,user_id', ignoreDuplicates: true }
        );

      if (viewErr) {
        // Fallback insert if upsert is unsupported
        await supabase.from('story_views').insert([{ story_id: storyId, user_id: userId }]).catch(() => {});
      }

      // Safely increment view_count on stories table
      try {
        const { data: storyRow } = await supabase.from('stories').select('view_count').eq('id', storyId).maybeSingle();
        if (storyRow) {
          await supabase.from('stories').update({ view_count: (storyRow.view_count || 0) + 1 }).eq('id', storyId);
        }
      } catch (_) {}
    }

    res.json({ success: true, storyId, isViewed: true });
  } catch (err) {
    console.error('Error recording story view:', err);
    res.status(500).json({ error: err.message });
  }
});
router.get('/api/stories/:id/insights', authenticateToken, async (req, res) => {
  try {
    const storyId = req.params.id;
    const { data: story, error: storyErr } = await supabase
      .from('stories')
      .select('author_id')
      .eq('id', storyId)
      .single();

    if (storyErr || !story) return res.status(404).json({ error: 'Story not found' });
    if (story.author_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden. Only the owner can view insights.' });
    }

    const { data: likesData } = await supabase
      .from('story_reactions')
      .select('user_id, profiles(id, full_name, username, profile_image_url)')
      .eq('story_id', storyId);

    const { data: viewsData } = await supabase
      .from('story_views')
      .select('user_id, profiles(id, full_name, username, profile_image_url)')
      .eq('story_id', storyId);

    const userMap = new Map();

    if (viewsData) {
      viewsData.forEach(v => {
        if (v.profiles && v.user_id) {
          userMap.set(v.user_id, {
            id: v.profiles.id,
            fullName: v.profiles.full_name || v.profiles.username,
            username: v.profiles.username,
            profileImage: v.profiles.profile_image_url,
            liked: false
          });
        }
      });
    }

    if (likesData) {
      likesData.forEach(l => {
        if (l.profiles && l.user_id) {
          if (userMap.has(l.user_id)) {
            userMap.get(l.user_id).liked = true;
          } else {
            userMap.set(l.user_id, {
              id: l.profiles.id,
              fullName: l.profiles.full_name || l.profiles.username,
              username: l.profiles.username,
              profileImage: l.profiles.profile_image_url,
              liked: true
            });
          }
        }
      });
    }

    const viewersList = Array.from(userMap.values()).sort((a, b) => {
      if (a.liked && !b.liked) return -1;
      if (!a.liked && b.liked) return 1;
      return 0;
    });

    res.json({ viewers: viewersList });
  } catch (err) {
    console.error('Error fetching story insights:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
