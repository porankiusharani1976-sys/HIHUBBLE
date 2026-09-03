import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { supabase } from '../supabase.js';
import { authenticateToken } from '../utils.js';

const router = express.Router();

// HELPER: Map Supabase Postgres schema to Frontend schema
function mapPostToFrontend(post, media, author, comments, likes) {
  const authorObj = author ? {
    _id: author.id,
    fullName: author.full_name || author.username,
    username: author.username,
    profileImage: author.profile_image_url || ''
  } : {
    _id: post.author_id || 'usr_unknown',
    fullName: 'User',
    username: 'user',
    profileImage: ''
  };

  const validMedia = (media || []).filter(m => m && m.media_url && !m.media_url.trim().toLowerCase().startsWith('blob:'));

  return {
    _id: post.id,
    author: authorObj,
    caption: post.caption || '',
    mediaUrl: validMedia.length > 0 ? validMedia[0].media_url : '',
    mediaType: validMedia.length > 0 ? validMedia[0].media_type : 'image',
    mediaItems: validMedia.map(m => ({
      url: m.media_url,
      type: m.media_type
    })),
    location: post.location || '',
    createdAt: post.created_at,
    likes: likes || [],
    comments: comments || []
  };
}

// Helper to map DB comment object to frontend format
function mapCommentToFrontend(c, userLikes = new Set()) {
  const cAuthor = c.author_profile || {
    id: c.author_id,
    full_name: 'User',
    username: 'user',
    profile_image_url: ''
  };

  return {
    _id: c.id,
    text: c.content,
    createdAt: c.created_at,
    postId: c.post_id,
    parentCommentId: c.parent_comment_id || null,
    likeCount: c.like_count || 0,
    replyCount: c.reply_count || 0,
    isLiked: userLikes.has(c.id),
    author: {
      _id: cAuthor.id,
      fullName: cAuthor.full_name || cAuthor.username,
      username: cAuthor.username,
      profileImage: cAuthor.profile_image_url || ''
    }
  };
}

// Helper to upload media item (base64 or URL) to permanent Supabase Storage
export async function uploadMediaItem(userId, mediaUrl, mediaType, prefix = 'hubb') {
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
      console.error(`[Storage Upload Error in ${bucketName}]:`, uploadErr.message);
      throw new Error(`Failed to upload media to storage: ${uploadErr.message}`);
    }

    const { data: publicUrlData } = supabase.storage.from(bucketName).getPublicUrl(storagePath);
    if (!publicUrlData?.publicUrl) {
      throw new Error('Failed to retrieve public storage URL for uploaded media.');
    }

    finalMediaUrl = publicUrlData.publicUrl;
  } else if (typeof mediaUrl === 'string') {
    if (!mediaUrl.startsWith('http://') && !mediaUrl.startsWith('https://')) {
      throw new Error('Invalid media URL scheme. Only secure HTTP/HTTPS URLs are allowed.');
    }
  }

  return { url: finalMediaUrl, type: finalType, storagePath, bucket: bucketName };
}

function parseScheduleTimeString(timeStr) {
  if (!timeStr) return new Date();

  const now = new Date();

  const directDate = new Date(timeStr);
  if (!isNaN(directDate.getTime()) && timeStr.includes('T') && timeStr.includes('Z')) {
    return directDate;
  }

  // Case 1: "Later Today, 8:00 PM"
  if (timeStr.toLowerCase().includes('later today')) {
    const timeMatch = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
    const date = new Date();
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      const period = timeMatch[3].toUpperCase();
      if (period === 'PM' && hours < 12) hours += 12;
      if (period === 'AM' && hours === 12) hours = 0;
      date.setHours(hours, minutes, 0, 0);
    } else {
      date.setHours(20, 0, 0, 0);
    }
    if (date <= now) {
      return new Date(now.getTime() + 10 * 60 * 1000);
    }
    return date;
  }

  // Case 2: "Tomorrow, 9:00 AM"
  if (timeStr.toLowerCase().includes('tomorrow')) {
    const timeMatch = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
    const date = new Date();
    date.setDate(date.getDate() + 1);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      const period = timeMatch[3].toUpperCase();
      if (period === 'PM' && hours < 12) hours += 12;
      if (period === 'AM' && hours === 12) hours = 0;
      date.setHours(hours, minutes, 0, 0);
    } else {
      date.setHours(9, 0, 0, 0);
    }
    return date;
  }

  // Case 3: "Aug 11, 8:00 PM" (or similar custom date)
  try {
    const currentYear = now.getFullYear();
    const cleaned = timeStr.replace(/,/, ` ${currentYear},`);
    const date = new Date(cleaned);
    if (!isNaN(date.getTime())) {
      if (date <= now) {
        return new Date(now.getTime() + 10 * 60 * 1000);
      }
      return date;
    }
  } catch (_) { }

  return new Date(now.getTime() + 10 * 60 * 1000);
}

