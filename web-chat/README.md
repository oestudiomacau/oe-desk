# OE DESK 网页客服

GitHub Pages 从 `web-chat/public` 发布网页。网页通过 `/api/chat` 提交问题与当前对话最近 24 条消息，再用该请求的随机凭据查询或取消。Sites 上的 Worker 用 D1 暂存请求，由本地 OE DESK 主动发起 HTTPS 连接取回。网页和本地服务的 `/api/chat` 共用 `answerQuestion`，使用当前的知识库、训练问答、总提示词与启用技能。网页提示语会引导客户回原购买平台处理订单和售后操作。

## 配置本地连接

1. 将 `backend/worker.js` 用作 Sites 的 Worker 入口，给站点绑定 D1（绑定名 `DB`），部署时应用 `backend/drizzle` 的迁移。
2. 在 Sites 中设置机密变量 `LOCAL_CONNECTOR_TOKEN`，值为 32 个随机字节的十六进制编码。
3. 在 OE DESK 的 `data/public-chat-connector.json` 写入以下内容。如果设置了 `RCB_DATA_DIR`，使用该目录。文件由 Git 忽略。

```json
{
  "endpoint": "https://oe-desk-chat-api.exquisiteclove2.chatgpt.site",
  "token": "填入与 Sites 相同的 LOCAL_CONNECTOR_TOKEN"
}
```

4. 执行 `npm run electron`，或运行 `npm start` 启动本地服务。访问本机 `http://127.0.0.1:3000/api/public-chat/status` 检查 `connected`。旧进程异常退出后，重新连接最多需等待约 30 秒。

公开网页需要本地服务与模型服务保持运行。网页只收到客户答复，访客会话留在当前标签页。网关限制请求大小、提交频率和并发队列。排队请求有效期为三分钟，过期记录由本地连接器轮询时清理。

## 网页训练场

访客可以打开「训练场」提交客户问法和建议答复，也可以从某条 AI 回复进入「改进这条答复」。建议保存在网关，OE DESK 离线时也可提交，待审核建议保留最多 30 天。

在本地 OE DESK 左侧打开「网页训练建议」，核对或修改答复后采纳，也可以丢弃。采纳会写入本地客服知识并重新加载检索。
