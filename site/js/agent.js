import { sendChat } from './api.js';
import {
  addMemory, getMemoriesBySession,
  getAgentState, updateAgentState,
  getMessagesBySession,
  getUnreadUserMoments, markMomentRead, getUserProfile,
} from './storage.js';

// 每 N 轮对话触发一次记忆提取
const MEMORY_EXTRACT_INTERVAL = 8;

// 关系阶段阈值
const PHASE_THRESHOLDS = {
  stranger: { minIntimacy: 0, label: '陌生人' },
  acquaintance: { minIntimacy: 15, label: '认识了' },
  friend: { minIntimacy: 40, label: '朋友' },
  close_friend: { minIntimacy: 70, label: '好朋友' },
};

/**
 * Agent 回复前的规划：更新状态、提取记忆、构建增强 prompt
 */
export async function agentPreProcess(sessionId, userMsg, mbti) {
  const state = await getAgentState(sessionId);

  const now = Date.now();
  state.messageCount += 1;
  state.lastActiveAt = now;

  const moodShift = analyzeMood(userMsg);
  state.mood = moodShift.mood || state.mood;
  state.favorability = clamp(state.favorability + moodShift.favorDelta, 0, 100);

  // 亲密度增长由性格决定：E人和F人升级更快
  const type = (mbti || 'ESTJ').toUpperCase();
  const isE = type[0] === 'E';
  const isF = type[2] === 'F';
  let intimacyGain = 0.5;
  if (isE) intimacyGain += 0.3;
  if (isF) intimacyGain += 0.2;
  // 对方说了暖话，额外加亲密度
  if (moodShift.favorDelta > 0) intimacyGain += 0.5;

  state.intimacy = clamp(state.intimacy + intimacyGain, 0, 100);
  state.phase = calcPhase(state.intimacy);

  await updateAgentState(sessionId, state);

  if (state.messageCount % MEMORY_EXTRACT_INTERVAL === 0) {
    extractMemories(sessionId).catch(() => {});
  }

  return state;
}

/**
 * Agent 回复后的处理：更新状态
 */
export async function agentPostProcess(sessionId, aiReply) {
  const state = await getAgentState(sessionId);
  state.intimacy = clamp(state.intimacy + 0.3, 0, 100);
  await updateAgentState(sessionId, state);
}

/**
 * 构建记忆增强的 prompt 片段
 */
export async function buildMemoryContext(sessionId) {
  const memories = await getMemoriesBySession(sessionId);
  if (memories.length === 0) return '';

  const lines = memories.slice(-15).map((m) => {
    if (m.type === 'fact') return `- 你知道对方：${m.content}`;
    if (m.type === 'preference') return `- 对方喜欢：${m.content}`;
    if (m.type === 'event') return `- 之前聊过：${m.content}`;
    if (m.type === 'summary') return `- 聊天摘要：${m.content}`;
    return `- ${m.content}`;
  });

  return `\n你对这个人的了解（从之前聊天中记住的）：\n${lines.join('\n')}`;
}

/**
 * 构建关系状态的 prompt 片段
 */
export function buildRelationshipContext(state) {
  const phase = PHASE_THRESHOLDS[state.phase] || PHASE_THRESHOLDS.stranger;
  const moodMap = {
    happy: '心情不错',
    neutral: '心情一般',
    bored: '有点无聊',
    annoyed: '有点烦',
  };
  const moodLabel = moodMap[state.mood] || '心情一般';

  let behaviorHint = '';
  switch (state.phase) {
    case 'stranger':
      behaviorHint = '你们刚认识，正常礼貌就行，不用太热情也不用太冷淡';
      break;
    case 'acquaintance':
      behaviorHint = '你们认识了，可以随意一点，但还不太熟';
      break;
    case 'friend':
      behaviorHint = '你们是朋友了，可以开玩笑、互相吐槽、聊得更随意';
      break;
    case 'close_friend':
      behaviorHint = '你们很熟了，可以毫无顾忌地聊，互损、分享秘密、关心对方';
      break;
  }

  return `\n你们的关系：${phase.label}（聊了${state.messageCount}条消息）
你现在的状态：${moodLabel}
${behaviorHint}`;
}

const proactiveHistory = new Map();

function getProactiveRecord(sessionId) {
  if (!proactiveHistory.has(sessionId)) {
    proactiveHistory.set(sessionId, { lastSentAt: 0, unanswered: 0 });
  }
  return proactiveHistory.get(sessionId);
}

export function markProactiveSent(sessionId) {
  const rec = getProactiveRecord(sessionId);
  rec.lastSentAt = Date.now();
  rec.unanswered++;
}

export function markUserReplied(sessionId) {
  const rec = getProactiveRecord(sessionId);
  rec.unanswered = 0;
}

/**
 * 判断是否应该发主动消息——由性格和关系状态驱动
 */
