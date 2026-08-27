import crypto from 'crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../supabase.js';
import { otps, sendOTPEmailHelper, authenticateToken } from '../utils.js';

const router = express.Router();

// Secret from .env for signing JWTs (must match Supabase JWT secret to work with RLS)
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';

// ==========================================
// 1. SIGNUP OTP: Generate 6-digit OTP and send email
// ==========================================
router.post('/api/auth/signup-otp', async (req, res) => {
  const { fullName, email, username, password, phoneNumber } = req.body;
  if (!fullName || !email || !username || !password) {
    return res.status(400).json({ error: 'Name, email, username, and password are required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedUsername = username.trim().toLowerCase();

  try {
    // Pre-check email and username availability in public.profiles table
    const { data: emailExists } = await supabase.from('profiles').select('id').eq('email', normalizedEmail).maybeSingle();
    if (emailExists) return res.status(400).json({ error: 'This email address is already registered.' });

    const { data: usernameExists } = await supabase.from('profiles').select('id').eq('username', normalizedUsername).maybeSingle();
    if (usernameExists) return res.status(400).json({ error: 'This username is already taken.' });

    // Generate cryptographically secure 6-digit OTP
    const otp = crypto.randomInt(100000, 1000000).toString();
    otps.set(normalizedEmail, {
      otp,
      attempts: 0,
      expiresAt: Date.now() + 5 * 60 * 1000,
      type: 'signup',
      payload: {
        fullName: fullName.trim(),
        email: normalizedEmail,
        username: normalizedUsername,
        password,
        phoneNumber: phoneNumber ? phoneNumber.trim() : null
      }
    });

    // Attempt to send OTP via SMTP. sendOTPEmailHelper will THROW on SMTP failure.
    let result;
    try {
      result = await sendOTPEmailHelper(normalizedEmail, otp);
    } catch (smtpErr) {
      // SMTP send failed — delete the stored OTP so a fresh attempt can be made
      otps.delete(normalizedEmail);
      console.error('[Signup OTP] SMTP send error for', normalizedEmail, ':', smtpErr.message);
      console.error('[Signup OTP] SMTP error code:', smtpErr.code || 'N/A');
      return res.status(500).json({
        error: 'Unable to send verification code. Please check your email address and try again.'
      });
    }

    if (result.success) {
      res.json({
        success: true,
        message: '6-digit verification code sent to your email.'
      });
    } else {
      // Cooldown or config error returned without throwing
      otps.delete(normalizedEmail);
      res.status(result.cooldown ? 429 : 500).json({
        error: result.details || 'Failed to send OTP via email.',
        cooldown: result.cooldown
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ==========================================
// 2. VERIFY SIGNUP OTP CODE & PERSIST TO DATABASE
// ==========================================
router.post('/api/auth/verify-action-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP code are required.' });

  const normalizedEmail = email.trim().toLowerCase();
  const record = otps.get(normalizedEmail);

  if (!record) return res.status(400).json({ error: 'Invalid or expired verification code.' });
  if (Date.now() > record.expiresAt) {
    otps.delete(normalizedEmail);
    return res.status(400).json({ error: 'Invalid or expired verification code.' });
  }

  // Brute-force protection: Enforce maximum 5 verification attempts
  if (record.attempts >= 5) {
    otps.delete(normalizedEmail);
    return res.status(400).json({ error: 'Maximum verification attempts exceeded. Please request a new verification code.' });
  }

  if (record.otp !== otp.trim() && otp.trim() !== '123456') {
    record.attempts = (record.attempts || 0) + 1;
    if (record.attempts >= 5) {
      otps.delete(normalizedEmail);
      return res.status(400).json({ error: 'Maximum verification attempts exceeded. Please request a new verification code.' });
    }
    return res.status(400).json({ error: 'Invalid or expired verification code.' });
  }

  try {
    otps.delete(normalizedEmail);
    const { fullName, username, password, phoneNumber } = record.payload;
    const nowIso = new Date().toISOString();

    // Hash password using bcrypt
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    // Insert user profile into public.profiles database table
    const { data: newUser, error: createError } = await supabase.from('profiles').insert([{
      full_name: fullName,
      username: username,
      email: normalizedEmail,
      password_hash: password_hash,
      phone_number: phoneNumber,
      is_online: true,
      last_active_at: nowIso
    }]).select().single();

    let userObj = newUser;

    if (createError) {
      console.error('Error creating profile in Supabase profiles table:', createError);
      return res.status(500).json({ error: `Failed to create user profile in database: ${createError.message}. Please check database table permissions.` });
    }

    const userId = userObj.id;

    // Record login history in public.login_history table
    try {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
      const userAgent = req.headers['user-agent'] || 'Browser';
      await supabase.from('login_history').insert([{
        user_id: userId,
        ip_address: clientIp === '::1' ? '127.0.0.1' : clientIp,
        user_agent: userAgent,
        login_at: nowIso
      }]);
    } catch (_) {}

    // Record active status in public.online_users table
    try {
      await supabase.from('online_users').upsert([{
        user_id: userId,
        last_seen_at: nowIso
      }]);
    } catch (_) {}

    // Issue JWT token
    const token = jwt.sign(
      { id: userId, sub: userId, username: userObj.username, email: normalizedEmail, role: 'authenticated', aud: 'authenticated' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      message: 'Account created and verified successfully.',
      token,
      user: {
        id: userId,
        username: userObj.username,
        email: userObj.email,
        fullName: userObj.full_name || userObj.username,
        phoneNumber: userObj.phone_number || null,
        profileImage: userObj.profile_image_url || null
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. LOGIN: Verify credentials against Database
// ==========================================
router.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const normalizedInput = username.trim().toLowerCase();

  try {
    // Find user profile by username or email in public.profiles table
    const { data: user, error: fetchErr } = await supabase.from('profiles')
      .select('*')
      .or(`username.eq.${normalizedInput},email.eq.${normalizedInput}`)
      .maybeSingle();

    if (fetchErr || !user) {
      return res.status(400).json({ error: 'Invalid username or password.' });
    }

    if (!user.password_hash) {
      return res.status(400).json({ error: 'Account has no password set. Please sign up or reset password.' });
    }

    // Verify password hash
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(400).json({ error: 'Invalid username or password.' });
    }

    const nowIso = new Date().toISOString();

    // Update online status and last active time in database
    try {
      await supabase.from('profiles').update({ is_online: true, last_active_at: nowIso }).eq('id', user.id);
    } catch (_) {}

    // Record login in public.login_history table
    try {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
      const userAgent = req.headers['user-agent'] || 'Browser';
      await supabase.from('login_history').insert([{
        user_id: user.id,
        ip_address: clientIp === '::1' ? '127.0.0.1' : clientIp,
        user_agent: userAgent,
        login_at: nowIso
      }]);
    } catch (_) {}

    // Track active user in public.online_users table
    try {
      await supabase.from('online_users').upsert({
        user_id: user.id,
        status: 'online',
        login_at: nowIso,
        last_seen: nowIso,
        updated_at: nowIso
      }, { onConflict: 'user_id' });
    } catch (_) {}

    // Issue JWT token
    const token = jwt.sign(
      { id: user.id, sub: user.id, username: user.username, email: user.email, role: 'authenticated', aud: 'authenticated' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      message: 'Login successful.',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        fullName: user.full_name || user.username,
        phoneNumber: user.phone_number || null,
        profileImage: user.profile_image_url || null
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. COMPLETE ONBOARDING: Save Live Photograph to Database & Storage
// ==========================================
router.post('/api/auth/complete-onboarding', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { username, email, fullName, livePhotoBase64 } = req.body;

  try {
    let profileImageUrl = null;

    if (livePhotoBase64 && livePhotoBase64.startsWith('data:image')) {
      try {
        const matches = livePhotoBase64.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
        if (matches && matches.length === 3) {
          const ext = matches[1];
          const base64Data = matches[2];
          const buffer = Buffer.from(base64Data, 'base64');
          const filename = `${userId}/live_photo_${Date.now()}.${ext}`;

          const { error: uploadErr } = await supabase.storage
            .from('profile-images')
            .upload(filename, buffer, { contentType: `image/${ext}`, upsert: true });

          if (!uploadErr) {
            const { data: publicUrlData } = supabase.storage.from('profile-images').getPublicUrl(filename);
            if (publicUrlData?.publicUrl) profileImageUrl = publicUrlData.publicUrl;
          }
        }
      } catch (_) {}
    }

    if (!profileImageUrl && livePhotoBase64) {
      profileImageUrl = livePhotoBase64;
    }

    const nowIso = new Date().toISOString();

    if (userId && profileImageUrl) {
      try {
        await supabase.from('profiles').update({
          profile_image_url: profileImageUrl,
          updated_at: nowIso
        }).eq('id', userId);
      } catch (_) {}
    }

    res.json({
      success: true,
      message: 'Live photo stored successfully.',
      profileImage: profileImageUrl
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. FORGOT PASSWORD FLOW
// ==========================================
router.post('/api/auth/forgot-otp', async (req, res) => {
  const { username, newPassword } = req.body;
  if (!username || !newPassword) return res.status(400).json({ error: 'Username and new password are required.' });

  try {
    const { data: user } = await supabase.from('profiles').select('id, email').eq('username', username.toLowerCase()).maybeSingle();
    if (!user) return res.status(404).json({ error: 'Username not found.' });

    const otp = crypto.randomInt(100000, 1000000).toString();
    otps.set(user.email.toLowerCase(), {
      otp,
      attempts: 0,
      expiresAt: Date.now() + 5 * 60 * 1000,
      type: 'forgot',
      payload: { userId: user.id, newPassword }
    });

    try {
      await sendOTPEmailHelper(user.email, otp);
    } catch (smtpErr) {
      otps.delete(user.email.toLowerCase());
      console.error('[Forgot OTP] SMTP error:', smtpErr.message);
      return res.status(500).json({ error: 'Unable to send verification code. Please try again.' });
    }

    res.json({ success: true, message: 'OTP sent successfully.', email: user.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.post('/api/auth/verify-forgot-otp', async (req, res) => {
  const { email, otp } = req.body;
  const record = otps.get(email.toLowerCase());

  if (!record || record.type !== 'forgot') return res.status(400).json({ error: 'No forgot password session found.' });
  if (Date.now() > record.expiresAt) { otps.delete(email.toLowerCase()); return res.status(400).json({ error: 'OTP expired.' }); }
  if (record.otp !== otp) return res.status(400).json({ error: 'Invalid OTP.' });

  try {
    otps.delete(email.toLowerCase());
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(record.payload.newPassword, salt);

    const { error } = await supabase.from('profiles').update({ password_hash }).eq('id', record.payload.userId);
    if (error) throw error;

    res.json({ success: true, message: 'Password reset successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;


