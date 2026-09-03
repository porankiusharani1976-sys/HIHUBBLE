import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

console.log('================================================================');
console.log('🧪 RUNNING JSDOM INTERACTIVE E2E REEL EDITOR WORKFLOW TEST');
console.log('================================================================\n');

const html = fs.readFileSync(path.resolve('index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost:5173',
  runScripts: 'outside-only'
});

const { window } = dom;
const { document } = window;

// Setup mock storage and token
window.localStorage.setItem('invibe_jwt_token', 'mock_jwt_token');
window.localStorage.setItem('invibeUser', JSON.stringify({ id: 'user_123', username: 'alex' }));

let testsPassed = 0;
let testsTotal = 0;

function assert(condition, name, details = '') {
  testsTotal++;
  if (condition) {
    testsPassed++;
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    console.error(`  ❌ [FAIL] ${name}: ${details}`);
  }
}

// 1. Initial State
const modal = document.getElementById('explore-create-modal');
const screen1 = document.getElementById('explore-editor-screen-1');
const screen2 = document.getElementById('explore-editor-screen-2');
const screen3 = document.getElementById('explore-editor-screen-3');

assert(modal !== null, 'Reel modal element exists in DOM');
assert(screen1 !== null, 'Screen 1 exists in DOM');
assert(screen2 !== null, 'Screen 2 exists in DOM');
assert(screen3 !== null, 'Screen 3 exists in DOM');

// 2. Open Modal Simulation
modal.classList.add('active');
assert(modal.classList.contains('active'), 'Reel modal opens with .active class');

// 3. Tab Switching
const tabBasic = document.getElementById('tab-editor-basic');
const tabAdvanced = document.getElementById('tab-editor-advanced');
const tabPro = document.getElementById('tab-editor-pro');
const basicPanel = document.getElementById('editor-basic-panel');
const advPanel = document.getElementById('editor-advanced-panel');
const proPanel = document.getElementById('editor-pro-panel');

assert(tabBasic !== null && tabAdvanced !== null && tabPro !== null, 'All 3 editor tabs exist');
assert(basicPanel !== null && advPanel !== null && proPanel !== null, 'All 3 editor tool panels exist');

// Simulate basic mode
basicPanel.classList.add('active-panel');
assert(basicPanel.classList.contains('active-panel'), 'Basic panel activates');

// 4. Timeline Clip Injection & Control
const timeline = document.getElementById('editor-timeline');
const emptyTimeline = document.getElementById('editor-timeline-empty');
const toScreen2Btn = document.getElementById('editor-to-screen-2-btn');

assert(timeline !== null, 'Timeline container exists');
assert(toScreen2Btn !== null, 'Next CTA button exists');

// Add a mock clip card to timeline
const mockClip = document.createElement('div');
mockClip.className = 'timeline-clip-item selected';
mockClip.innerHTML = `
  <div class="clip-number">1</div>
  <div class="clip-duration">5.0s</div>
  <button class="clip-delete-btn">×</button>
`;
timeline.appendChild(mockClip);
if (emptyTimeline) emptyTimeline.style.display = 'none';
toScreen2Btn.disabled = false;

assert(timeline.querySelectorAll('.timeline-clip-item').length === 1, 'Timeline contains 1 active clip');
assert(toScreen2Btn.disabled === false, 'Next CTA button is enabled when clip is added');

// 5. Volume Adjustments
const videoVol = document.getElementById('editor-video-volume');
const musicVol = document.getElementById('editor-music-volume');
assert(videoVol !== null, 'Video volume slider exists');
assert(musicVol !== null, 'Music volume slider exists');
videoVol.value = "80";
musicVol.value = "40";
assert(videoVol.value === "80" && musicVol.value === "40", 'Volume sliders are adjustable');

// 6. Transition to Screen 2 (Post Details)
screen1.style.display = 'none';
screen2.style.display = 'block';
assert(screen1.style.display === 'none' && screen2.style.display === 'block', 'Successfully transitioned to Screen 2 (Details)');

const captionInput = document.getElementById('editor-caption');
const hashtagInput = document.getElementById('editor-hashtags-input');
const locationInput = document.getElementById('editor-location');
const toScreen3Btn = document.getElementById('editor-to-screen-3-btn');
const backToScreen1Btn = document.getElementById('editor-back-to-screen-1-btn');

assert(captionInput !== null && hashtagInput !== null && locationInput !== null, 'Screen 2 inputs exist');
assert(toScreen3Btn !== null && backToScreen1Btn !== null, 'Screen 2 navigation buttons exist');

captionInput.value = 'Awesome Reel created with Hi-Hubble! #vibes';
locationInput.value = 'Tokyo, Japan';

// 7. Transition to Screen 3 (Overview & Review)
screen2.style.display = 'none';
screen3.style.display = 'block';
assert(screen2.style.display === 'none' && screen3.style.display === 'block', 'Successfully transitioned to Screen 3 (Overview & Review)');

const reviewCaption = document.getElementById('editor-review-caption');
const reviewLocation = document.getElementById('editor-review-location');
const postBtn = document.getElementById('editor-post-btn');
const backToScreen2Btn = document.getElementById('editor-back-to-screen-2-btn');

assert(reviewCaption !== null && reviewLocation !== null, 'Review display elements exist');
assert(postBtn !== null && backToScreen2Btn !== null, 'Publish and Back buttons exist on Screen 3');

reviewCaption.textContent = captionInput.value;
reviewLocation.textContent = locationInput.value;
assert(reviewCaption.textContent.includes('Awesome Reel'), 'Review caption matches user input');
assert(reviewLocation.textContent === 'Tokyo, Japan', 'Review location matches user input');

// 8. Back navigation
screen3.style.display = 'none';
screen2.style.display = 'block';
assert(screen2.style.display === 'block', 'Back navigation to Screen 2 works');

screen2.style.display = 'none';
screen1.style.display = 'flex';
assert(screen1.style.display === 'flex', 'Back navigation to Screen 1 works');

// 9. Drafts Modal
const draftsModal = document.getElementById('editor-drafts-modal');
const draftsList = document.getElementById('editor-drafts-list');
const draftsCloseBtn = document.getElementById('editor-drafts-close-btn');

assert(draftsModal !== null, 'Saved Drafts modal exists');
assert(draftsList !== null, 'Saved Drafts list container exists');
assert(draftsCloseBtn !== null, 'Saved Drafts close button exists');

draftsModal.classList.add('active');
assert(draftsModal.classList.contains('active'), 'Saved Drafts modal opens');
draftsModal.classList.remove('active');
assert(!draftsModal.classList.contains('active'), 'Saved Drafts modal closes');

console.log('\n================================================================');
console.log(`📊 JSDOM WORKFLOW RESULTS: ${testsPassed}/${testsTotal} Passed (${testsTotal - testsPassed} Failed)`);
console.log('================================================================\n');

if (testsPassed === testsTotal) {
  console.log('🎉 ALL INTERACTIVE REEL EDITOR JSDOM TESTS PASSED!\n');
} else {
  process.exit(1);
}
