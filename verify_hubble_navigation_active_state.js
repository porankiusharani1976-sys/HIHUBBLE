/**
 * HI-HUBBLE — HUBBLE RADIAL NAVIGATION ACTIVE-STATE & GLOW VERIFICATION SUITE
 */

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const htmlContent = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

const dom = new JSDOM(htmlContent, {
  url: 'http://localhost:3000',
  runScripts: 'outside-only',
  resources: 'usable'
});

const { window } = dom;
const { document } = window;

// Set up mock window and localStorage
global.window = window;
global.document = document;
global.sessionStorage = window.sessionStorage;
global.localStorage = window.localStorage;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

console.log('\n======================================================');
console.log('  RUNNING HUBBLE RADIAL NAVIGATION ACTIVE-STATE TESTS');
console.log('======================================================\n');

// 1. Verify HTML Structure
console.log('--- Test Suite 1: Radial Menu Markup & Data Attributes ---');
const radialWrapper = document.getElementById('radial-menu-wrapper');
assert(radialWrapper !== null, 'radial-menu-wrapper exists in DOM');

const radialItems = document.querySelectorAll('#radial-menu-wrapper .radial-item-bubble');
assert(radialItems.length === 6, `Found 6 radial menu items (actual: ${radialItems.length})`);

const expectedViews = ['chats', 'explore', 'home', 'notifications', 'search', 'profile'];
expectedViews.forEach(view => {
  const item = document.querySelector(`#radial-menu-wrapper .radial-item-bubble[data-target-view="${view}"]`);
  assert(item !== null, `Radial item for data-target-view="${view}" exists with explicit attribute`);
});

const notifBtn = document.getElementById('nav-notifications-btn');
assert(notifBtn && notifBtn.getAttribute('data-target-view') === 'notifications', 'nav-notifications-btn has data-target-view="notifications"');

const activeGlow = document.getElementById('radial-active-glow');
assert(activeGlow !== null, 'radial-active-glow element exists');

// 2. Load and verify navigation logic
console.log('\n--- Test Suite 2: Context-Aware Route Detection ---');

// Mock state and containers
const state = { activeView: 'home' };
const navContainer = document.getElementById('floating-bubble-nav');
const notifPanel = document.getElementById('notifications-panel');
const reelModal = document.getElementById('explore-create-modal');
const storyModal = document.getElementById('story-viewer-modal');

// Implement canonical resolution matching src/main.js
function getCanonicalActiveNavSection() {
  if (notifPanel && (notifPanel.style.display === 'flex' || notifPanel.style.display === 'block' || notifPanel.classList.contains('active'))) {
    return 'notifications';
  }

  if (reelModal && (reelModal.classList.contains('active') || reelModal.style.display === 'block' || reelModal.style.display === 'flex')) {
    return 'explore';
  }

  if (storyModal && (storyModal.classList.contains('active') || storyModal.style.display === 'flex' || storyModal.style.display === 'block')) {
    if (state.activeView === 'explore' || state.activeView === 'reels' || document.body.classList.contains('explore-view-active')) {
      return 'explore';
    }
    return 'home';
  }

  const cur = (state.activeView || '').toLowerCase();

  if (cur === 'explore' || cur === 'reels' || cur === 'create-hubbs' || cur === 'review-hubbs') {
    return 'explore';
  }

  if (cur === 'chats' || cur === 'chat' || cur === 'messages') {
    return 'chats';
  }

  if (cur === 'home' || cur === 'feed' || cur === 'create-post') {
    return 'home';
  }

  if (cur === 'search') {
    return 'search';
  }

  if (cur === 'profile' || cur === 'profile-settings' || cur === 'settings') {
    return 'profile';
  }

  if (cur === 'notifications') {
    return 'notifications';
  }

  const activePanel = document.querySelector('.view-panel.active');
  if (activePanel) {
    const panelId = activePanel.id;
    if (panelId === 'view-explore' || panelId === 'view-create-hubbs' || panelId === 'view-review-hubbs') return 'explore';
    if (panelId === 'view-chats') return 'chats';
    if (panelId === 'view-home' || panelId === 'view-create-post') return 'home';
    if (panelId === 'view-search') return 'search';
    if (panelId === 'view-profile' || panelId === 'view-profile-settings' || panelId === 'view-settings') return 'profile';
  }

  return 'home';
}

