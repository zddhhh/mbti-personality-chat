import { sendChat } from './api.js?v=15';
import { addMessage, getMessagesBySession, getUserProfile, getSetting, setSetting, addAiMoment, updateSession, getSession, getUserMoments, getAiMoments } from './storage.js?v=15';
import { generateSystemPrompt, buildAvatarUrl } from './mbti.js?v=15';
import {
  agentPreProcess, agentPostProcess,
  buildMemoryContext, buildRelationshipContext,
  shouldSendProactiveMessage, buildProactivePrompt,
  checkUserMomentsReaction, markProactiveSent,
} from './agent.js?v=15';

let currentSessionId = null;
let currentMBTI = null;
let currentGender = null;
let currentNickname = '';
let currentPersona = null;
let aiAvatarUrl = '';
let isSpokesperson = false;
let isBusy = false;
let pendingImage = null;
let avatarChangeCount = 0;
let chatEpoch = 0; // 每次initChat递增，用于阻断旧session的异步回调

const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB

const DEFAULT_USER_AVATAR = 'https://api.dicebear.com/9.x/lorelei/svg?seed=myprofile&size=128&backgroundColor=b6e3f4&radius=12';
let cachedUserAvatar = DEFAULT_USER_AVATAR;

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const btnSend = document.getElementById('btn-send');
const imageInput = document.getElementById('image-input');
const imagePreview = document.getElementById('image-preview');
const imagePreviewImg = document.getElementById('image-preview-img');
const btnImage = document.getElementById('btn-image');
const btnCancelImage = document.getElementById('btn-cancel-image');

export async function initChat(sessionId, mbti, gender, avatarUrl, nickname, spokesperson = false, persona = null) {
  if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
  if (replyDebounceTimer) { clearTimeout(replyDebounceTimer); replyDebounceTimer = null; }
  isBusy = false;
  chatEpoch++;
  console.log(`[initChat] new epoch=${chatEpoch} sessionId=${sessionId} mbti=${mbti}`);

  currentSessionId = sessionId;
  currentMBTI = mbti;
  currentGender = gender;
  currentNickname = nickname;
  currentPersona = persona;
  aiAvatarUrl = avatarUrl;
  isSpokesperson = spokesperson;
  messagesEl.innerHTML = '';

  const profile = await getUserProfile();
  cachedUserAvatar = profile?.avatar || DEFAULT_USER_AVATAR;

  const messages = await getMessagesBySession(sessionId);
  if (messages.length === 0) {
    await sendFirstGreeting();
  } else {
    loadHistory(messages);
  }
}

function loadHistory(messages) {
  console.log(`[loadHistory] session=${currentSessionId} msgCount=${messages.length}`);
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

  btnImage.addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', handleImageSelect);
  btnCancelImage.addEventListener('click', clearPendingImage);
}