// ------------------------------------------------------------------------------
// 0. AUTHENTICATED SIGNED UPLOAD URL GENERATOR FOR LARGE MEDIA STREAMING
// ------------------------------------------------------------------------------
router.post('/api/upload-url', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { fileName, fileType, ext, type } = req.body || {};
    const isVideo = (fileType && fileType.startsWith('video/')) || type === 'video' || (ext && ['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv'].includes(ext.toLowerCase()));
    const isAudio = (fileType && fileType.startsWith('audio/')) || type === 'audio' || (ext && ['mp3', 'wav', 'm4a', 'aac', 'ogg'].includes(ext.toLowerCase()));
    const bucketName = isVideo ? 'post-videos' : 'post-images';
    const cleanExt = (ext || (isVideo ? 'mp4' : (isAudio ? 'mp3' : 'jpeg'))).replace(/[^a-zA-Z0-9]/g, '') || (isVideo ? 'mp4' : 'jpeg');
    const prefix = isVideo ? 'vid' : (isAudio ? 'aud' : 'hubb');
    const storagePath = `${userId}/${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.${cleanExt}`;

    const { data: signData, error: signErr } = await supabase.storage
      .from(bucketName)
      .createSignedUploadUrl(storagePath);

    if (signErr || !signData?.signedUrl) {
      console.error(`[Signed Upload URL Error in ${bucketName}]:`, signErr?.message);
      return res.status(500).json({ error: `Failed to generate upload authorization: ${signErr?.message || 'Unknown error'}` });
    }

    const { data: publicUrlData } = supabase.storage.from(bucketName).getPublicUrl(storagePath);
    if (!publicUrlData?.publicUrl) {
      return res.status(500).json({ error: 'Failed to generate public storage path for media.' });
    }

    res.json({
      success: true,
      signedUrl: signData.signedUrl,
      token: signData.token,
      storagePath,
      bucket: bucketName,
      publicUrl: publicUrlData.publicUrl,
      mediaType: isVideo ? 'video' : (isAudio ? 'audio' : 'image')
    });
  } catch (err) {
    console.error('POST /api/upload-url error:', err);
    res.status(500).json({ error: err.message || 'Internal server error generating upload authorization.' });
  }
});

// ------------------------------------------------------------------------------
// 0.1. AUTHENTICATED BINARY MEDIA UPLOAD FALLBACK ENDPOINT
// ------------------------------------------------------------------------------
router.post('/api/upload', authenticateToken, express.raw({ type: '*/*', limit: '500mb' }), async (req, res) => {
  try {
    const userId = req.user.id;
    const rawContentType = req.headers['content-type'] || 'application/octet-stream';
    const queryType = (req.query.type || '').toLowerCase();
    const isVideo = rawContentType.startsWith('video') || queryType === 'video';
    const isAudio = rawContentType.startsWith('audio') || queryType === 'audio';
    const bucketName = isVideo ? 'post-videos' : 'post-images';
    const rawExt = req.query.ext || (isVideo ? 'mp4' : (isAudio ? 'mp3' : 'jpeg'));
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || (isVideo ? 'mp4' : 'jpeg');
    const prefix = isVideo ? 'vid' : (isAudio ? 'aud' : 'hubb');
    const storagePath = `${userId}/${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.${ext}`;

    const buffer = req.body;
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: 'Media payload is empty or invalid.' });
    }

    const { error: uploadErr } = await supabase.storage
      .from(bucketName)
      .upload(storagePath, buffer, { contentType: rawContentType, upsert: true });

    if (uploadErr) {
      console.error(`[POST /api/upload Error in ${bucketName}]:`, uploadErr.message);
      return res.status(500).json({ error: `Failed to upload media to storage: ${uploadErr.message}` });
    }

    const { data: publicUrlData } = supabase.storage.from(bucketName).getPublicUrl(storagePath);
    if (!publicUrlData?.publicUrl) {
      return res.status(500).json({ error: 'Failed to retrieve public storage URL for uploaded media.' });
    }

    res.status(201).json({
      success: true,
      url: publicUrlData.publicUrl,
      mediaUrl: publicUrlData.publicUrl,
      mediaType: isVideo ? 'video' : (isAudio ? 'audio' : 'image'),
      storagePath,
      bucket: bucketName
    });
  } catch (err) {
    console.error('POST /api/upload error:', err);
    res.status(500).json({ error: err.message || 'Internal server error during upload.' });
  }
});