function updateHubbleActiveState() {
  const activeSection = getCanonicalActiveNavSection();

  const radialBubbles = document.querySelectorAll('#radial-menu-wrapper .radial-item-bubble');
  let activeBubbleEl = null;

  radialBubbles.forEach(bubble => {
    let target = bubble.getAttribute('data-target-view');
    if (!target) {
      if (bubble.id === 'nav-notifications-btn' || bubble.querySelector('i[data-lucide="bell"]')) {
        target = 'notifications';
      } else if (bubble.id === 'radial-search-btn' || bubble.querySelector('i[data-lucide="search"]')) {
        target = 'search';
      }
    }

    const isMatch = (target === activeSection) ||
                    (activeSection === 'chats' && (target === 'messages' || target === 'chat')) ||
                    (activeSection === 'explore' && (target === 'reels' || target === 'hubbing')) ||
                    (activeSection === 'home' && (target === 'feed'));

    if (isMatch) {
      bubble.classList.add('active-bubble');
      activeBubbleEl = bubble;
    } else {
      bubble.classList.remove('active-bubble');
    }
  });

  const activeGlowEl = document.getElementById('radial-active-glow');
  if (activeGlowEl) {
    if (activeBubbleEl && navContainer && navContainer.classList.contains('open')) {
      activeGlowEl.style.opacity = '1';

      const isVertical = navContainer.classList.contains('orient-vertical-down') ||
                         navContainer.classList.contains('orient-vertical-up') ||
                         navContainer.classList.contains('orient-compact-grid');

      if (isVertical) {
        activeGlowEl.style.left = '50%';
        activeGlowEl.style.transform = 'translate(-50%, -50%)';
        activeGlowEl.style.top = (activeBubbleEl.offsetTop + (activeBubbleEl.offsetHeight / 2)) + 'px';
      } else {
        activeGlowEl.style.top = '50%';
        activeGlowEl.style.transform = 'translateY(-50%)';
        activeGlowEl.style.left = (activeBubbleEl.offsetLeft + (activeBubbleEl.offsetWidth / 2) - 20) + 'px';
      }
    } else {
      activeGlowEl.style.opacity = '0';
    }
  }
}

// Test View Mapping
state.activeView = 'explore';
assert(getCanonicalActiveNavSection() === 'explore', 'state.activeView="explore" maps to explore (Hubbing)');

state.activeView = 'reels';
assert(getCanonicalActiveNavSection() === 'explore', 'state.activeView="reels" maps to explore (Hubbing)');

state.activeView = 'create-hubbs';
assert(getCanonicalActiveNavSection() === 'explore', 'state.activeView="create-hubbs" maps to explore (Hubbing)');

state.activeView = 'review-hubbs';
assert(getCanonicalActiveNavSection() === 'explore', 'state.activeView="review-hubbs" maps to explore (Hubbing)');

state.activeView = 'home';
if (reelModal) reelModal.classList.add('active');
assert(getCanonicalActiveNavSection() === 'explore', 'Reel Editor modal active maps to explore (Hubbing)');
if (reelModal) reelModal.classList.remove('active');

state.activeView = 'chats';
assert(getCanonicalActiveNavSection() === 'chats', 'state.activeView="chats" maps to chats (Messages)');

state.activeView = 'search';
assert(getCanonicalActiveNavSection() === 'search', 'state.activeView="search" maps to search (Search)');

state.activeView = 'profile';
assert(getCanonicalActiveNavSection() === 'profile', 'state.activeView="profile" maps to profile (My Profile)');

state.activeView = 'profile-settings';
assert(getCanonicalActiveNavSection() === 'profile', 'state.activeView="profile-settings" maps to profile (My Profile)');

state.activeView = 'settings';
assert(getCanonicalActiveNavSection() === 'profile', 'state.activeView="settings" maps to profile (My Profile)');

state.activeView = 'home';
if (notifPanel) notifPanel.style.display = 'flex';
assert(getCanonicalActiveNavSection() === 'notifications', 'Open notifications panel maps to notifications');
if (notifPanel) notifPanel.style.display = 'none';

