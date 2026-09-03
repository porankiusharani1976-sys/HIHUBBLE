import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

console.log('================================================================');
console.log('🧪 RUNNING MULTI-MEDIA TIMELINE & INDEPENDENT SELECTION TEST SUITE');
console.log('================================================================\n');

const html = fs.readFileSync(path.resolve('index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost:5173',
  runScripts: 'dangerously'
});

const { window } = dom;
const { document } = window;

// Polyfill window / storage / canvas / pointer events
window.localStorage.setItem('invibe_jwt_token', 'mock_jwt_token');
window.localStorage.setItem('invibeUser', JSON.stringify({ id: 'user_123', username: 'alex' }));
window.HTMLCanvasElement.prototype.getContext = () => ({
  drawImage: () => {},
  clearRect: () => {},
  fillRect: () => {},
  strokeRect: () => {},
  fillText: () => {},
  strokeText: () => {},
  measureText: () => ({ width: 100 }),
  beginPath: () => {},
  closePath: () => {},
  arc: () => {},
  fill: () => {},
  stroke: () => {},
  save: () => {},
  restore: () => {},
  translate: () => {},
  rotate: () => {},
  scale: () => {},
  filter: 'none',
  font: '',
  fillStyle: '',
  strokeStyle: '',
  textAlign: '',
  textBaseline: ''
});

window.Image = class MockImage {
  constructor() {
    this.complete = true;
    this._src = '';
  }
  set src(val) {
    this._src = val;
    this.complete = true;
    if (typeof this.onload === 'function') {
      setTimeout(() => this.onload(), 0);
    }
  }
  get src() {
    return this._src;
  }
};

let testsPassed = 0;
let testsTotal = 0;

function assert(condition, message) {
  testsTotal++;
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    testsPassed++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
  }
}

// Mock URL.createObjectURL and URL.revokeObjectURL
let blobCounter = 0;
window.URL.createObjectURL = (blob) => `blob:mock-url-${++blobCounter}`;
window.URL.revokeObjectURL = () => {};

// Load controller code
const controllerCode = fs.readFileSync(path.resolve('src/video_editor_controller.js'), 'utf8');
const sanitizedCode = controllerCode
  .replace(/import\s+{[^}]+}\s+from\s+['"]mediabunny['"];?/g, '// mocked mediabunny')
  .replace(/import\s+{[^}]+}\s+from\s+['"][^'"]+['"];?/g, '// mocked imports')
  .replace('export function initVideoEditor', 'window.initVideoEditor = function');

// Run controller in dom window context
dom.window.eval(sanitizedCode);

assert(typeof window.initVideoEditor === 'function', 'initVideoEditor is successfully initialized in DOM');

// Initialize video editor
window.initVideoEditor('http://localhost:5173', (msg) => console.log('Toast:', msg));

const modal = document.getElementById('explore-create-modal');
const screen1 = document.getElementById('explore-editor-screen-1');
const timelineContainer = document.getElementById('editor-timeline');
const clipCountDisplay = document.getElementById('editor-clip-count');
const fileInput = document.getElementById('editor-file-input');

assert(modal !== null, 'Modal exists');
assert(screen1 !== null, 'Screen 1 exists');
assert(timelineContainer !== null, 'Timeline container exists');
assert(fileInput !== null, 'File input exists');

// --- SIMULATE SELECTING 5 IMAGE MEDIA ITEMS (Images A, B, C, D, E) ---
console.log('\n--- TEST SCENARIO: User selects 5 images (Image A, B, C, D, E) ---');

const mockFiles = [
  { name: 'photo_A.jpg', type: 'image/jpeg', size: 102400 },
  { name: 'photo_B.png', type: 'image/png', size: 204800 },
  { name: 'photo_C.webp', type: 'image/webp', size: 153600 },
  { name: 'photo_D.jpg', type: 'image/jpeg', size: 128000 },
  { name: 'photo_E.png', type: 'image/png', size: 307200 }
];

// Trigger change event with 5 files
const fileList = mockFiles.map(f => {
  const blob = new window.Blob(['mock image content'], { type: f.type });
  blob.name = f.name;
  return blob;
});

// Dispatch change event to file input
Object.defineProperty(fileInput, 'files', {
  value: fileList,
  writable: true
});
fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));