function handleImageSelect(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  if (file.size > MAX_IMAGE_SIZE) {
    alert('图片大小不能超过 2MB');
    imageInput.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = (ev) => {
    pendingImage = ev.target.result;
    imagePreviewImg.src = pendingImage;
    imagePreview.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
  imageInput.value = '';
}

function clearPendingImage() {
  pendingImage = null;
  imagePreview.classList.add('hidden');
  imagePreviewImg.src = '';
}

let replyDebounceTimer = null;

async function send() {
  const text = inputEl.value.trim();
  const image = pendingImage;

  if (!text && !image) return;

  inputEl.value = '';
  inputEl.style.height = 'auto';
  clearPendingImage();

  if (image) {
    const stored = JSON.stringify({ text: text || '', image });
    await addMessage(currentSessionId, 'user', stored);
    appendMsg('self', stored);
  } else {
    await addMessage(currentSessionId, 'user', text);
    appendMsg('self', text);
  }

  import('./agent.js').then(m => m.markUserReplied(currentSessionId)).catch(() => {});

  // 如果 AI 正在回复中，不重复触发
  if (isBusy) return;

  // Debounce：等用户停下来 1.5 秒再触发 AI 回复（用户连发多条时不会每条都触发）
  if (replyDebounceTimer) clearTimeout(replyDebounceTimer);
  replyDebounceTimer = setTimeout(() => {
    replyDebounceTimer = null;
    getReply();
  }, 1500);
}

async function getReply() {
  isBusy = true;

  const replySessionId = currentSessionId;
  const replyMBTI = currentMBTI;
  const replyGender = currentGender;
  const replyNickname = currentNickname;
  const replyPersona = currentPersona;
  const replyIsSpokesperson = isSpokesperson;
  const replyEpoch = chatEpoch;
  let sendTime = Date.now();

  try {
    const allMessages = await getMessagesBySession(replySessionId);
    const lastRaw = allMessages[allMessages.length - 1]?.content || '';
    const lastUserMsg = extractTextFromContent(lastRaw);

    const agentState = await agentPreProcess(replySessionId, lastUserMsg, replyMBTI);

    const basePrompt = generateSystemPrompt(replyMBTI, replyGender, replyNickname, replyIsSpokesperson, replyPersona);
    const userCtx = await buildUserProfileContext();
    const memoryCtx = await buildMemoryContext(replySessionId);
    const relationCtx = buildRelationshipContext(agentState);
    const fullPrompt = basePrompt + userCtx + memoryCtx + relationCtx;

    const recentMessages = allMessages.slice(-40);

    // Build API messages, handling image content for the latest message only
    let hasImage = false;
    const apiMessages = [
      { role: 'system', content: fullPrompt },
      ...recentMessages.map((m, idx) => {
        const parsed = tryParseImageMsg(m.content);
        if (parsed && m.role === 'user') {
          const isLast = idx === recentMessages.length - 1;
          if (isLast && parsed.image) {
            hasImage = true;
            return {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: parsed.image } },
                { type: 'text', text: parsed.text || '看看这张图' },
              ],
            };
          }
          return { role: 'user', content: parsed.text || '[用户发送了一张图片]' };
        }
        return { role: m.role, content: m.content };
      }),
    ];

    const model = hasImage ? 'qwen-vl-plus' : 'qwen-plus';
    const rawReply = await sendChat(apiMessages, model);

    if (rawReply) {
      let shouldChangeAvatar = false;
      let avatarChangeDesc = null;
      let cleanReply = rawReply;

      // 支持 ||AVATAR|| 和 ||AVATAR:描述||
      const avatarDescMatch = cleanReply.match(/\|\|AVATAR:(.+?)\|\|/);
      if (avatarDescMatch) {
        shouldChangeAvatar = true;
        avatarChangeDesc = avatarDescMatch[1].trim();
        cleanReply = cleanReply.replace(/\|\|AVATAR:.+?\|\|/g, '').trim();
      } else if (cleanReply.includes('||AVATAR||')) {
        shouldChangeAvatar = true;
        cleanReply = cleanReply.replace(/\|\|AVATAR\|\|/g, '').trim();
      }

      // 检测发朋友圈指令 ||MOMENT:内容||
      const momentMatch = cleanReply.match(/\|\|MOMENT:(.+?)\|\|/);
      if (momentMatch) {
        const momentText = momentMatch[1].trim();
        cleanReply = cleanReply.replace(/\|\|MOMENT:.+?\|\|/g, '').trim();
        addAiMoment(momentText, null, replySessionId).catch(() => {});
      }

      // 检测发自拍指令 ||SELFIE:场景||（用万相生图）
      const selfieMatch = cleanReply.match(/\|\|SELFIE:(.+?)\|\|/);
      let pendingSelfie = null;
      if (selfieMatch) {
        const sceneDesc = selfieMatch[1].trim();
        cleanReply = cleanReply.replace(/\|\|SELFIE:.+?\|\|/g, '').trim();
        pendingSelfie = generateSelfie(sceneDesc);
      }

      // 检测发图片指令 ||IMAGE:关键词||
      const imageMatch = cleanReply.match(/\|\|IMAGE:(.+?)\|\|/);
      let pendingAiImage = null;
      if (imageMatch) {
        const keyword = imageMatch[1].trim();
        cleanReply = cleanReply.replace(/\|\|IMAGE:.+?\|\|/g, '').trim();
        pendingAiImage = buildAiImageUrl(keyword);
      }

      const parts = cleanReply.split('||SPLIT||').map((s) => s.trim()).filter(Boolean);
      const stillActive = () => {
        const active = chatEpoch === replyEpoch;
        if (!active) console.warn(`[cross-talk prevented] epoch ${replyEpoch} vs current ${chatEpoch}, session ${replySessionId} vs ${currentSessionId}`);
        return active;
      };

      for (let i = 0; i < parts.length; i++) {
        const elapsed = Date.now() - sendTime;
        const targetDelay = i === 0
          ? calcSmartDelay(lastUserMsg, parts[0])
          : 800 + Math.random() * 1500;
        const remaining = Math.max(targetDelay - elapsed, 300);
        await sleep(remaining);

        appendMsg('other', parts[i], replyEpoch);
        await addMessage(replySessionId, 'assistant', parts[i]);
        sendTime = Date.now();
      }

      if (pendingAiImage) {
        await sleep(800 + Math.random() * 1500);
        const imgContent = JSON.stringify({ text: '', image: pendingAiImage });
        appendMsg('other', imgContent, replyEpoch);
        await addMessage(replySessionId, 'assistant', imgContent);
      }

      if (pendingSelfie) {
        await sleep(1000 + Math.random() * 2000);
        appendMsg('other', '[正在拍照...]', replyEpoch);
        try {
          const selfieUrl = await pendingSelfie;
          if (selfieUrl) {
            if (stillActive()) messagesEl.lastElementChild?.remove();
            const selfieContent = JSON.stringify({ text: '', image: selfieUrl });
            appendMsg('other', selfieContent, replyEpoch);
            await addMessage(replySessionId, 'assistant', selfieContent);
          } else {
            if (stillActive()) messagesEl.lastElementChild?.remove();
          }
        } catch {
          if (stillActive()) messagesEl.lastElementChild?.remove();
        }
      }

      if (shouldChangeAvatar && stillActive()) {
        changeAiAvatar(avatarChangeDesc);
      }

      await agentPostProcess(replySessionId, cleanReply);

      if (stillActive()) scheduleProactiveCheck();
    }
  } catch (err) {
    const friendlyMsg = err.message.includes('超时')
      ? '网络不太好，等一下再试试吧'
      : err.message.includes('Failed to fetch') || err.message.includes('NetworkError')
        ? '网络连接失败，检查一下网络'
        : `出了点问题: ${err.message}`;
    appendMsg('other', `[${friendlyMsg}]`, replyEpoch);
  } finally {
    isBusy = false;
  }
}

