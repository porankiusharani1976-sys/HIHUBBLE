import dotenv from 'dotenv';
dotenv.config();

process.env.NO_AUTO_LISTEN = 'true';
import app from './server.js';
import { supabase } from './supabase.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

let activeServer = null;
let API_URL = 'http://127.0.0.1:3188';

async function startServer() {
  return new Promise((resolve) => {
    activeServer = app.listen(3188, '127.0.0.1', () => {
      console.log(`[Test Server] Running on ${API_URL}`);
      resolve();
    });
  });
}

function stopServer() {
  if (activeServer) {
    activeServer.close();
    console.log('[Test Server] Stopped.');
  }
}

async function runOtpSmtpTestSuite() {
  console.log('================================================================');
  console.log('🧪 RUNNING HI-HUBBLE SIGNUP OTP + GMAIL SMTP VERIFICATION SUITE');
  console.log('================================================================\n');

  await startServer();

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Environment Variables & Security Checks
    // -------------------------------------------------------------------------
    console.log('[TEST 1] Auditing Server-Side SMTP Environment Configuration...');
    const emailUser = (process.env.EMAIL_USER || process.env.GMAIL_USER || '').trim();
    const rawPass = (process.env.EMAIL_PASS || process.env.GMAIL_APP_PASSWORD || '').trim();
    const emailPass = rawPass.replace(/\s+/g, '');

    assert(emailUser === 'ansoceanversetechnologies@gmail.com', `EMAIL_USER is configured correctly (${emailUser})`);
    assert(emailPass.length === 16, `EMAIL_PASS is a 16-character Gmail App Password (normalized length: ${emailPass.length})`);
    assert(!process.env.VITE_EMAIL_PASS, 'VITE_EMAIL_PASS is NOT exposed to client-side');
    assert(!process.env.VITE_GMAIL_APP_PASSWORD, 'VITE_GMAIL_APP_PASSWORD is NOT exposed to client-side');

    // -------------------------------------------------------------------------
    // TEST 2: Database Table Accessibility
    // -------------------------------------------------------------------------
    console.log('\n[TEST 2] Verifying public.email_verification_otps Database Table...');
    const { data: tableCheck, error: tableErr } = await supabase
      .from('email_verification_otps')
      .select('id')
      .limit(1);

    assert(!tableErr, 'email_verification_otps table is queryable via Supabase client');

    // -------------------------------------------------------------------------
    // TEST 3: Signup OTP Generation & Real Gmail SMTP Delivery
    // -------------------------------------------------------------------------
    console.log('\n[TEST 3] Dispatching Real 6-Digit OTP Email via Gmail SMTP...');
    const testTimestamp = Date.now();
    const testEmail = 'ansoceanversetechnologies@gmail.com'; // Deliver to real recipient inbox
    const testUsername = `test_user_${testTimestamp}`;
    const testPassword = 'SecurePassword123!';
    const testFullName = 'Hubble QA Tester';

    // Clean any previous test OTP records for this email
    await supabase.from('email_verification_otps').delete().eq('email', testEmail);

    const signupRes = await fetch(`${API_URL}/api/auth/signup-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: testFullName,
        email: testEmail,
        username: testUsername,
        password: testPassword,
        phoneNumber: '+1234567890'
      })
    });

    const signupData = await signupRes.json();
    assert(signupRes.ok && signupData.success === true, 'Signup OTP endpoint returned HTTP 200 and success: true');
    console.log('  📬 Real email dispatched via Gmail SMTP to recipient:', testEmail);

    // -------------------------------------------------------------------------
    // TEST 4: Verify Database Storage & Hash Security
    // -------------------------------------------------------------------------
    console.log('\n[TEST 4] Verifying Persistent Database Storage & Hash Security...');
    const { data: dbRecord, error: dbFetchErr } = await supabase
      .from('email_verification_otps')
      .select('*')
      .eq('email', testEmail)
      .eq('type', 'signup')
      .is('consumed_at', null)
      .single();

    assert(!dbFetchErr && dbRecord, 'OTP record found in public.email_verification_otps');
    assert(dbRecord.otp_hash && dbRecord.otp_hash.length === 64, 'Stored OTP is a 64-character SHA-256 hash (never plaintext)');
    assert(!dbRecord.otp, 'Plaintext OTP column does not exist');
    assert(dbRecord.payload && dbRecord.payload.username === testUsername, 'Pending registration payload is stored correctly in DB');
    assert(dbRecord.attempts === 0, 'Initial attempts count is 0');

    // Check expiry window (should be approx 10 minutes)
    const expiresMs = new Date(dbRecord.expires_at).getTime();
    const remainingMins = (expiresMs - Date.now()) / (60 * 1000);
    assert(remainingMins >= 9 && remainingMins <= 10.1, `Expiry window is 10 minutes (remaining: ${remainingMins.toFixed(1)} mins)`);

    // -------------------------------------------------------------------------
    // TEST 5: Resend Cooldown Enforcement (429 Rate Limit)
    // -------------------------------------------------------------------------
    console.log('\n[TEST 5] Testing Resend Cooldown Rate-Limiting (25s window)...');
    const cooldownRes = await fetch(`${API_URL}/api/auth/signup-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: testFullName,
        email: testEmail,
        username: testUsername,
        password: testPassword
      })
    });

    const cooldownData = await cooldownRes.json();
    assert(cooldownRes.status === 429, `Rapid consecutive OTP request correctly rejected with HTTP 429 (status: ${cooldownRes.status})`);
    assert(cooldownData.cooldown > 0, `Cooldown seconds returned to caller: ${cooldownData.cooldown}s`);

    // -------------------------------------------------------------------------
    // TEST 6: Incorrect OTP Handling & Attempt Tracking
    // -------------------------------------------------------------------------
    console.log('\n[TEST 6] Testing Incorrect OTP Rejection & Brute-Force Attempt Counter...');
    const wrongOtpRes = await fetch(`${API_URL}/api/auth/verify-action-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        otp: '000000'
      })
    });

    assert(wrongOtpRes.status === 400, `Incorrect OTP rejected with HTTP 400 (status: ${wrongOtpRes.status})`);

    const { data: updatedRecord } = await supabase
      .from('email_verification_otps')
      .select('attempts')
      .eq('id', dbRecord.id)
      .single();

    assert(updatedRecord.attempts === 1, `Failed attempt counter incremented to 1 in database`);

    // -------------------------------------------------------------------------
    // TEST 7: Hardcoded Test Bypasses Rejection (e.g. '123456')
    // -------------------------------------------------------------------------
    console.log('\n[TEST 7] Verifying Test Bypass Codes (e.g., 123456) Are Strictly Blocked...');
    const bypassRes = await fetch(`${API_URL}/api/auth/verify-action-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        otp: '123456'
      })
    });

    assert(bypassRes.status === 400, `Bypass code '123456' rejected with HTTP 400`);

    // -------------------------------------------------------------------------
    // TEST 8: Successful OTP Verification & Account Creation
    // -------------------------------------------------------------------------
    console.log('\n[TEST 8] Testing Successful Verification & Account Creation in public.profiles...');
    // We compute the OTP hash match by setting a known test 6-digit code directly in DB for testing
    const validTestOtp = '582914';
    const validOtpHash = crypto.createHash('sha256').update(validTestOtp).digest('hex');

    await supabase
      .from('email_verification_otps')
      .update({ otp_hash: validOtpHash, attempts: 0 })
      .eq('id', dbRecord.id);

    const verifyRes = await fetch(`${API_URL}/api/auth/verify-action-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        otp: validTestOtp
      })
    });

    const verifyData = await verifyRes.json();
    assert(verifyRes.ok && verifyData.success === true, 'Verification returned HTTP 200 and success: true');
    assert(verifyData.token && typeof verifyData.token === 'string', 'JWT authentication token successfully issued');
    assert(verifyData.user && verifyData.user.username === testUsername, 'Returned user matches registered username');

    // Verify user profile exists in public.profiles
    const { data: createdProfile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', verifyData.user.id)
      .single();

    assert(createdProfile && createdProfile.email === testEmail, 'User profile successfully created and persisted in public.profiles');
    assert(createdProfile.password_hash.startsWith('$2'), 'User password stored as secure bcrypt hash');

    // -------------------------------------------------------------------------
    // TEST 9: Single-Use Guarantee (Replay Attack Prevention)
    // -------------------------------------------------------------------------
    console.log('\n[TEST 9] Verifying OTP Invalidation & Replay Attack Prevention...');
    const replayRes = await fetch(`${API_URL}/api/auth/verify-action-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        otp: validTestOtp
      })
    });

    assert(replayRes.status === 400, 'Re-using the same OTP code is rejected with HTTP 400');

    // -------------------------------------------------------------------------
    // TEST 10: User Login with Newly Created Verified Credentials
    // -------------------------------------------------------------------------
    console.log('\n[TEST 10] Testing User Login with Newly Created Account...');
    const loginRes = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUsername,
        password: testPassword
      })
    });

    const loginData = await loginRes.json();
    assert(loginRes.ok && loginData.success === true, 'Login with new credentials succeeded with HTTP 200');
    assert(loginData.token, 'Login returned valid JWT session token');

    // Clean up QA test profile
    await supabase.from('profiles').delete().eq('id', createdProfile.id);
    console.log('  🧹 Cleaned up temporary QA test profile from database.');

    console.log('\n================================================================');
    console.log(`🎉 ALL ${passed} VERIFICATION SUITE TESTS PASSED WITH ZERO ERRORS!`);
    console.log('================================================================\n');

  } catch (err) {
    console.error('\n❌ Test Suite Failed with Error:', err.message);
  } finally {
    stopServer();
  }
}

runOtpSmtpTestSuite();
