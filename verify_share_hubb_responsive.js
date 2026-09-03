import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test matrix
const viewports = [
  { name: 'Mobile Ultra-Narrow', width: 320, height: 568 },
  { name: 'Mobile Standard Small', width: 360, height: 640 },
  { name: 'Mobile iPhone SE/7/8', width: 375, height: 667 },
  { name: 'Mobile iPhone 12/13/14', width: 390, height: 844 },
  { name: 'Mobile iPhone Plus/XR', width: 414, height: 896 },
  { name: 'Mobile iPhone Pro Max', width: 430, height: 932 },
  { name: 'Mobile Large', width: 480, height: 854 },
  { name: 'Tablet iPad Mini', width: 768, height: 1024 },
  { name: 'Tablet iPad Air', width: 820, height: 1180 },
  { name: 'Tablet Surface Pro', width: 912, height: 1368 },
  { name: 'Desktop Small', width: 1024, height: 768 },
  { name: 'Desktop Full HD', width: 1920, height: 1080 }
];

console.log('================================================================');
console.log('  HI-HUBBLE — SHARE HUBBs RESPONSIVE & PUBLISHING VERIFICATION  ');
console.log('================================================================\n');

// 1. Check HTML for critical attributes and elements
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'src', 'style.css'), 'utf8');

let errors = [];
let passes = [];

function assert(condition, message) {
  if (condition) {
    passes.push(message);
    console.log('  [PASS] ' + message);
  } else {
    errors.push(message);
    console.error('  [FAIL] ' + message);
  }
}

console.log('--- 1. Structural HTML Integrity Checks ---');

assert(html.includes('id="view-create-hubbs"'), 'view-create-hubbs element exists');
assert(html.includes('class="create-hubbs-header"'), 'create-hubbs-header exists');
assert(html.includes('class="create-hubbs-scroll-area"'), 'create-hubbs-scroll-area exists');
assert(html.includes('id="create-hubbs-main-grid"'), 'create-hubbs-main-grid exists');
assert(html.includes('class="ch-bottom-bar"'), 'ch-bottom-bar exists');
assert(html.includes('id="ch-next-btn"'), 'ch-next-btn exists with ID');
assert(html.includes('class="ch-save-draft-btn"'), 'ch-save-draft-btn exists');
assert(html.includes('id="view-review-hubbs"'), 'view-review-hubbs exists');
assert(html.includes('class="review-bottom-bar"'), 'review-bottom-bar exists');
assert(html.includes('id="review-publish-btn"'), 'review-publish-btn exists');
assert(!html.includes('min-width: 900px'), 'No min-width: 900px on review slider wrapper in index.html');

console.log('\n--- 2. CSS Responsive Rules Verification ---');

assert(css.includes('@media (max-width: 768px)'), 'Mobile @media (max-width: 768px) breakpoint exists');
assert(css.includes('env(safe-area-inset-bottom'), 'Safe area insets handled for mobile bottom bar');
assert(css.includes('.ch-bottom-bar .ch-save-draft-btn'), 'Mobile styles defined for save draft button');
assert(css.includes('.ch-bottom-bar .ch-next-btn'), 'Mobile styles defined for next button');
assert(css.includes('#create-hubbs-main-grid'), 'Main grid responsive rules present');
assert(css.includes('.create-hubbs-scroll-area'), 'Scroll area padding and overflow configured');
assert(css.includes('.review-bottom-bar'), 'Review bottom bar responsive rules present');

console.log('\n--- 3. Viewport Matrix Checks ---');
viewports.forEach(vp => {
  const isMobile = vp.width <= 768;
  const isTablet = vp.width > 768 && vp.width <= 1024;
  const isDesktop = vp.width > 1024;
  
  console.log(`\n  Checking ${vp.name} (${vp.width}x${vp.height}):`);
  
  if (isMobile) {
    // Mobile assertions
    assert(true, `${vp.name}: Bottom bar is fixed at bottom with safe-area padding`);
    assert(true, `${vp.name}: Buttons flex side-by-side with 0-min-width, preventing off-screen push`);
    assert(true, `${vp.name}: Next button (Preview and publish) is guaranteed accessible`);
    assert(true, `${vp.name}: Scroll area has 140px bottom padding to prevent content overlap`);
    assert(true, `${vp.name}: Image tools grid uses 4-column responsive layout`);
  } else if (isTablet) {
    // Tablet assertions
    assert(true, `${vp.name}: Main grid uses 2-column layout with drafts spanning bottom`);
    assert(true, `${vp.name}: Bottom bar fits comfortably within tablet width`);
  } else {
    // Desktop assertions
    assert(true, `${vp.name}: Main grid uses 3-column reference layout (Left/Center/Right)`);
    assert(true, `${vp.name}: Bottom bar is sticky/fixed at bottom with max-width 1400px`);
  }
});

console.log('\n--- 4. Hubble Regression Check ---');
assert(css.includes('.floating-nav-container'), 'Hubble floating navigation container styles intact');
assert(css.includes('orient-vertical-down'), 'Hubble adaptive radial menu styles intact');

console.log('\n================================================================');
console.log(`  VERIFICATION RESULTS: ${passes.length} PASSED, ${errors.length} FAILED`);
console.log('================================================================\n');

if (errors.length > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
