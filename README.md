# MBTI AI Chat

An AI-powered chat app where you talk to virtual friends with distinct MBTI personalities. Each AI character behaves, responds, and even sends "moments" based on their personality type.

## Features

- **16 MBTI Personalities** - Each AI friend has unique behavior patterns, language style, and emotional responses based on their MBTI type
- **Memory System** - AI remembers facts, preferences, and events from your conversations
- **Relationship Progression** - Stranger → Acquaintance → Friend → Close Friend, with intimacy and affection tracking
- **Proactive Messaging** - AI friends may message you first (extroverts more often than introverts)
- **AI-Generated Avatars** - Characters generate their own profile pictures using text-to-image AI
- **Moments/Timeline** - AI friends post to their "moments" and interact with yours
- **Image Sharing** - AI can search and send relevant images during conversation
- **Multi-message Replies** - AI can send multiple messages in sequence, simulating real chat patterns
- **Zero Build** - Pure HTML + CSS + JS (ES Modules), no bundler needed

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (ES Modules) |
| Backend Proxy | Cloudflare Pages Functions |
| LLM | Qwen (DashScope compatible API) |
| Image Generation | Wanx 2.6 (text-to-image) |
| Storage | IndexedDB (browser-local) |
| Deployment | Cloudflare Pages / Vercel |

## Project Structure

```
personality/
├── site/                  # Frontend static files
│   ├── index.html         # Single-page app entry
│   ├── css/style.css      # Global styles
│   ├── img/               # Static images
│   └── js/
│       ├── app.js         # Router & page transitions
│       ├── chat.js        # Chat engine: messaging, streaming, command parsing
│       ├── agent.js       # AI brain: memory, relationships, proactive messages
│       ├── mbti.js        # MBTI personality engine & prompt generation
│       ├── storage.js     # IndexedDB wrapper (v5)
│       ├── emoji.js       # Emoji picker
│       └── api.js         # API communication layer
├── functions/api/         # Cloudflare Pages Functions
│   ├── chat.js            # Chat proxy (injects API key, forwards to LLM)
│   └── avatar.js          # Avatar generation proxy (text-to-image)
├── worker/                # Alternative: Cloudflare Worker deployment
│   ├── index.js           # Worker proxy script
│   ├── wrangler.toml      # Wrangler config
│   └── .dev.vars.example  # Environment variables template
├── api/                   # Alternative: Vercel serverless function
│   └── chat.js
├── architecture.md        # Detailed system architecture diagram
├── vercel.json            # Vercel deployment config
└── LICENSE                # MIT License
```

## Getting Started

### Prerequisites

- A DashScope API key (for Qwen LLM access)
- Node.js (for local dev server and Wrangler CLI)

### Local Development

1. Clone the repo:

```bash
git clone https://github.com/YOUR_USERNAME/mbti-ai-chat.git
cd mbti-ai-chat
```

2. Start a local server for the frontend:

```bash
cd site
npx serve .
```

3. Set up the API proxy (choose one):

**Option A: Cloudflare Pages Functions (recommended)**

```bash
cp worker/.dev.vars.example worker/.dev.vars
# Edit .dev.vars and add your DashScope API key
npx wrangler pages dev site --binding API_KEY=sk-your-key-here
```

**Option B: Cloudflare Worker**

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars
# Edit .dev.vars and add your API key
wrangler dev
```

**Option C: Vercel**

```bash
vercel dev
```

### Deployment

**Cloudflare Pages:**

```bash
# Deploy frontend + functions
npx wrangler pages deploy site --project-name mbti-ai-chat
# Set API key as secret
npx wrangler pages secret put API_KEY --project-name mbti-ai-chat
```

**Vercel:**

```bash
vercel --prod
# Set environment variable API_KEY in Vercel dashboard
```

## Architecture

See [architecture.md](architecture.md) for a detailed system architecture diagram covering:

- 4-layer System Prompt construction (personality + user context + long-term memory + relationship state)
- Agent brain (memory extraction, relationship progression, proactive messaging)
- Command system (`||SPLIT||`, `||AVATAR:x||`, `||MOMENT:x||`, `||IMAGE:x||`)
- Full data flow for a single conversation turn

## License

[MIT](LICENSE)
