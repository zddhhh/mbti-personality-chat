import { generateRandomProfile, generateAvatarPrompt, DIMENSIONS } from './mbti.js?v=15';
import {
  createSession, getSetting, setSetting,
  getMessagesBySession, getAgentState,
  getUserProfile, saveUserProfile,
  addUserMoment, getUserMoments, deleteUserMoment,
  getAiMoments, getAllSessions, deleteSession,
  getLastMessageBySession,
  addMessage, getUnreadCount, markSessionRead,
} from './storage.js?v=15';
import { initChat, setupChatListeners, clearCurrentChat, setMyAvatarClickHandler, refreshUserAvatar, cleanupChat } from './chat.js?v=15';
import { initEmojiPanel, togglePanel, closePanel } from './emoji.js?v=15';

// --- Views ---
const viewLanding = document.getElementById('view-landing');
const viewAiSelect = document.getElementById('view-ai-select');
const viewUserProfile = document.getElementById('view-user-profile');
const viewLoading = document.getElementById('view-loading');
const viewChatList = document.getElementById('view-chat-list');
const viewChat = document.getElementById('view-chat');

// --- Buttons ---
const btnFind = document.getElementById('btn-find');

// --- Chat page ---
const headerName = document.getElementById('header-name');
const headerMbti = document.getElementById('header-mbti');
const btnBack = document.getElementById('btn-back');
const btnMore = document.getElementById('btn-more');
const btnEmoji = document.getElementById('btn-emoji');
const emojiPanel = document.getElementById('emoji-panel');
const inputEl = document.getElementById('input');
const dropdownMenu = document.getElementById('dropdown-menu');

// --- Loading page ---
const loadingHint = document.getElementById('loading-hint');

let aiMBTI = 'ESTJ';
let aiGender = 'male';
let userMBTI = 'ESTJ';
let userGender = 'male';
let currentProfile = null;
let currentSessionId = null;

// --- Background proactive message system ---
let bgProactiveTimer = null;

async function startBackgroundProactive() {
  if (bgProactiveTimer) clearTimeout(bgProactiveTimer);
  const delay = 60000 + Math.random() * 60000; // 1-2分钟检查一次（更频繁）
  bgProactiveTimer = setTimeout(async () => {
    try {
      const sessions = await getAllSessions();
      if (sessions.length === 0) { startBackgroundProactive(); return; }

      const { shouldSendProactiveMessage, buildProactivePrompt, checkUserMomentsReaction, markProactiveSent } = await import('./agent.js');

      for (const session of sessions) {
        if (session.id === currentSessionId) continue;
        const profile = session.profile;
        if (!profile) continue;

        const mbti = profile.mbti;
        try {
          const momentsReaction = await checkUserMomentsReaction(mbti);
          if (momentsReaction) {
            await addMessage(session.id, 'assistant', momentsReaction);
            markProactiveSent(session.id);
            refreshChatListIfVisible();
            continue;
          }
        } catch (e) {
          console.warn('[bg-proactive] moments check error:', e);
        }

        const should = await shouldSendProactiveMessage(session.id, mbti);
        if (!should) continue;

        const state = await getAgentState(session.id);
        const starters = buildProactivePrompt(state, profile.mbti);
        const msg = starters[Math.floor(Math.random() * starters.length)];
        if (msg) {
          await addMessage(session.id, 'assistant', msg);
          markProactiveSent(session.id);
          console.log('[bg-proactive] sent to', session.id, ':', msg);
          refreshChatListIfVisible();
        }
      }
    } catch (e) {
      console.error('[bg-proactive] error:', e);
    }
    startBackgroundProactive();
  }, delay);
}

function refreshChatListIfVisible() {
  if (viewChatList.classList.contains('active')) {
    showChatList();
  }
}

// --- Show/hide views ---
const allViews = () => [viewLanding, viewAiSelect, viewUserProfile, viewLoading, viewChatList, viewChat];

function showView(view) {
  allViews().forEach((v) => v.classList.remove('active'));
  view.classList.add('active');
}

// --- Migrate old data format ---
async function migrateOldSessions() {
  const sessions = await getAllSessions();
  if (sessions.length > 0 && !sessions[0].profile) {
    const oldProfile = await getSetting('current_profile');
    if (oldProfile) {
      const { updateSession } = await import('./storage.js');
      await updateSession(sessions[0].id, { profile: oldProfile });
    }
  }
}

