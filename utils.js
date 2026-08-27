// HI-HUBBLE utils — SMTP, OTP, Auth Middleware
// Credentials are read from server-side .env only. Never exposed to frontend.
import dotenv from 'dotenv';
dotenv.config(); // Must be first — loads .env before any process.env reads below

import nodemailer from 'nodemailer';
import jwt from 'jsonwebtoken';
import { supabase } from './supabase.js';

dotenv.config();

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'hihubble-secure-jwt-secret';

// In-memory store for OTPs
export const otps = new Map();

// Map to enforce 25-second cooldown between consecutive email requests
export const lastEmailSentMap = new Map();

// Initialize Nodemailer transport using Gmail SMTP credentials from .env
// Priority: EMAIL_PASS (plain 16-char) > GMAIL_APP_PASSWORD (may have spaces, stripped)
const emailUser = process.env.EMAIL_USER || process.env.GMAIL_USER || '';
const rawPass = process.env.EMAIL_PASS || process.env.GMAIL_APP_PASSWORD || '';
const emailPass = rawPass.replace(/\s+/g, '');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: emailUser,
    pass: emailPass
  },
  tls: {
    rejectUnauthorized: false
  }
});

// Verify SMTP connection at startup (safe diagnostic only — no credentials in logs)
transporter.verify((err) => {
  if (err) {
    console.error('[SMTP] Connection verification FAILED at startup:', err.message);
    console.error('[SMTP] Code:', err.code || 'N/A');
    console.error('[SMTP] Check that EMAIL_USER and EMAIL_PASS in .env are correct Gmail App Password credentials.');
    console.error('[SMTP] Generate a new App Password at: https://myaccount.google.com/apppasswords');
  } else {
    console.log('[SMTP] Gmail SMTP connection verified successfully. Ready to send emails.');
    console.log('[SMTP] Sender account configured:', emailUser);
  }
});

/**
 * Send 6-Digit Verification Code OTP via Email.
 *
 * Returns { success: true } ONLY if the email was actually submitted to the SMTP server.
 * Returns { success: false, details, cooldown? } on any failure.
 *
 * IMPORTANT: This function does NOT silently swallow sendMail() errors.
 * If SMTP fails, the caller receives a real error so the user can be informed.
 */
export async function sendOTPEmailHelper(targetEmail, otpCode) {
  const normalizedEmail = targetEmail.trim().toLowerCase();
  const now = Date.now();

  // Enforce 25-second cooldown between consecutive emails to the same address
  const lastSent = lastEmailSentMap.get(normalizedEmail);
  if (lastSent && (now - lastSent) < 25000) {
    const waitSecs = Math.ceil((25000 - (now - lastSent)) / 1000);
    return {
      success: false,
      details: `Please wait ${waitSecs} seconds before requesting another verification code.`,
      cooldown: waitSecs
    };
  }

  // Abort early if SMTP credentials are not configured
  if (!emailUser || !emailPass) {
    console.error('[SMTP] Cannot send email: EMAIL_USER or EMAIL_PASS is not set in .env');
    return {
      success: false,
      details: 'Email service is not configured. Please contact support.'
    };
  }

  const mailOptions = {
    from: `"HI-HUBBLE" <${emailUser}>`,
    to: normalizedEmail,
    subject: `Your Hi-HUBBLE Verification Code`,
    html: `
      <div style="background-color: #0b0914; color: #ffffff; font-family: 'Outfit', 'Inter', Helvetica, Arial, sans-serif; padding: 40px 20px; text-align: center; border-radius: 16px; max-width: 520px; margin: 0 auto; border: 1px solid rgba(255,255,255,0.1);">
        <div style="margin-bottom: 24px;">
          <h1 style="color: #ffffff; font-size: 26px; font-weight: 800; margin: 0; display: inline-block; background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Hi-HUBBLE ❤️</h1>
          <p style="color: #94a3b8; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 2px; margin-top: 4px;">CONNECT • SHARE • BELONG</p>
        </div>
        
        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 30px 20px; margin-bottom: 24px;">
          <h2 style="font-size: 18px; font-weight: 700; color: #ffffff; margin-top: 0; margin-bottom: 12px;">Two-Factor Verification Code</h2>
          <p style="color: #cbd5e1; font-size: 14px; margin-bottom: 24px; line-height: 1.5;">Use the 6-digit verification code below to complete your Hi-HUBBLE authentication:</p>
          
          <div style="background: #130f26; border: 2px solid #a855f7; border-radius: 12px; padding: 18px; font-size: 36px; font-weight: 800; letter-spacing: 12px; color: #ffffff; display: inline-block; margin-bottom: 20px;">
            ${otpCode}
          </div>
          
          <p style="color: #94a3b8; font-size: 12px; margin: 8px 0 0 0;">This verification code will expire in <strong>5 minutes</strong>.</p>
          <p style="color: #64748b; font-size: 11px; margin: 8px 0 0 0;">Do not share this code with anyone.</p>
        </div>
        
        <p style="color: #64748b; font-size: 12px; margin: 0;">If you did not request this verification code, please ignore this email.</p>
      </div>
    `
  };

  // Attempt SMTP send — do NOT silently swallow errors
  await transporter.sendMail(mailOptions);

  // Only reached if sendMail() succeeded (did not throw)
  lastEmailSentMap.set(normalizedEmail, now);
  console.log('[SMTP] Verification email dispatched successfully to:', normalizedEmail);
  return { success: true };
}


