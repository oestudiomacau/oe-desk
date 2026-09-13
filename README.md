# RCB RAG Customer Service

This project serves the RCB customer-service UI and a local RAG API.

## What It Does

1. Loads `knowledge-base/products/*.md` and `knowledge-base/rcb-product-catalog.csv`.
2. Splits them into retrieval chunks.
3. Uses embedding similarity plus lexical retrieval when an embedding model is available.
4. Sends only the top retrieved chunks, the platform, and recent conversation context to the chat model.
5. Requires JSON output containing a customer answer, human-handoff signal, and a training-draft suggestion.

The prompt explicitly prohibits inventing fitment, price, inventory, delivery, installation, and after-sales details not present in the retrieved sources.

## Start

1. Copy `.env.example` to `.env`.
2. Configure either Ollama or an OpenAI-compatible provider.
3. Run `npm start`.
4. Open `http://localhost:3000` rather than the `file://` page.

For Ollama, install and run both a chat model and an embedding model. The default configuration expects `qwen3:8b` and `nomic-embed-text`.

For OpenAI-compatible services, set `RAG_PROVIDER=openai`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_CHAT_MODEL` in `.env`. Keep `.env` out of version control.

For DeepSeek, the included `.env` already selects `https://api.deepseek.com` and `deepseek-chat`; fill only `OPENAI_API_KEY`. DeepSeek provides chat generation but not embeddings, so `RAG_EMBEDDING_ENABLED=false` keeps retrieval lexical. Add a separate embedding provider before enabling vector retrieval.

## Web Search Fallback

Open **连接配置** from the lower-left settings button to configure the model and optional Tavily web-search API. The service searches the web only when local knowledge retrieval finds no match. Search snippets are labeled as web references and are never allowed to establish fitment, pricing, inventory, shipping, or after-sales commitments. Keys are posted only to the local service, stored in `.env`, and never returned by the settings API.

## API

- `GET /api/health` returns provider and retrieval-index status.
- `POST /api/chat` accepts `{ "question": "...", "platform": "tmall" | "douyin", "history": [] }`.
- `POST /api/reindex` regenerates the in-memory embedding index after knowledge-base edits.

## 闲鱼工作台桥接

### Electron 独立会话模式（推荐）

普通 HTML iframe 无法承载闲鱼登录态。项目现在提供 Electron 容器：

```bash
npm run electron
```

Electron 会为每个闲鱼店铺创建独立的持久化 Session（`persist:xianyu-<storeId>`），在 BrowserView 中打开 `https://www.goofish.com/im`，页面加载完成后自动注入闲鱼桥接脚本。首次使用在 Electron 窗口内完成登录；同一店铺下次启动会保留登录态。Electron 会自动复用已运行的 `npm start` 服务，不会重复监听 3000 端口；也可显式设置 `RCB_ELECTRON_EXTERNAL_SERVER=true`。

Electron 模式只先接入闲鱼，天猫和抖音仍使用各自的顶层页面入口。

店铺接入中的闲鱼工作区包含内嵌 Goofish 页面和本地消息桥接。浏览器跨域策略不允许本地页面直接读取闲鱼 DOM，因此真实消息读取需要浏览器 RPA 扩展或 Playwright 适配器。工作台会在收到消息后自动调用现有 RAG/DeepSeek 工作流：低风险且命中已核验资料的回复进入发送队列；车型适配、售后、价格库存和未命中资料的问题只生成草稿并等待人工。

- `GET /api/xianyu/status` returns bridge/listener status.
- `GET /api/xianyu/messages?since=<cursor>` returns new messages.
- `POST /api/xianyu/messages` accepts an incoming message from the RPA adapter.
- `POST /api/xianyu/reply` stores an AI or human reply in the outgoing queue.
- `POST /api/xianyu/process` runs the existing RAG workflow for a received message.
- `POST /api/xianyu/outbox/ack` marks a queue item as sent after the RPA script clicks the real send button.

使用外部 Chrome/Edge 时，请从工作台下载并重新安装 `rpa/xianyu-bridge.user.js`（当前版本 0.7.1）到 Tampermonkey/篡改猴，在闲鱼顶层聊天页登录。脚本会先为左侧会话列表建立基线；首屏已经标记为未读的会话会立即处理，后续发现任意会话的预览或未读状态变化时自动打开该会话、只同步触发变化的最后一条买家消息，并把 AI 回复精确发回该会话。工作台和桥接状态约每秒刷新，右下角状态会显示“已扫描/已同步”计数，`GET /api/xianyu/status` 的 `sessions[].diagnostics` 可用于确认监听是否真正命中。

由于闲鱼登录态属于 `goofish.com`，普通 HTML iframe 无法把已登录 DOM 交给 localhost 页面。若内嵌框显示为空白，请使用“在新标签打开”登录，并在同一浏览器安装桥接脚本；工作台右侧仍会实时显示消息、模型思考状态、风险判断和发送队列。桥接脚本会按当前闲鱼会话 ID过滤发送队列，避免把回复发到错误会话。