// --- Chat list ---
async function showChatList() {
  const sessions = await getAllSessions();
  const listEl = document.getElementById('chat-list');
  listEl.innerHTML = '';

  if (sessions.length === 0) {
    document.getElementById('btn-to-chat-list').classList.add('hidden');
    showView(viewLanding);
    return;
  }

  for (const s of sessions) {
    const profile = s.profile;
    if (!profile) continue;

    const remark = await getSetting(`remark_${s.id}`);
    const lastMsg = await getLastMessageBySession(s.id);

    let preview = '';
    if (lastMsg) {
      let txt = lastMsg.content || '';
      try { const p = JSON.parse(txt); txt = p.text || '[图片]'; } catch {}
      preview = txt.length > 30 ? txt.slice(0, 30) + '...' : txt;
    }

    const timeStr = lastMsg ? formatMomentTime(lastMsg.timestamp) : formatMomentTime(s.createdAt);
    const unread = await getUnreadCount(s.id);

    const item = document.createElement('div');
    item.className = 'chat-list-item';
    item.dataset.sessionId = s.id;
    item.innerHTML = `
      <div class="chat-list-avatar-wrap">
        <img class="chat-list-avatar" src="${profile.avatar}" alt="">
        ${unread > 0 ? `<span class="chat-list-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
      </div>
      <div class="chat-list-body">
        <div class="chat-list-top">
          <span>
            <span class="chat-list-name">${remark || profile.nickname}</span>
            <span class="chat-list-mbti">${profile.mbti}</span>
          </span>
          <span class="chat-list-time">${timeStr}</span>
        </div>
        <div class="chat-list-preview">${preview || '开始聊天'}</div>
      </div>
      <button class="chat-list-delete" data-sid="${s.id}">删除</button>
    `;
    listEl.appendChild(item);
  }

  // Event delegation
  listEl.onclick = async (e) => {
    const delBtn = e.target.closest('.chat-list-delete');
    if (delBtn) {
      e.stopPropagation();
      const sid = Number(delBtn.dataset.sid);
      if (!confirm('删除这个好友和全部聊天记录？')) return;
      await deleteSession(sid);
      await showChatList();
      return;
    }
    const item = e.target.closest('.chat-list-item');
    if (item) {
      const sid = Number(item.dataset.sessionId);
      const sessions = await getAllSessions();
      const session = sessions.find((s) => s.id === sid);
      if (session?.profile) openSession(session);
    }
  };

  showView(viewChatList);
}

async function openSession(session) {
  currentProfile = session.profile;
  currentSessionId = session.id;
  await markSessionRead(session.id);
  enterChat(session.profile, session.id);
}

// --- Selector helpers ---

function initSelectorGroup(containerSelector, onSelect) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  container.querySelectorAll('.gender-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.gender-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      onSelect(btn.dataset.gender);
    });
  });
}

function initMBTISelectorGroup(containerSelector, onChange) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  container.querySelectorAll('.dimension').forEach((dim) => {
    dim.querySelectorAll('.dim-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        dim.querySelectorAll('.dim-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        onChange(getMBTIFromContainer(container));
      });
    });
  });
}

function getMBTIFromContainer(container) {
  const selected = container.querySelectorAll('.dim-btn.active');
  return Array.from(selected).map((b) => b.dataset.value).join('');
}

function initAllSelectors() {
  // AI selectors (page 2)
  initSelectorGroup('#ai-gender-selector', (g) => { aiGender = g; });
  initMBTISelectorGroup('#ai-mbti-selector', (mbti) => {
    aiMBTI = mbti;
    const hint = document.getElementById('enfj-hint');
    if (aiMBTI === 'ENFJ') {
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }
  });

  // User selectors (page 3)
  initSelectorGroup('#user-gender-selector', (g) => { userGender = g; });
  initMBTISelectorGroup('#user-mbti-selector', (mbti) => { userMBTI = mbti; });
}

// --- Loading & transition ---
const LOADING_HINTS = [
  '分析性格匹配中...',
  '正在翻阅TA的朋友圈...',
  '确认契合度...',
  '找到了！正在生成TA的形象...',
  '好像挺有眼缘的...',
  '马上就好...',
];

async function startLoading() {
  const userNickname = document.getElementById('user-nickname').value.trim();
  if (!userNickname) {
    alert('请输入你的昵称');
    return;
  }

  const existingProfile = await getUserProfile();
  const userProfileData = {
    nickname: userNickname,
    gender: userGender,
    mbti: userMBTI,
    bio: existingProfile?.bio || '',
    avatar: existingProfile?.avatar || null,
  };
  await saveUserProfile(userProfileData);

  showView(viewLoading);

  const profile = generateRandomProfile(aiMBTI, aiGender);

  // Generate AI avatar with Wanx in parallel with loading hints
  const avatarPromise = generateAiAvatar(aiMBTI, aiGender).catch(() => null);

  for (let i = 0; i < LOADING_HINTS.length; i++) {
    loadingHint.textContent = LOADING_HINTS[i];
    await sleep(1200 + Math.random() * 600);
  }

  // Wait for avatar if still loading
  const aiAvatarUrl = await avatarPromise;
  if (aiAvatarUrl) {
    profile.avatar = aiAvatarUrl;
  }

  currentProfile = profile;
  const session = await createSession(aiMBTI, profile);
  currentSessionId = session.id;
  await markSessionRead(session.id);

  document.getElementById('btn-to-chat-list').classList.remove('hidden');
  enterChat(profile, session.id);
}

async function enterChat(profile, sessionId) {
  showView(viewChat);
  const remark = await getSetting(`remark_${sessionId}`);
  headerName.textContent = remark || profile.nickname;
  headerMbti.textContent = profile.mbti;
  initChat(sessionId, profile.mbti, profile.gender, profile.avatar, profile.nickname, profile.isSpokesperson || false, profile.persona || null);
}

// --- Back to chat list ---
async function goBackToChatList() {
  cleanupChat();
  currentProfile = null;
  currentSessionId = null;
  await showChatList();
}

// --- New match from chat (keeps old sessions) ---
async function startNewMatch() {
  closeDropdown();
  cleanupChat();
  currentProfile = null;
  currentSessionId = null;
  showView(viewAiSelect);
}

// --- AI Avatar generation ---
async function generateAiAvatar(mbti, gender) {
  const prompt = generateAvatarPrompt(mbti, gender);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    const resp = await fetch('/api/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.url || null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

// --- Helpers ---
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Dropdown menu ---
function toggleDropdown() {
  dropdownMenu.classList.toggle('hidden');
}

function closeDropdown() {
  dropdownMenu.classList.add('hidden');
}

// --- Profile panel ---
const PHASE_LABELS = {
  stranger: '陌生人',
  acquaintance: '认识',
  friend: '朋友',
  close_friend: '密友',
};

async function showProfile() {
  closeDropdown();
  if (!currentProfile) return;

  document.getElementById('profile-avatar').src = currentProfile.avatar;
  document.getElementById('profile-name').textContent = currentProfile.nickname;
  document.getElementById('profile-mbti-badge').textContent = currentProfile.mbti;
  document.getElementById('profile-gender').textContent = currentProfile.gender === 'female' ? '女生' : '男生';

  const letters = currentProfile.mbti.split('');
  const traits = letters.map((l) => DIMENSIONS[l]?.label || l).join(' / ');
  document.getElementById('profile-personality').textContent = traits;

  const remark = currentSessionId ? await getSetting(`remark_${currentSessionId}`) : null;
  document.getElementById('profile-remark-text').textContent = remark || '未设置';

  if (currentSessionId) {
    const state = await getAgentState(currentSessionId);
    document.getElementById('profile-phase').textContent = PHASE_LABELS[state.phase] || '陌生人';
    document.getElementById('profile-msg-count').textContent = `${state.messageCount || 0} 条`;
  }

  document.getElementById('profile-panel').classList.remove('hidden');
}

// --- Moments panel (AI persona's "朋友圈") ---

const FRIEND_NAMES = ['小鱼', '阿瑜', '星星', '可乐', '橘子', '大壮', '小麦', '草莓', '月月', '阿飞'];

function pickFriends(n) {
  const shuffled = [...FRIEND_NAMES].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

function getMomentsForMBTI(mbti, gender, nickname) {
  const type = mbti.toUpperCase();
  const isI = type[0] === 'I';
  const isE = !isI;
  const isN = type[1] === 'N';
  const isS = !isN;
  const isT = type[2] === 'T';
  const isF = !isT;
  const isP = type[3] === 'P';
  const isJ = !isP;
  const isMale = gender === 'male';
  const now = Date.now();
  const h = 3600000;
  const d = 86400000;

  const all = [];

  // 根据 16 种 MBTI 生成不同的朋友圈内容
  if (type === 'INTJ' || type === 'INTP') {
    all.push(
      { text: '又debug到凌晨两点 但找到bug的那一刻真的爽', time: now - h * 5, likes: pickFriends(2), comments: [{ name: '阿飞', text: '你不睡觉的吗' }] },
      { text: '新买的机械键盘到了 红轴 手感还行', time: now - d * 2, likes: pickFriends(4), comments: [] },
      { text: isMale ? '周末一个人在家研究新框架 挺好的' : '独处的时候效率最高', time: now - d * 4, likes: pickFriends(1), comments: [{ name: '小鱼', text: '社恐之王' }] },
      { text: '看了三遍《星际穿越》 每次都有新的理解', time: now - d * 7, likes: pickFriends(6), comments: [{ name: '可乐', text: '我看一遍就睡着了' }] },
      { text: isN ? '如果人类能活到200岁 社会结构会完全不同吧' : '新的显示器到了 4K真的不一样', time: now - d * 12, likes: pickFriends(3), comments: [] },
      { text: '咖啡喝多了 凌晨四点还没困', time: now - d * 18, likes: pickFriends(2), comments: [{ name: '月月', text: '保重身体啊' }] },
    );
  } else if (type === 'INFJ' || type === 'INFP') {
    all.push(
      { text: '深夜读完一本书 脑子里乱七八糟的想法停不下来', time: now - h * 3, likes: pickFriends(5), comments: [{ name: '星星', text: '什么书啊 推荐一下' }] },
      { text: '有些话说不出口 就写在这里吧\n"我们终其一生 都在寻找另一个自己"', time: now - d * 3, likes: pickFriends(8), comments: [{ name: '小鱼', text: '写得好' }, { name: '橘子', text: '你又emo了' }] },
      { text: isMale ? '一个人在河边坐了一下午 看水面发呆' : '今天的晚霞好美 拍了好多照片但都不如亲眼看到的', time: now - d * 5, likes: pickFriends(7), comments: [] },
      { text: '如果时间可以倒流 你会回到哪一天', time: now - d * 9, likes: pickFriends(4), comments: [{ name: '阿瑜', text: '高考前一天' }, { name: '大壮', text: '不会 往前看' }] },
      { text: '路过花店买了一束向日葵 心情好了一点', time: now - d * 14, likes: pickFriends(9), comments: [{ name: '草莓', text: '你也太浪漫了吧' }] },
      { text: '失眠的夜晚 适合听Radiohead', time: now - d * 20, likes: pickFriends(3), comments: [] },
    );
  } else if (type === 'ISTJ' || type === 'ISFJ') {
    all.push(
      { text: isMale ? '今天的计划全部完成 打卡' : '周末大扫除 家里终于干净了', time: now - h * 8, likes: pickFriends(3), comments: [{ name: '可乐', text: '自律达人' }] },
      { text: '新种的多肉活了 第三盆了', time: now - d * 2, likes: pickFriends(5), comments: [{ name: '小鱼', text: '前两盆呢' }, { name: nickname, text: '别问' }] },
      { text: isMale ? '给妈打了个电话 聊了半小时' : '今天做了蛋糕 卖相一般 味道还行', time: now - d * 5, likes: pickFriends(6), comments: [] },
      { text: '在家待了一天 很舒服 不想出门', time: now - d * 8, likes: pickFriends(2), comments: [{ name: '阿飞', text: '我也是' }] },
      { text: isF ? '帮邻居收了快递 举手之劳' : '书架终于按颜色排好了', time: now - d * 13, likes: pickFriends(4), comments: [] },
      { text: '有时候安静也是一种力量', time: now - d * 19, likes: pickFriends(7), comments: [{ name: '月月', text: '深有同感' }] },
    );
  } else if (type === 'ISTP' || type === 'ISFP') {
    all.push(
      { text: isMale ? '今天拆了个旧音响 修好了 有点成就感' : '画了一下午水彩 虽然没画完', time: now - h * 6, likes: pickFriends(3), comments: [] },
      { text: '骑车去了郊外 路上没什么人 风很大', time: now - d * 3, likes: pickFriends(5), comments: [{ name: '阿瑜', text: '好自在' }] },
      { text: isMale ? '新的工具箱到了' : '学了个新的手工 串珠', time: now - d * 6, likes: pickFriends(2), comments: [] },
      { text: '不想说话的时候就戴上耳机 全世界都安静了', time: now - d * 10, likes: pickFriends(4), comments: [{ name: '星星', text: '同款社恐' }] },
      { text: isF ? '流浪猫又来了 给它开了个罐头' : '手冲咖啡终于不苦了', time: now - d * 15, likes: pickFriends(6), comments: [{ name: '草莓', text: '好温柔' }] },
      { text: '一个人去看了场电影 挺好的', time: now - d * 21, likes: pickFriends(3), comments: [] },
    );
  } else if (type === 'ENTJ' || type === 'ESTJ') {
    all.push(
      { text: '效率就是生命 今天搞定了五件事', time: now - h * 4, likes: pickFriends(4), comments: [{ name: '小鱼', text: '卷王' }, { name: '大壮', text: '佩服' }] },
      { text: isMale ? '健身打卡第180天 没有不可能' : '新的季度OKR写好了 目标清晰', time: now - d * 2, likes: pickFriends(7), comments: [] },
      { text: '有些事想清楚就去做 别磨叽 想太多什么都做不了', time: now - d * 5, likes: pickFriends(5), comments: [{ name: '可乐', text: '说得好' }] },
      { text: '团建组织完毕 从选餐厅到活动流程一条龙', time: now - d * 8, likes: pickFriends(8), comments: [{ name: '阿飞', text: '天生领导者' }] },
      { text: isMale ? '跑了个半马 成绩还行 下次争取破2' : '项目提前两天交付 团队给力', time: now - d * 14, likes: pickFriends(6), comments: [] },
      { text: '读完了《原则》 做了20页笔记', time: now - d * 20, likes: pickFriends(3), comments: [{ name: '月月', text: '太强了' }] },
    );
  } else if (type === 'ENTP' || type === 'ENFP') {
    all.push(
      { text: '凌晨三点的想法通常都是天才想法（也可能不是', time: now - h * 2, likes: pickFriends(6), comments: [{ name: '阿瑜', text: '哈哈哈你又发疯了' }] },
      { text: isMale ? '又又又开始了新的爱好 这次是飞盘' : '刚学了尤克里里 弹了三天就搁下了哈哈', time: now - d, likes: pickFriends(8), comments: [{ name: '小鱼', text: '三分钟热度本度' }, { name: '星星', text: '上次不是说学吉他吗' }] },
      { text: '人生就是不断尝试然后放弃的过程 但还是要试', time: now - d * 4, likes: pickFriends(5), comments: [] },
      { text: '刚和出租车司机聊了半小时人生 他说我应该去说脱口秀', time: now - d * 7, likes: pickFriends(9), comments: [{ name: '大壮', text: '正常人谁和出租车司机聊半小时' }, { name: '可乐', text: '哈哈哈哈' }] },
      { text: isF ? '今天帮三个人解决了问题 我是不是太热心了' : '有了一个改变世界的想法 等我先睡一觉', time: now - d * 11, likes: pickFriends(7), comments: [] },
      { text: '在超市里待了两小时 什么都没买 但很开心', time: now - d * 16, likes: pickFriends(4), comments: [{ name: '橘子', text: '你是来逛街还是来体验生活' }] },
    );
  } else if (type === 'ENFJ' || type === 'ESFJ') {
    all.push(
      { text: isMale ? '周末和朋友去爬山了 累但开心 下次还去' : '和闺蜜吃了顿火锅 聊了三个小时 笑到肚子疼', time: now - h * 7, likes: pickFriends(8), comments: [{ name: '草莓', text: '下次带我' }, { name: '小麦', text: '又没叫我' }] },
      { text: '新发现了一家超好吃的店 下次带你们去', time: now - d * 2, likes: pickFriends(7), comments: [{ name: '可乐', text: '在哪在哪' }, { name: '阿瑜', text: '啥时候去' }] },
      { text: '生活嘛 开心最重要 不开心的事就让它过去', time: now - d * 5, likes: pickFriends(5), comments: [] },
      { text: isMale ? '教弟弟做作业 差点被气死 但他学会了' : '帮闺蜜挑了一下午衣服 比自己买还开心', time: now - d * 8, likes: pickFriends(6), comments: [{ name: '月月', text: '你太好了吧' }] },
      { text: '今天收到一封感谢信 突然觉得一切都值得', time: now - d * 13, likes: pickFriends(9), comments: [{ name: '星星', text: '暖心' }, { name: '大壮', text: '你值得' }] },
      { text: isF ? '看到路边卖花的老奶奶 全买了' : '聚会组织完毕 二十个人的饭局 我来安排', time: now - d * 18, likes: pickFriends(4), comments: [] },
    );
  } else if (type === 'ESTP' || type === 'ESFP') {
    all.push(
      { text: isMale ? '今天蹦极了 下次要去跳伞' : '蹦迪到两点 腿软了但很嗨', time: now - h * 3, likes: pickFriends(7), comments: [{ name: '阿飞', text: '疯了吧' }, { name: '小鱼', text: '我也想去' }] },
      { text: '人生苦短 及时行乐', time: now - d * 2, likes: pickFriends(5), comments: [] },
      { text: isMale ? '打球打赢了 请客吃饭' : '学了个新舞蹈 今晚就去练', time: now - d * 4, likes: pickFriends(8), comments: [{ name: '大壮', text: '带我啊' }] },
      { text: '和陌生人聊了一路 下车的时候互换了联系方式', time: now - d * 7, likes: pickFriends(6), comments: [{ name: '可乐', text: '社牛天花板' }] },
      { text: '周末自驾去了海边 风超大 浪超大 人超少', time: now - d * 12, likes: pickFriends(9), comments: [{ name: '草莓', text: '照片发出来' }, { name: '橘子', text: '下次叫我' }] },
      { text: isMale ? '新学了冲浪 摔了八次 站起来了三次 值' : '今天唱K唱到嗓子哑了 但最后一首超好听', time: now - d * 17, likes: pickFriends(4), comments: [] },
    );
  } else {
    all.push(
      { text: '今天天气真好 出门走了走', time: now - d, likes: pickFriends(3), comments: [] },
      { text: '吃了一碗很好吃的面', time: now - d * 3, likes: pickFriends(2), comments: [{ name: '小鱼', text: '哪家的' }] },
      { text: '周末快乐', time: now - d * 6, likes: pickFriends(5), comments: [] },
    );
  }

  return all;
}

async function showMoments() {
  closeDropdown();
  if (!currentProfile) return;

  document.getElementById('moments-avatar').src = currentProfile.avatar;
  document.getElementById('moments-nickname').textContent = currentProfile.nickname;

  // 预设朋友圈 + AI 动态发的朋友圈合并
  const presetMoments = getMomentsForMBTI(currentProfile.mbti, currentProfile.gender, currentProfile.nickname);
  const dynamicMoments = await getAiMoments(currentSessionId);

  const dynamicFormatted = dynamicMoments.map((m) => ({
    text: m.text,
    time: m.createdAt,
    likes: m.likes || [],
    comments: m.comments || [],
    image: m.image || null,
    isDynamic: true,
  }));

  const allMoments = [...dynamicFormatted, ...presetMoments]
    .sort((a, b) => b.time - a.time);

  const listEl = document.getElementById('moments-list');
  listEl.innerHTML = '';

  allMoments.forEach((m) => {
    const item = document.createElement('div');
    item.className = 'moment-item';

    const timeStr = formatMomentTime(m.time);
    let socialHtml = '';

    if (m.likes?.length || m.comments?.length) {
      socialHtml += '<div class="moment-social">';
      if (m.likes?.length) {
        socialHtml += `<div class="moment-likes">❤️ ${m.likes.join('，')}</div>`;
      }
      if (m.comments?.length) {
        socialHtml += m.comments.map((c) =>
          `<div class="moment-comment"><span class="moment-comment-name">${c.name}</span>：${c.text}</div>`
        ).join('');
      }
      socialHtml += '</div>';
    }

    let imgHtml = '';
    if (m.image) {
      imgHtml = `<img class="msg-bubble-image" src="${m.image}" alt="" style="margin-top:6px;">`;
    }

    const dynamicTag = m.isDynamic ? '<span style="font-size:0.7rem;color:#07c160;margin-left:4px;">NEW</span>' : '';

    item.innerHTML = `
      <img class="moment-avatar" src="${currentProfile.avatar}" alt="">
      <div class="moment-content">
        <div class="moment-name">${currentProfile.nickname}${dynamicTag}</div>
        <div class="moment-text">${m.text}</div>
        ${imgHtml}
        <div class="moment-time">${timeStr}</div>
        ${socialHtml}
      </div>
    `;
    listEl.appendChild(item);
  });

  document.getElementById('moments-panel').classList.remove('hidden');
}

function formatMomentTime(ts) {
  const diff = Date.now() - ts;
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return '刚刚';
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

// --- Clear chat ---
async function handleClearChat() {
  closeDropdown();
  if (!confirm('确定清空聊天记录吗？记忆和关系不会消失')) return;
  clearCurrentChat();
}

// --- Remark (备注) ---
async function handleSetRemark() {
  closeDropdown();
  if (!currentSessionId) return;
  const remarkKey = `remark_${currentSessionId}`;
  const currentRemark = await getSetting(remarkKey);
  const name = prompt('给 TA 设置一个备注名：', currentRemark || '');
  if (name === null) return;

  const trimmed = name.trim();
  if (trimmed) {
    await setSetting(remarkKey, trimmed);
    headerName.textContent = trimmed;
  } else {
    await setSetting(remarkKey, null);
    if (currentProfile) {
      headerName.textContent = currentProfile.nickname;
    }
  }
}

// --- Dropdown item handler ---
function handleDropdownAction(action) {
  switch (action) {
    case 'profile': showProfile(); break;
    case 'moments': showMoments(); break;
    case 'remark': handleSetRemark(); break;
    case 'clear': handleClearChat(); break;
    case 'rematch': startNewMatch(); break;
  }
}

// --- My Profile (用户自己资料) ---

const USER_AVATAR_URL = 'https://api.dicebear.com/9.x/lorelei/svg?seed=myprofile&size=128&backgroundColor=b6e3f4&radius=12';

async function showMyProfile() {
  const profile = await getUserProfile() || {};
  const avatarSrc = profile.avatar || USER_AVATAR_URL;
  document.getElementById('my-profile-avatar').src = avatarSrc;
  document.getElementById('my-profile-name').textContent = profile.nickname || '未设置';
  document.getElementById('my-nickname-text').textContent = profile.nickname || '点击设置';
  document.getElementById('my-bio-text').textContent = profile.bio || '点击设置';
  document.getElementById('my-mbti-text').textContent = profile.mbti || '未设置';
  document.getElementById('my-profile-panel').classList.remove('hidden');
}

async function changeMyAvatar() {
  const profile = await getUserProfile() || {};
  const choice = prompt('换头像方式：\n1 - 随机生成新头像\n2 - 上传图片\n\n输入 1 或 2：', '1');
  if (choice === null) return;

  if (choice.trim() === '2') {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { alert('图片不能超过 2MB'); return; }
      const reader = new FileReader();
      reader.onload = async (ev) => {
        profile.avatar = ev.target.result;
        await saveUserProfile(profile);
        document.getElementById('my-profile-avatar').src = profile.avatar;
        refreshUserAvatar();
      };
      reader.readAsDataURL(file);
    };
    input.click();
  } else {
    const seed = `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const styles = ['lorelei', 'adventurer', 'avataaars', 'notionists', 'micah', 'open-peeps'];
    const style = styles[Math.floor(Math.random() * styles.length)];
    const bgColors = ['b6e3f4', 'c0aede', 'ffd5dc', 'ffdfbf', 'd1d4f9'];
    const bg = bgColors[Math.floor(Math.random() * bgColors.length)];
    profile.avatar = `https://api.dicebear.com/9.x/${style}/svg?seed=${seed}&size=128&backgroundColor=${bg}&radius=12`;
    await saveUserProfile(profile);
    document.getElementById('my-profile-avatar').src = profile.avatar;
    refreshUserAvatar();
  }
}

