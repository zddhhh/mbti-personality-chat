// Auto-detect: use local proxy in dev, Vercel API in production
const API_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : '/api/chat';

/**
 * 发送聊天请求（非流式）
 */
export async function sendChat(messages) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen-plus', messages, stream: false }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 错误 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}