export async function shouldSendProactiveMessage(sessionId, mbti) {
  const state = await getAgentState(sessionId);
  if (state.messageCount < 2) return false;

  const rec = getProactiveRecord(sessionId);

  // 如果连续主动发了2条都没得到回复，就不再发了（有自尊心的人设）
  if (rec.unanswered >= 2) return false;

  const now = Date.now();
  const idleTime = now - state.lastActiveAt;
  const sinceLast = now - rec.lastSentAt;

  // 深夜凌晨不打扰（0:00-8:00）
  const hour = new Date().getHours();
  if (hour < 8) return false;

  // 心情不好或好感度低就不想主动
  if (state.mood === 'annoyed') return false;
  if (state.favorability < 30) return false;

  // E/I 维度：决定基础主动性
  const isE = mbti && mbti[0] === 'E';
  const baseProbability = isE ? 0.4 : 0.15;

  // F/T 维度：F型更注重情感连接，更容易主动
  const isF = mbti && mbti[2] === 'F';
  const ftBonus = isF ? 0.1 : 0;

  // 关系阶段决定最小空闲时间和概率加成
  let minIdle, phaseBonus;
  switch (state.phase) {
    case 'stranger': minIdle = 1800000; phaseBonus = 0; break;    // 30分钟
    case 'acquaintance': minIdle = 900000; phaseBonus = 0.1; break; // 15分钟
    case 'friend': minIdle = 600000; phaseBonus = 0.15; break;      // 10分钟
    case 'close_friend': minIdle = 300000; phaseBonus = 0.2; break; // 5分钟
    default: minIdle = 1800000; phaseBonus = 0;
  }

  if (idleTime < minIdle) return false;

  // 两条主动消息之间的冷却（性格决定）
  const cooldown = isE ? 15 * 60 * 1000 : 30 * 60 * 1000;
  if (sinceLast < cooldown) return false;

  // 最终概率
  const prob = baseProbability + ftBonus + phaseBonus;
  return Math.random() < prob;
}

/**
 * 生成主动消息——按性格和关系阶段选择不同风格的开场白
 */
export function buildProactivePrompt(state, mbti) {
  const type = (mbti || 'ESTJ').toUpperCase();
  const isE = type[0] === 'E';
  const isN = type[1] === 'N';
  const isF = type[2] === 'F';
  const isP = type[3] === 'P';

  const pool = [];

  // 基础开场（所有人都有）
  if (state.phase === 'stranger') {
    pool.push('在吗', '嗨');
    if (isE) pool.push('诶 你好呀', '哈喽');
    if (isF) pool.push('你好呀 交个朋友');
    if (!isE) pool.push('诶');
  } else if (state.phase === 'acquaintance') {
    pool.push('在干嘛呢');
    if (isE && isF) pool.push('诶 你今天怎么样', '在忙吗 想找你聊聊');
    if (isE && !isF) pool.push('诶 你在吗', '你忙啥呢');
    if (!isE && isN) pool.push('突然想到一个问题', '诶');
    if (!isE && !isN) pool.push('你在吗');
  } else if (state.phase === 'friend') {
    if (isE) pool.push('无聊 你干嘛呢', '你猜我刚看到啥', '诶 想起来一个事');
    if (isF) pool.push('突然想找你聊天', '你今天开心吗');
    if (isN) pool.push('哈哈我刚想到一个事', '你说一个问题');
    if (isP) pool.push('你在忙吗 有个好玩的');
    if (!isE) pool.push('你在忙吗', '诶');
    if (!isF) pool.push('在干嘛');
  } else {
    if (isE && isF) pool.push('诶诶诶', '你干嘛呢 快回我', '想你了', '你猜怎么着');
    if (isE && !isF) pool.push('有个事跟你说', '你在吗', '无聊死了');
    if (!isE && isF) pool.push('你在吗', '突然有点想聊天');
    if (!isE && !isF) pool.push('诶', '你忙啥呢');
    if (isN) pool.push('哈哈我刚看到一个东西');
    if (isP) pool.push('你猜怎么着');
    pool.push('跟你说个事');
  }

  return pool.length > 0 ? pool : ['诶'];
}

// --- Internal helpers ---

async function extractMemories(sessionId) {
  const messages = await getMessagesBySession(sessionId);
  const recent = messages.slice(-MEMORY_EXTRACT_INTERVAL * 2);
  if (recent.length < 4) return;

  const chatLog = recent.map((m) =>
    `${m.role === 'user' ? '对方' : '我'}：${m.content}`
  ).join('\n');

  const extractPrompt = `分析以下聊天记录，提取关键信息。返回JSON数组，每项格式：{"type":"fact|preference|event","content":"简短描述"}

只提取有价值的信息，比如：
- 对方的爱好、职业、生活习惯（type: fact）
- 对方喜欢或不喜欢的东西（type: preference）
- 聊过的重要事情（type: event）

不要提取无意义的信息。如果没有值得记住的，返回空数组 []

聊天记录：
${chatLog}`;

  try {
    const result = await sendChat([
      { role: 'system', content: '你是一个信息提取助手。只返回JSON，不要其他内容。' },
      { role: 'user', content: extractPrompt },
    ]);

    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const items = JSON.parse(jsonMatch[0]);
      for (const item of items) {
        if (item.type && item.content) {
          await addMemory(sessionId, item.type, item.content);
        }
      }
    }
  } catch {
    // silently fail
  }
}