// ------------------------------------------------------------------------------
// 1. CREATE NEW POST / HUBB
// ------------------------------------------------------------------------------
router.post('/api/posts', authenticateToken, async (req, res) => {
  const { mediaUrl, mediaType, caption, location, scheduledAt, collaborators, mediaItems, editorState } = req.body;

  // Server-side diagnostics (safe output, no tokens or huge base64)
  const firstItem = Array.isArray(mediaItems) && mediaItems.length > 0 ? mediaItems[0] : null;
  const firstUrl = firstItem ? (firstItem.mediaUrl || firstItem.url || '') : (mediaUrl || '');

  console.log('[HUBB POST DEBUG]', {
    method: req.method,
    url: req.originalUrl || req.url,
    contentType: req.headers['content-type'],
    captionLength: typeof caption === 'string' ? caption.length : 0,
    mediaItemsCount: Array.isArray(mediaItems) ? mediaItems.length : 0,
    firstItemType: firstItem ? (firstItem.mediaType || firstItem.type) : mediaType,
    firstItemUrlPresence: !!firstUrl,
    firstItemUrlPrefix: firstUrl ? firstUrl.substring(0, 50) : null
  });

  // Normalize media items array from both new HUBB payload and legacy post payload
  let rawMediaItems = [];
  if (Array.isArray(mediaItems) && mediaItems.length > 0) {
    rawMediaItems = mediaItems;
  } else if (mediaUrl) {
    rawMediaItems = [{ mediaUrl, mediaType: mediaType || 'image' }];
  }

  // Filter valid media items that have a non-empty mediaUrl or url property
  const itemsToProcess = rawMediaItems.filter(item => {
    const url = item.mediaUrl || item.url;
    return typeof url === 'string' && url.trim().length > 0;
  });

  const hasMedia = itemsToProcess.length > 0;
  const hasCaption = typeof caption === 'string' && caption.trim().length > 0;

  if (!hasMedia && !hasCaption) {
    return res.status(400).json({
      error: 'Media URL or caption is required.',
      received: {
        hasCaption,
        mediaItemsCount: itemsToProcess.length
      }
    });
  }

  const userId = req.user.id;

  try {
    // 1. Get profile
    const { data: dbProfile, error: profErr } = await supabase
      .from('profiles')
      .select('id, full_name, username, email, profile_image_url')
      .eq('id', userId)
      .single();

    if (profErr || !dbProfile) {
      return res.status(400).json({ error: 'Author profile not found.' });
    }

    let isScheduled = false;
    let scheduledIso = null;

    if (scheduledAt) {
      const scheduledTime = parseScheduleTimeString(scheduledAt);
      if (scheduledTime > new Date()) {
        isScheduled = true;
        scheduledIso = scheduledTime.toISOString();
      }
    }

    if (isScheduled) {
      let scheduledPosts = [];
      const postsFile = path.join(os.tmpdir(), 'scheduled_posts.json');
      try {
        if (fs.existsSync(postsFile)) {
          scheduledPosts = JSON.parse(fs.readFileSync(postsFile, 'utf8'));
        }
      } catch (e) {
        console.warn('Read scheduled_posts.json notice:', e.message);
      }

      const newScheduled = {
        id: Math.random().toString(36).substring(2, 9),
        userId,
        caption: caption || '',
        location: location || null,
        scheduledAt: scheduledIso,
        mediaItems: itemsToProcess
      };

      scheduledPosts.push(newScheduled);
      try {
        fs.writeFileSync(postsFile, JSON.stringify(scheduledPosts, null, 2), 'utf8');
      } catch (fsErr) {
        console.warn('FS write notice (handled for read-only filesystem):', fsErr.message);
      }

      return res.status(201).json({
        success: true,
        scheduled: true,
        id: newScheduled.id,
        scheduledAt: scheduledIso
      });
    }

    // 2. Pre-process and upload all media items to permanent storage FIRST
    const uploadedMediaItems = [];
    for (let i = 0; i < itemsToProcess.length; i++) {
      const item = itemsToProcess[i];
      const rawUrl = item.mediaUrl || item.url || '';
      const rawType = item.mediaType || item.type || 'image';
      if (!rawUrl) continue;

      try {
        const uploaded = await uploadMediaItem(userId, rawUrl, rawType, 'hubb');
        uploadedMediaItems.push(uploaded);
      } catch (uploadErr) {
        console.error('[POST /api/posts Upload Failure]:', uploadErr.message);
        // Compensating cleanup of any already-uploaded files for this request
        for (const prev of uploadedMediaItems) {
          if (prev.storagePath && prev.bucket) {
            try { await supabase.storage.from(prev.bucket).remove([prev.storagePath]); } catch (_) { }
          }
        }
        return res.status(400).json({ error: `Media upload failed: ${uploadErr.message}` });
      }
    }

    if (!caption && uploadedMediaItems.length === 0) {
      return res.status(400).json({ error: 'Post must contain either a caption or media.' });
    }

    // 3. Insert Post with base payload (guaranteed columns)
    const basePayload = {
      author_id: userId,
      caption: caption || '',
      location: location || null
    };

    let { data: newPost, error: postErr } = await supabase
      .from('posts')
      .insert([basePayload])
      .select('id, author_id, caption, location, created_at')
      .single();

    if (postErr || !newPost) {
      console.error("Supabase post insert error:", postErr);
      // Compensating cleanup of uploaded files
      for (const prev of uploadedMediaItems) {
        if (prev.storagePath && prev.bucket) {
          try { await supabase.storage.from(prev.bucket).remove([prev.storagePath]); } catch (_) { }
        }
      }
      return res.status(500).json({ error: postErr?.message || 'Database error creating post.' });
    }

    // 4. Insert into post_media with permanent URLs
    let newMediaArr = [];
    if (uploadedMediaItems.length > 0) {
      const mediaInserts = uploadedMediaItems.map((up, idx) => ({
        post_id: newPost.id,
        media_url: up.url,
        media_type: up.type,
        display_order: idx + 1
      }));

      const { data: mediaData, error: mediaErr } = await supabase
        .from('post_media')
        .insert(mediaInserts)
        .select();

      if (mediaErr) {
        console.error("Media insert error, rolling back post:", mediaErr.message);
        // Rollback created post
        try { await supabase.from('posts').delete().eq('id', newPost.id); } catch (_) { }
        // Cleanup uploaded files
        for (const prev of uploadedMediaItems) {
          if (prev.storagePath && prev.bucket) {
            try { await supabase.storage.from(prev.bucket).remove([prev.storagePath]); } catch (_) { }
          }
        }
        return res.status(500).json({ error: `Failed to insert post media: ${mediaErr.message}` });
      }

      if (mediaData && mediaData.length > 0) {
        newMediaArr.push(...mediaData);
      }
    }

    // Update user post count if column exists
    try {
      const { count: currentPostCount } = await supabase.from('posts').select('*', { count: 'exact', head: true }).eq('author_id', userId);
      if (currentPostCount) {
        await supabase.from('profiles').update({ post_count: currentPostCount }).eq('id', userId);
      }
    } catch (_) { }

    const mappedPost = mapPostToFrontend(newPost, newMediaArr, dbProfile, [], []);
    res.status(201).json(mappedPost);
  } catch (err) {
    console.error("POST /api/posts error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------------------
// 2. GET FEED POSTS
// ------------------------------------------------------------------------------
router.get('/api/posts', async (req, res) => {
  const { userId, authorId } = req.query;
  const targetAuthor = authorId || userId;

  try {
    let query = supabase
      .from('posts')
      .select(`
        *,
        author_profile:profiles!author_id(id, full_name, username, profile_image_url),
        media:post_media(media_url, media_type)
      `)
      .order('created_at', { ascending: false })
      .limit(25);

    if (targetAuthor) {
      if (targetAuthor.includes('-')) {
        query = query.eq('author_id', targetAuthor);
      } else {
        const { data: prof } = await supabase.from('profiles').select('id').eq('username', targetAuthor).maybeSingle();
        if (prof) {
          query = query.eq('author_id', prof.id);
        }
      }
    }

    const { data: postsData, error } = await query;

    if (error) {
      console.warn("GET /api/posts error:", error.message);
      return res.json([]);
    }

    const posts = [];
    if (postsData && postsData.length > 0) {
      const postIds = postsData.map(p => p.id);

      // Batch fetch comments & likes in 2 bulk queries instead of N+1 loop queries
      const [{ data: allComments }, { data: allLikes }] = await Promise.all([
        supabase
          .from('comments')
          .select('*, author_profile:profiles!author_id(id, full_name, username, profile_image_url)')
          .in('post_id', postIds)
          .order('created_at', { ascending: true }),
        supabase
          .from('likes')
          .select('post_id, user_id')
          .in('post_id', postIds)
      ]);

      const commentsByPost = {};
      (allComments || []).forEach(c => {
        if (!commentsByPost[c.post_id]) commentsByPost[c.post_id] = [];
        commentsByPost[c.post_id].push(mapCommentToFrontend(c));
      });

      const likesByPost = {};
      (allLikes || []).forEach(l => {
        if (!likesByPost[l.post_id]) likesByPost[l.post_id] = [];
        likesByPost[l.post_id].push(l.user_id);
      });

      for (const p of postsData) {
        const authorObj = p.author_profile || {
          id: p.author_id,
          username: 'user',
          full_name: 'User',
          profile_image_url: ''
        };

        if (authorObj.username === 'hubble_user' || p.author_id === '00000000-0000-0000-0000-000000000001') {
          continue;
        }

        const mappedComments = commentsByPost[p.id] || [];
        const mappedLikes = likesByPost[p.id] || [];

        posts.push(mapPostToFrontend(p, p.media || [], authorObj, mappedComments, mappedLikes));
      }
    }

    res.json(posts);
  } catch (err) {
    console.error("GET /api/posts error:", err);
    res.json([]);
  }
});

// ------------------------------------------------------------------------------
// 3. GET COMMENTS FOR A POST
// ------------------------------------------------------------------------------
router.get('/api/posts/:id/comments', async (req, res) => {
  const postId = req.params.id;
  try {
    const { data: commentsData, error } = await supabase
      .from('comments')
      .select('*, author_profile:profiles!author_id(id, full_name, username, profile_image_url)')
      .eq('post_id', postId)
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const mappedComments = (commentsData || []).map(c => mapCommentToFrontend(c));
    res.json(mappedComments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------------------
// 4. CREATE COMMENT ON A POST
// ------------------------------------------------------------------------------
router.post('/api/posts/:id/comment', authenticateToken, async (req, res) => {
  const postId = req.params.id;
  const { text, parentCommentId } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Comment text cannot be empty.' });
  }

  if (text.trim().length > 1000) {
    return res.status(400).json({ error: 'Comment length cannot exceed 1000 characters.' });
  }

  const userId = req.user.id;

  try {
    // 1. Verify Post Exists
    const { data: targetPost, error: postErr } = await supabase
      .from('posts')
      .select('id, author_id')
      .eq('id', postId)
      .maybeSingle();

    if (postErr || !targetPost) {
      return res.status(404).json({ error: 'Target post does not exist or has been deleted.' });
    }

    // 2. Insert Comment into public.comments
    const insertPayload = {
      post_id: targetPost.id,
      author_id: userId,
      content: text.trim()
    };

    if (parentCommentId) {
      insertPayload.parent_comment_id = parentCommentId;
    }

    const { data: insertedComment, error: commentErr } = await supabase
      .from('comments')
      .insert([insertPayload])
      .select('*, author_profile:profiles!author_id(id, full_name, username, profile_image_url)')
      .single();

    if (commentErr) {
      console.error("Comment DB insert error:", commentErr);
      return res.status(500).json({ error: `Database insert failed: ${commentErr.message}` });
    }

    // 3. Update comment_count in public.posts
    try {
      const { count: totalComments } = await supabase
        .from('comments')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', targetPost.id);

      await supabase.from('posts').update({ comment_count: totalComments || 1 }).eq('id', targetPost.id);
    } catch (_) { }

    // 4. Update reply_count on parent comment if replying
    if (parentCommentId) {
      try {
        const { count: replyCount } = await supabase
          .from('comments')
          .select('*', { count: 'exact', head: true })
          .eq('parent_comment_id', parentCommentId);

        await supabase.from('comments').update({ reply_count: replyCount || 1 }).eq('id', parentCommentId);
      } catch (_) { }
    }

    // 5. Send Notification to post author or parent comment author
    const notificationRecipient = parentCommentId ? null : targetPost.author_id;
    if (notificationRecipient && notificationRecipient !== userId) {
      try {
        await supabase.from('notifications').insert([{
          recipient_id: notificationRecipient,
          sender_id: userId,
          type: 'comment',
          target_type: 'post',
          post_id: targetPost.id
        }]);
      } catch (_) { }
    }

    // Return the newly created comment object + updated post comments list
    const { data: allPostComments } = await supabase
      .from('comments')
      .select('*, author_profile:profiles!author_id(id, full_name, username, profile_image_url)')
      .eq('post_id', targetPost.id)
      .order('created_at', { ascending: true });

    const mappedCommentsList = (allPostComments || []).map(c => mapCommentToFrontend(c));
    const newlyCreatedComment = mapCommentToFrontend(insertedComment);

    return res.status(201).json({
      comment: newlyCreatedComment,
      comments: mappedCommentsList
    });
  } catch (err) {
    console.error("Comment handler error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------------------
// 5. CREATE COMMENT REPLY
// ------------------------------------------------------------------------------
router.post('/api/comments/:id/reply', authenticateToken, async (req, res) => {
  const parentCommentId = req.params.id;
  const { text } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Reply text cannot be empty.' });
  }

  const userId = req.user.id;

  try {
    // 1. Fetch parent comment
    const { data: parentComment, error: parentErr } = await supabase
      .from('comments')
      .select('id, post_id, author_id')
      .eq('id', parentCommentId)
      .maybeSingle();

    if (parentErr || !parentComment) {
      return res.status(404).json({ error: 'Parent comment not found.' });
    }

    // 2. Insert reply
    const { data: insertedReply, error: replyErr } = await supabase
      .from('comments')
      .insert([{
        post_id: parentComment.post_id,
        parent_comment_id: parentComment.id,
        author_id: userId,
        content: text.trim()
      }])
      .select('*, author_profile:profiles!author_id(id, full_name, username, profile_image_url)')
      .single();

    if (replyErr) {
      return res.status(500).json({ error: replyErr.message });
    }

    // 3. Update reply_count on parent comment & comment_count on post
    try {
      const { count: replyCount } = await supabase.from('comments').select('*', { count: 'exact', head: true }).eq('parent_comment_id', parentComment.id);
      await supabase.from('comments').update({ reply_count: replyCount || 1 }).eq('id', parentComment.id);

      const { count: totalPostComments } = await supabase.from('comments').select('*', { count: 'exact', head: true }).eq('post_id', parentComment.post_id);
      await supabase.from('posts').update({ comment_count: totalPostComments || 1 }).eq('id', parentComment.post_id);
    } catch (_) { }

    // 4. Send Notification to parent comment author
    if (parentComment.author_id && parentComment.author_id !== userId) {
      try {
        await supabase.from('notifications').insert([{
          recipient_id: parentComment.author_id,
          sender_id: userId,
          type: 'reply',
          target_type: 'comment',
          post_id: parentComment.post_id,
          comment_id: parentComment.id
        }]);
      } catch (_) { }
    }

    return res.status(201).json(mapCommentToFrontend(insertedReply));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------------------
// 6. TOGGLE POST LIKE
// ------------------------------------------------------------------------------
router.post('/api/posts/:id/like', authenticateToken, async (req, res) => {
  const postId = req.params.id;
  const userId = req.user.id;

  try {
    // 1. Resolve Post ID
    const { data: postData, error: postErr } = await supabase
      .from('posts')
      .select('id, author_id')
      .eq('id', postId)
      .maybeSingle();

    if (postErr || !postData) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    const targetPostId = postData.id;
    const postAuthorId = postData.author_id;

    // 2. Check existing like in public.likes
    const { data: existingLike } = await supabase
      .from('likes')
      .select('id')
      .eq('post_id', targetPostId)
      .eq('user_id', userId)
      .maybeSingle();

    const isLiked = !existingLike;

    if (isLiked) {
      await supabase.from('likes').insert([{ post_id: targetPostId, user_id: userId, target_type: 'post' }]);

      // Notification
      if (postAuthorId && postAuthorId !== userId) {
        try {
          await supabase.from('notifications').insert([{
            recipient_id: postAuthorId,
            sender_id: userId,
            type: 'like',
            target_type: 'post',
            post_id: targetPostId
          }]);
        } catch (_) { }
      }
    } else {
      await supabase.from('likes').delete().eq('post_id', targetPostId).eq('user_id', userId);
    }

    // 3. Update like count in public.posts
    const { count: likesCount } = await supabase
      .from('likes')
      .select('*', { count: 'exact', head: true })
      .eq('post_id', targetPostId);

    await supabase.from('posts').update({ like_count: likesCount || 0 }).eq('id', targetPostId);

    return res.json({ success: true, likesCount: likesCount || 0, isLiked });
  } catch (err) {
    console.error("Like error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------------------
// 7. TOGGLE COMMENT LIKE
// ------------------------------------------------------------------------------
router.post('/api/comments/:id/like', authenticateToken, async (req, res) => {
  const commentId = req.params.id;
  const userId = req.user.id;

  try {
    const { data: commentData, error: cErr } = await supabase
      .from('comments')
      .select('id, author_id, post_id')
      .eq('id', commentId)
      .maybeSingle();

    if (cErr || !commentData) {
      return res.status(404).json({ error: 'Comment not found.' });
    }

    // Check existing like
    const { data: existingLike } = await supabase
      .from('likes')
      .select('id')
      .eq('comment_id', commentId)
      .eq('user_id', userId)
      .maybeSingle();

    const isLiked = !existingLike;

    if (isLiked) {
      await supabase.from('likes').insert([{ comment_id: commentId, user_id: userId, target_type: 'comment' }]);

      if (commentData.author_id && commentData.author_id !== userId) {
        try {
          await supabase.from('notifications').insert([{
            recipient_id: commentData.author_id,
            sender_id: userId,
            type: 'comment_like',
            target_type: 'comment',
            post_id: commentData.post_id,
            comment_id: commentId
          }]);
        } catch (_) { }
      }
    } else {
      await supabase.from('likes').delete().eq('comment_id', commentId).eq('user_id', userId);
    }

    // Recalculate comment like count
    const { count: likesCount } = await supabase
      .from('likes')
      .select('*', { count: 'exact', head: true })
      .eq('comment_id', commentId);

    await supabase.from('comments').update({ like_count: likesCount || 0 }).eq('id', commentId);

    return res.json({ success: true, likesCount: likesCount || 0, isLiked });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------------------
// 8. DELETE COMMENT
// ------------------------------------------------------------------------------
router.delete('/api/comments/:id', authenticateToken, async (req, res) => {
  const commentId = req.params.id;
  const userId = req.user.id;

  try {
    const { data: commentData } = await supabase
      .from('comments')
      .select('id, author_id, post_id')
      .eq('id', commentId)
      .maybeSingle();

    if (!commentData) {
      return res.status(404).json({ error: 'Comment not found.' });
    }

    if (commentData.author_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: You can only delete your own comments.' });
    }

    await supabase.from('comments').delete().eq('id', commentId);

    // Update post comment count
    const { count: totalComments } = await supabase
      .from('comments')
      .select('*', { count: 'exact', head: true })
      .eq('post_id', commentData.post_id);

    await supabase.from('posts').update({ comment_count: totalComments || 0 }).eq('id', commentData.post_id);

    return res.json({ success: true, message: 'Comment deleted successfully.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------------------
// 9. GET TRENDING POSTS / HUBBS
// ------------------------------------------------------------------------------
router.get('/api/posts/trending', async (req, res) => {
  try {
    const { data: postsData, error } = await supabase
      .from('posts')
      .select(`
        id, caption, location, created_at, like_count, comment_count, author_id,
        author_profile:profiles!author_id(id, full_name, username, profile_image_url),
        media:post_media(media_url, media_type)
      `)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      console.warn("GET /api/posts/trending DB error:", error.message);
      return res.json([]);
    }

    const trendingHubbs = (postsData || []).map(p => {
      const mediaItem = p.media && p.media.length > 0 ? p.media[0] : null;
      let rawCaption = (p.caption || '').replace(/<[^>]*>/g, '').trim();

      const hashtagMatch = rawCaption.match(/#[a-zA-Z0-9_]+/);
      let title = rawCaption || (p.location ? `Hub in ${p.location.split(',')[0]}` : 'Trending Hubb');
      if (title.length > 50) title = title.substring(0, 50) + '...';

      return {
        _id: p.id,
        title: title,
        hashtag: hashtagMatch ? hashtagMatch[0] : (p.location ? `#${p.location.split(',')[0].replace(/\s+/g, '')}` : '#trending'),
        author: {
          _id: p.author_profile?.id || p.author_id,
          fullName: p.author_profile?.full_name || p.author_profile?.username || 'User',
          username: p.author_profile?.username || 'user',
          profileImage: p.author_profile?.profile_image_url || ''
        },
        mediaUrl: mediaItem ? mediaItem.media_url : '',
        mediaType: mediaItem ? mediaItem.media_type : 'image',
        likesCount: p.like_count || 0,
        commentsCount: p.comment_count || 0,
        createdAt: p.created_at
      };
    });

    res.json(trendingHubbs);
  } catch (err) {
    console.error("[GET /api/posts/trending error]:", err);
    res.json([]);
  }
});

// ------------------------------------------------------------------------------
// GET /api/posts/saved - Get all saved posts for user
// ------------------------------------------------------------------------------
router.get('/api/posts/saved', authenticateToken, async (req, res) => {
  const userId = req.user.id || req.user.userId;

  try {
    const { data: savedPostsData, error: savedErr } = await supabase
      .from('saved_posts')
      .select(`
        post_id,
        created_at,
        posts (
          *,
          author_profile:profiles!author_id(id, full_name, username, profile_image_url),
          media:post_media(media_url, media_type)
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (savedErr) throw savedErr;

    const posts = [];
    if (savedPostsData && savedPostsData.length > 0) {
      const postIds = savedPostsData.map(s => s.post_id).filter(Boolean);

      if (postIds.length > 0) {
        // Batch fetch comments & likes in 2 bulk queries
        const [{ data: allComments }, { data: allLikes }] = await Promise.all([
          supabase
            .from('comments')
            .select('*, author_profile:profiles!author_id(id, full_name, username, profile_image_url)')
            .in('post_id', postIds)
            .order('created_at', { ascending: true }),
          supabase
            .from('likes')
            .select('post_id, user_id')
            .in('post_id', postIds)
        ]);

        const commentsByPost = {};
        (allComments || []).forEach(c => {
          if (!commentsByPost[c.post_id]) commentsByPost[c.post_id] = [];
          commentsByPost[c.post_id].push(mapCommentToFrontend(c));
        });

        const likesByPost = {};
        (allLikes || []).forEach(l => {
          if (!likesByPost[l.post_id]) likesByPost[l.post_id] = [];
          likesByPost[l.post_id].push(l.user_id);
        });

        for (const s of savedPostsData) {
          if (!s.posts) continue;
          const p = s.posts;
          const authorObj = p.author_profile || {
            id: p.author_id,
            username: 'user',
            full_name: 'User',
            profile_image_url: ''
          };

          const mappedComments = commentsByPost[p.id] || [];
          const mappedLikes = likesByPost[p.id] || [];

          posts.push(mapPostToFrontend(p, p.media || [], authorObj, mappedComments, mappedLikes));
        }
      }
    }
    res.json(posts);
  } catch (err) {
    console.error("GET /api/posts/saved error:", err);
    res.status(500).json({ error: 'Failed to retrieve saved posts' });
  }
});

// ------------------------------------------------------------------------------
// POST /api/posts/:id/save - Toggle bookmark/save for post
// ------------------------------------------------------------------------------
router.post('/api/posts/:id/save', authenticateToken, async (req, res) => {
  const postId = req.params.id;
  const userId = req.user.id || req.user.userId;

  try {
    const { data: existingSave } = await supabase
      .from('saved_posts')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .maybeSingle();

    const isSaved = !existingSave;

    if (isSaved) {
      await supabase.from('saved_posts').insert([{ post_id: postId, user_id: userId }]);
    } else {
      await supabase.from('saved_posts').delete().eq('post_id', postId).eq('user_id', userId);
    }

    res.json({ isSaved });
  } catch (err) {
    console.error("POST /api/posts/:id/save error:", err.message);
    res.status(500).json({ error: 'Failed to toggle save post' });
  }
});

// ------------------------------------------------------------------------------
// 10. GET SINGLE POST BY ID
// ------------------------------------------------------------------------------
router.get('/api/posts/:id', authenticateToken, async (req, res) => {
  const postId = req.params.id;
  try {
    const { data: postData, error: postError } = await supabase
      .from('posts')
      .select(`
        *,
        author_profile:profiles!author_id(id, full_name, username, profile_image_url),
        media:post_media(media_url, media_type)
      `)
      .eq('id', postId)
      .maybeSingle();

    if (postError) {
      console.error("[GET /api/posts/:id error]:", postError.message);
      return res.status(500).json({ error: 'Failed to fetch post.' });
    }

    if (!postData) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    // Fetch comments & likes for this post
    const [{ data: commentsData }, { data: likesData }] = await Promise.all([
      supabase
        .from('comments')
        .select('*, author_profile:profiles!author_id(id, full_name, username, profile_image_url)')
        .eq('post_id', postId)
        .order('created_at', { ascending: true }),
      supabase
        .from('likes')
        .select('user_id')
        .eq('post_id', postId)
    ]);

    const mappedComments = (commentsData || []).map(c => mapCommentToFrontend(c));
    const mappedLikes = (likesData || []).map(l => l.user_id);
    const authorObj = postData.author_profile || {
      id: postData.author_id,
      username: 'user',
      full_name: 'User',
      profile_image_url: ''
    };

    const post = mapPostToFrontend(postData, postData.media || [], authorObj, mappedComments, mappedLikes);
    res.json(post);
  } catch (err) {
    console.error("[GET /api/posts/:id error]:", err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ------------------------------------------------------------------------------
// 11. DELETE A POST
// ------------------------------------------------------------------------------
router.delete('/api/posts/:id', authenticateToken, async (req, res) => {
  const postId = req.params.id;
  const userId = req.user.id;

  try {
    // 1. Fetch post to verify existence and authorship
    const { data: post, error: fetchErr } = await supabase
      .from('posts')
      .select('id, author_id')
      .eq('id', postId)
      .maybeSingle();

    if (fetchErr) {
      console.error('[DELETE /api/posts/:id] Fetch error:', fetchErr.message);
      return res.status(500).json({ error: 'Failed to fetch post for deletion.' });
    }

    if (!post) {
      return res.status(404).json({ error: 'Post not found or already deleted.' });
    }

    // Check authorization (allow author to delete)
    if (post.author_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: You are not authorized to delete this post.' });
    }

    // 2. Delete child dependencies from related tables
    await Promise.allSettled([
      supabase.from('post_media').delete().eq('post_id', postId),
      supabase.from('likes').delete().eq('post_id', postId),
      supabase.from('comments').delete().eq('post_id', postId),
      supabase.from('bookmarks').delete().eq('post_id', postId),
      supabase.from('saved_posts').delete().eq('post_id', postId),
      supabase.from('notifications').delete().eq('post_id', postId)
    ]);

    // 3. Delete the post row itself from DB table
    const { error: deleteErr } = await supabase
      .from('posts')
      .delete()
      .eq('id', postId);

    if (deleteErr) {
      console.error('[DELETE /api/posts/:id] Delete error:', deleteErr.message);
      return res.status(500).json({ error: deleteErr.message });
    }

    // 4. Update post_count on profile
    try {
      const { count: remainingPostCount } = await supabase
        .from('posts')
        .select('*', { count: 'exact', head: true })
        .eq('author_id', userId);

      await supabase
        .from('profiles')
        .update({ post_count: remainingPostCount || 0 })
        .eq('id', userId);
    } catch (countErr) {
      console.warn('[DELETE /api/posts/:id] Post count update warning:', countErr.message);
    }

    res.json({ success: true, message: 'Post deleted successfully.' });
  } catch (err) {
    console.error('[DELETE /api/posts/:id] Error:', err);
    res.status(500).json({ error: 'Internal server error while deleting post.' });
  }
});

export default router;