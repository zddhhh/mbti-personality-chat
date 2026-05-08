const DB_NAME = 'mbti-chat-db';
const DB_VERSION = 5;

let dbInstance = null;

function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('sessions')) {
        const sessionStore = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
        sessionStore.createIndex('updatedAt', 'updatedAt');
      }

      if (!db.objectStoreNames.contains('messages')) {
        const messageStore = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
        messageStore.createIndex('sessionId', 'sessionId');
      }

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }

      // Agent 长期记忆：存储从对话中提取的关键信息
      if (!db.objectStoreNames.contains('memories')) {
        const memStore = db.createObjectStore('memories', { keyPath: 'id', autoIncrement: true });
        memStore.createIndex('sessionId', 'sessionId');
        memStore.createIndex('type', 'type');
        memStore.createIndex('createdAt', 'createdAt');
      }

      // Agent 状态：好感度、亲密度、情绪等
      if (!db.objectStoreNames.contains('agent_state')) {
        db.createObjectStore('agent_state', { keyPath: 'sessionId' });
      }

      // 用户个人资料
      if (!db.objectStoreNames.contains('user_profile')) {
        db.createObjectStore('user_profile', { keyPath: 'key' });
      }

      // 用户朋友圈
      if (!db.objectStoreNames.contains('user_moments')) {
        const momentsStore = db.createObjectStore('user_moments', { keyPath: 'id', autoIncrement: true });
        momentsStore.createIndex('createdAt', 'createdAt');
      }

      // AI 朋友圈
      if (!db.objectStoreNames.contains('ai_moments')) {
        const aiMomentsStore = db.createObjectStore('ai_moments', { keyPath: 'id', autoIncrement: true });
        aiMomentsStore.createIndex('createdAt', 'createdAt');
        aiMomentsStore.createIndex('sessionId', 'sessionId');
      } else if (event.oldVersion < 5) {
        const aiMomentsStore = event.target.transaction.objectStore('ai_moments');
        if (!aiMomentsStore.indexNames.contains('sessionId')) {
          aiMomentsStore.createIndex('sessionId', 'sessionId');
        }
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

// --- Sessions ---

export async function createSession(mbti, profile = {}) {
  const db = await openDB();
  const now = Date.now();
  const session = {
    mbti,
    title: profile.nickname || `${mbti} 对话`,
    createdAt: now,
    updatedAt: now,
    profile, // { nickname, avatar, gender, mbti, isSpokesperson }
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    const request = store.add(session);
    request.onsuccess = () => {
      session.id = request.result;
      resolve(session);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getAllSessions() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readonly');
    const store = tx.objectStore('sessions');
    const index = store.index('updatedAt');
    const request = index.openCursor(null, 'prev');
    const results = [];
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getSession(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readonly');
    const request = tx.objectStore('sessions').get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function updateSession(id, updates) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const session = { ...getReq.result, ...updates, updatedAt: Date.now() };
      const putReq = store.put(session);
      putReq.onsuccess = () => resolve(session);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function deleteSession(id) {
  const db = await openDB();
  const stores = ['sessions', 'messages', 'memories', 'agent_state', 'ai_moments'];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.objectStore('sessions').delete(id);
    tx.objectStore('agent_state').delete(id);

    // Delete by sessionId index for messages, memories, ai_moments
    for (const storeName of ['messages', 'memories', 'ai_moments']) {
      const store = tx.objectStore(storeName);
      const idx = store.index('sessionId');
      const req = idx.openCursor(IDBKeyRange.only(id));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Messages ---

export async function addMessage(sessionId, role, content) {
  const db = await openDB();
  const message = { sessionId, role, content, timestamp: Date.now() };

  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    const request = tx.objectStore('messages').add(message);
    request.onsuccess = () => {
      message.id = request.result;
      resolve(message);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getMessagesBySession(sessionId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readonly');
    const index = tx.objectStore('messages').index('sessionId');
    const request = index.getAll(IDBKeyRange.only(sessionId));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getLastMessageBySession(sessionId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readonly');
    const idx = tx.objectStore('messages').index('sessionId');
    const req = idx.openCursor(IDBKeyRange.only(sessionId), 'prev');
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      resolve(cursor ? cursor.value : null);
    };
    req.onerror = () => reject(req.error);
  });
}

// --- Settings ---

export async function getSetting(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readonly');
    const request = tx.objectStore('settings').get(key);
    request.onsuccess = () => resolve(request.result?.value);
    request.onerror = () => reject(request.error);
  });
}

export async function setSetting(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readwrite');
    const request = tx.objectStore('settings').put({ key, value });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// --- Memories (长期记忆) ---

export async function addMemory(sessionId, type, content, metadata = {}) {
  const db = await openDB();
  const memory = { sessionId, type, content, metadata, createdAt: Date.now() };
  return new Promise((resolve, reject) => {
    const tx = db.transaction('memories', 'readwrite');
    const req = tx.objectStore('memories').add(memory);
    req.onsuccess = () => { memory.id = req.result; resolve(memory); };
    req.onerror = () => reject(req.error);
  });
}

export async function getMemoriesBySession(sessionId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('memories', 'readonly');
    const req = tx.objectStore('memories').index('sessionId').getAll(IDBKeyRange.only(sessionId));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- Agent State (关系/情绪状态) ---

const DEFAULT_STATE = {
  intimacy: 0,       // 亲密度 0-100
  favorability: 50,  // 好感度 0-100
  mood: 'neutral',   // 当前情绪：happy/neutral/bored/annoyed
  messageCount: 0,   // 总消息数
  lastActiveAt: 0,   // 上次活跃时间
  topics: [],        // 聊过的话题关键词
  phase: 'stranger', // 关系阶段：stranger/acquaintance/friend/close_friend
};

export async function getAgentState(sessionId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('agent_state', 'readonly');
    const req = tx.objectStore('agent_state').get(sessionId);
    req.onsuccess = () => resolve(req.result || { sessionId, ...DEFAULT_STATE });
    req.onerror = () => reject(req.error);
  });
}

export async function updateAgentState(sessionId, updates) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('agent_state', 'readwrite');
    const store = tx.objectStore('agent_state');
    const getReq = store.get(sessionId);
    getReq.onsuccess = () => {
      const current = getReq.result || { sessionId, ...DEFAULT_STATE };
      const updated = { ...current, ...updates };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve(updated);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// --- User Profile ---

export async function getUserProfile() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('user_profile', 'readonly');
    const req = tx.objectStore('user_profile').get('profile');
    req.onsuccess = () => resolve(req.result?.value || null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveUserProfile(profile) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('user_profile', 'readwrite');
    const req = tx.objectStore('user_profile').put({ key: 'profile', value: profile });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// --- User Moments (朋友圈) ---

export async function addUserMoment(moment) {
  const db = await openDB();
  const record = { ...moment, createdAt: Date.now(), aiRead: false };
  return new Promise((resolve, reject) => {
    const tx = db.transaction('user_moments', 'readwrite');
    const req = tx.objectStore('user_moments').add(record);
    req.onsuccess = () => { record.id = req.result; resolve(record); };
    req.onerror = () => reject(req.error);
  });
}

export async function getUserMoments() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('user_moments', 'readonly');
    const idx = tx.objectStore('user_moments').index('createdAt');
    const req = idx.openCursor(null, 'prev');
    const results = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { results.push(cursor.value); cursor.continue(); }
      else resolve(results);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getUnreadUserMoments() {
  const all = await getUserMoments();
  return all.filter((m) => !m.aiRead);
}

export async function deleteUserMoment(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('user_moments', 'readwrite');
    const req = tx.objectStore('user_moments').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function markMomentRead(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('user_moments', 'readwrite');
    const store = tx.objectStore('user_moments');
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      if (getReq.result) {
        const updated = { ...getReq.result, aiRead: true };
        store.put(updated);
      }
      resolve();
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// --- Export / Import ---

export async function exportData() {
  const db = await openDB();
  const getAll = (storeName) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const [sessions, messages, settings] = await Promise.all([
    getAll('sessions'),
    getAll('messages'),
    getAll('settings'),
  ]);

  return { sessions, messages, settings, exportedAt: new Date().toISOString() };
}

export async function importData(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'messages', 'settings'], 'readwrite');

    const sessionStore = tx.objectStore('sessions');
    const messageStore = tx.objectStore('messages');
    const settingStore = tx.objectStore('settings');

    sessionStore.clear();
    messageStore.clear();
    settingStore.clear();

    data.sessions?.forEach((s) => sessionStore.add(s));
    data.messages?.forEach((m) => messageStore.add(m));
    data.settings?.forEach((s) => settingStore.add(s));

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- AI 朋友圈 ---

export async function addAiMoment(text, image = null, sessionId = null) {
  const db = await openDB();
  const moment = { text, image, sessionId, createdAt: Date.now(), likes: [], comments: [] };
  return new Promise((resolve, reject) => {
    const tx = db.transaction('ai_moments', 'readwrite');
    const store = tx.objectStore('ai_moments');
    const req = store.add(moment);
    req.onsuccess = () => { moment.id = req.result; resolve(moment); };
    req.onerror = () => reject(req.error);
  });
}

export async function getAiMoments(sessionId = null) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('ai_moments', 'readonly');
    const store = tx.objectStore('ai_moments');
    if (sessionId != null) {
      const idx = store.index('sessionId');
      const req = idx.getAll(IDBKeyRange.only(sessionId));
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.createdAt - a.createdAt));
      req.onerror = () => reject(req.error);
    } else {
      const idx = store.index('createdAt');
      const req = idx.getAll();
      req.onsuccess = () => resolve(req.result.reverse());
      req.onerror = () => reject(req.error);
    }
  });
}

export async function updateAiMoment(moment) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('ai_moments', 'readwrite');
    tx.objectStore('ai_moments').put(moment);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getUnreadCount(sessionId) {
  const lastRead = await getSetting(`lastRead_${sessionId}`) || 0;
  const messages = await getMessagesBySession(sessionId);
  return messages.filter((m) => m.role === 'assistant' && m.timestamp > lastRead).length;
}

export async function markSessionRead(sessionId) {
  await setSetting(`lastRead_${sessionId}`, Date.now());
}
