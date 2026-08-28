import { supabase } from './supabase.js';

async function run() {
  const { data: posts, error: postsErr } = await supabase
    .from('posts')
    .select(`
      *,
      author_profile:profiles!author_id(id, full_name, username, profile_image_url),
      media:post_media(media_url, media_type)
    `)
    .order('created_at', { ascending: false })
    .limit(25);

  if (postsErr) {
    console.error("Supabase Query Error:", postsErr);
  } else {
    console.log("Query Succeeded! Posts fetched:", posts.length);
    if (posts && posts.length > 0) {
      console.log("First post profile:", posts[0].author_profile);
      console.log("First post media:", posts[0].media);
    }
  }
}
run();