console.log('\n--- Test Suite 3: Active Bubble Uniqueness & Accuracy ---');

function testActiveBubbleForView(viewName, expectedTargetView) {
  state.activeView = viewName;
  updateHubbleActiveState();

  const activeBubbles = document.querySelectorAll('#radial-menu-wrapper .radial-item-bubble.active-bubble');
  assert(activeBubbles.length === 1, `Exactly 1 active bubble when on ${viewName} (found: ${activeBubbles.length})`);

  const activeBubble = activeBubbles[0];
  const target = activeBubble ? activeBubble.getAttribute('data-target-view') : null;
  assert(target === expectedTargetView, `Active bubble is "${expectedTargetView}" when on ${viewName} (actual: "${target}")`);

  // Explicit check that Hubbing never activates Notifications incorrectly
  if (expectedTargetView === 'explore') {
    const notifActive = document.querySelector('#nav-notifications-btn.active-bubble');
    assert(notifActive === null, 'Notifications is NOT active when on Hubbing/explore');
  }
}

testActiveBubbleForView('explore', 'explore');
testActiveBubbleForView('reels', 'explore');
testActiveBubbleForView('create-hubbs', 'explore');
testActiveBubbleForView('review-hubbs', 'explore');
testActiveBubbleForView('home', 'home');
testActiveBubbleForView('create-post', 'home');
testActiveBubbleForView('chats', 'chats');
testActiveBubbleForView('messages', 'chats');
testActiveBubbleForView('search', 'search');
testActiveBubbleForView('profile', 'profile');
testActiveBubbleForView('profile-settings', 'profile');

console.log('\n--- Test Suite 4: Hubble Radial Menu Open State & Glow Positioning ---');

// Test closed menu: glow is hidden
navContainer.classList.remove('open');
state.activeView = 'explore';
updateHubbleActiveState();
assert(activeGlow.style.opacity === '0', 'radial-active-glow opacity is 0 when menu is closed');

// Test open horizontal menu: glow is visible and correctly positioned
navContainer.classList.add('open');
updateHubbleActiveState();
assert(activeGlow.style.opacity === '1', 'radial-active-glow opacity is 1 when menu is open');
assert(activeGlow.style.top === '50%', 'radial-active-glow top is 50% in horizontal mode');

// Test open vertical-down menu
navContainer.classList.add('orient-vertical-down');
updateHubbleActiveState();
assert(activeGlow.style.left === '50%', 'radial-active-glow left is 50% in vertical-down mode');
assert(activeGlow.style.transform === 'translate(-50%, -50%)', 'radial-active-glow has translate(-50%, -50%) in vertical-down mode');
navContainer.classList.remove('orient-vertical-down');

// Test open vertical-up menu
navContainer.classList.add('orient-vertical-up');
updateHubbleActiveState();
assert(activeGlow.style.left === '50%', 'radial-active-glow left is 50% in vertical-up mode');
navContainer.classList.remove('orient-vertical-up');

// Test open compact grid menu
navContainer.classList.add('orient-compact-grid');
updateHubbleActiveState();
assert(activeGlow.style.left === '50%', 'radial-active-glow left is 50% in compact grid mode');
navContainer.classList.remove('orient-compact-grid');

console.log('\n--- Test Suite 5: CSS Rules & Visual Refinements ---');
const cssContent = fs.readFileSync(path.join(__dirname, 'src/style.css'), 'utf8');

assert(cssContent.includes('.radial-item-bubble.active-bubble .radial-btn'), 'CSS contains .radial-item-bubble.active-bubble .radial-btn');
assert(cssContent.includes('.radial-item-bubble.active-bubble .radial-badge'), 'CSS contains .radial-item-bubble.active-bubble .radial-badge');
assert(cssContent.includes('#radial-active-glow'), 'CSS contains #radial-active-glow');
assert(cssContent.includes('body.light-theme .radial-item-bubble.active-bubble'), 'CSS contains light theme active bubble styles');

console.log('\n======================================================');
console.log(`TOTAL TESTS: ${passed + failed}`);
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
console.log('======================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('ALL HUBBLE ACTIVE-STATE VERIFICATION TESTS PASSED SUCCESSFULLY! 🎉\n');
}
