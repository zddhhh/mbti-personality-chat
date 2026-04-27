const DB_NAME = 'mbti-chat-db';
const DB_VERSION = 1;

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

export async function createSession(mbti, title) {
  const db = await openDB();
  const now = Date.now();
  const session = { mbti, title: title || `${mbti} 对话`, createdAt: now, updatedAt: now };

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
  return new Promise(async (resolve, reject) => {
    const tx = db.transaction(['sessions', 'messages'], 'readwrite');
    tx.objectStore('sessions').delete(id);

    const msgStore = tx.objectStore('messages');
    const index = msgStore.index('sessionId');
    const request = index.openCursor(IDBKeyRange.only(id));
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

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
