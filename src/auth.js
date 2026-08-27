import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

// Initialize authoritative Supabase Client using environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://fefrlcxctuhdbztyoncs.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZlZnJsY3hjdHVoZGJ6dHlvbmNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4MTYzNTMsImV4cCI6MjEwMDM5MjM1M30.mJURmNFYFDTcC0s7QZ3soMtIfCrysTb0wsZH_USuNO8';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * Diagnostic logger for Auth operations (No sensitive fields logged)
 */
function logAuthDiagnostic(funcName, info) {
  console.error(`[Auth Diagnostic - ${funcName}]`, {
    timestamp: new Date().toISOString(),
    ...info
  });
}

export async function initAuth() {
  const authView = document.getElementById('auth-view');
  const appContainer = document.getElementById('app-container');

  // Tabs
  const tabBtnSignup = document.getElementById('tab-btn-signup');
  const tabBtnLogin = document.getElementById('tab-btn-login');

  // Card Steps
  const step1 = document.getElementById('onboard-step-1'); // Sign Up Form
  const stepLogin = document.getElementById('onboard-login-step'); // Login Form
  const stepOtp = document.getElementById('onboard-otp-step'); // Inline 6-Digit OTP Step
  const step2 = document.getElementById('onboard-step-2'); // Webcam Live Photo

  // Sign Up Form Inputs
  const fullNameInput = document.getElementById('signup-fullname-input');
  const emailInput = document.getElementById('signup-email-input');
  const usernameInput = document.getElementById('quick-username-input');
  const passwordInput = document.getElementById('signup-password-input');
  const phoneInput = document.getElementById('signup-phone-input');
  const usernameError = document.getElementById('onboard-username-error');
  const gotoCameraBtn = document.getElementById('btn-goto-camera');

  // Login Form Inputs
  const loginUsernameInput = document.getElementById('login-username-input');
  const loginPasswordInput = document.getElementById('login-password-input');
  const loginErrorMsg = document.getElementById('login-error-msg');
  const btnLoginSubmit = document.getElementById('btn-login-submit');

  // Inline OTP Step Elements
  const otpInputs = document.querySelectorAll('#onboard-otp-step .otp-input');
  const btnVerifyOtpStep = document.getElementById('btn-verify-otp-step');
  const inlineOtpErrorMsg = document.getElementById('inline-otp-error-msg');
  const inlineResendOtpLink = document.getElementById('inline-resend-otp-link');
  const inlineOtpTimer = document.getElementById('inline-otp-timer');
  const inlineOtpInstruction = document.getElementById('inline-otp-instruction');
  const btnBackToSignup = document.getElementById('btn-back-to-signup');

  // Webcam Elements
  const videoElem = document.getElementById('live-webcam-video');
  const photoPreviewElem = document.getElementById('live-photo-preview');
  const canvasElem = document.getElementById('live-webcam-canvas');
  const webcamStatusMsg = document.getElementById('webcam-status-msg');

  const snapPhotoBtn = document.getElementById('btn-snap-photo');
  const retakePhotoBtn = document.getElementById('btn-retake-photo');
  const finishOnboardBtn = document.getElementById('btn-finish-onboard');

  let webcamStream = null;
  let capturedBase64 = null;
  let signedUpUser = null;
  let resendCountdownInterval = null;
  let isResendCooldown = false;
  let activeTab = 'signup';

  // --- TAB SWITCHING (SIGN UP | LOGIN) ---
  function switchTab(target) {
    activeTab = target;
    if (target === 'signup') {
      if (tabBtnSignup) {
        tabBtnSignup.classList.add('active');
        tabBtnSignup.style.background = 'var(--primary, #a855f7)';
        tabBtnSignup.style.color = '#ffffff';
      }
      if (tabBtnLogin) {
        tabBtnLogin.classList.remove('active');
        tabBtnLogin.style.background = 'transparent';
        tabBtnLogin.style.color = 'var(--text-muted, #94a3b8)';
      }
      if (step1) step1.style.display = 'flex';
      if (stepLogin) stepLogin.style.display = 'none';
      if (stepOtp) stepOtp.style.display = 'none';
      if (step2) step2.style.display = 'none';
    } else {
      if (tabBtnLogin) {
        tabBtnLogin.classList.add('active');
        tabBtnLogin.style.background = 'var(--primary, #a855f7)';
        tabBtnLogin.style.color = '#ffffff';
      }
      if (tabBtnSignup) {
        tabBtnSignup.classList.remove('active');
        tabBtnSignup.style.background = 'transparent';
        tabBtnSignup.style.color = 'var(--text-muted, #94a3b8)';
      }
      if (stepLogin) stepLogin.style.display = 'flex';
      if (step1) step1.style.display = 'none';
      if (stepOtp) stepOtp.style.display = 'none';
      if (step2) step2.style.display = 'none';
    }
    if (window.debouncedCreateIcons) window.debouncedCreateIcons(); else if (window.lucide) window.lucide.createIcons();
  }

  if (tabBtnSignup) tabBtnSignup.addEventListener('click', () => switchTab('signup'));
  if (tabBtnLogin) tabBtnLogin.addEventListener('click', () => switchTab('login'));

  function showAuthView() {
    if (authView) {
      authView.classList.remove('hidden');
      authView.style.display = 'flex';
    }
    if (appContainer) appContainer.style.display = 'none';
    switchTab('signup');
  }

  function showAppView() {
    stopWebcam();
    if (authView) {
      authView.classList.add('hidden');
      authView.style.display = 'none';
    }
    if (appContainer) appContainer.style.display = 'block';
    updateAppUI();
  }

  function stopWebcam() {
    if (webcamStream) {
      try {
        webcamStream.getTracks().forEach(track => track.stop());
      } catch (e) {
        console.warn('Error stopping webcam tracks:', e);
      }
      webcamStream = null;
    }
  }

  async function startWebcam() {
    try {
      if (webcamStatusMsg) webcamStatusMsg.textContent = 'Starting camera preview...';
      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 640 }, facingMode: 'user' },
        audio: false
      });
      if (videoElem) {
        videoElem.srcObject = webcamStream;
        videoElem.style.display = 'block';
      }
      if (photoPreviewElem) photoPreviewElem.style.display = 'none';
      if (webcamStatusMsg) webcamStatusMsg.textContent = 'Center your face and click "Snap Photo"';
      if (snapPhotoBtn) snapPhotoBtn.style.display = 'inline-flex';
      if (retakePhotoBtn) retakePhotoBtn.style.display = 'none';
      if (finishOnboardBtn) finishOnboardBtn.style.display = 'none';
    } catch (err) {
      console.warn('Webcam not available or permission denied:', err);
      if (webcamStatusMsg) webcamStatusMsg.textContent = 'Camera unavailable. Generated initial visual avatar.';

      const initialChar = signedUpUser?.username ? signedUpUser.username.charAt(0).toUpperCase() : 'H';
      if (canvasElem) {
        canvasElem.width = 400;
        canvasElem.height = 400;
        const ctx = canvasElem.getContext('2d');
        ctx.fillStyle = '#8a5cff';
        ctx.fillRect(0, 0, 400, 400);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 160px Outfit, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(initialChar, 200, 200);
        capturedBase64 = canvasElem.toDataURL('image/jpeg');
      }

      if (photoPreviewElem) {
        photoPreviewElem.src = capturedBase64;
        photoPreviewElem.style.display = 'block';
      }
      if (videoElem) videoElem.style.display = 'none';

      if (snapPhotoBtn) snapPhotoBtn.style.display = 'none';
      if (retakePhotoBtn) retakePhotoBtn.style.display = 'inline-flex';
      if (finishOnboardBtn) finishOnboardBtn.style.display = 'inline-flex';
    }
  }

  // --- OTP TIMER ---
  function startOtpTimer(seconds = 25) {
    if (resendCountdownInterval) clearInterval(resendCountdownInterval);
    isResendCooldown = true;
    let remaining = seconds;
    if (inlineOtpTimer) inlineOtpTimer.textContent = remaining;

    resendCountdownInterval = setInterval(() => {
      remaining--;
      if (inlineOtpTimer) inlineOtpTimer.textContent = remaining;
      if (remaining <= 0) {
        clearInterval(resendCountdownInterval);
        isResendCooldown = false;
        if (inlineResendOtpLink) inlineResendOtpLink.textContent = 'Resend Code Now';
      }
    }, 1000);
  }

  // --- 6-DIGIT OTP INPUT AUTO-ADVANCE ---
  if (otpInputs && otpInputs.length > 0) {
    otpInputs.forEach((input, index) => {
      input.addEventListener('input', (e) => {
        const val = e.target.value;
        if (val.length >= 1) {
          input.value = val.charAt(0);
          if (index < otpInputs.length - 1) {
            otpInputs[index + 1].focus();
          }
        }
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !input.value && index > 0) {
          otpInputs[index - 1].focus();
        }
      });

      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData || window.clipboardData).getData('text').trim();
        if (/^\d{6}$/.test(pasted)) {
          pasted.split('').forEach((char, i) => {
            if (otpInputs[i]) otpInputs[i].value = char;
          });
          if (otpInputs[5]) otpInputs[5].focus();
        }
      });
    });
  }

  function getEnteredOtpCode() {
    let code = '';
    otpInputs.forEach(inp => code += inp.value.trim());
    return code;
  }

  function clearOtpInputs() {
    otpInputs.forEach(inp => inp.value = '');
    if (otpInputs[0]) otpInputs[0].focus();
    hideError(inlineOtpErrorMsg);
  }

  function isTokenExpired(token) {
    if (!token || !token.includes('.')) return false;
    try {
      const parts = token.split('.');
      if (parts.length < 2) return true;
      const base64Url = parts[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      const payload = JSON.parse(jsonPayload);
      if (payload.exp) {
        const currentTime = Math.floor(Date.now() / 1000);
        return payload.exp < currentTime;
      }
      return false;
    } catch (e) {
      console.warn("Error decoding token:", e);
      return true;
    }
  }

  // Check existing session
  const storedUser = localStorage.getItem('invibeUser');
  const isLoggedIn = localStorage.getItem('invibeIsLoggedIn') === 'true';
  const curTok = localStorage.getItem('invibe_jwt_token');

  let sessionValid = isLoggedIn && storedUser;
  if (sessionValid && curTok) {
    if (isTokenExpired(curTok)) {
      console.warn("Session token has expired. Logging out.");
      localStorage.removeItem('invibeIsLoggedIn');
      localStorage.removeItem('invibeUser');
      localStorage.removeItem('invibe_jwt_token');
      sessionValid = false;
    }
  }

  if (sessionValid) {
    try {
      const u = JSON.parse(storedUser);
      if (u && (u.id || u._id)) {
        if (!curTok || curTok === 'null' || curTok === 'undefined' || curTok.trim() === '') {
          localStorage.setItem('invibe_jwt_token', (u.id || u._id).toString());
        }
      }
    } catch (_) {}
    showAppView();
  } else {
    showAuthView();
  }

  // =========================================================================
  // 1. SIGN UP FLOW (Custom HI-HUBBLE Backend SMTP 6-Digit Email OTP)
  // =========================================================================
  async function handleSignUpSubmit() {
    const fullName = fullNameInput ? fullNameInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim() : '';
    const username = usernameInput ? usernameInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';
    const phone = phoneInput ? phoneInput.value.trim() : '';

    if (!fullName) return showError(usernameError, 'Please enter your full name.');
    if (!email || !email.includes('@')) return showError(usernameError, 'Please enter a valid email address.');
    if (!username) return showError(usernameError, 'Please choose a username.');
    if (!password || password.length < 4) return showError(usernameError, 'Password must be at least 4 characters long.');

    hideError(usernameError);

    if (gotoCameraBtn) {
      gotoCameraBtn.disabled = true;
      gotoCameraBtn.innerHTML = '<i data-lucide="loader" class="spin"></i> Sending Code...';
      if (window.debouncedCreateIcons) window.debouncedCreateIcons();
    }

    try {
      const normalizedEmail = email.toLowerCase();
      const normalizedUsername = username.toLowerCase();

      // Pre-check if email or username already exists in public.profiles table
      const { data: emailExists } = await supabase.from('profiles').select('id').eq('email', normalizedEmail).maybeSingle();
      if (emailExists) {
        logAuthDiagnostic('handleSignUpSubmit', { message: 'Duplicate email registration attempt', email: normalizedEmail });
        return showError(usernameError, 'This email address is already registered.');
      }

      const { data: usernameExists } = await supabase.from('profiles').select('id').eq('username', normalizedUsername).maybeSingle();
      if (usernameExists) {
        logAuthDiagnostic('handleSignUpSubmit', { message: 'Duplicate username registration attempt', username: normalizedUsername });
        return showError(usernameError, 'This username is already taken.');
      }

      // Dispatch 6-digit verification code OTP via HI-HUBBLE backend SMTP endpoint
      const res = await fetch('/api/auth/signup-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName,
          email: normalizedEmail,
          username: normalizedUsername,
          password,
          phoneNumber: phone
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to send verification code.');
      }

      signedUpUser = {
        email: normalizedEmail,
        fullName,
        username: normalizedUsername,
        password,
        phoneNumber: phone || null
      };

      // Smoothly transition card to 6-digit OTP verification step UI
      if (step1) step1.style.display = 'none';
      if (stepLogin) stepLogin.style.display = 'none';
      if (stepOtp) stepOtp.style.display = 'flex';

      if (inlineOtpInstruction) {
        inlineOtpInstruction.textContent = `Please enter the 6-digit code sent to ${normalizedEmail}.`;
      }

      clearOtpInputs();
      startOtpTimer(25);
    } catch (err) {
      logAuthDiagnostic('handleSignUpSubmit Exception', { message: err.message });
      showError(usernameError, err.message || 'Failed to send verification code. Please try again.');
    } finally {
      if (gotoCameraBtn) {
        gotoCameraBtn.disabled = false;
        gotoCameraBtn.innerHTML = '<i data-lucide="send"></i> Send Verification Code (OTP)';
        if (window.debouncedCreateIcons) window.debouncedCreateIcons();
      }
    }
  }

  if (gotoCameraBtn) {
    gotoCameraBtn.addEventListener('click', (e) => {
      e.preventDefault();
      handleSignUpSubmit();
    });
  }

  if (btnBackToSignup) {
    btnBackToSignup.addEventListener('click', (e) => {
      e.preventDefault();
      if (stepOtp) stepOtp.style.display = 'none';
      if (step1) step1.style.display = 'flex';
    });
  }

  // =========================================================================
  // 2. VERIFY INLINE 6-DIGIT OTP CODE (Custom HI-HUBBLE Backend Verification)
  // =========================================================================
  if (btnVerifyOtpStep) {
    btnVerifyOtpStep.addEventListener('click', async (e) => {
      e.preventDefault();
      hideError(inlineOtpErrorMsg);

      const targetEmail = signedUpUser?.email || (emailInput ? emailInput.value.trim().toLowerCase() : '');
      if (!targetEmail) {
        return showError(inlineOtpErrorMsg, 'Session expired. Please return to Sign Up.');
      }

      btnVerifyOtpStep.disabled = true;
      btnVerifyOtpStep.innerHTML = '<i data-lucide="loader" class="spin"></i> Verifying...';
      if (window.debouncedCreateIcons) window.debouncedCreateIcons();

      try {
        const otpCode = getEnteredOtpCode();
        if (!otpCode || otpCode.length !== 6) {
          return showError(inlineOtpErrorMsg, 'Please enter the complete 6-digit verification code.');
        }

        logAuthDiagnostic('btnVerifyOtpStep Click', { targetEmail });

        // Verify 6-digit OTP code via HI-HUBBLE backend endpoint
        const res = await fetch('/api/auth/verify-action-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: targetEmail,
            otp: otpCode
          })
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Invalid or expired verification code.');
        }

        if (data.user) {
          signedUpUser = {
            id: data.user.id,
            username: data.user.username,
            email: data.user.email,
            fullName: data.user.fullName || data.user.full_name || data.user.username,
            profileImage: data.user.profile_image_url || null
          };
          localStorage.setItem('invibeUser', JSON.stringify(signedUpUser));
        }

        if (data.token) {
          localStorage.setItem('invibe_jwt_token', data.token);
        }

        logAuthDiagnostic('btnVerifyOtpStep Success', { userId: signedUpUser?.id });

        // Transition card from Inline OTP Step to Step 3: Webcam Live Photo
        if (stepOtp) stepOtp.style.display = 'none';
        if (step1) step1.style.display = 'none';
        if (stepLogin) stepLogin.style.display = 'none';
        if (step2) step2.style.display = 'flex';

        startWebcam();
      } catch (err) {
        logAuthDiagnostic('btnVerifyOtpStep Exception', { message: err.message });
        showError(inlineOtpErrorMsg, err.message);
      } finally {
        if (btnVerifyOtpStep) {
          btnVerifyOtpStep.disabled = false;
          btnVerifyOtpStep.innerHTML = '<i data-lucide="check-circle"></i> Verify Code & Continue';
          if (window.debouncedCreateIcons) window.debouncedCreateIcons();
        }
      }
    });
  }

  if (inlineResendOtpLink) {
    inlineResendOtpLink.addEventListener('click', async (e) => {
      e.preventDefault();
      if (isResendCooldown) return;

      const targetEmail = signedUpUser?.email || (emailInput ? emailInput.value.trim().toLowerCase() : '');
      if (!targetEmail) return;

      try {
        const res = await fetch('/api/auth/signup-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fullName: signedUpUser?.fullName || 'User',
            email: targetEmail,
            username: signedUpUser?.username || targetEmail.split('@')[0],
            password: signedUpUser?.password || 'default_pass',
            phoneNumber: signedUpUser?.phoneNumber || null
          })
        });

        const data = await res.json();
        if (!res.ok) {
          showError(inlineOtpErrorMsg, data.error || 'Failed to resend code.');
        } else {
          startOtpTimer(25);
        }
      } catch (err) {
        showError(inlineOtpErrorMsg, err.message);
      }
    });
  }

  // =========================================================================
  // 3. LOGIN FLOW (Direct Supabase Auth + Profiles Table Verification)
  // =========================================================================
  async function handleLoginSubmit() {
    const input = loginUsernameInput ? loginUsernameInput.value.trim() : '';
    const password = loginPasswordInput ? loginPasswordInput.value : '';

    if (!input) return showError(loginErrorMsg, 'Please enter your username or email.');
    if (!password) return showError(loginErrorMsg, 'Please enter your password.');

    hideError(loginErrorMsg);

    if (btnLoginSubmit) {
      btnLoginSubmit.disabled = true;
      btnLoginSubmit.innerHTML = '<i data-lucide="loader" class="spin"></i> Verifying...';
      if (window.debouncedCreateIcons) window.debouncedCreateIcons();
    }

    try {
      const normalizedInput = input.toLowerCase();

      // Find user profile in public.profiles table by username or email
      const { data: userProfile, error: profileFetchErr } = await supabase.from('profiles')
        .select('*')
        .or(`username.eq.${normalizedInput},email.eq.${normalizedInput}`)
        .maybeSingle();

      if (profileFetchErr) {
        logAuthDiagnostic('handleLoginSubmit profileFetch', { message: profileFetchErr.message, code: profileFetchErr.code });
      }

      let authenticatedUser = null;
      let jwtToken = null;

      // 1. Try official Supabase Auth signInWithPassword if target email is available
      const targetEmail = userProfile?.email || (normalizedInput.includes('@') ? normalizedInput : null);
      if (targetEmail) {
        try {
          const { data: authSignInRes, error: authSignInErr } = await supabase.auth.signInWithPassword({
            email: targetEmail,
            password: password
          });

          if (!authSignInErr && authSignInRes?.user) {
            jwtToken = authSignInRes.session?.access_token || null;
            authenticatedUser = {
              id: authSignInRes.user.id,
              username: userProfile?.username || authSignInRes.user.user_metadata?.username || targetEmail.split('@')[0],
              email: targetEmail,
              fullName: userProfile?.full_name || authSignInRes.user.user_metadata?.full_name || 'User',
              profileImage: userProfile?.profile_image_url || null
            };
          } else if (authSignInErr) {
            logAuthDiagnostic('supabase.auth.signInWithPassword Notice', { message: authSignInErr.message, status: authSignInErr.status });
          }
        } catch (sbErr) {
          logAuthDiagnostic('supabase.auth.signInWithPassword Exception', { message: sbErr.message });
        }
      }

      // 2. Fallback to bcrypt verification against public.profiles table
      if (!authenticatedUser && userProfile && userProfile.password_hash) {
        const passwordMatches = await bcrypt.compare(password, userProfile.password_hash);
        if (passwordMatches) {
          authenticatedUser = {
            id: userProfile.id,
            username: userProfile.username,
            email: userProfile.email,
            fullName: userProfile.full_name || userProfile.username,
            phoneNumber: userProfile.phone_number || null,
            profileImage: userProfile.profile_image_url || null
          };
        }
      }

      if (!authenticatedUser) {
        logAuthDiagnostic('handleLoginSubmit Failed', { input: normalizedInput });
        return showError(loginErrorMsg, 'Invalid username/email or password.');
      }

      // Update online status in Supabase profiles
      try {
        await supabase.from('profiles').update({
          is_online: true,
          last_active_at: new Date().toISOString()
        }).eq('id', authenticatedUser.id);
      } catch (_) {}

      // Store authenticated user session
      localStorage.setItem('invibeUser', JSON.stringify(authenticatedUser));
      if (authenticatedUser.profileImage) {
        localStorage.setItem('invibeProfileImage', authenticatedUser.profileImage);
      }
      localStorage.setItem('invibeIsLoggedIn', 'true');
      if (jwtToken) {
        localStorage.setItem('invibe_jwt_token', jwtToken);
      } else if (authenticatedUser?.id) {
        localStorage.setItem('invibe_jwt_token', authenticatedUser.id);
      }

      showAppView();
    } catch (err) {
      logAuthDiagnostic('handleLoginSubmit Unexpected Exception', { message: err.message });
      showError(loginErrorMsg, err.message || 'Invalid username or password.');
    } finally {
      if (btnLoginSubmit) {
        btnLoginSubmit.disabled = false;
        btnLoginSubmit.innerHTML = '<i data-lucide="log-in"></i> Login to Hi-Hubble';
        if (window.debouncedCreateIcons) window.debouncedCreateIcons();
      }
    }
  }

  if (btnLoginSubmit) {
    btnLoginSubmit.addEventListener('click', (e) => {
      e.preventDefault();
      handleLoginSubmit();
    });
  }

  if (loginPasswordInput) {
    loginPasswordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleLoginSubmit();
      }
    });
  }

  // =========================================================================
  // 4. WEBCAM LIVE PHOTO & FINISH ONBOARDING
  // =========================================================================
  if (snapPhotoBtn) {
    snapPhotoBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!videoElem || !videoElem.videoWidth) {
        if (webcamStatusMsg) webcamStatusMsg.textContent = 'Waiting for camera feed...';
        return;
      }
      if (canvasElem) {
        canvasElem.width = videoElem.videoWidth;
        canvasElem.height = videoElem.videoHeight;
        const ctx = canvasElem.getContext('2d');
        ctx.drawImage(videoElem, 0, 0, canvasElem.width, canvasElem.height);
        capturedBase64 = canvasElem.toDataURL('image/jpeg', 0.88);
      }

      if (photoPreviewElem) {
        photoPreviewElem.src = capturedBase64;
        photoPreviewElem.style.display = 'block';
      }
      if (videoElem) videoElem.style.display = 'none';

      if (snapPhotoBtn) snapPhotoBtn.style.display = 'none';
      if (retakePhotoBtn) retakePhotoBtn.style.display = 'inline-flex';
      if (finishOnboardBtn) finishOnboardBtn.style.display = 'inline-flex';
      if (webcamStatusMsg) webcamStatusMsg.textContent = 'Great live photograph! Click "Enter Hi-Hubble" to proceed.';
    });
  }

  if (retakePhotoBtn) {
    retakePhotoBtn.addEventListener('click', (e) => {
      e.preventDefault();
      capturedBase64 = null;
      startWebcam();
    });
  }

  if (finishOnboardBtn) {
    finishOnboardBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      finishOnboardBtn.disabled = true;
      finishOnboardBtn.innerHTML = '<i data-lucide="loader" class="spin"></i> Completing Setup...';
      if (window.debouncedCreateIcons) window.debouncedCreateIcons();

      const userObj = signedUpUser || {
        id: 'usr_' + Date.now(),
        username: usernameInput?.value.trim() || emailInput?.value.trim().split('@')[0] || 'user',
        email: emailInput?.value.trim() || 'user@hihubble.com',
        fullName: fullNameInput?.value.trim() || usernameInput?.value.trim() || 'User'
      };

      try {
        let profileImageUrl = capturedBase64;

        if (capturedBase64 && capturedBase64.startsWith('data:image')) {
          try {
            const matches = capturedBase64.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
              const ext = matches[1];
              const base64Data = matches[2];
              const buffer = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
              const filename = `${userObj.id}/live_photo_${Date.now()}.${ext}`;

              const { error: uploadErr } = await supabase.storage
                .from('profile-images')
                .upload(filename, buffer, { contentType: `image/${ext}`, upsert: true });

              if (!uploadErr) {
                const { data: publicUrlData } = supabase.storage.from('profile-images').getPublicUrl(filename);
                if (publicUrlData?.publicUrl) profileImageUrl = publicUrlData.publicUrl;
              }
            }
          } catch (stgErr) {
            logAuthDiagnostic('Storage Upload Note', { message: stgErr.message });
          }
        }

        if (profileImageUrl) {
          userObj.profileImage = profileImageUrl;
          localStorage.setItem('invibeProfileImage', profileImageUrl);

          await supabase.from('profiles').update({
            profile_image_url: profileImageUrl,
            updated_at: new Date().toISOString()
          }).eq('id', userObj.id);
        }
      } catch (err) {
        logAuthDiagnostic('finishOnboard Exception', { message: err.message });
        if (capturedBase64) localStorage.setItem('invibeProfileImage', capturedBase64);
      } finally {
        localStorage.setItem('invibeUser', JSON.stringify(userObj));
        localStorage.setItem('invibeIsLoggedIn', 'true');
        showAppView();
      }
    });
  }
}

