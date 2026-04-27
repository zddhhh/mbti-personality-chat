import { sendChat } from './api.js';
import { addMessage, getMessagesBySession } from './storage.js';
import { generateSystemPrompt } from './mbti.js';

let currentSessionId = null;
let currentMBTI = null;
let currentGender = null;
let currentNickname = '';
let aiAvatarUrl = '';
let isBusy = false;

const USER_AVATAR = 'https://randomuser.me/api/portraits/lego/1.jpg';

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const btnSend = document.getElementById('btn-send');

export async function initChat(sessionId, mbti, gender, avatarUrl, nickname) {
  currentSessionId = sessionId;
  currentMBTI = mbti;
  currentGender = gender;
  currentNickname = nickname;
  aiAvatarUrl = avatarUrl;
  messagesEl.innerHTML = '';

  const messages = await getMessagesBySession(sessionId);
  if (messages.length === 0) {
    await sendFirstGreeting();
  } else {
    loadHistory(messages);
  }
}

function loadHistory(messages) {
  let lastTime = 0;
  messages.forEach((msg) => {
    if (msg.timestamp - lastTime > 5 * 60 * 1000) {
      appendTimeSep(msg.timestamp);
    }
    lastTime = msg.timestamp;
    appendMsg(msg.role === 'user' ? 'self' : 'other', msg.content);
  });
  scrollBottom();
}

export function setupChatListeners() {
  btnSend.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 90) + 'px';
  });
}

async function send() {
  const text = inputEl.value.trim();
  if (!text || isBusy) return;

  inputEl.value = '';
  inputEl.style.height = 'auto';

  await addMessage(currentSessionId, 'user', text);
  appendMsg('self', text);

  await getReply();
}

async function getReply() {
  isBusy = true;
  btnSend.disabled = true;

  const sendTime = Date.now();

  try {
    const allMessages = await getMessagesBySession(currentSessionId);
    const systemPrompt = generateSystemPrompt(currentMBTI, currentGender, currentNickname);

    const lastUserMsg = allMessages[allMessages.length - 1]?.content || '';

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...allMessages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const reply = await sendChat(apiMessages);

    // Calculate smart delay
    const elapsed = Date.now() - sendTime;
    const targetDelay = calcSmartDelay(lastUserMsg, reply);
    const remaining = Math.max(targetDelay - elapsed, 300);
    await sleep(remaining);

    if (reply) {
      appendMsg('other', reply);
      await addMessage(currentSessionId, 'assistant', reply);
    }
  } catch (err) {
    appendMsg('other', `[出错了] ${err.message}`);
  } finally {
    isBusy = false;
    btnSend.disabled = false;
  }
}

async function sendFirstGreeting() {
  isBusy = true;
  btnSend.disabled = true;

  try {
    const systemPrompt = generateSystemPrompt(currentMBTI, currentGender, currentNickname);
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '[系统：这是你们第一次聊天。发一个简短的招呼，不超过5个字。比如"嗨"、"在吗"、"诶你好"。]' },
    ];

    const reply = await sendChat(messages);
    await sleep(1500 + Math.random() * 2000);

    const greeting = reply || '嗨';
    appendMsg('other', greeting);
    await addMessage(currentSessionId, 'assistant', greeting);
  } catch {
    await sleep(1500);
    appendMsg('other', '嗨');
    await addMessage(currentSessionId, 'assistant', '嗨');
  } finally {
    isBusy = false;
    btnSend.disabled = false;
  }
}

// --- Smart delay logic ---

let lastUserSendTime = 0;

function calcSmartDelay(userMsg, replyText) {
  const now = Date.now();
  const userGap = now - lastUserSendTime;
  lastUserSendTime = now;

  // Check if user message implies "wait" or "later"
  const waitKeywords = /等一下|稍等|等等|一会|待会|等下|马上|先忙/;
  if (waitKeywords.test(userMsg)) {
    return 6000 + Math.random() * 8000; // 6-14 seconds
  }

  // Match user rhythm: if user replies fast, AI replies relatively fast
  let rhythmFactor = 1;
  if (userGap > 0 && userGap < 3000) {
    rhythmFactor = 0.7; // User is fast, AI responds quicker
  } else if (userGap > 10000) {
    rhythmFactor = 1.3; // User is slow, AI takes a bit more time
  }

  // Base delay based on reply length
  const replyLen = replyText.length;
  let base;
  if (replyLen <= 5) {
    base = 1500 + Math.random() * 1500; // 1.5-3s for short replies
  } else if (replyLen <= 20) {
    base = 2500 + Math.random() * 2500; // 2.5-5s for medium
  } else {
    base = 4000 + Math.random() * 3000; // 4-7s for longer
  }

  // Add some randomness to feel natural
  const jitter = (Math.random() - 0.5) * 1000;
  return Math.max((base * rhythmFactor) + jitter, 1500);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}


// --- DOM helpers ---

function appendMsg(side, content) {
  const el = document.createElement('div');
  el.className = `msg ${side}`;

  const avatar = document.createElement('img');
  avatar.className = 'msg-avatar';
  avatar.src = side === 'self' ? USER_AVATAR : aiAvatarUrl;
  avatar.alt = '';

  const body = document.createElement('div');
  body.className = 'msg-body';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = content;

  body.appendChild(bubble);
  el.appendChild(avatar);
  el.appendChild(body);
  messagesEl.appendChild(el);
  scrollBottom();
}

function appendTimeSep(ts) {
  const sep = document.createElement('div');
  sep.className = 'time-sep';
  sep.textContent = formatTimeSep(ts);
  messagesEl.appendChild(sep);
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function formatTimeSep(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function stopStreaming() {
  // No longer streaming, but keep for interface compatibility
}