async function editMyNickname() {
  const profile = await getUserProfile() || {};
  const name = prompt('设置你的昵称：', profile.nickname || '');
  if (name === null) return;
  profile.nickname = name.trim() || '';
  await saveUserProfile(profile);
  document.getElementById('my-nickname-text').textContent = profile.nickname || '点击设置';
  document.getElementById('my-profile-name').textContent = profile.nickname || '未设置';
}

async function editMyBio() {
  const profile = await getUserProfile() || {};
  const bio = prompt('设置你的个性签名：', profile.bio || '');
  if (bio === null) return;
  profile.bio = bio.trim() || '';
  await saveUserProfile(profile);
  document.getElementById('my-bio-text').textContent = profile.bio || '点击设置';
}

async function editMyMBTI() {
  const profile = await getUserProfile() || {};
  const mbti = prompt('你的 MBTI 类型（如 INFP）：', profile.mbti || '');
  if (mbti === null) return;
  const upper = (mbti.trim() || '').toUpperCase();
  if (upper && !/^[EI][SN][TF][JP]$/.test(upper)) {
    alert('格式不对，请输入4个字母如 INFP');
    return;
  }
  profile.mbti = upper;
  await saveUserProfile(profile);
  document.getElementById('my-mbti-text').textContent = upper || '未设置';
}

