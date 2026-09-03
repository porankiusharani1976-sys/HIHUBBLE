import ffmpegPath from 'ffmpeg-static';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { supabase } from '../supabase.js';

const execFileAsync = promisify(execFile);

/**
 * Optimizes a single reel video from WebM/high-bitrate to web-optimized H.264/AAC MP4 with faststart.
 * NEVER deletes or overwrites the original video.
 *
 * @param {Object} reel - The reel database row
 * @returns {Promise<Object>} - Optimization result { success, optimizedUrl, error, savingsPercent }
 */
export async function optimizeReelMedia(reel) {
  if (!reel || !reel.video_url) {
    return { success: false, error: 'No video URL provided' };
  }

  const reelId = reel.id;
  const authorId = reel.author_id || 'system';
  const originalUrl = reel.video_url;

  // If already optimized, skip
  const existingOptUrl = reel.location_data?.optimization?.optimized_media_url;
  if (existingOptUrl && reel.location_data?.optimization?.status === 'ready') {
    return { success: true, optimizedUrl: existingOptUrl, skipped: true };
  }

  const tmpDir = path.join(os.tmpdir(), 'hihubble_media_opt');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const inPath = path.join(tmpDir, `reel_${reelId}_in.webm`);
  const outPath = path.join(tmpDir, `reel_${reelId}_opt.mp4`);

  try {
    // 1. Fetch source media buffer
    console.log(`[REEL OPTIMIZER] Downloading source media for reel: ${reelId}`);
    const res = await fetch(originalUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching source video: ${originalUrl}`);
    const srcBuf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(inPath, srcBuf);

    const origBytes = srcBuf.length;
    const duration = reel.duration_seconds || 10;
    const origBitrateKbps = duration > 0 ? Math.round((origBytes * 8) / (duration * 1000)) : 0;

    console.log(`[REEL OPTIMIZER] Source size: ${(origBytes / (1024 * 1024)).toFixed(2)} MB (~${origBitrateKbps} kbps)`);

    // 2. Transcode to web-optimized mobile profile:
    // H.264 Main profile, max 720p width/height, CRF 24, maxrate 1400k, 2-sec GOP (60 frames), AAC 128k, faststart moov atom at beginning
    const transcodeArgs = [
      '-y',
      '-i', inPath,
      '-vf', "scale='min(720,iw)':'-2'",
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '24',
      '-maxrate', '1400k',
      '-bufsize', '2800k',
      '-pix_fmt', 'yuv420p',
      '-g', '60',
      '-keyint_min', '30',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-movflags', '+faststart',
      outPath
    ];

    console.log(`[REEL OPTIMIZER] Executing FFmpeg transcode...`);
    await execFileAsync(ffmpegPath, transcodeArgs);

    if (!fs.existsSync(outPath)) {
      throw new Error('FFmpeg completed without generating output file');
    }

    const optBuf = fs.readFileSync(outPath);
    const optBytes = optBuf.length;
    const optSizeMB = (optBytes / (1024 * 1024)).toFixed(2);
    const optBitrateKbps = duration > 0 ? Math.round((optBytes * 8) / (duration * 1000)) : 0;
    const savingsPercent = ((1 - (optBytes / origBytes)) * 100).toFixed(1);

    console.log(`[REEL OPTIMIZER] Generated optimized MP4: ${optSizeMB} MB (~${optBitrateKbps} kbps), ${savingsPercent}% size reduction`);

    // 3. Upload optimized MP4 to Supabase Storage under post-videos bucket
    const storagePath = `${authorId}/opt_reel_${reelId}_${Date.now()}.mp4`;
    console.log(`[REEL OPTIMIZER] Uploading to Supabase Storage: post-videos/${storagePath}`);

    const { data: uploadData, error: uploadErr } = await supabase.storage
      .from('post-videos')
      .upload(storagePath, optBuf, {
        contentType: 'video/mp4',
        cacheControl: '31536000, immutable',
        upsert: true
      });

    if (uploadErr) {
      throw new Error(`Supabase storage upload error: ${uploadErr.message}`);
    }

    const { data: publicUrlData } = supabase.storage
      .from('post-videos')
      .getPublicUrl(storagePath);

    const optimizedUrl = publicUrlData?.publicUrl;
    if (!optimizedUrl) {
      throw new Error('Failed to resolve public URL from Supabase Storage');
    }

    // 4. Update database metadata in location_data without overwriting original_media_url
    const updatedLocationData = {
      ...(reel.location_data || {}),
      optimization: {
        status: 'ready',
        optimized_media_url: optimizedUrl,
        original_media_url: originalUrl,
        file_size_bytes: optBytes,
        bitrate_kbps: optBitrateKbps,
        video_codec: 'h264',
        audio_codec: 'aac',
        optimized_at: new Date().toISOString()
      }
    };

    const { error: dbErr } = await supabase
      .from('reels')
      .update({ location_data: updatedLocationData })
      .eq('id', reelId);

    if (dbErr) {
      console.warn(`[REEL OPTIMIZER] Database metadata update notice: ${dbErr.message}`);
    }

    // Cleanup local temporary files
    try {
      if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch (_) {}

    return {
      success: true,
      reelId,
      originalUrl,
      optimizedUrl,
      origBytes,
      optBytes,
      savingsPercent
    };

  } catch (err) {
    console.error(`[REEL OPTIMIZER] Error optimizing reel ${reelId}:`, err.message);
    // Cleanup temporary files
    try {
      if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch (_) {}

    // Record error in database so system knows not to retry endlessly
    try {
      const errLocationData = {
        ...(reel.location_data || {}),
        optimization: {
          status: 'failed',
          optimization_error: err.message,
          failed_at: new Date().toISOString()
        }
      };
      await supabase
        .from('reels')
        .update({ location_data: errLocationData })
        .eq('id', reelId);
    } catch (_) {}

    return { success: false, reelId, error: err.message };
  }
}
