const isCapacitor = !!window.Capacitor;
const API_URL = isCapacitor
  ? 'https://hihubble-five.vercel.app'
  : (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '[::1]' ||
    window.location.hostname === '::1' ||
    window.location.hostname.startsWith('192.168.') ||
    window.location.hostname.startsWith('10.') ||
    window.location.hostname.startsWith('172.') ||
    window.location.hostname.endsWith('.local')
  ) ? `${window.location.protocol}//${window.location.hostname}:3000`
    : window.location.origin;

window.API_URL = API_URL;

const detectMediaType = (url) => {
  if (typeof url !== 'string' || !url) return 'image';
  const lower = url.toLowerCase();
  if (lower.startsWith('data:video') || lower.includes('/post-videos/') || lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.webm') || lower.includes('video/')) {
    return 'video';
  }
  return 'image';
};

export const createPost = async (postData) => {
  const token = localStorage.getItem('invibe_jwt_token') || (window.getAuthToken ? window.getAuthToken() : null);
  const mediaList = Array.isArray(postData.media) ? postData.media : (postData.media ? [postData.media] : []);
  const firstMedia = mediaList[0] || '';

  const res = await fetch(`${API_URL}/api/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      caption: postData.content,
      mediaUrl: firstMedia,
      mediaType: detectMediaType(firstMedia),
      mediaItems: mediaList.map(url => ({
        url: url,
        type: detectMediaType(url)
      })),
      location: postData.location
    })
  });
  if (!res.ok) {
    let errorMsg = 'Failed to create post';
    try {
      const errData = await res.json();
      if (errData && errData.error) errorMsg = errData.error;
    } catch (_) { }
    throw new Error(errorMsg);
  }
  return res.json();
};

export const uploadMediaBinary = async (file) => {
  const token = localStorage.getItem('invibe_jwt_token') || (window.getAuthToken ? window.getAuthToken() : null);
  if (!token) throw new Error('Authentication required for media upload.');

  const isVideo = file.type ? file.type.startsWith('video/') : (file.name && /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(file.name));
  const isAudio = file.type ? file.type.startsWith('audio/') : (file.name && /\.(mp3|wav|m4a|aac|ogg)$/i.test(file.name));
  const ext = file.name ? file.name.split('.').pop() : (isVideo ? 'mp4' : (isAudio ? 'mp3' : 'jpeg'));
  const typeParam = isVideo ? 'video' : (isAudio ? 'audio' : 'image');
  const contentType = file.type || (isVideo ? 'video/mp4' : 'application/octet-stream');

  try {
    // 1. Request signed upload authorization (0 bytes media buffered in Node backend)
    const authRes = await fetch(`${API_URL}/api/upload-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        fileName: file.name || `media_${Date.now()}.${ext}`,
        fileType: contentType,
        ext,
        type: typeParam
      })
    });

    if (authRes.ok) {
      const authData = await authRes.json();
      if (authData && authData.signedUrl && authData.publicUrl) {
        // 2. Direct streaming binary upload from browser to Supabase Storage CDN (0 Base64 RAM, 0 Node server buffer)
        const uploadRes = await fetch(authData.signedUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': contentType
          },
          body: file
        });

        if (uploadRes.ok) {
          return authData.publicUrl;
        }
        console.warn('[Direct Storage Upload notice, trying fallback]:', uploadRes.status);
      }
    }
  } catch (directErr) {
    console.warn('[Signed upload request notice, trying binary endpoint]:', directErr.message);
  }

  // 3. Fallback: Authenticated binary endpoint
  const res = await fetch(`${API_URL}/api/upload?type=${typeParam}&ext=${encodeURIComponent(ext)}`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'Authorization': `Bearer ${token}`
    },
    body: file
  });

  if (!res.ok) {
    let errorMsg = 'Failed to upload media';
    try {
      const errData = await res.json();
      if (errData && errData.error) errorMsg = errData.error;
    } catch (_) {}
    throw new Error(errorMsg);
  }

  const data = await res.json();
  return data.url || data.mediaUrl;
};

export const uploadMedia = async (file) => {
  return uploadMediaBinary(file);
};

export const saveDraft = async (draftData) => {
  const drafts = JSON.parse(localStorage.getItem('invibe_drafts') || '[]');
  drafts.unshift({
    id: Date.now(),
    updatedAt: new Date().toISOString(),
    ...draftData
  });
  localStorage.setItem('invibe_drafts', JSON.stringify(drafts));
  return { success: true };
};

export const schedulePost = async (postData) => {
  const token = localStorage.getItem('invibe_jwt_token') || (window.getAuthToken ? window.getAuthToken() : null);
  const mediaList = Array.isArray(postData.media) ? postData.media : (postData.media ? [postData.media] : []);
  const firstMedia = mediaList[0] || '';

  const res = await fetch(`${API_URL}/api/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      caption: postData.content,
      mediaUrl: firstMedia,
      mediaType: detectMediaType(firstMedia),
      mediaItems: mediaList.map(url => ({
        url: url,
        type: detectMediaType(url)
      })),
      scheduledAt: postData.scheduledAt || postData.scheduleTime,
      location: postData.location
    })
  });
  if (!res.ok) {
    let errorMsg = 'Failed to schedule post';
    try {
      const errData = await res.json();
      if (errData && errData.error) errorMsg = errData.error;
    } catch (_) { }
    throw new Error(errorMsg);
  }
  return res.json();
};