// --- My Moments (我的朋友圈) ---

let pendingMomentImage = null;

async function showMyMoments() {
  document.getElementById('my-profile-panel').classList.add('hidden');

  const profile = await getUserProfile() || {};
  const avatarSrc = profile.avatar || USER_AVATAR_URL;
  document.getElementById('my-moments-avatar').src = avatarSrc;
  document.getElementById('my-moments-nickname').textContent = profile.nickname || '我';

  const moments = await getUserMoments();
  const listEl = document.getElementById('my-moments-list');
  listEl.innerHTML = '';

  if (moments.length === 0) {
    listEl.innerHTML = '<div style="text-align:center;color:#999;padding:40px;">还没有朋友圈，点右上角 + 发一条吧</div>';
  }

  moments.forEach((m) => {
    const item = document.createElement('div');
    item.className = 'moment-item';
    const timeStr = formatMomentTime(m.createdAt);

    let imgHtml = '';
    if (m.image) {
      imgHtml = `<img class="msg-bubble-image" src="${m.image}" alt="" style="margin-top:6px;">`;
    }

    let aiHtml = '';
    if (m.aiReaction) {
      aiHtml = `<div class="moment-ai-reaction">${m.aiReaction}</div>`;
    }

    item.innerHTML = `
      <img class="moment-avatar" src="${avatarSrc}" alt="">
      <div class="moment-content">
        <div class="moment-name">${profile.nickname || '我'}</div>
        <div class="moment-text">${m.text || ''}</div>
        ${imgHtml}
        <div class="moment-meta">
          <span class="moment-time">${timeStr}</span>
          <button class="moment-delete-btn" data-moment-id="${m.id}">删除</button>
        </div>
        ${aiHtml}
      </div>
    `;
    listEl.appendChild(item);
  });

  // Delete button event delegation
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.moment-delete-btn');
    if (!btn) return;
    const id = Number(btn.dataset.momentId);
    if (!confirm('删除这条朋友圈？')) return;
    await deleteUserMoment(id);
    await showMyMoments();
  });

  document.getElementById('my-moments-panel').classList.remove('hidden');
}