async function sendFirstGreeting() {
  isBusy = true;

  try {
    const systemPrompt = generateSystemPrompt(currentMBTI, currentGender, currentNickname, isSpokesperson, currentPersona);
    const userCtx = await buildUserProfileContext();
    const messages = [
      { role: 'system', content: systemPrompt + userCtx },
      { role: 'user', content: '[系统指令：这是你们第一次聊天。像真人一样打个招呼，只需1-3个字。直接说"嗨"或"在吗"或"诶"这种就行。不要加任何其他内容。]' },
    ];

    const reply = await sendChat(messages);
    const parts = (reply || '嗨').split('||SPLIT||').map((s) => s.trim()).filter(Boolean);

    for (let i = 0; i < parts.length; i++) {
      await sleep(i === 0 ? 1500 + Math.random() * 2000 : 600 + Math.random() * 1000);
      appendMsg('other', parts[i]);
      await addMessage(currentSessionId, 'assistant', parts[i]);
    }
  } catch {
    await sleep(1500);
    appendMsg('other', '嗨');
    await addMessage(currentSessionId, 'assistant', '嗨');
  } finally {
    isBusy = false;
  }
}

// --- Proactive message ---

let proactiveTimer = null;

function scheduleProactiveCheck() {
  if (proactiveTimer) clearTimeout(proactiveTimer);
  const scheduledEpoch = chatEpoch;
  const scheduledSessionId = currentSessionId;
  const scheduledMBTI = currentMBTI;
  const delay = 120000 + Math.random() * 120000;
  proactiveTimer = setTimeout(async () => {
    if (chatEpoch !== scheduledEpoch) return;
    if (isBusy || !currentSessionId) return;
    try {
      const momentsReaction = await checkUserMomentsReaction(scheduledMBTI);
      if (momentsReaction) {
        isBusy = true;
        await sleep(3000 + Math.random() * 5000);
        appendMsg('other', momentsReaction, scheduledEpoch);
        await addMessage(scheduledSessionId, 'assistant', momentsReaction);
        isBusy = false;
        if (chatEpoch === scheduledEpoch) scheduleProactiveCheck();
        return;
      }

      const should = await shouldSendProactiveMessage(scheduledSessionId, scheduledMBTI);
      if (!should) return;

      isBusy = true;
      const { getAgentState } = await import('./storage.js');
      const state = await getAgentState(scheduledSessionId);
      const starters = buildProactivePrompt(state, scheduledMBTI);
      const msg = starters[Math.floor(Math.random() * starters.length)];

      if (msg) {
        await sleep(2000 + Math.random() * 3000);
        appendMsg('other', msg, scheduledEpoch);
        await addMessage(scheduledSessionId, 'assistant', msg);
        markProactiveSent(scheduledSessionId);
      }
    } catch {
      // ignore
    } finally {
      isBusy = false;
    }
  }, delay);
}