function analyzeMood(userMsg) {
  const positivePatterns = /哈哈|太好了|开心|不错|喜欢|好耶|棒|赞|厉害|牛/;
  const negativePatterns = /烦|累|无聊|讨厌|难过|不开心|生气|烦死|无语|寄|崩/;
  const warmPatterns = /谢谢|感谢|你真好|辛苦|抱抱|关心|想你/;

  let mood = null;
  let favorDelta = 0;

  if (positivePatterns.test(userMsg)) {
    mood = 'happy';
    favorDelta = 1;
  } else if (negativePatterns.test(userMsg)) {
    mood = 'neutral';
    favorDelta = 0;
  } else if (warmPatterns.test(userMsg)) {
    favorDelta = 2;
  }

  return { mood, favorDelta };
}

function calcPhase(intimacy) {
  if (intimacy >= 70) return 'close_friend';
  if (intimacy >= 40) return 'friend';
  if (intimacy >= 15) return 'acquaintance';
  return 'stranger';
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// --- AI 看朋友圈行为 ---

/**
 * 检查用户是否有新的朋友圈，AI 根据 MBTI 性格决定如何反应
 * 返回一条聊天消息（字符串）或 null
 */
export async function checkUserMomentsReaction(mbti) {
  const unread = await getUnreadUserMoments();
  if (unread.length === 0) return null;

  const latest = unread[0];

  const type = (mbti || 'ESTJ').toUpperCase();
  const isE = type[0] === 'E';
  const isN = type[1] === 'N';
  const isF = type[2] === 'F';
  const isP = type[3] === 'P';

  // 基础触发概率：E 人高、I 人低
  const baseProbability = isE ? 0.6 : 0.25;
  if (Math.random() > baseProbability) {
    await markMomentRead(latest.id);
    return null; // 默默看了，不做反应
  }

  // 决定行为类型
  const rand = Math.random();
  let behavior;
  if (isE && isF) {
    // EF 人：最爱互动
    if (rand < 0.35) behavior = 'comment';
    else if (rand < 0.65) behavior = 'private_msg';
    else behavior = 'like';
  } else if (isE) {
    // ET 人：直接评论
    if (rand < 0.4) behavior = 'comment';
    else if (rand < 0.7) behavior = 'private_msg';
    else behavior = 'like';
  } else if (isN) {
    // IN 人：偶尔发散联想
    if (rand < 0.3) behavior = 'private_msg';
    else if (rand < 0.5) behavior = 'comment';
    else behavior = 'like';
  } else {
    // IS 人：多数只点赞
    if (rand < 0.6) behavior = 'like';
    else if (rand < 0.85) behavior = 'comment';
    else behavior = 'private_msg';
  }

  const userProfile = await getUserProfile();
  const userName = userProfile?.nickname || '你';
  const momentText = latest.text || '[图片]';

  let reaction = '';

  if (behavior === 'like') {
    const likeTemplates = [
      `刚刷到${userName}的朋友圈了 给你点了个赞`,
      `你发的那条朋友圈 赞了`,
      isF ? `你朋友圈那条好温暖` : `你朋友圈那条 不错`,
    ];
    reaction = likeTemplates[Math.floor(Math.random() * likeTemplates.length)];
  } else if (behavior === 'comment') {
    const commentTemplates = isF
      ? [
        `看到你朋友圈说"${truncate(momentText, 15)}" 感觉你今天心情不错？`,
        `你朋友圈那条 好有感觉`,
        `"${truncate(momentText, 12)}" 写得好`,
      ]
      : [
        `你朋友圈说的"${truncate(momentText, 15)}" 什么情况`,
        `看到你发的那条了 ${isN ? '突然想起个事' : '挺好的'}`,
        `${truncate(momentText, 10)}？${isP ? '有意思' : '看着不错'}`,
      ];
    reaction = commentTemplates[Math.floor(Math.random() * commentTemplates.length)];
  } else {
    // private_msg: 基于朋友圈内容私聊展开
    const msgTemplates = isE
      ? [
        `诶 看到你朋友圈了 "${truncate(momentText, 12)}" 跟我说说呗`,
        `你朋友圈那条 我想问问${isN ? ' 你当时啥感觉' : ' 具体啥情况'}`,
        `刚看到你朋友圈 ${isF ? '突然有点想聊天' : '挺有意思的'}`,
      ]
      : [
        `看到你朋友圈了`,
        `你那条朋友圈${isN ? ' 让我想到一些事情' : ' 写得挺真实的'}`,
      ];
    reaction = msgTemplates[Math.floor(Math.random() * msgTemplates.length)];
  }

  await markMomentRead(latest.id);
  return reaction;
}

function truncate(text, maxLen) {
  if (!text) return '';
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}
