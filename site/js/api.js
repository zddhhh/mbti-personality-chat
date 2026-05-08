const API_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : '/api/chat';

const TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;

async function fetchWithTimeout(url, options, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Array} messages
 * @param {string} model
 */
export async function sendChat(messages, model = 'qwen-plus') {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API 错误 (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError') {
        lastError = new Error('请求超时，请稍后重试');
      }
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}