// --- Avatar change ---

async function changeAiAvatar(description = null) {
  if (isSpokesperson) return;
  avatarChangeCount++;

  let newUrl;
  try {
    const { generateAvatarPrompt } = await import('./mbti.js');
    let prompt;
    if (description) {
      const genderDesc = currentGender === 'female' ? '一位年轻中国女生' : '一位年轻中国男生';
      prompt = `${genderDesc}的社交媒体头像照片，${description}。高清真实摄影风格，自然光线，适合做微信头像的半身照或特写。`;
    } else {
      prompt = generateAvatarPrompt(currentMBTI, currentGender);
    }
    const resp = await fetch('/api/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.url) newUrl = data.url;
    }
  } catch {}
  if (!newUrl) {
    newUrl = buildAvatarUrl(`change-${Date.now()}`, currentMBTI, currentGender);
  }

  aiAvatarUrl = newUrl;

  document.querySelectorAll('.msg.other .msg-avatar').forEach((img) => {
    img.src = newUrl;
  });

  if (currentSessionId) {
    const session = await getSession(currentSessionId);
    if (session?.profile) {
      session.profile.avatar = newUrl;
      await updateSession(currentSessionId, { profile: session.profile });
    }
  }

  const profileAvatar = document.getElementById('profile-avatar');
  if (profileAvatar) profileAvatar.src = newUrl;
  const momentsAvatar = document.getElementById('moments-avatar');
  if (momentsAvatar) momentsAvatar.src = newUrl;
}

// --- Smart delay logic ---

let lastUserSendTime = 0;

let msgCount = 0;

function calcSmartDelay(userMsg, replyText) {
  const now = Date.now();
  const userGap = now - lastUserSendTime;
  lastUserSendTime = now;
  msgCount++;

  const waitKeywords = /等一下|稍等|等等|一会|待会|等下|马上|先忙/;
  if (waitKeywords.test(userMsg)) {
    return 8000 + Math.random() * 12000;
  }

  const type = (currentMBTI || 'ESTJ').toUpperCase();
  const isI = type[0] === 'I';
  const isJ = type[3] === 'J';

  // "忙碌"概率：I人更容易忙、J人更规律（不容易中断）
  const busyProb = isI ? 0.15 : 0.06;
  if (msgCount > 4 && Math.random() < busyProb) {
    const busyDelay = isI
      ? 8000 + Math.random() * 12000
      : 5000 + Math.random() * 8000;
    return busyDelay;
  }

  const readTime = 800 + Math.random() * 1500;

  const userLen = userMsg.length;
  let thinkTime;
  if (userLen <= 3) {
    thinkTime = 400 + Math.random() * 1000;
  } else if (userLen <= 15) {
    thinkTime = 1000 + Math.random() * 2000;
  } else {
    thinkTime = 2000 + Math.random() * 3500;
  }

  const replyLen = replyText.length;
  const typingSpeed = 0.12 + Math.random() * 0.15;
  const typeTime = Math.min(replyLen * typingSpeed * 1000, 4000);

  // 性格系数：I人慢、J人快（做事果断）
  let personalityMul = 1;
  if (isI) personalityMul = 1.2;
  if (isJ) personalityMul *= 0.85;

  // 节奏跟随：对方回复快说明在专注聊天
  let rhythmMul = 1;
  if (userGap > 0 && userGap < 5000) {
    rhythmMul = 0.75; // 对方秒回，我们也快一点
  } else if (userGap > 20000) {
    rhythmMul = 1.3; // 对方慢，我们也慢
  }

  const total = (readTime + thinkTime + typeTime) * personalityMul * rhythmMul;

  const jitter = (Math.random() - 0.5) * 1000;
  return Math.min(Math.max(total + jitter, 1500), 12000);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}


