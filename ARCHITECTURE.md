# RCB RAG 客服模块边界

## 前端

- `index.html`：页面骨架、现有工作区渲染和事件编排。DOM id 保持稳定，便于后续拆分。
- `client/import-manager.js`：浏览器文件校验、Base64 读取和 `/api/import` 调用。
- `client/prompt-skill-manager.js`：提示词/技能的创建、选择和排序纯函数。

## 后端

- `server.js`：HTTP 路由、模型调用、检索编排和静态文件服务。
- `server/knowledge-import.js`：资料格式转换、文件名/大小校验、导入目录写入。
- `knowledge-base/products/`：仓库内置商品资料。
- `knowledge-base/imported/products/`：用户导入的商品资料。
- `knowledge-base/imported/knowledge/`：用户导入的客服知识资料。

## 数据流

1. 页面选择 TXT、MD、CSV、JSON 或 XLS/XLSX。
2. `client/import-manager.js` 发送 JSON（文件 Base64）到本地 `/api/import`。
3. `server/knowledge-import.js` 将表格转换成 Markdown，并添加来源元数据。
4. 服务重新加载 Markdown，清空旧索引；后续 `/api/chat` 会检索新资料。
5. 训练场摘录仍保存在候选队列，必须人工审核，不会自动写入生产 RAG。

## 本地状态

- `rcb-prompt-settings`：一个客服总提示词 + 技能数组。
- `rcb-imported-files`：前端展示已导入文件和时间；真实内容以 `knowledge-base/imported/` 为准。
- `rcb-candidate-knowledge`：训练场候选知识。

后续新增工作区时，优先新增独立 `client/*.js` 管理器和 `server/*.js` 领域模块，再由 `index.html/server.js` 做薄编排。
