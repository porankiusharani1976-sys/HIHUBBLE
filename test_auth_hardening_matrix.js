import jwt from 'jsonwebtoken';
import { supabase } from './supabase.js';
import { CANONICAL_JWT_SECRET } from './utils.js';
import app from './server.js';

const PORT = 3088;
const BASE_URL = `http://localhost:${PORT}`;

async function runAuthMatrix() {
  const server = app.listen(PORT);
  console.log('================================================================');
  console.log('HI-HUBBLE AUTHENTICATION HARDENING — COMPREHENSIVE TEST SUITE');
  console.log('================================================================\n');

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
    // 0. Fetch an existing real user profile from DB to test authentications
    const { data: realUser, error: realUserErr } = await supabase
      .from('profiles')
      .select('id, username, email, password_hash')
      .not('password_hash', 'is', null)
      .limit(1)
      .single();

    if (realUserErr || !realUser) {
      throw new Error('No testable user profile found in database: ' + realUserErr?.message);
    }

    console.log(`[Test Context] Using existing user: ${realUser.username} (${realUser.id})\n`);

    const validCanonicalJwt = jwt.sign(
      { id: realUser.id, sub: realUser.id, username: realUser.username, email: realUser.email, role: 'authenticated', aud: 'authenticated' },
      CANONICAL_JWT_SECRET,
      { expiresIn: '7d' }
    );

    // --- TEST 1: GET /api/auth/me with valid canonical token ---
    const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${validCanonicalJwt}` }
    });
    const meData = await meRes.json();
    assert(meRes.status === 200 && meData.success === true && meData.user.id === realUser.id,
      'GET /api/auth/me with valid canonical JWT', `Status: ${meRes.status}, data: ${JSON.stringify(meData)}`);

    // --- TEST 2: GET /api/auth/me with missing token ---
    const noTokRes = await fetch(`${BASE_URL}/api/auth/me`);
    const noTokData = await noTokRes.json();
    assert(noTokRes.status === 401 && noTokData.error?.code === 'TOKEN_REQUIRED',
      'GET /api/auth/me with missing token returns 401 TOKEN_REQUIRED', `Status: ${noTokRes.status}`);

    // --- TEST 3: Raw UUID as Bearer token (Must be rejected, no bypass) ---
    const rawUuidRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${realUser.id}` }
    });
    const rawUuidData = await rawUuidRes.json();
    assert(rawUuidRes.status === 401 && rawUuidData.error?.code === 'TOKEN_MALFORMED',
      'Raw UUID Bearer token is strictly rejected (no bypass)', `Status: ${rawUuidRes.status}`);

    // --- TEST 4: Malformed token (no dots) ---
    const malformedRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { 'Authorization': 'Bearer not_a_real_jwt_token_format' }
    });
    const malformedData = await malformedRes.json();
    assert(malformedRes.status === 401 && malformedData.error?.code === 'TOKEN_MALFORMED',
      'Malformed token without dots rejected as 401 TOKEN_MALFORMED', `Status: ${malformedRes.status}`);

    // --- TEST 5: Expired Token ---
    const expiredJwt = jwt.sign(
      { id: realUser.id, sub: realUser.id, username: realUser.username },
      CANONICAL_JWT_SECRET,
      { expiresIn: '-10s' } // Expired 10 seconds ago
    );
    const expRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${expiredJwt}` }
    });
    const expData = await expRes.json();
    assert(expRes.status === 401 && expData.error?.code === 'TOKEN_EXPIRED',
      'Expired token rejected as 401 TOKEN_EXPIRED', `Status: ${expRes.status}, code: ${expData.error?.code}`);

    // --- TEST 6: Invalid Signature / Multi-secret fallback eliminated ---
    const fakeSecretJwt = jwt.sign(
      { id: realUser.id, sub: realUser.id, username: realUser.username },
      'wrong-secret-key-attacker-9999',
      { expiresIn: '1d' }
    );
    const fakeSecRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${fakeSecretJwt}` }
    });
    const fakeSecData = await fakeSecRes.json();
    assert(fakeSecRes.status === 401 && fakeSecData.error?.code === 'TOKEN_INVALID',
      'Invalid signature rejected as 401 TOKEN_INVALID', `Status: ${fakeSecRes.status}`);

    // --- TEST 7: Non-existent profile UUID in claims ---
    const phantomJwt = jwt.sign(
      { id: '00000000-0000-4000-8000-000000000000', sub: '00000000-0000-4000-8000-000000000000' },
      CANONICAL_JWT_SECRET,
      { expiresIn: '1d' }
    );
    const phantomRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${phantomJwt}` }
    });
    const phantomData = await phantomRes.json();
    assert(phantomRes.status === 401 && phantomData.error?.code === 'PROFILE_NOT_FOUND',
      'Non-existent user UUID rejected as 401 PROFILE_NOT_FOUND', `Status: ${phantomRes.status}`);

    // --- TEST 8: POST /api/auth/login with wrong password ---
    const wrongPassRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: realUser.username, password: 'definitely_wrong_password_xyz' })
    });
    const wrongPassData = await wrongPassRes.json();
    assert(wrongPassRes.status === 400 && wrongPassData.error?.code === 'INVALID_CREDENTIALS',
      'Login with wrong password returns 400 INVALID_CREDENTIALS', `Status: ${wrongPassRes.status}`);

    // --- TEST 9: POST /api/auth/login with non-existent username ---
    const nonExistentRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nonexistent_user_998877_xyz', password: 'some_password' })
    });
    const nonExistentData = await nonExistentRes.json();
    assert(nonExistentRes.status === 400 && nonExistentData.error?.code === 'INVALID_CREDENTIALS',
      'Login with non-existent user returns 400 INVALID_CREDENTIALS', `Status: ${nonExistentRes.status}`);

    // --- TEST 10: POST /api/auth/signup-otp duplicate email check ---
    const dupEmailRes = await fetch(`${BASE_URL}/api/auth/signup-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Test User',
        email: realUser.email,
        username: 'unique_user_' + Date.now(),
        password: 'Password123!'
      })
    });
    const dupEmailData = await dupEmailRes.json();
    assert(dupEmailRes.status === 400 && dupEmailData.error?.includes('already registered'),
      'Signup pre-check catches duplicate email', `Status: ${dupEmailRes.status}, error: ${dupEmailData.error}`);

    // --- TEST 11: POST /api/auth/signup-otp duplicate username check ---
    const dupUserRes = await fetch(`${BASE_URL}/api/auth/signup-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Test User',
        email: `new_email_${Date.now()}@example.com`,
        username: realUser.username,
        password: 'Password123!'
      })
    });
    const dupUserData = await dupUserRes.json();
    assert(dupUserRes.status === 400 && dupUserData.error?.includes('already taken'),
      'Signup pre-check catches duplicate username', `Status: ${dupUserRes.status}, error: ${dupUserData.error}`);

    // --- TEST 12: Fresh Signup & OTP Verification Flow (Non-Destructive Atomicity Test) ---
    const testEmail = `authtest_${Date.now()}@hihubble-verify.org`;
    const testUsername = `authtest_${Date.now().toString().slice(-6)}`;
    const testPassword = 'SecurePassword_2026!';
    const rawOtp = '789123';
    const otpHash = (await import('crypto')).default.createHash('sha256').update(rawOtp).digest('hex');

    // Create a pending signup record directly in email_verification_otps
    const { data: testOtpRecord, error: otpErr } = await supabase
      .from('email_verification_otps')
      .insert([{
        email: testEmail,
        otp_hash: otpHash,
        type: 'signup',
        payload: {
          fullName: 'Hardening Test Account',
          email: testEmail,
          username: testUsername,
          password: testPassword
        },
        attempts: 0,
        expires_at: new Date(Date.now() + 600000).toISOString(),
        last_sent_at: new Date().toISOString()
      }])
      .select('id')
      .single();

    assert(!otpErr && testOtpRecord?.id, 'Direct OTP session fixture created for testing', `Error: ${otpErr?.message}`);

    // TEST 13: Wrong OTP verification (Atomicity: OTP must NOT be consumed)
    const badOtpRes = await fetch(`${BASE_URL}/api/auth/verify-action-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, otp: '000000' })
    });
    const badOtpData = await badOtpRes.json();
    assert(badOtpRes.status === 400 && badOtpData.error?.code === 'INVALID_OTP',
      'Incorrect OTP rejected as 400 INVALID_OTP', `Status: ${badOtpRes.status}, error: ${JSON.stringify(badOtpData)}`);

    // Verify OTP record still active (not consumed)
    const { data: unconsumedCheck } = await supabase
      .from('email_verification_otps')
      .select('attempts, consumed_at')
      .eq('id', testOtpRecord.id)
      .single();
    assert(unconsumedCheck?.attempts === 1 && unconsumedCheck?.consumed_at === null,
      'OTP session preserved after failed attempt with incremented counter', `Record: ${JSON.stringify(unconsumedCheck)}`);

    // TEST 14: Correct OTP verification -> successful profile creation & canonical token return
    const goodOtpRes = await fetch(`${BASE_URL}/api/auth/verify-action-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, otp: rawOtp })
    });
    const goodOtpData = await goodOtpRes.json();
    assert(goodOtpRes.status === 200 && goodOtpData.success === true && Boolean(goodOtpData.token),
      'Correct OTP successfully creates profile and returns canonical JWT', `Status: ${goodOtpRes.status}`);

    const createdUserId = goodOtpData.user?.id;
    const createdToken = goodOtpData.token;

    // Verify token received from signup is signed with CANONICAL_JWT_SECRET
    let decodedCreatedToken = null;
    try {
      decodedCreatedToken = jwt.verify(createdToken, CANONICAL_JWT_SECRET);
    } catch (_) {}
    assert(decodedCreatedToken?.id === createdUserId,
      'Signup JWT is strictly verifiable with CANONICAL_JWT_SECRET', `Decoded: ${JSON.stringify(decodedCreatedToken)}`);

    // TEST 15: Double-click OTP Verification (Calling verify-action-otp a second time)
    const doubleClickRes = await fetch(`${BASE_URL}/api/auth/verify-action-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, otp: rawOtp })
    });
    const doubleClickData = await doubleClickRes.json();
    assert(doubleClickRes.status === 400 && doubleClickData.error?.code === 'OTP_NOT_FOUND',
      'Double-click OTP verification cleanly rejected without 500 error or duplicate insert', `Status: ${doubleClickRes.status}`);

    // TEST 16: Login with newly created user credentials
    const newLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testUsername, password: testPassword })
    });
    const newLoginData = await newLoginRes.json();
    assert(newLoginRes.status === 200 && newLoginData.success === true && Boolean(newLoginData.token),
      'Newly created user logs in successfully with username', `Status: ${newLoginRes.status}`);

    // TEST 17: Login with newly created user email
    const emailLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testEmail, password: testPassword })
    });
    const emailLoginData = await emailLoginRes.json();
    assert(emailLoginRes.status === 200 && emailLoginData.success === true,
      'Newly created user logs in successfully with email identifier', `Status: ${emailLoginRes.status}`);

    // TEST 18: GET /api/reels with canonical token identifies current user
    const reelsRes = await fetch(`${BASE_URL}/api/reels`, {
      headers: { 'Authorization': `Bearer ${createdToken}` }
    });
    const reelsData = await reelsRes.json();
    assert(reelsRes.status === 200 && Array.isArray(reelsData),
      'GET /api/reels accepts canonical JWT without error', `Status: ${reelsRes.status}, count: ${reelsData?.length}`);

    // TEST 19: POST /api/users/logout-presence with canonical token
    const logoutRes = await fetch(`${BASE_URL}/api/users/logout-presence`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${createdToken}` }
    });
    const logoutData = await logoutRes.json();
    assert(logoutRes.status === 200 && logoutData.success === true,
      'POST /api/users/logout-presence succeeds with canonical JWT', `Status: ${logoutRes.status}`);

    // Clean up created test profile to maintain database hygiene
    if (createdUserId) {
      await supabase.from('online_users').delete().eq('user_id', createdUserId);
      await supabase.from('login_history').delete().eq('user_id', createdUserId);
      await supabase.from('profiles').delete().eq('id', createdUserId);
      console.log(`[Test Cleanup] Removed test profile fixture (${createdUserId})`);
    }

  } catch (matrixErr) {
    console.error('Test matrix unexpected error:', matrixErr);
    failed++;
  }

  console.log('\n================================================================');
  console.log(`TEST MATRIX SUMMARY: ${passed} PASSED | ${failed} FAILED`);
  console.log('================================================================');

  server.close(() => {
    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  });
}

runAuthMatrix();
