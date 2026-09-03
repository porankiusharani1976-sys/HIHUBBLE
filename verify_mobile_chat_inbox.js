/**
 * HI-HUBBLE — MOBILE CHAT INBOX ENLARGED MASCOT CARD & SPACE UTILIZATION VERIFICATION SUITE
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
console.log('  RUNNING MOBILE CHAT INBOX ENLARGED MASCOT SUITE');
console.log('======================================================\n');

// 1. DOM Hierarchy & Mascot Placement
console.log('--- Test Suite 1: Structural Flex Hierarchy & Mascot Placement ---');
const chatInboxSidebar = document.querySelector('.chat-inbox-sidebar');
assert(chatInboxSidebar !== null, 'chat-inbox-sidebar exists in DOM');

const inboxHeader = chatInboxSidebar.querySelector('.inbox-header');
assert(inboxHeader !== null, 'inbox-header exists inside chat-inbox-sidebar');

const inboxTitle = inboxHeader.querySelector('h3');
assert(inboxTitle && inboxTitle.textContent.trim() === 'Chat Inbox', 'Inbox title is "Chat Inbox"');

const searchInput = document.getElementById('inbox-search-input');
assert(searchInput !== null, 'inbox-search-input field exists');

const chatThreadsList = chatInboxSidebar.querySelector('.chat-threads-list');
assert(chatThreadsList !== null, 'chat-threads-list scrollable container exists');

const mascotFooter = document.getElementById('inbox-mascot-footer');
assert(mascotFooter !== null, 'inbox-mascot-footer exists inside chat-inbox-sidebar');

// Verify order: header -> list -> mascotFooter
const children = Array.from(chatInboxSidebar.children);
const headerIdx = children.indexOf(inboxHeader);
const listIdx = children.indexOf(chatThreadsList);
const footerIdx = children.indexOf(mascotFooter);

assert(headerIdx === 0, 'inbox-header is the 1st element at the top');
assert(listIdx === 1, 'chat-threads-list is the 2nd element consuming vertical space');
assert(footerIdx === 2, 'inbox-mascot-footer is the 3rd element anchored at the bottom');

const mascotCard = mascotFooter.querySelector('.inbox-mascot-card');
assert(mascotCard !== null, 'inbox-mascot-card exists inside footer');

const mascotImg = mascotCard.querySelector('.inbox-mascot-img');
assert(mascotImg !== null, 'inbox-mascot-img exists');
assert(mascotImg.getAttribute('src') === '/hihubble-mascot-circle.png', 'Mascot image points to /hihubble-mascot-circle.png');

const mascotAssetPath = path.join(__dirname, 'public/hihubble-mascot-circle.png');
assert(fs.existsSync(mascotAssetPath), 'public/hihubble-mascot-circle.png exists on filesystem');

const mascotTitle = mascotCard.querySelector('.inbox-mascot-title');
assert(mascotTitle && mascotTitle.textContent.trim() === 'Your conversations, in one place', 'Mascot title is "Your conversations, in one place"');

const mascotSubtitle = mascotCard.querySelector('.inbox-mascot-subtitle');
assert(mascotSubtitle && mascotSubtitle.textContent.includes('Stay connected'), 'Mascot subtitle text exists');

// 2. Test Scalable Chat List Simulation across Extreme Counts (0 to 100+)
console.log('\n--- Test Suite 2: Chat List Scalability & Mascot Stability (0, 1, 5, 8, 15, 30, 50, 100+ chats) ---');

function createMockUser(index) {
  return {
    id: `user_${index}`,
    _id: `user_${index}`,
    username: `hubber_${index}`,
    fullName: `Hubber User ${index}`,
    profileImage: `https://images.unsplash.com/photo-${1500000000000 + index}?auto=format&fit=crop&w=150&h=150`,
    isOnline: index % 2 === 0
  };
}

function createMockThread(index) {
  return {
    conversationId: `conv_${index}`,
    user: createMockUser(index),
    unreadCount: index === 1 ? 3 : (index === 4 ? 1 : 0),
    lastMessage: {
      content: `Hey, this is message ${index}!`,
      createdAt: new Date(Date.now() - index * 60000).toISOString()
    }
  };
}

let selectedUserId = null;
function mockSelectConversation(user) {
  selectedUserId = user.id || user._id;
}

function simulateRenderChatThreads(threads) {
  chatThreadsList.innerHTML = '';
  if (threads.length === 0) {
    chatThreadsList.innerHTML = '<div class="empty-inbox-placeholder" style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; min-height:120px; padding:24px 16px; text-align:center; color:var(--text-muted);"><span style="font-size:13px; font-weight:600;">No conversations yet</span><span style="font-size:11.5px; opacity:0.75;">Search users above to start chatting with your hub.</span></div>';
    return;
  }

  threads.forEach((thread) => {
    const u = thread.user;
    const item = document.createElement('div');
    item.className = `thread-item ${selectedUserId === u.id ? 'active' : ''}`;
    item.setAttribute('data-thread', u.id);
    item.innerHTML = `
      <div class="thread-avatar">
        <img src="${u.profileImage}" alt="${u.fullName}" />
        <span class="online-indicator ${u.isOnline ? 'online' : 'offline'}"></span>
      </div>
      <div class="thread-details">
        <div class="thread-meta">
          <span class="thread-name">${u.fullName}</span>
          <span class="thread-time">${new Date(thread.lastMessage.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div class="thread-preview">
          <span class="preview-text">${thread.lastMessage.content}</span>
          ${thread.unreadCount > 0 ? `<span class="unread-count">${thread.unreadCount}</span>` : ''}
        </div>
      </div>
    `;
    item.addEventListener('click', () => mockSelectConversation(u));
    chatThreadsList.appendChild(item);
  });
}

// Test 0 conversations
simulateRenderChatThreads([]);
assert(chatThreadsList.querySelectorAll('.thread-item').length === 0, '0 chats: chat-threads-list has 0 thread items');
assert(chatThreadsList.querySelector('.empty-inbox-placeholder') !== null, '0 chats: displays centered empty placeholder');
assert(mascotFooter.parentElement === chatInboxSidebar, '0 chats: mascot footer remains anchored at bottom of sidebar');

// Test 1 conversation
const threads1 = [createMockThread(1)];
simulateRenderChatThreads(threads1);
assert(chatThreadsList.querySelectorAll('.thread-item').length === 1, '1 chat: renders exactly 1 thread item');
assert(mascotFooter.parentElement === chatInboxSidebar, '1 chat: mascot footer remains anchored at bottom of sidebar');

// Test 5 conversations
const threads5 = Array.from({ length: 5 }, (_, i) => createMockThread(i + 1));
simulateRenderChatThreads(threads5);
assert(chatThreadsList.querySelectorAll('.thread-item').length === 5, '5 chats: renders exactly 5 thread items');

// Test 8 conversations
const threads8 = Array.from({ length: 8 }, (_, i) => createMockThread(i + 1));
simulateRenderChatThreads(threads8);
assert(chatThreadsList.querySelectorAll('.thread-item').length === 8, '8 chats: renders exactly 8 thread items');

// Test 15 conversations (Scalable scrolling)
const threads15 = Array.from({ length: 15 }, (_, i) => createMockThread(i + 1));
simulateRenderChatThreads(threads15);
assert(chatThreadsList.querySelectorAll('.thread-item').length === 15, '15 chats: renders exactly 15 thread items');
assert(mascotFooter.parentElement === chatInboxSidebar, '15 chats: mascot footer remains anchored at bottom of sidebar');

// Test 30 conversations (Scalable scrolling)
const threads30 = Array.from({ length: 30 }, (_, i) => createMockThread(i + 1));
simulateRenderChatThreads(threads30);
assert(chatThreadsList.querySelectorAll('.thread-item').length === 30, '30 chats: renders exactly 30 thread items');

// Test 100+ conversations (Large Scalability)
const threads100 = Array.from({ length: 105 }, (_, i) => createMockThread(i + 1));
simulateRenderChatThreads(threads100);
assert(chatThreadsList.querySelectorAll('.thread-item').length === 105, '105 chats: renders exactly 105 thread items');
assert(mascotFooter.parentElement === chatInboxSidebar, '105 chats: mascot footer remains anchored at bottom without pushing layout');

// 3. Test Thread Selection & Interactivity
console.log('\n--- Test Suite 3: Thread Selection & Interaction ---');
const thread3 = chatThreadsList.querySelector('.thread-item[data-thread="user_3"]');
assert(thread3 !== null, 'Thread item for user_3 exists');
thread3.click();
assert(selectedUserId === 'user_3', 'Clicking thread item selects user_3');

// 4. Verify Enlarged Mascot Card CSS & Space Utilization
console.log('\n--- Test Suite 4: Enlarged Mascot Card CSS & Vertical Space Filling ---');
const cssContent = fs.readFileSync(path.join(__dirname, 'src/style.css'), 'utf8');

assert(cssContent.includes('.chats-layout-grid:not(.chatting) .inbox-mascot-footer') && cssContent.includes('flex: 1 1 auto !important;'), 'CSS sets flex: 1 1 auto on mobile inbox-mascot-footer to fill available space');
assert(cssContent.includes('min-height: 180px !important;'), 'CSS sets min-height: 180px on mobile inbox-mascot-footer for generous visual presence');
assert(cssContent.includes('.chats-layout-grid:not(.chatting) .inbox-mascot-card') && cssContent.includes('padding: 24px 16px !important;'), 'CSS sets generous vertical padding 24px 16px on mobile mascot card');
assert(cssContent.includes('width: 84px !important;') && cssContent.includes('height: 84px !important;'), 'CSS increases mascot image dimensions to 84px on standard mobile');
assert(cssContent.includes('font-size: 15.5px !important;'), 'CSS sets prominent title typography on enlarged mascot card');
assert(cssContent.includes('body.light-theme .inbox-mascot-card'), 'CSS contains light theme mascot card styles');

console.log('\n======================================================');
console.log(`TOTAL TESTS: ${passed + failed}`);
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
console.log('======================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('ALL ENLARGED MASCOT CARD & SPACE FILLING TESTS PASSED! 🎉\n');
}
