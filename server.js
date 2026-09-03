import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

import { supabase } from './supabase.js';
import { uploadMediaItem } from './routes/posts.js';
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import postsRoutes from './routes/posts.js';
import reelsRoutes from './routes/reels.js';
import storiesRoutes from './routes/stories.js';
import notificationsRoutes from './routes/notifications.js';
import chatsRoutes from './routes/chats.js';
import callsRoutes from './routes/calls.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
app.set('etag', false); // Server updated with strict presence & auth validation

// Enable CORS for all routes and preflight requests
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Token', 'Accept', 'Cache-Control'],
  exposedHeaders: ['X-Conversation-Id']
}));

// Security & Cache Control Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  if (req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Debug logger middleware
app.use((req, res, next) => {
  console.log(`[Backend Debug] ${req.method} ${req.url}`);
  next();
});

// Body parser limits (100mb) to support image and up to 5-minute video post uploads
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'dist')));

// Mount API Routes
app.use(authRoutes);
app.use(usersRoutes);
app.use(postsRoutes);
app.use(reelsRoutes);
app.use(storiesRoutes);
app.use(notificationsRoutes);
app.use(chatsRoutes);
app.use(callsRoutes);

// Catch unmatched API routes and return JSON 404 (prevent SPA HTML fallback on API calls)
app.all('/api/{*splat}', (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.url}` });
});

// Fallback all other requests to frontend SPA
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

if (!process.env.NO_AUTO_LISTEN && (process.env.NODE_ENV !== 'production' || !process.env.VERCEL)) {
  app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT} with Supabase`);
  });
}

// Background Scheduler for Scheduled HUBBs

export async function processScheduledItems() {
  let countProcessed = 0;
  try {
    const now = new Date().toISOString();

    // 1. Process Database scheduled stories in Supabase (transition status from scheduled -> published)
    try {
      const { data: updatedStories, error: dbErr } = await supabase
        .from('stories')
        .update({ status: 'published', isScheduled: false })
        .eq('status', 'scheduled')
        .lte('scheduledAt', now)
        .select('id');

      if (updatedStories && updatedStories.length > 0) {
        countProcessed += updatedStories.length;
        console.log(`[Scheduler] Auto-published ${updatedStories.length} scheduled story(ies) in database.`);
      }
    } catch (dbErr) {
      console.warn('[Scheduler] DB story publish notice:', dbErr.message);
    }

    // 2. Process local scheduled posts (/tmp fallback)
    const postsFile = path.join(os.tmpdir(), 'scheduled_posts.json');
    if (fs.existsSync(postsFile)) {
      let scheduledPosts = [];
      try {
        scheduledPosts = JSON.parse(fs.readFileSync(postsFile, 'utf8'));
      } catch (_) {}

      const duePosts = scheduledPosts.filter(p => p.scheduledAt <= now);
      const remainingPosts = scheduledPosts.filter(p => p.scheduledAt > now);

      if (duePosts.length > 0) {
        for (const post of duePosts) {
          try {
            console.log(`[Scheduler] Publishing scheduled post by user ${post.userId}`);
            
            // Insert post row
            const basePayload = {
              author_id: post.userId,
              caption: post.caption || '',
              location: post.location || null
            };

            const { data: newPost, error: postErr } = await supabase
              .from('posts')
              .insert([basePayload])
              .select('id')
              .single();

            if (postErr || !newPost) {
              console.error(`[Scheduler] Failed to create post row:`, postErr?.message);
              continue;
            }

            // Upload and insert media items
            for (let i = 0; i < post.mediaItems.length; i++) {
              const item = post.mediaItems[i];
              const uploaded = await uploadMediaItem(post.userId, item.mediaUrl || item.url, item.mediaType || item.type);

              await supabase
                .from('post_media')
                .insert([{
                  post_id: newPost.id,
                  media_url: uploaded.url,
                  media_type: uploaded.type,
                  display_order: i + 1
                }]);
            }
            console.log(`[Scheduler] Successfully auto-published scheduled post ${newPost.id}`);
            countProcessed++;
          } catch (pubErr) {
            console.error(`[Scheduler] Error auto-publishing post:`, pubErr.message);
          }
        }

        // Save remaining scheduled posts safely
        try {
          fs.writeFileSync(postsFile, JSON.stringify(remainingPosts, null, 2), 'utf8');
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error('[Scheduler] Unexpected error:', err.message);
  }
  return countProcessed;
}

// Cron endpoint for Vercel Serverless triggers
app.all('/api/cron/publish-scheduled', async (req, res) => {
  try {
    const processed = await processScheduledItems();
    res.json({ success: true, processedCount: processed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run background interval loop locally when NOT running inside Vercel serverless environment
if (!process.env.VERCEL) {
  setInterval(processScheduledItems, 5000);
}

export default app;
