/**
 * Shared Thumbnail Service for HI-HUBBLE Drafts
 * Handles rendering thumbnails consistently across Post HUBBs, Share HUBBs, and HUBBING.
 */

/**
 * Extracts the best available thumbnail URL and identifies if it's a video.
 * Parses through different draft structures (IndexedDB blobs, Base64 strings, API URLs).
 * @param {Object} draft - The draft object to parse.
 * @returns {Object} { url: string, isVideo: boolean }
 */
export function getDraftThumbnailInfo(draft) {
  if (!draft) return { url: '', isVideo: false };

  let url = draft.thumbDataUrl || draft.mediaThumbUrl || draft.thumbnailUrl || '';
  let isVideo = false;

  if (!url) {
    let primaryMedia = null;
    
    if (draft.mediaItems && draft.mediaItems.length > 0) {
      primaryMedia = draft.mediaItems[0];
    } else if (draft.mediaFile) {
      primaryMedia = { file: draft.mediaFile, type: draft.mediaType || 'image' };
    } else if (draft.media && draft.media.length > 0) {
      // Legacy format
      primaryMedia = typeof draft.media[0] === 'string' ? { url: draft.media[0] } : draft.media[0];
    }

    if (primaryMedia) {
      if (primaryMedia.thumbDataUrl) {
         url = primaryMedia.thumbDataUrl;
      } else if (primaryMedia.thumbUrl) {
         url = primaryMedia.thumbUrl;
      } else if (primaryMedia.blob || primaryMedia.file) {
         const file = primaryMedia.blob || primaryMedia.file;
         isVideo = Boolean((file.type && file.type.startsWith('video')) || (primaryMedia.type && primaryMedia.type.startsWith('video')));
         url = URL.createObjectURL(file);
      } else if (primaryMedia.url) {
         url = primaryMedia.url;
         isVideo = Boolean(url.includes('video') || url.endsWith('.mp4') || url.startsWith('blob:video') || (primaryMedia.type && primaryMedia.type.startsWith('video')));
      } else if (primaryMedia.previewUrl) {
         url = primaryMedia.previewUrl;
         isVideo = Boolean(primaryMedia.type && primaryMedia.type.startsWith('video'));
      }
    }
  } else {
     // If a direct URL is found, check if it implies a video
     if (url.includes('video') || url.endsWith('.mp4') || url.startsWith('blob:video')) {
         isVideo = true;
     }
  }

  // Fallback type check
  if (!isVideo && draft.mediaType && typeof draft.mediaType === 'string' && draft.mediaType.startsWith('video')) {
    isVideo = true;
  }

  // If the draft contains reels/clips data but no direct thumbnail
  if (!url && draft.editorState && draft.editorState.clips && draft.editorState.clips.length > 0) {
    const firstClip = draft.editorState.clips[0];
    if (firstClip.url) {
      url = firstClip.url;
      isVideo = true;
    }
  }

  return { url: url || '', isVideo };
}

/**
 * Returns the HTML string to render a draft thumbnail in vanilla JS modules.
 * Properly formats `<video>` tags with #t=0.1 to show the first frame instead of a black box.
 * @param {Object} thumbInfo - The { url, isVideo } object from getDraftThumbnailInfo.
 * @returns {string} HTML string
 */
export function renderThumbnailHTML(thumbInfo) {
  if (!thumbInfo || !thumbInfo.url) {
    return `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:rgba(255,255,255,0.4);"><i data-lucide="image" style="width:24px; height:24px;"></i></div>`;
  }
  
  if (thumbInfo.isVideo) {
    // #t=0.1 ensures the first frame is loaded as a poster for video blob URLs
    const videoUrl = thumbInfo.url.includes('#t=') ? thumbInfo.url : `${thumbInfo.url}#t=0.1`;
    return `<video src="${videoUrl}" preload="metadata" muted playsinline style="width:100%; height:100%; object-fit:cover; pointer-events:none;"></video>`;
  } else {
    return `<img src="${thumbInfo.url}" alt="Draft thumbnail" style="width:100%; height:100%; object-fit:cover;" onerror="this.onerror=null; this.style.display='none';" />`;
  }
}