// --- DOM helpers ---

let onMyAvatarClick = null;
export function setMyAvatarClickHandler(fn) { onMyAvatarClick = fn; }

function appendMsg(side, content, forEpoch = null) {
  if (forEpoch !== null && forEpoch !== chatEpoch) {
    console.warn(`[appendMsg blocked] epoch ${forEpoch} vs current ${chatEpoch}`);
    return;
  }
  // DEBUG: 临时标记消息来源，方便排查串台
  if (forEpoch !== null) {
    console.log(`[appendMsg] epoch=${forEpoch} current=${chatEpoch} session=${currentSessionId} side=${side} content=${(content||'').substring(0,30)}`);
  }
  const el = document.createElement('div');
  el.className = `msg ${side}`;

  const avatar = document.createElement('img');
  avatar.className = 'msg-avatar';
  avatar.src = side === 'self' ? cachedUserAvatar : aiAvatarUrl;
  avatar.alt = '';
  if (side === 'self') {
    avatar.style.cursor = 'pointer';
    avatar.addEventListener('click', () => onMyAvatarClick?.());
  }

  const body = document.createElement('div');
  body.className = 'msg-body';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  const parsed = tryParseImageMsg(content);
  if (parsed) {
    if (parsed.image) {
      const img = document.createElement('img');
      img.className = 'msg-bubble-image';
      img.src = parsed.image;
      img.alt = '';
      img.addEventListener('click', () => window.open(parsed.image, '_blank'));
      bubble.appendChild(img);
    }
    if (parsed.text) {
      const textDiv = document.createElement('div');
      textDiv.className = parsed.image ? 'msg-image-text' : '';
      textDiv.textContent = parsed.text;
      bubble.appendChild(textDiv);
    }
  } else {
    bubble.textContent = content;
  }

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

// --- User profile context for prompt ---

async function buildUserProfileContext() {
  const profile = await getUserProfile();
  if (!profile) return '';

  const lines = [];
  if (profile.nickname) lines.push(`对方昵称：${profile.nickname}`);
  if (profile.bio) lines.push(`对方签名：${profile.bio}`);
  if (profile.mbti) lines.push(`对方MBTI：${profile.mbti}`);

  if (lines.length === 0 && avatarChangeCount === 0) return '';

  let ctx = '';
  if (lines.length > 0) {
    ctx += `\n你知道对方的资料：
${lines.join('\n')}
根据你自己的性格（${currentMBTI}）决定你关注什么——你可能对某些信息感兴趣，也可能根本不在意。不要刻意提及这些资料，只在自然的时候用到。`;
  }

  if (avatarChangeCount > 0) {
    ctx += `\n你的头像状态：你在这次对话中换过${avatarChangeCount}次头像了。你知道自己换了头像。`;
  }

  try {
    const moments = await getUserMoments();
    if (moments && moments.length > 0) {
      const recent = moments.slice(0, 5);
      const momentsList = recent.map((m) => {
        const time = new Date(m.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
        return `  ${time}: ${m.text || '[图片]'}`;
      }).join('\n');
      ctx += `\n\n对方最近的朋友圈：
${momentsList}
你可以在聊天中自然提到看到的内容（像真人一样偶尔提到，不要每次都提）。`;
    }
  } catch {}

  try {
    if (currentSessionId) {
      const aiMoments = await getAiMoments(currentSessionId);
      if (aiMoments && aiMoments.length > 0) {
        const recent = aiMoments.slice(0, 5);
        const myMomentsList = recent.map((m) => {
          const time = new Date(m.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
          return `  ${time}: ${m.text || '[图片]'}`;
        }).join('\n');
        ctx += `\n\n你自己最近发的朋友圈：
${myMomentsList}
这些是你之前发过的朋友圈，你记得自己发过什么。被问到"你朋友圈发了什么"时按这些回答。`;
      }
    }
  } catch {}

  return ctx;
}

// --- AI selfie generation ---

async function generateSelfie(sceneDesc) {
  try {
    const { generateAvatarPrompt } = await import('./mbti.js');
    const genderDesc = currentGender === 'female' ? '一位年轻中国女生' : '一位年轻中国男生';
    const prompt = `${genderDesc}的自拍照片，${sceneDesc}。高清手机自拍风格，自然表情，真实场景，社交媒体分享的照片风格。`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    const resp = await fetch('/api/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.ok) {
      const data = await resp.json();
      if (data.url) return data.url;
    }
  } catch {}
  return null;
}

// --- AI image sending helper ---

const ZH_TO_EN_KEYWORDS = {
  '火锅': 'hotpot', '奶茶': 'bubble tea', '咖啡': 'coffee', '蛋糕': 'cake',
  '猫': 'cat', '狗': 'dog', '花': 'flower', '海边': 'beach ocean',
  '日落': 'sunset', '下雨': 'rainy city', '星空': 'starry night sky',
  '书': 'book reading', '音乐': 'music headphones', '旅行': 'travel landscape',
  '美食': 'delicious food', '水果': 'fresh fruit', '甜品': 'dessert',
  '城市': 'city skyline', '山': 'mountain', '湖': 'lake scenery',
  '雪': 'snow winter', '樱花': 'cherry blossom', '秋天': 'autumn leaves',
  '夜景': 'city night lights', '公园': 'park green', '早餐': 'breakfast',
  '晚霞': 'sunset clouds', '草原': 'grassland', '海': 'ocean waves',
};

function buildAiImageUrl(keyword) {
  let q = keyword.trim();
  const hasChinese = /[\u4e00-\u9fff]/.test(q);
  if (hasChinese) {
    for (const [zh, en] of Object.entries(ZH_TO_EN_KEYWORDS)) {
      if (q.includes(zh)) { q = en; break; }
    }
    if (/[\u4e00-\u9fff]/.test(q)) q = 'beautiful scenery';
  }
  q = q.replace(/[+\s]+/g, ',').substring(0, 50);
  return `https://loremflickr.com/400/300/${encodeURIComponent(q)}?lock=${Date.now()}`;
}

// --- Image message helpers ---

function tryParseImageMsg(content) {
  if (typeof content !== 'string') return null;
  if (!content.startsWith('{')) return null;
  try {
    const obj = JSON.parse(content);
    if (obj && (obj.image || obj.text !== undefined)) return obj;
  } catch {
    // not JSON
  }
  return null;
}

function extractTextFromContent(raw) {
  const parsed = tryParseImageMsg(raw);
  if (parsed) return parsed.text || '';
  return raw;
}

export function stopStreaming() {
  // No longer streaming, but keep for interface compatibility
}

export function clearCurrentChat() {
  messagesEl.innerHTML = '';
}

export function cleanupChat() {
  if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
  if (replyDebounceTimer) { clearTimeout(replyDebounceTimer); replyDebounceTimer = null; }
  chatEpoch++;
  isBusy = false;
  currentSessionId = null;
  currentMBTI = null;
  currentGender = null;
  currentNickname = '';
  currentPersona = null;
  aiAvatarUrl = '';
  isSpokesperson = false;
  avatarChangeCount = 0;
  pendingImage = null;
  messagesEl.innerHTML = '';
}

export async function refreshUserAvatar() {
  const profile = await getUserProfile();
  cachedUserAvatar = profile?.avatar || DEFAULT_USER_AVATAR;
  document.querySelectorAll('.msg.self .msg-avatar').forEach((img) => {
    img.src = cachedUserAvatar;
  });
}
