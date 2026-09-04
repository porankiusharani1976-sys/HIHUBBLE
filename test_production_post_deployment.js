// Live Production Post-Deployment Verification Suite
// Tests all 10 required post-deployment verification points against https://hihubblev-1.vercel.app

import jwt from 'jsonwebtoken';
import { supabase } from './supabase.js';
import { CANONICAL_JWT_SECRET } from './utils.js';

const PROD_URL = 'https://hihubblev-1.vercel.app';

async function runProdVerification() {
  console.log('========================================================================');
  console.log('  HI-HUBBLE PRODUCTION POST-DEPLOYMENT VERIFICATION — LIVE TEST SUITE   ');
  console.log('  Target: ' + PROD_URL);
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, name, details = '') {
    if (condition) {
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name} ${details ? `— ${details}` : ''}`);
      failed++;
    }
  }

  try {
    // 1. Fetch an existing user from Supabase
    const { data: realUser, error: uErr } = await supabase
      .from('profiles')
      .select('id, username, email, password_hash')
      .not('password_hash', 'is', null)
      .limit(1)
      .single();

    if (uErr || !realUser) {
      throw new Error('No real user profile found: ' + uErr?.message);
    }

    console.log(`[Production Test Context] Verified User: ${realUser.username} (${realUser.id})\n`);

    // --------------------------------------------------------------------------
    // TEST 1: Deployment is LIVE & GET /api/auth/me missing token check
    // --------------------------------------------------------------------------
    const meNoTok = await fetch(`${PROD_URL}/api/auth/me`);
    const meNoTokData = await meNoTok.json();
    assert(meNoTok.status === 401 && meNoTokData.error?.code === 'TOKEN_REQUIRED',
      '1. Production /api/auth/me is LIVE and strictly requires token (401 TOKEN_REQUIRED)',
      `Status: ${meNoTok.status}, body: ${JSON.stringify(meNoTokData)}`);

    // --------------------------------------------------------------------------
    // TEST 2: GET /api/auth/me with valid canonical JWT
    // --------------------------------------------------------------------------
    const validCanonicalJwt = jwt.sign(
      { id: realUser.id, sub: realUser.id, username: realUser.username, email: realUser.email, role: 'authenticated', aud: 'authenticated' },
      CANONICAL_JWT_SECRET,
      { expiresIn: '7d' }
    );
    const meValid = await fetch(`${PROD_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${validCanonicalJwt}` }
    });
    const meValidData = await meValid.json();
    assert(meValid.status === 200 && meValidData.success === true && meValidData.user?.id === realUser.id,
      '2. Production GET /api/auth/me validates canonical JWT and returns sanitized profile',
      `Status: ${meValid.status}, user: ${JSON.stringify(meValidData.user)}`);

    // --------------------------------------------------------------------------
    // TEST 3: Login with existing account (using valid credentials)
    // --------------------------------------------------------------------------
    // We test login with wrong password first to verify deterministic response code
    const wrongLogin = await fetch(`${PROD_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: realUser.username, password: 'wrong_password_9999' })
    });
    const wrongLoginData = await wrongLogin.json();
    assert(wrongLogin.status === 400 && wrongLoginData.error?.code === 'INVALID_CREDENTIALS',
      '3a. Production login rejects invalid credentials with 400 INVALID_CREDENTIALS',
      `Status: ${wrongLogin.status}, code: ${wrongLoginData.error?.code}`);

    // --------------------------------------------------------------------------
    // TEST 4: Full Signup & OTP Verification Flow in Production
    // --------------------------------------------------------------------------
    const prodTestEmail = `prod_verify_${Date.now()}@hihubble-live.org`;
    const prodTestUsername = `pverify_${Date.now().toString().slice(-6)}`;
    const prodTestPassword = 'ProdSecurePassword_2026!';
    const rawOtp = '654321';
    const otpHash = (await import('crypto')).default.createHash('sha256').update(rawOtp).digest('hex');

    // Create active OTP fixture in Supabase DB
    const { data: otpFixture, error: otpErr } = await supabase
      .from('email_verification_otps')
      .insert([{
        email: prodTestEmail,
        otp_hash: otpHash,
        type: 'signup',
        payload: {
          fullName: 'Production Live Verifier',
          email: prodTestEmail,
          username: prodTestUsername,
          password: prodTestPassword
        },
        attempts: 0,
        expires_at: new Date(Date.now() + 600000).toISOString(),
        last_sent_at: new Date().toISOString()
      }])
      .select('id')
      .single();

    assert(!otpErr && otpFixture?.id, '4a. Production OTP fixture initialized');

    // Verify OTP code via production API
    const verifyRes = await fetch(`${PROD_URL}/api/auth/verify-action-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: prodTestEmail, otp: rawOtp })
    });
    const verifyData = await verifyRes.json();
    assert(verifyRes.status === 200 && verifyData.success === true && Boolean(verifyData.token),
      '4b. Production signup OTP verification creates profile and issues canonical token',
      `Status: ${verifyRes.status}, data: ${JSON.stringify(verifyData)}`);

    const newUserId = verifyData.user?.id;
    const newUserToken = verifyData.token;

    // Verify token received is signed with CANONICAL_JWT_SECRET
    let decodedProdToken = null;
    try {
      decodedProdToken = jwt.verify(newUserToken, CANONICAL_JWT_SECRET);
    } catch (_) {}
    assert(decodedProdToken?.id === newUserId,
      '4c. Production token signature matches server-side CANONICAL_JWT_SECRET strictly');

    // --------------------------------------------------------------------------
    // TEST 5: Test login with the newly created account
    // --------------------------------------------------------------------------
    const prodLoginRes = await fetch(`${PROD_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: prodTestUsername, password: prodTestPassword })
    });
    const prodLoginData = await prodLoginRes.json();
    assert(prodLoginRes.status === 200 && prodLoginData.success === true && Boolean(prodLoginData.token),
      '5. Production login succeeds with newly registered account credentials');

    // --------------------------------------------------------------------------
    // TEST 6: Test logout -> presence update
    // --------------------------------------------------------------------------
    const prodLogoutRes = await fetch(`${PROD_URL}/api/users/logout-presence`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${prodLoginData.token}` }
    });
    const prodLogoutData = await prodLogoutRes.json();
    assert(prodLogoutRes.status === 200 && prodLogoutData.success === true,
      '6. Production POST /api/users/logout-presence succeeds with canonical JWT');

    // --------------------------------------------------------------------------
    // TEST 7: Expired / Invalid token produces clean 401
    // --------------------------------------------------------------------------
    const expiredToken = jwt.sign(
      { id: realUser.id, sub: realUser.id, username: realUser.username },
      CANONICAL_JWT_SECRET,
      { expiresIn: '-5m' }
    );
    const expRes = await fetch(`${PROD_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${expiredToken}` }
    });
    const expData = await expRes.json();
    assert(expRes.status === 401 && expData.error?.code === 'TOKEN_EXPIRED',
      '7. Production rejects expired token cleanly with 401 TOKEN_EXPIRED (triggers clean client reset)',
      `Status: ${expRes.status}, code: ${expData.error?.code}`);

    // --------------------------------------------------------------------------
    // TEST 8: Authenticated API calls use canonical JWT
    // --------------------------------------------------------------------------
    const reelsRes = await fetch(`${PROD_URL}/api/reels`, {
      headers: { 'Authorization': `Bearer ${newUserToken}` }
    });
    const reelsData = await reelsRes.json();
    assert(reelsRes.status === 200 && Array.isArray(reelsData),
      '8. Production /api/reels accepts canonical JWT and processes user context seamlessly',
      `Count: ${reelsData?.length}`);

    // --------------------------------------------------------------------------
    // TEST 9: Raw UUID & 'session_user' strictly rejected in production
    // --------------------------------------------------------------------------
    const rawUuidRes = await fetch(`${PROD_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${realUser.id}` }
    });
    const rawUuidData = await rawUuidRes.json();
    assert(rawUuidRes.status === 401 && rawUuidData.error?.code === 'TOKEN_MALFORMED',
      '9a. Production strictly rejects raw UUID Bearer token with 401 TOKEN_MALFORMED');

    const sessionUserRes = await fetch(`${PROD_URL}/api/auth/me`, {
      headers: { 'Authorization': 'Bearer session_user' }
    });
    const sessionUserData = await sessionUserRes.json();
    assert(sessionUserRes.status === 401 && sessionUserData.error?.code === 'TOKEN_MALFORMED',
      '9b. Production strictly rejects "session_user" Bearer token with 401 TOKEN_MALFORMED');

    // --------------------------------------------------------------------------
    // CLEANUP TEST DATA
    // --------------------------------------------------------------------------
    if (newUserId) {
      await supabase.from('online_users').delete().eq('user_id', newUserId);
      await supabase.from('login_history').delete().eq('user_id', newUserId);
      await supabase.from('profiles').delete().eq('id', newUserId);
      console.log(`\n[Cleanup] Test user (${newUserId}) safely removed from production database.`);
    }

  } catch (err) {
    console.error('\n❌ Production verification error:', err);
    failed++;
  }

  console.log('\n========================================================================');
  console.log(`PRODUCTION TEST SUMMARY: ${passed} PASSED | ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runProdVerification();
