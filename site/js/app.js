import { generateRandomProfile } from './mbti.js';
import { createSession, getSetting, setSetting } from './storage.js';
import { initChat, setupChatListeners } from './chat.js';
import { initEmojiPanel, togglePanel, closePanel } from './emoji.js';

// --- Views ---
const viewSelect = document.getElementById('view-select');
const viewLoading = document.getElementById('view-loading');
const viewChat = document.getElementById('view-chat');

// --- Select page ---
const btnFind = document.getElementById('btn-find');

// --- Chat page ---
const headerName = document.getElementById('header-name');
const btnBack = document.getElementById('btn-back');
const btnMore = document.getElementById('btn-more');
const btnEmoji = document.getElementById('btn-emoji');
const emojiPanel = document.getElementById('emoji-panel');
const inputEl = document.getElementById('input');

// --- Loading page ---
const loadingHint = document.getElementById('loading-hint');

let currentMBTI = 'ESTJ';
let currentGender = 'male';

// --- Show/hide views ---
function showView(view) {
  viewSelect.classList.remove('active');
  viewLoading.classList.remove('active');
  viewChat.classList.remove('active');
  view.classList.add('active');
}

// --- Check existing session (skip to chat if exists) ---
async function checkExistingSession() {
  const profile = await getSetting('current_profile');
  const sessionId = await getSetting('current_session_id');

  if (profile && sessionId) {
    showView(viewChat);
    headerName.textContent = profile.nickname;
    initChat(sessionId, profile.mbti, profile.gender, profile.avatar, profile.nickname);
    return true;
  }
  return false;
}

// --- Gender selector ---
function initGenderSelector() {
  document.querySelectorAll('.gender-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.gender-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentGender = btn.dataset.gender;
    });
  });
}

// --- MBTI selector ---
function initMBTISelector() {
  document.querySelectorAll('.dimension').forEach((dim) => {
    dim.querySelectorAll('.dim-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        dim.querySelectorAll('.dim-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        updateMBTI();
      });
    });
  });
  updateMBTI();
}

function updateMBTI() {
  const selected = document.querySelectorAll('.dim-btn.active');
  currentMBTI = Array.from(selected).map((b) => b.dataset.value).join('');
}

// --- Loading & transition ---
const LOADING_HINTS = [
  '分析性格匹配中...',
  '正在翻阅TA的朋友圈...',
  '确认契合度...',
  '找到了！正在建立连接...',
];

async function startLoading() {
  showView(viewLoading);

  for (let i = 0; i < LOADING_HINTS.length; i++) {
    loadingHint.textContent = LOADING_HINTS[i];
    await sleep(800 + Math.random() * 400);
  }

  const profile = generateRandomProfile(currentMBTI, currentGender);
  const session = await createSession(currentMBTI);

  await setSetting('current_profile', profile);
  await setSetting('current_session_id', session.id);

  await sleep(500);
  enterChat(profile, session.id);
}

function enterChat(profile, sessionId) {
  showView(viewChat);
  headerName.textContent = profile.nickname;
  initChat(sessionId, profile.mbti, profile.gender, profile.avatar, profile.nickname);
}

// --- Reset ---
async function resetChat() {
  if (!confirm('重新匹配会清除当前对话，确定吗？')) return;
  await setSetting('current_profile', null);
  await setSetting('current_session_id', null);
  showView(viewSelect);
}

// --- Helpers ---
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Init ---
async function init() {
  initGenderSelector();
  initMBTISelector();
  setupChatListeners();
  initEmojiPanel(emojiPanel, inputEl);

  btnFind.addEventListener('click', startLoading);
  btnBack.addEventListener('click', resetChat);

  btnMore.addEventListener('click', () => {
    // reserved
  });

  btnEmoji.addEventListener('click', togglePanel);
  document.getElementById('messages').addEventListener('click', closePanel);

  await checkExistingSession();
}

init();
