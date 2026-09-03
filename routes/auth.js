import crypto from 'crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../supabase.js';
import { sendOTPEmailHelper, authenticateToken } from '../utils.js';

const router = express.Router();

// Secret from .env for signing JWTs (must match Supabase JWT secret to work with RLS)
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';

// ==========================================
// 1. SIGNUP OTP: Generate 6-digit OTP and send email via Gmail SMTP
// ==========================================
router.post('/api/auth/signup-otp', async (req, res) => {
  const { fullName, email, username, password, phoneNumber, gender, dateOfBirth } = req.body;
  if (!fullName || !email || !username || !password) {
    return res.status(400).json({ error: 'Name, email, username, and password are required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedUsername = username.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    // 1. Pre-check email and username availability in public.profiles table
    const { data: emailExists } = await supabase.from('profiles').select('id').eq('email', normalizedEmail).maybeSingle();
    if (emailExists) return res.status(400).json({ error: 'This email address is already registered.' });

    const { data: usernameExists } = await supabase.from('profiles').select('id').eq('username', normalizedUsername).maybeSingle();
    if (usernameExists) return res.status(400).json({ error: 'This username is already taken.' });

    // 2. Enforce 25-second resend cooldown using persistent database timestamps
    const { data: recentOtp } = await supabase
      .from('email_verification_otps')
      .select('last_sent_at')
      .eq('email', normalizedEmail)
      .order('last_sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentOtp && recentOtp.last_sent_at) {
      const elapsed = Date.now() - new Date(recentOtp.last_sent_at).getTime();
      if (elapsed < 25000) {
        const waitSecs = Math.ceil((25000 - elapsed) / 1000);
        return res.status(429).json({
          error: `Please wait ${waitSecs} seconds before requesting another verification code.`,
          cooldown: waitSecs
        });
      }
    }

    // 3. Invalidate any prior unconsumed signup OTP records for this email
    await supabase
      .from('email_verification_otps')
      .delete()
      .eq('email', normalizedEmail)
      .eq('type', 'signup');

    // 4. Generate cryptographically secure 6-digit numeric OTP
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10-minute expiry

    // 5. Store hashed OTP and pending signup payload in database
    const { data: insertedOtp, error: insertErr } = await supabase
      .from('email_verification_otps')
      .insert([{
        email: normalizedEmail,
        otp_hash: otpHash,
        type: 'signup',
        payload: {
          fullName: fullName.trim(),
          email: normalizedEmail,
          username: normalizedUsername,
          password,
          phoneNumber: phoneNumber ? phoneNumber.trim() : null,
          gender: gender || null,
          dateOfBirth: dateOfBirth || null
        },
        attempts: 0,
        expires_at: expiresAt,
        last_sent_at: new Date().toISOString()
      }])
      .select('id')
      .single();

    if (insertErr || !insertedOtp) {
      console.error('[Signup OTP] Failed to store OTP in database:', insertErr?.message);
      return res.status(500).json({ error: 'Unable to initialize verification. Please try again.' });
    }

    // 6. Send OTP via Nodemailer Gmail SMTP
    try {
      await sendOTPEmailHelper(normalizedEmail, otp);
    } catch (smtpErr) {
      // Clean up the stored OTP on SMTP failure so user can retry cleanly
      await supabase.from('email_verification_otps').delete().eq('id', insertedOtp.id);
      console.error('[Signup OTP] SMTP dispatch error for', normalizedEmail, ':', smtpErr.message);
      console.error('[Signup OTP] SMTP error code:', smtpErr.code || 'N/A');
      return res.status(500).json({
        error: 'Unable to send verification code right now. Please try again.'
      });
    }

    return res.json({
      success: true,
      message: '6-digit verification code sent to your email.'
    });
  } catch (err) {
    console.error('[Signup OTP] Unexpected error:', err.message);
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});


// ==========================================
// 2. VERIFY SIGNUP OTP CODE & PERSIST TO DATABASE
// ==========================================
router.post('/api/auth/verify-action-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP code are required.' });

  const normalizedEmail = email.trim().toLowerCase();
  const enteredOtp = otp.trim();

  try {
    // 1. Fetch active, unconsumed signup OTP record from database
    const { data: record, error: fetchErr } = await supabase
      .from('email_verification_otps')
      .select('*')
      .eq('email', normalizedEmail)
      .eq('type', 'signup')
      .is('consumed_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchErr || !record) {
      return res.status(400).json({ error: 'Invalid or expired verification code.' });
    }

    // 2. Check 10-minute expiry
    if (new Date(record.expires_at) < new Date()) {
      await supabase.from('email_verification_otps').delete().eq('id', record.id);
      return res.status(400).json({ error: 'Verification code has expired. Please request a new code.' });
    }

    // 3. Brute-force protection: Enforce maximum 5 verification attempts
    if (record.attempts >= 5) {
      await supabase.from('email_verification_otps').delete().eq('id', record.id);
      return res.status(400).json({ error: 'Maximum verification attempts exceeded. Please request a new verification code.' });
    }

    // 4. Constant-time hash verification
    const enteredHash = crypto.createHash('sha256').update(enteredOtp).digest('hex');
    const enteredBuf = Buffer.from(enteredHash, 'hex');
    const storedBuf = Buffer.from(record.otp_hash, 'hex');
    const isMatch = (enteredBuf.length === storedBuf.length) && crypto.timingSafeEqual(enteredBuf, storedBuf);

    if (!isMatch) {
      const nextAttempts = (record.attempts || 0) + 1;
      if (nextAttempts >= 5) {
        await supabase.from('email_verification_otps').delete().eq('id', record.id);
        return res.status(400).json({ error: 'Maximum verification attempts exceeded. Please request a new verification code.' });
      }
      await supabase.from('email_verification_otps').update({ attempts: nextAttempts }).eq('id', record.id);
      return res.status(400).json({ error: 'Invalid verification code.' });
    }

    // 5. Mark OTP as consumed and clean up
    await supabase.from('email_verification_otps').update({ consumed_at: new Date().toISOString() }).eq('id', record.id);
    await supabase.from('email_verification_otps').delete().eq('email', normalizedEmail);

    // 6. Extract pending registration payload
    const { fullName, username, password, phoneNumber, gender, dateOfBirth } = record.payload || {};
    if (!fullName || !username || !password) {
      return res.status(400).json({ error: 'Registration session details missing. Please sign up again.' });
    }

    const nowIso = new Date().toISOString();

    // 7. Hash password with bcrypt
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    let insertPayload = {
      full_name: fullName,
      username: username,
      email: normalizedEmail,
      password_hash: password_hash,
      phone_number: phoneNumber,
      is_online: true,
      last_active_at: nowIso
    };
    
    if (gender) insertPayload.gender = gender;
    if (dateOfBirth) insertPayload.date_of_birth = dateOfBirth;

    // 8. Insert finalized user profile into public.profiles database table
    let { data: newUser, error: createError } = await supabase.from('profiles').insert([insertPayload]).select().single();
    
    // Fallback if optional columns don't exist
    if (createError && createError.code === '42703') {
      console.warn('[Signup Verification] Column not found error (42703). Retrying without gender/date_of_birth.');
      delete insertPayload.gender;
      delete insertPayload.date_of_birth;
      const retryResult = await supabase.from('profiles').insert([insertPayload]).select().single();
      newUser = retryResult.data;
      createError = retryResult.error;
    }

    if (createError || !newUser) {
      console.error('[Signup Verification] Error creating profile in Supabase profiles table:', createError);
      return res.status(500).json({ error: 'Failed to create user profile in database. Please check database permissions.' });
    }

    const userId = newUser.id;

    // 9. Record login history in public.login_history table
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

    // 10. Record active status in public.online_users table
    try {
      await supabase.from('online_users').upsert([{
        user_id: userId,
        last_seen_at: nowIso
      }]);
    } catch (_) {}

    // 11. Issue JWT token (7-day duration)
    const token = jwt.sign(
      { id: userId, sub: userId, username: newUser.username, email: normalizedEmail, role: 'authenticated', aud: 'authenticated' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      message: 'Account created and verified successfully.',
      token,
      user: {
        id: userId,
        username: newUser.username,
        email: newUser.email,
        fullName: newUser.full_name || newUser.username,
        phoneNumber: newUser.phone_number || null,
        profileImage: newUser.profile_image_url || null
      }
    });
  } catch (err) {
    console.error('[Signup Verification] Unexpected error:', err.message);
    res.status(500).json({ error: 'An unexpected error occurred during verification.' });
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
    const normalizedUsername = username.trim().toLowerCase();
    const { data: user } = await supabase.from('profiles').select('id, email').eq('username', normalizedUsername).maybeSingle();
    if (!user || !user.email) return res.status(404).json({ error: 'Username not found or has no email associated.' });

    const normalizedEmail = user.email.trim().toLowerCase();

    // Check 25s cooldown
    const { data: recentOtp } = await supabase
      .from('email_verification_otps')
      .select('last_sent_at')
      .eq('email', normalizedEmail)
      .order('last_sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentOtp && recentOtp.last_sent_at) {
      const elapsed = Date.now() - new Date(recentOtp.last_sent_at).getTime();
      if (elapsed < 25000) {
        const waitSecs = Math.ceil((25000 - elapsed) / 1000);
        return res.status(429).json({
          error: `Please wait ${waitSecs} seconds before requesting another code.`,
          cooldown: waitSecs
        });
      }
    }

    // Invalidate existing forgot OTPs
    await supabase.from('email_verification_otps').delete().eq('email', normalizedEmail).eq('type', 'forgot');

    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { data: insertedOtp, error: insertErr } = await supabase
      .from('email_verification_otps')
      .insert([{
        email: normalizedEmail,
        otp_hash: otpHash,
        type: 'forgot',
        payload: { userId: user.id, newPassword },
        attempts: 0,
        expires_at: expiresAt,
        last_sent_at: new Date().toISOString()
      }])
      .select('id')
      .single();

    if (insertErr || !insertedOtp) {
      return res.status(500).json({ error: 'Unable to initialize password reset. Please try again.' });
    }

    try {
      await sendOTPEmailHelper(normalizedEmail, otp);
    } catch (smtpErr) {
      await supabase.from('email_verification_otps').delete().eq('id', insertedOtp.id);
      console.error('[Forgot OTP] SMTP error:', smtpErr.message);
      return res.status(500).json({ error: 'Unable to send verification code right now. Please try again.' });
    }

    res.json({ success: true, message: 'Verification code sent to your email.', email: normalizedEmail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.post('/api/auth/verify-forgot-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP code are required.' });

  const normalizedEmail = email.trim().toLowerCase();
  const enteredOtp = otp.trim();

  try {
    const { data: record, error: fetchErr } = await supabase
      .from('email_verification_otps')
      .select('*')
      .eq('email', normalizedEmail)
      .eq('type', 'forgot')
      .is('consumed_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchErr || !record) return res.status(400).json({ error: 'No active password reset session found.' });
    if (new Date(record.expires_at) < new Date()) {
      await supabase.from('email_verification_otps').delete().eq('id', record.id);
      return res.status(400).json({ error: 'Verification code has expired.' });
    }
    if (record.attempts >= 5) {
      await supabase.from('email_verification_otps').delete().eq('id', record.id);
      return res.status(400).json({ error: 'Maximum verification attempts exceeded. Please request a new code.' });
    }

    const enteredHash = crypto.createHash('sha256').update(enteredOtp).digest('hex');
    const enteredBuf = Buffer.from(enteredHash, 'hex');
    const storedBuf = Buffer.from(record.otp_hash, 'hex');
    const isMatch = (enteredBuf.length === storedBuf.length) && crypto.timingSafeEqual(enteredBuf, storedBuf);

    if (!isMatch) {
      const nextAttempts = (record.attempts || 0) + 1;
      if (nextAttempts >= 5) {
        await supabase.from('email_verification_otps').delete().eq('id', record.id);
        return res.status(400).json({ error: 'Maximum verification attempts exceeded. Please request a new code.' });
      }
      await supabase.from('email_verification_otps').update({ attempts: nextAttempts }).eq('id', record.id);
      return res.status(400).json({ error: 'Invalid verification code.' });
    }

    await supabase.from('email_verification_otps').update({ consumed_at: new Date().toISOString() }).eq('id', record.id);
    await supabase.from('email_verification_otps').delete().eq('email', normalizedEmail);

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


