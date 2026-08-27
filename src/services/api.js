const isCapacitor = !!window.Capacitor;
const API_URL = isCapacitor
  ? 'https://hi-hubble-z1qx.vercel.app'
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

export const createPost = async (postData) => {
  const token = localStorage.getItem('invibe_jwt_token');
  const res = await fetch(`${API_URL}/api/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      caption: postData.content,
      mediaUrl: postData.media[0] || '',
      mediaType: (postData.media[0]?.includes('video') || postData.media[0]?.startsWith('data:video')) ? 'video' : 'image',
      mediaItems: (postData.media || []).map(url => ({
        url: url,
        type: (url.includes('video') || url.startsWith('data:video')) ? 'video' : 'image'
      })),
      location: postData.location
    })
  });
  if (!res.ok) {
    let errorMsg = 'Failed to create post';
    try {
      const errData = await res.json();
      if (errData && errData.error) errorMsg = errData.error;
    } catch (_) {}
    throw new Error(errorMsg);
  }
  return res.json();
};

export const uploadMedia = async (file) => {
  // Simple base64 fallback or custom backend uploader mock
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      resolve({ url: e.target.result });
    };
    reader.readAsDataURL(file);
  });
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
  const token = localStorage.getItem('invibe_jwt_token');
  const res = await fetch(`${API_URL}/api/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      caption: postData.content,
      mediaUrl: postData.media[0] || '',
      mediaType: (postData.media[0]?.includes('video') || postData.media[0]?.startsWith('data:video')) ? 'video' : 'image',
      mediaItems: (postData.media || []).map(url => ({
        url: url,
        type: (url.includes('video') || url.startsWith('data:video')) ? 'video' : 'image'
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
    } catch (_) {}
    throw new Error(errorMsg);
  }
  return res.json();
};