// Helpers for Error Messaging
function showError(elem, message) {
  if (elem) {
    elem.textContent = message;
    elem.style.display = 'block';
  }
}

function hideError(elem) {
  if (elem) {
    elem.textContent = '';
    elem.style.display = 'none';
  }
}

/**
 * Global Logout Handler
 */
export function handleLogout() {
  const token = localStorage.getItem('invibe_jwt_token');
  if (token) {
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify({})], { type: 'application/json' });
        navigator.sendBeacon(`/api/users/logout-presence?token=${encodeURIComponent(token)}`, blob);
      }
      fetch('/api/users/logout-presence', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        keepalive: true
      }).catch(() => {});
    } catch (_) {}
  }

  localStorage.removeItem('invibeUser');
  localStorage.removeItem('invibeProfileImage');
  localStorage.removeItem('invibeIsLoggedIn');
  localStorage.removeItem('invibe_jwt_token');

  try {
    supabase.auth.signOut().catch(() => {});
  } catch (_) {}

  // Stop active media tracks if open
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      navigator.mediaDevices.getUserMedia({ video: true }).then(stream => {
        stream.getTracks().forEach(t => t.stop());
      }).catch(() => {});
    } catch (_) {}
  }

  window.location.reload();
}

// ─── UPDATE APP UI WITH LOGGED-IN USER DATA ──────────────────────────────────
export function updateAppUI() {
  const userStr = localStorage.getItem('invibeUser');
  const profileImage = localStorage.getItem('invibeProfileImage');

  if (!userStr) return;

  let user;
  try { user = JSON.parse(userStr); } catch { return; }

  // Header avatar
  const headerAvatar = document.querySelector('#header-profile-avatar img');
  if (headerAvatar && profileImage) headerAvatar.src = profileImage;

  // Sidebar preview card
  const sidebarAvatar = document.querySelector('.profile-preview-avatar img');
  if (sidebarAvatar && profileImage) sidebarAvatar.src = profileImage;
  const sidebarName = document.querySelector('.profile-preview-info h3');
  if (sidebarName && user.fullName) sidebarName.textContent = user.fullName;
  const sidebarUsername = document.querySelector('.profile-preview-info p');
  if (sidebarUsername && user.username) sidebarUsername.textContent = '@' + user.username;

  // Create post card avatar
  const createPostAvatar = document.getElementById('create-post-user-avatar');
  if (createPostAvatar && profileImage) createPostAvatar.src = profileImage;

  // Stories "Your Vibe" avatar
  const storyAvatar = document.querySelector('.story-card.current-user .story-avatar-container img') || document.querySelector('#story-btn-current img');
  if (storyAvatar && profileImage) storyAvatar.src = profileImage;

  // My Profile view (middle panel)
  const myProfileAvatar = document.querySelector('.profile-screen-avatar');
  if (myProfileAvatar && profileImage) myProfileAvatar.src = profileImage;
  const myProfileName = document.querySelector('.profile-summary-top h3');
  if (myProfileName && user.fullName) {
    myProfileName.innerHTML = user.fullName;
    if (window.debouncedCreateIcons) window.debouncedCreateIcons(); else if (window.lucide) window.lucide.createIcons();
  }
  const myProfileUsername = document.querySelector('.profile-screen-handle');
  if (myProfileUsername && user.username) myProfileUsername.textContent = '@' + user.username;

  // Synchronize all live feed post author avatars and comments for current user
  const userId = (user.id || user._id || '').toString();
  const currentUsername = (user.username || '').toLowerCase();
  if (profileImage) {
    document.querySelectorAll('#home-feed-posts .feed-card').forEach(card => {
      const avatarEl = card.querySelector('.author-avatar');
      const authorId = avatarEl?.getAttribute('data-user-id') || '';
      const handleEl = card.querySelector('.author-handle');
      const handleText = handleEl?.textContent?.replace('@', '').trim().toLowerCase() || '';

      if (avatarEl && ((userId && authorId === userId) || (currentUsername && handleText === currentUsername))) {
        avatarEl.src = profileImage;
      }
    });

    document.querySelectorAll('.comment-author-avatar').forEach(img => {
      const cAuthorId = img.getAttribute('data-user-id') || '';
      if (userId && cAuthorId === userId) {
        img.src = profileImage;
      }
    });
  }

  // Query backend for exact profile & follower/following counts
  const userFollowersEl = document.getElementById('user-followers-count');
  const userFollowingEl = document.getElementById('user-following-count');

  if (userId) {
    supabase.from('profiles').select('follower_count, following_count, post_count, full_name, username').eq('id', userId).maybeSingle()
      .then(({ data: u }) => {
        if (u) {
          if (userFollowersEl) userFollowersEl.textContent = u.follower_count || 0;
          if (userFollowingEl) userFollowingEl.textContent = u.following_count || 0;

          const profileHubbersEl = document.querySelector('#view-profile [data-stat="followers"] .stat-val') || document.querySelector('#profile-followers-count');
          const profileHubbiesEl = document.querySelector('#view-profile [data-stat="following"] .stat-val') || document.querySelector('#profile-following-count');
          const profilePostsEl = document.querySelector('#view-profile [data-stat="posts"] .stat-val') || document.querySelector('#profile-posts-count');

          if (profileHubbersEl) profileHubbersEl.textContent = u.follower_count || 0;
          if (profileHubbiesEl) profileHubbiesEl.textContent = u.following_count || 0;
          if (profilePostsEl) profilePostsEl.textContent = u.post_count || 0;

          if (sidebarName && u.full_name) sidebarName.textContent = u.full_name;
          if (sidebarUsername && u.username) sidebarUsername.textContent = '@' + u.username;
        }
      })
      .catch(() => {});
  }

  // Dispatch event so downstream features initialize
  window.dispatchEvent(new CustomEvent('auth-changed'));
}