function openMomentCompose() {
  document.getElementById('moment-text').value = '';
  pendingMomentImage = null;
  document.getElementById('moment-image-preview').classList.add('hidden');
  document.getElementById('moment-compose').classList.remove('hidden');
}

function handleMomentImageSelect(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    alert('图片不能超过 2MB');
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    pendingMomentImage = ev.target.result;
    document.getElementById('moment-preview-img').src = pendingMomentImage;
    document.getElementById('moment-image-preview').classList.remove('hidden');
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

async function submitMoment() {
  const text = document.getElementById('moment-text').value.trim();
  if (!text && !pendingMomentImage) {
    alert('请输入内容或添加图片');
    return;
  }
  const moment = { text, image: pendingMomentImage || null };
  await addUserMoment(moment);
  document.getElementById('moment-compose').classList.add('hidden');
  await showMyMoments();
}

// --- Stats board (simulated data) ---

function initStatsBoard() {
  const launchDate = new Date('2026-04-20').getTime();
  const now = Date.now();
  const daysSinceLaunch = Math.max(1, (now - launchDate) / 86400000);

  // 基于时间的缓慢增长 + 随机波动
  const baseUsers = Math.floor(daysSinceLaunch * 38 + 127);
  const baseMatches = Math.floor(baseUsers * 2.3 + 45);
  const baseMessages = Math.floor(baseMatches * 28 + 890);

  const jitter = () => Math.floor(Math.random() * 20 - 10);

  const users = baseUsers + jitter();
  const matches = baseMatches + jitter() * 3;
  const messages = baseMessages + jitter() * 15;

  animateCounter('stat-users', users);
  animateCounter('stat-matches', matches);
  animateCounter('stat-messages', messages);
}

function animateCounter(id, target) {
  const el = document.getElementById(id);
  const duration = 1200;
  const start = Date.now();
  const from = Math.floor(target * 0.6);

  function tick() {
    const elapsed = Date.now() - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.floor(from + (target - from) * eased);
    el.textContent = current.toLocaleString();
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// --- Announcement modal ---
function showAnnouncement() {
  const modal = document.getElementById('announcement-modal');
  modal.classList.remove('hidden');

  document.getElementById('btn-close-modal').addEventListener('click', () => {
    modal.classList.add('hidden');
  }, { once: true });
}

// --- Init ---
async function init() {
  initAllSelectors();
  setupChatListeners();
  initEmojiPanel(emojiPanel, inputEl);

  // 多页导航
  document.getElementById('btn-to-ai-select').addEventListener('click', () => {
    showView(viewAiSelect);
  });
  document.getElementById('btn-to-chat-list').addEventListener('click', () => {
    showChatList();
  });
  document.getElementById('btn-back-to-landing').addEventListener('click', () => {
    showView(viewLanding);
  });
  document.getElementById('btn-to-user-profile').addEventListener('click', () => {
    showView(viewUserProfile);
  });
  document.getElementById('btn-back-to-ai-select').addEventListener('click', () => {
    showView(viewAiSelect);
  });

  btnFind.addEventListener('click', startLoading);
  btnBack.addEventListener('click', goBackToChatList);

  // Chat list: new match
  document.getElementById('btn-new-match').addEventListener('click', () => {
    showView(viewAiSelect);
  });

  // Dropdown menu
  btnMore.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown();
  });

  document.querySelectorAll('.dropdown-item').forEach((item) => {
    item.addEventListener('click', () => handleDropdownAction(item.dataset.action));
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!dropdownMenu.contains(e.target) && e.target !== btnMore) {
      closeDropdown();
    }
  });

  // Profile panel close + remark button
  document.getElementById('btn-close-profile').addEventListener('click', () => {
    document.getElementById('profile-panel').classList.add('hidden');
  });

  document.getElementById('profile-remark-btn').addEventListener('click', async () => {
    document.getElementById('profile-panel').classList.add('hidden');
    await handleSetRemark();
  });

  // Moments panel close
  document.getElementById('btn-close-moments').addEventListener('click', () => {
    document.getElementById('moments-panel').classList.add('hidden');
  });

  // My profile: click own avatar
  setMyAvatarClickHandler(showMyProfile);

  document.getElementById('btn-close-my-profile').addEventListener('click', () => {
    document.getElementById('my-profile-panel').classList.add('hidden');
  });
  document.getElementById('my-profile-avatar').addEventListener('click', changeMyAvatar);
  document.getElementById('my-profile-avatar').style.cursor = 'pointer';
  document.getElementById('my-edit-nickname').addEventListener('click', editMyNickname);
  document.getElementById('my-edit-bio').addEventListener('click', editMyBio);
  document.getElementById('my-edit-mbti').addEventListener('click', editMyMBTI);
  document.getElementById('btn-my-moments').addEventListener('click', showMyMoments);

  // My moments panel
  document.getElementById('btn-close-my-moments').addEventListener('click', () => {
    document.getElementById('my-moments-panel').classList.add('hidden');
  });
  document.getElementById('btn-new-moment').addEventListener('click', openMomentCompose);

  // Moment compose
  document.getElementById('moment-add-image').addEventListener('click', () => {
    document.getElementById('moment-image-input').click();
  });
  document.getElementById('moment-image-input').addEventListener('change', handleMomentImageSelect);
  document.getElementById('moment-cancel-img').addEventListener('click', () => {
    pendingMomentImage = null;
    document.getElementById('moment-image-preview').classList.add('hidden');
  });
  document.getElementById('moment-cancel').addEventListener('click', () => {
    document.getElementById('moment-compose').classList.add('hidden');
  });
  document.getElementById('moment-submit').addEventListener('click', submitMoment);

  btnEmoji.addEventListener('click', togglePanel);
  document.getElementById('messages').addEventListener('click', closePanel);

  // Pre-fill user nickname if exists
  const savedProfile = await getUserProfile();
  if (savedProfile?.nickname) {
    document.getElementById('user-nickname').value = savedProfile.nickname;
  }

  initStatsBoard();
  showAnnouncement();
  await migrateOldSessions();

  const sessions = await getAllSessions();
  if (sessions.length > 0) {
    document.getElementById('btn-to-chat-list').classList.remove('hidden');
  }

  startBackgroundProactive();
}

init();