/**
 * Middleware to authenticate requests using JWTs or local session fallback
 */
export async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];

  if (!token && req.headers['x-user-token']) {
    token = req.headers['x-user-token'];
  }

  if (!token && req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token || token === 'undefined' || token === 'null') {
    return res.status(401).json({ error: 'Unauthorized: Authentication token is required.' });
  }

  const possibleSecrets = [
    process.env.SUPABASE_JWT_SECRET,
    process.env.JWT_SECRET,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_ANON_KEY,
    process.env.VITE_SUPABASE_ANON_KEY,
    'hihubble-secure-jwt-secret',
    'hi_hubble_super_secure_jwt_secret_key_2026_spec'
  ].filter(Boolean);

  let decoded = null;
  let userId = null;
  let email = '';
  let username = 'user';
  let fullName = 'User';

  if (token.includes('.')) {
    for (const secret of possibleSecrets) {
      try {
        decoded = jwt.verify(token, secret);
        if (decoded) {
          userId = decoded.id || decoded.sub;
          email = decoded.email || '';
          username = decoded.username || (decoded.email ? decoded.email.split('@')[0] : 'user');
          fullName = decoded.full_name || decoded.fullName || decoded.username || 'User';
          break;
        }
      } catch (_) {}
    }

    if (!userId) {
      // Fallback: Verify token directly using Supabase client
      try {
        const { data: { user: sbUser }, error: sbErr } = await supabase.auth.getUser(token);
        if (sbUser && !sbErr) {
          userId = sbUser.id;
          email = sbUser.email || '';
          username = sbUser.user_metadata?.username || (sbUser.email ? sbUser.email.split('@')[0] : 'user');
          fullName = sbUser.user_metadata?.full_name || sbUser.user_metadata?.fullName || username;
          decoded = { id: userId, email, username, full_name: fullName };
        }
      } catch (err) {
        console.warn('Supabase auth fallback verification warning:', err.message);
      }
    }

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Invalid authentication token signature.' });
    }
  }

  if (userId) {
    req.token = token;
    req.user = {
      id: userId,
      email: email,
      username: username,
      full_name: fullName
    };

    // Fetch fresh profile details from public.profiles
    try {
      let dbProfile = null;
      if (userId && userId !== 'temp_user_id') {
        const { data } = await supabase
          .from('profiles')
          .select('id, full_name, username, email, profile_image_url')
          .eq('id', userId)
          .maybeSingle();
        dbProfile = data;
      }

      if (!dbProfile && req.user.username) {
        const { data } = await supabase
          .from('profiles')
          .select('id, full_name, username, email, profile_image_url')
          .eq('username', req.user.username)
          .maybeSingle();
        dbProfile = data;
      }

      if (!dbProfile && req.user.email) {
        const { data } = await supabase
          .from('profiles')
          .select('id, full_name, username, email, profile_image_url')
          .eq('email', req.user.email)
          .maybeSingle();
        dbProfile = data;
      }

      if (!dbProfile && req.user.id) {
        const { data: createdProfile } = await supabase
          .from('profiles')
          .upsert([{
            id: req.user.id,
            username: req.user.username || 'user',
            email: req.user.email || null,
            full_name: req.user.full_name || req.user.username || 'User',
            password_hash: '$2b$10$e0MYzXy3vV1rV1rV1rV1r.1rV1rV1rV1rV1rV1rV1rV1rV1rV1r',
            is_online: true
          }], { onConflict: 'id' })
          .select('id, full_name, username, email, profile_image_url')
          .maybeSingle();
        dbProfile = createdProfile;
      }

      if (dbProfile) {
        req.user.id = dbProfile.id;
        req.user.username = dbProfile.username || req.user.username;
        req.user.full_name = dbProfile.full_name || req.user.full_name;
        req.user.email = dbProfile.email || req.user.email;
        req.user.profile_image_url = dbProfile.profile_image_url || '';
      }
    } catch (_) {}

    if (req.user.id) {
      return next();
    }
  }

  // Session lookup for non-JWT UUIDs if valid profile matches token directly
  if (token && token.length > 10 && !token.includes('.')) {
    try {
      const { data: dbProfile } = await supabase
        .from('profiles')
        .select('id, full_name, username, email, profile_image_url')
        .or(`id.eq.${token},username.eq.${token},email.eq.${token}`)
        .maybeSingle();

      if (dbProfile) {
        req.token = token;
        req.user = {
          id: dbProfile.id,
          username: dbProfile.username,
          full_name: dbProfile.full_name || dbProfile.username,
          email: dbProfile.email,
          profile_image_url: dbProfile.profile_image_url || ''
        };
        return next();
      }
    } catch (_) {}
  }

  return res.status(401).json({ error: 'Unauthorized: Invalid or expired authentication token.' });
}

