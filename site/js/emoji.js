// 常用表情集合，按类别分组
const EMOJI_GROUPS = [
  {
    name: '常用',
    emojis: [
      '😊', '😂', '🤣', '😍', '🥰', '😘', '😭', '😅',
      '😆', '😏', '🙃', '😌', '😢', '😤', '🥺', '😳',
      '🤔', '😎', '🤗', '😴', '🥱', '😑', '🙄', '😬',
      '👍', '👎', '👌', '✌️', '🤝', '👏', '💪', '🙏',
    ],
  },
  {
    name: '表情',
    emojis: [
      '❤️', '💔', '💕', '✨', '🔥', '💯', '🎉', '🎊',
      '😈', '👻', '💀', '🤡', '😇', '🥳', '🤩', '😋',
      '🤮', '🤧', '😷', '🤒', '😵', '🫠', '🫣', '🫡',
      '🐶', '🐱', '🐼', '🐷', '🌹', '🌸', '☀️', '🌙',
    ],
  },
  {
    name: '手势',
    emojis: [
      '👋', '🤙', '🤟', '🤘', '👆', '👇', '👈', '👉',
      '✊', '👊', '🫶', '🫰', '🤌', '🤏', '☝️', '🫵',
      '💅', '🤳', '🙌', '🫲', '🫱', '🤲', '👐', '✋',
    ],
  },
  {
    name: '日常',
    emojis: [
      '☕', '🍵', '🧋', '🍺', '🍻', '🥤', '🍔', '🍕',
      '🎵', '🎶', '📱', '💻', '🎮', '📚', '💤', '💭',
      '🏃', '🚗', '✈️', '🏠', '💼', '🎁', '📸', '🔑',
    ],
  },
];

let panelEl = null;
let inputEl = null;
let isOpen = false;

export function initEmojiPanel(panelElement, inputElement) {
  panelEl = panelElement;
  inputEl = inputElement;
  renderPanel();
}

function renderPanel() {
  panelEl.innerHTML = '';

  const tabBar = document.createElement('div');
  tabBar.className = 'emoji-tabs';

  const contentArea = document.createElement('div');
  contentArea.className = 'emoji-content';

  EMOJI_GROUPS.forEach((group, idx) => {
    const tab = document.createElement('button');
    tab.className = `emoji-tab${idx === 0 ? ' active' : ''}`;
    tab.textContent = group.emojis[0];
    tab.addEventListener('click', () => {
      tabBar.querySelectorAll('.emoji-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      showGroup(idx);
    });
    tabBar.appendChild(tab);
  });

  panelEl.appendChild(contentArea);
  panelEl.appendChild(tabBar);
  showGroup(0);

  function showGroup(index) {
    contentArea.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'emoji-grid';

    EMOJI_GROUPS[index].emojis.forEach((emoji) => {
      const btn = document.createElement('button');
      btn.className = 'emoji-item';
      btn.textContent = emoji;
      btn.addEventListener('click', () => insertEmoji(emoji));
      grid.appendChild(btn);
    });

    contentArea.appendChild(grid);
  }
}

function insertEmoji(emoji) {
  const start = inputEl.selectionStart;
  const end = inputEl.selectionEnd;
  const text = inputEl.value;
  inputEl.value = text.slice(0, start) + emoji + text.slice(end);
  inputEl.selectionStart = inputEl.selectionEnd = start + emoji.length;
  inputEl.focus();
  inputEl.dispatchEvent(new Event('input'));
}

export function togglePanel() {
  isOpen = !isOpen;
  panelEl.classList.toggle('hidden', !isOpen);
  return isOpen;
}

export function closePanel() {
  isOpen = false;
  panelEl.classList.add('hidden');
}

export function isPanelOpen() {
  return isOpen;
}
