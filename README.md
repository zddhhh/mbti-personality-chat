# MBTI Personality Chat

基于 MBTI 人格类型的智能对话网页。用户输入自己的 MBTI 类型后，系统动态生成匹配的人格化聊天智能体，模拟真实人类性格对应的聊天方式。

## 技术架构

- **前端**：原生 HTML + CSS + JS（ES Module），零构建
- **后端代理**：Cloudflare Worker（注入 API Key，转发请求）
- **LLM**：通义千问（DashScope 兼容模式）
- **存储**：IndexedDB（本地浏览器存储）
- **部署**：GitHub Pages（前端）+ Cloudflare Worker（API 代理）

## 目录结构

```
personality/
├── site/              # 前端静态文件 → GitHub Pages
│   ├── index.html     # 单页入口
│   ├── css/style.css  # 全局样式
│   └── js/
│       ├── app.js     # 主控：路由、页面切换
│       ├── chat.js    # 聊天核心：消息收发/流式渲染
│       ├── mbti.js    # MBTI prompt 动态生成
│       ├── storage.js # IndexedDB 封装
│       └── api.js     # Worker 通信层
└── worker/
    └── index.js       # Cloudflare Worker 代理脚本
```

## 本地开发

前端是纯静态文件，任意 HTTP 服务器即可：

```bash
cd site
npx serve .
```

## 部署

1. 前端：将 `site/` 目录部署到 GitHub Pages
2. Worker：使用 Cloudflare Wrangler CLI 部署

```bash
cd worker
wrangler deploy
wrangler secret put API_KEY  # 注入通义千问 API Key
```

## 创建日期

2026-04-27