// Wait for async image onload processing
setTimeout(() => {
  console.log('\n--- 1. CLIP DATA MODEL & DOM VALIDATION ---');

  const tracksContainer = document.getElementById('editor-tracks-container');
  assert(tracksContainer !== null, 'Tracks container #editor-tracks-container rendered');

  const renderedClips = tracksContainer ? tracksContainer.querySelectorAll('.timeline-clip-item') : [];
  assert(renderedClips.length === 5, `Timeline contains exactly 5 independent clip elements (found: ${renderedClips.length})`);
  assert(clipCountDisplay.innerText.includes('5 clips'), `Clip count header displays "5 clips" (found: "${clipCountDisplay.innerText}")`);

  // Check unique IDs and distinct names/badges
  const clipIds = [];
  renderedClips.forEach((item, index) => {
    const id = item.getAttribute('data-clip-id') || item.getAttribute('data-clip-index');
    clipIds.push(id);
    const numBadge = item.querySelector('.clip-number');
    const dur = item.querySelector('.timeline-clip-duration');
    const thumb = item.querySelector('img, video');

    assert(numBadge && numBadge.innerText === `#${index + 1}`, `Clip #${index + 1} has correct index badge #${index + 1}`);
    assert(dur && dur.innerText === '3.0s', `Clip #${index + 1} has independent 3.0s duration label`);
    assert(thumb && thumb.src.startsWith('blob:'), `Clip #${index + 1} has its own individual thumbnail element (${thumb?.src})`);
  });

  const uniqueIds = new Set(clipIds);
  assert(uniqueIds.size === 5, `All 5 clips have guaranteed unique IDs (${uniqueIds.size}/5 unique)`);

  console.log('\n--- 2. INDEPENDENT SELECTION VALIDATION ---');
  // Initially Clip 1 (index 0) should be selected
  assert(renderedClips[0].classList.contains('selected'), 'Clip 1 is initially selected (.selected class)');
  assert(!renderedClips[1].classList.contains('selected'), 'Clip 2 is NOT selected');
  assert(!renderedClips[2].classList.contains('selected'), 'Clip 3 is NOT selected');
  assert(!renderedClips[3].classList.contains('selected'), 'Clip 4 is NOT selected');
  assert(!renderedClips[4].classList.contains('selected'), 'Clip 5 is NOT selected');

  // Tap Clip 3 (index 2)
  console.log('-> User taps Clip 3');
  timelineContainer.querySelectorAll('.timeline-clip-item')[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  let currentClips = timelineContainer.querySelectorAll('.timeline-clip-item');
  assert(currentClips[2].classList.contains('selected'), 'Clip 3 is now selected');
  assert(!currentClips[0].classList.contains('selected'), 'Clip 1 is now unselected');
  assert(!currentClips[1].classList.contains('selected'), 'Clip 2 is unselected');
  assert(!currentClips[3].classList.contains('selected'), 'Clip 4 is unselected');
  assert(!currentClips[4].classList.contains('selected'), 'Clip 5 is unselected');

  // Tap Clip 5 (index 4)
  console.log('-> User taps Clip 5');
  currentClips[4].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  currentClips = timelineContainer.querySelectorAll('.timeline-clip-item');
  assert(currentClips[4].classList.contains('selected'), 'Clip 5 is now selected');
  assert(!currentClips[2].classList.contains('selected'), 'Clip 3 is now unselected');
  assert(!currentClips[0].classList.contains('selected'), 'Clip 1 is unselected');

  console.log('\n--- 3. INDEPENDENT TRIM STATE VALIDATION ---');
  // Trim Clip 5 (change startTrim to 1.0)
  const trimStart = document.getElementById('editor-trim-start');
  trimStart.value = '1.0';
  trimStart.dispatchEvent(new window.Event('change', { bubbles: true }));

  currentClips = timelineContainer.querySelectorAll('.timeline-clip-item');
  const clip5Duration = currentClips[4].querySelector('.timeline-clip-duration');
  assert(clip5Duration && clip5Duration.innerText === '2.0s', 'Clip 5 duration updated to 2.0s');

  // Verify other clips retain original 3.0s duration
  const clip1Duration = currentClips[0].querySelector('.timeline-clip-duration');
  const clip2Duration = currentClips[1].querySelector('.timeline-clip-duration');
  const clip3Duration = currentClips[2].querySelector('.timeline-clip-duration');
  const clip4Duration = currentClips[3].querySelector('.timeline-clip-duration');
  assert(clip1Duration.innerText === '3.0s', 'Clip 1 duration unaffected (3.0s)');
  assert(clip2Duration.innerText === '3.0s', 'Clip 2 duration unaffected (3.0s)');
  assert(clip3Duration.innerText === '3.0s', 'Clip 3 duration unaffected (3.0s)');
  assert(clip4Duration.innerText === '3.0s', 'Clip 4 duration unaffected (3.0s)');

  console.log('\n--- 4. PLAYHEAD & HORIZONTAL TIMELINE LAYOUT ---');
  const playhead = document.getElementById('editor-timeline-playhead');
  assert(playhead !== null, 'Playhead vertical marker exists');
  assert(playhead.style.width === '44px', 'Playhead has expanded touch hit area (44px)');

  const ruler = document.getElementById('editor-track-ruler');
  assert(ruler !== null, 'Ruler track exists');

  // Verify non-overlapping distinct left positions
  const leftPositions = Array.from(currentClips).map(c => parseInt(c.style.left || '0'));
  console.log('Clip horizontal left positions:', leftPositions);
  let positionsStrictlyIncreasing = true;
  for (let i = 1; i < leftPositions.length; i++) {
    if (leftPositions[i] <= leftPositions[i - 1]) {
      positionsStrictlyIncreasing = false;
    }
  }
  assert(positionsStrictlyIncreasing, 'All 5 clips have strictly increasing non-overlapping left positions');

  console.log('\n--- 5. CLIP REMOVAL & RE-INDEXING VALIDATION ---');
  // Remove Clip 2 (index 1)
  console.log('-> User clicks delete on Clip 2');
  const deleteBtnClip2 = currentClips[1].querySelector('.clip-delete-btn');
  deleteBtnClip2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  currentClips = timelineContainer.querySelectorAll('.timeline-clip-item');
  assert(currentClips.length === 4, `Remaining clips count is 4 (found: ${currentClips.length})`);
  assert(clipCountDisplay.innerText.includes('4 clips'), 'Clip count header updated to "4 clips"');

  // Verify re-indexing: badges are now #1, #2, #3, #4
  const newBadges = Array.from(currentClips).map(c => c.querySelector('.clip-number')?.innerText);
  assert(JSON.stringify(newBadges) === JSON.stringify(['#1', '#2', '#3', '#4']), `Clips successfully re-indexed: ${JSON.stringify(newBadges)}`);

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${testsPassed}/${testsTotal} Passed (${testsTotal - testsPassed} Failed)`);
  console.log('================================================================\n');

  if (testsPassed === testsTotal) {
    console.log('🎉 ALL MULTI-MEDIA TIMELINE & SELECTION TESTS PASSED!');
    process.exit(0);
  } else {
    console.error('❌ SOME TESTS FAILED');
    process.exit(1);
  }
}, 200);
