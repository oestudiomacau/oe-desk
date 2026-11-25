const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function waitForOutput(child, text, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${text}.\n${output}`)), timeoutMs);
    const onData = chunk => {
      output += chunk.toString();
      if (output.includes(text)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolve(output);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Workflow server exited early with ${code}.\n${output}`));
    });
  });
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

(async () => {
  let modelRequestCount = 0;
  let lastModelPrompt = '';
  const fakeModel = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.headers.authorization === 'Bearer rejected-draft-key') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'rejected-draft-key' }));
      return;
    }
    lastModelPrompt = JSON.parse(body).messages?.[0]?.content || '';
    modelRequestCount += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    // Exhaust the provider-level retry. The message pipeline must schedule a
    // bounded retry itself instead of waiting for another buyer message.
    if (modelRequestCount <= 2) {
      response.end('null');
      return;
    }
    response.end(JSON.stringify({ choices: [{ message: { content: '这是工作流生成的答复###这是第二段答复' } }] }));
  });
  const fakeModelPort = await listen(fakeModel);
  const portProbe = createServer();
  const appPort = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  const dataDir = await mkdtemp(join(tmpdir(), 'oe-desk-workflow-'));
  await writeFile(join(dataDir, 'workflow-config.json'), JSON.stringify({
    version: 1,
    activeFlowId: 'default-customer-reply',
    flows: [{
      id: 'default-customer-reply', name: '旧版人工流程', enabled: true,
      nodes: [
        { id: 'old-trigger', type: 'trigger', config: { channel: '天猫' } },
        { id: 'old-rag', type: 'rag', config: {} },
        { id: 'old-reply', type: 'reply', config: { mode: '人工确认后发送' } }
      ],
      edges: [{ id: 'old-a', from: 'old-trigger', to: 'old-rag' }, { id: 'old-b', from: 'old-rag', to: 'old-reply' }]
    }]
  }), 'utf8');
  const root = join(__dirname, '..');
  const child = spawn(process.execPath, [join(root, 'server.js')], {
    cwd: dataDir,
    env: {
      ...process.env,
      RCB_ALLOW_ENV_OVERRIDES: 'true',
      PORT: String(appPort === 49830 ? 49831 : 49830),
      RCB_DESKTOP_PORT: String(appPort),
      RCB_DATA_DIR: dataDir,
      RCB_FEIGE_HISTORY_KEY: 'fixture-history-scan-key',
      RCB_DESKTOP_SETTINGS_KEY: 'fixture-desktop-settings-key',
      RAG_PROVIDER: 'openai',
      OPENAI_BASE_URL: `http://127.0.0.1:${fakeModelPort}/v1`,
      OPENAI_API_KEY: 'integration-test-only',
      OPENAI_CHAT_MODEL: 'test-model',
      RAG_EMBEDDING_ENABLED: 'false',
      WEB_SEARCH_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  try {
    await waitForOutput(child, `http://localhost:${appPort}`);
    const base = `http://127.0.0.1:${appPort}`;
    const config = await json(`${base}/api/workflow/config`);
    assert.equal(config.state.version, 2, 'The server must migrate persisted v1 canvas configuration during startup.');
    assert.equal(config.state.flows[0].enabled, true);
    assert.equal(config.validations['default-customer-reply'].valid, true);
    assert.equal(config.state.flows[0].nodes.find(node => node.type === 'trigger').config.channel, '所有已接入店铺');
    assert.equal(config.state.flows[0].nodes.find(node => node.type === 'reply').config.mode, 'AI 全托管队列');

    await json(`${base}/api/xianyu/listener`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connected: true, listening: true, replyMode: 'human_collab' })
    });
    await json(`${base}/api/xianyu/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'RCB', conversationId: 'workflow-test-conversation', externalId: 'workflow-test-message' })
    });

    let runtime;
    const deadline = Date.now() + 7000;
    do {
      await new Promise(resolve => setTimeout(resolve, 120));
      runtime = await json(`${base}/api/workflow/runtime`);
    } while (Date.now() < deadline && runtime.runs[0]?.status !== 'completed');

    const run = runtime.runs[0];
    assert.equal(run.status, 'completed', `Workflow did not complete: ${JSON.stringify(run)}`);
    assert.equal(modelRequestCount, 3, 'A failed model call must recover without another inbound message.');
    assert.deepEqual(run.steps.map(step => step.nodeType), ['trigger', 'classifier', 'rag', 'reply']);
    assert.ok(run.steps.every(step => step.status === 'completed'));

    const outbox = await json(`${base}/api/xianyu/outbox?conversationId=workflow-test-conversation`);
    assert.equal(outbox.messages.length, 2, 'The automatic reply node must queue both ### delivery segments even while the global mode is human collaboration.');
    assert.ok(outbox.messages.every(item => item.conversationId === 'workflow-test-conversation'));

    await json(`${base}/api/workflow/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        activeFlowId: 'disabled-flow',
        flows: [{
          id: 'disabled-flow', name: '临时停用流程', enabled: false,
          nodes: [
            { id: 'disabled-trigger', type: 'trigger', config: { channel: '闲鱼' } },
            { id: 'disabled-reply', type: 'reply', config: { mode: 'AI 全托管队列' } }
          ],
          edges: [{ id: 'disabled-edge', from: 'disabled-trigger', to: 'disabled-reply' }]
        }]
      })
    });
    await json(`${base}/api/xianyu/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '流程停用后仍需回复', conversationId: 'workflow-fallback-conversation', externalId: 'workflow-fallback-message' })
    });
    let fallbackMessage;
    const fallbackDeadline = Date.now() + 5000;
    do {
      await new Promise(resolve => setTimeout(resolve, 100));
      const messages = await json(`${base}/api/xianyu/messages`);
      fallbackMessage = messages.messages.find(item => item.externalId === 'workflow-fallback-message');
    } while (Date.now() < fallbackDeadline && fallbackMessage?.status !== 'auto_queued');
    assert.equal(fallbackMessage?.status, 'auto_queued', `A broken/disabled canvas must fall back to the built-in reply flow: ${JSON.stringify(fallbackMessage)}`);
    assert.equal(fallbackMessage?.workflowFallback, true);
    assert.equal(fallbackMessage?.workflowFlowId, 'default-customer-reply');
    const fallbackOutbox = await json(`${base}/api/xianyu/outbox?conversationId=workflow-fallback-conversation`);
    assert.equal(fallbackOutbox.messages.length, 2);

    const headers = { 'content-type': 'application/json', 'x-oe-desk': 'workbench' };
    const operations = (path, method, body) => json(`${base}/api/workbench/${path}`, { headers, method, body: JSON.stringify(body) });
    assert.equal((await fetch(`${base}/api/workbench/history`)).status, 403);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS0sAAAAASUVORK5CYII=';
    const [asset] = await operations('assets', 'POST', { name: '测试安装图.png', data: png });
    assert.equal((await operations('assets/' + asset.id)).data, png);
    assert.deepEqual(await operations('assets/' + asset.id, 'DELETE'), []);

    await operations('rules', 'PUT', [
      { name: '包装问答', keywords: '包装', platform: 'xianyu', action: 'reply', enabled: true, answer: '请保留原包装。' },
      { name: '售后人工', keywords: '破损', platform: 'all', action: 'handoff', enabled: true }
    ]);
    await json(`${base}/api/xianyu/reply-mode`, {
      method: 'POST', headers, body: JSON.stringify({ replyMode: 'full_auto' })
    });
    for (const [conversationId, text] of [['rule-reply', '原包装还要留吗'], ['rule-handoff', '包装破损了']]) {
      await json(`${base}/api/xianyu/messages`, {
        method: 'POST', headers, body: JSON.stringify({ text, conversationId, externalId: conversationId })
      });
    }
    const countBefore = modelRequestCount;
    let history;
    const ruleDeadline = Date.now() + 5000;
    do {
      await new Promise(resolve => setTimeout(resolve, 100));
      history = await operations('history');
    } while (Date.now() < ruleDeadline && (!history.notifications.some(item => item.conversationId === 'rule-handoff')
      || !history.history.some(item => item.conversationId === 'rule-reply' && item.status === 'auto_queued')));
    const notice = history.notifications.find(item => item.conversationId === 'rule-handoff');
    assert.equal(notice?.rule, '售后人工');
    const ruledOutbox = await json(`${base}/api/xianyu/outbox?conversationId=rule-reply`);
    assert.deepEqual(ruledOutbox.messages.map(item => item.text), ['请保留原包装。']);
    assert.deepEqual((await json(`${base}/api/xianyu/outbox?conversationId=rule-handoff`)).messages, []);
    assert.equal(modelRequestCount, countBefore);

    const post = (path, body) => json(`${base}/api/${path}`, { headers, method: 'POST', body: JSON.stringify(body) });
    const bridgePost = (path, body, extraHeaders = {}) => json(`${base}/api/feige/${path}`, { headers: { ...headers, 'x-rcb-platform-bridge': 'feige', ...extraHeaders },
      method: 'POST', body: JSON.stringify(body) });
    const sessionId = 'fg-learning-test-session';
    const conversationId = 'test-learning-conversation';
    const question = '安装教程怎么查看？';
    await post('feige/session', { sessionId, conversationId, authenticated: true, routeReady: true,
      pageUrl: 'https://im.jinritemai.com/pc_seller_v2/main/workspace' });
    await post('feige/listener', { replyMode: 'self_learning' });
    const sourceId = 'buyer-learning-id';
    const received = await post('feige/messages', { sessionId, conversationId, externalId: sourceId, text: question });
    assert.equal(received.status, 'handled');
    const sample = { sessionId, conversationId, sourceId, replyId: 'platform-seller-id',
      text: '请打开商品详情页查看安装教程。', startedAt: Date.now() };
    assert.equal((await bridgePost('human-reply', { ...sample, sourceId: 'another-conversation' })).learned, false);
    await post('feige/messages', { sessionId, conversationId, externalId: 'newer-buyer', text: '另一条新问题' });
    assert.equal((await bridgePost('human-reply', sample)).learned, true);
    assert.equal((await bridgePost('human-reply', sample)).learned, true);
    const learning = await operations('self-learning', 'GET');
    assert.equal(learning.indexed, 1);
    assert.equal(learning.published, 0);
    assert.equal(learning.samples[0].question, question);
    assert.equal(modelRequestCount, countBefore, 'Manual observation must not start the model');
    await post('feige/listener', { replyMode: 'off' });
    assert.equal((await bridgePost('human-reply', { ...sample, replyId: 'off-mode-reply' })).learned, false);
    assert.deepEqual((await json(`${base}/api/feige/outbox?sessionId=${sessionId}`)).messages, []);
    await post('feige/listener', { replyMode: 'human_collab' });
    await post('chat', { question, platform: 'douyin' });
    assert.match(lastModelPrompt, /相近人工答复的常用长度约/);
    assert.doesNotMatch(lastModelPrompt, new RegExp(sample.text));
    const published = await operations('self-learning/publish', 'POST', { id: learning.samples[0].id });
    assert.equal(published.published, 1);
    const persisted = await json(`${base}/api/training/knowledge`);
    assert.ok(persisted.categories.some(category => category.items.some(item => item.question === question && item.answer === sample.text)));
    await post('xianyu/reply-mode', { replyMode: 'self_learning' });
    const xianyuSession = { sessionId: 'xy-learning-session', conversationId: 'xy-learning-chat' };
    await post('xianyu/listener', { ...xianyuSession, connected: true, pageUrl: 'https://www.goofish.com/im' });
    const xianyuSource = { ...xianyuSession, externalId: 'xy-buyer-id', text: '在哪里买到原包装？' };
    assert.equal((await post('xianyu/messages', xianyuSource)).status, 'handled');
    assert.equal((await post('xianyu/human-reply', { ...xianyuSession, sourceId: xianyuSource.externalId,
      replyId: 'xy-seller-id', text: '请联系订单里的店铺客服。', startedAt: Date.now() })).learned, true);
    assert.equal((await operations('self-learning', 'GET')).indexed, 2);

    await post('feige/listener', { replyMode: 'self_learning' });
    const secondAccount = { sessionId: 'fg-second-account-session', conversationId: 'account-two-conversation' };
    await post('feige/session', { ...secondAccount, authenticated: true, routeReady: true,
      pageUrl: 'https://im.jinritemai.com/pc_seller_v2/main/workspace' });
    const specification = { replyId: 'old-spec', question: '合成型号 TEST991 的总长度是多少？', answer: 'TEST991 的总长度是 317mm。' };
    const existingSpec = { question: '合成型号 TEST992 的长度是多少？', answer: 'TEST992 长度是 317mm。' };
    await post('training/knowledge', existingSpec);
    const past = { ...secondAccount, pairs: [specification,
      { ...specification, replyId: 'old-personal', answer: '订单号：ORD928595，长度317mm。' },
      { ...specification, replyId: 'old-uncertain', answer: '大约 317mm，应该是。' },
      { ...specification, replyId: 'old-known', question: existingSpec.question, answer: 'TEST992 长度是 50mm。' }] };
    await assert.rejects(post('feige/learning-history', past), /403/);
    await assert.rejects(bridgePost('learning-history', { ...past, conversationId }), /会话已变化/);
    await bridgePost('learning-history', past);
    await bridgePost('learning-history', past);
    const learnedHistory = (await operations('self-learning', 'GET')).samples.filter(item => item.source === 'history');
    assert.equal(learnedHistory.length, 3);
    assert.equal(learnedHistory.filter(item => item.knowledgeId).length, 1);
    const assets = (await json(`${base}/api/training/knowledge`)).categories.flatMap(category => category.items);
    assert.equal(assets.find(item => item.question === question).answer, sample.text);
    assert.equal(assets.find(item => item.question === existingSpec.question).answer, existingSpec.answer);
    assert.equal(assets.filter(item => item.question === specification.question).length, 1);
    assert.equal(assets.find(item => item.question === specification.question).answer, specification.answer);
    assert.equal(learnedHistory.find(item => item.question === existingSpec.question).decision, 'conflict');
    assert.deepEqual((await json(`${base}/api/feige/outbox?sessionId=${secondAccount.sessionId}`)).messages, []);

    const manualFact = { question: 'TEST993 的总宽度是多少？', answer: 'TEST993 的宽度是 96mm。' };
    const manualSource = { ...secondAccount, externalId: 'new-manual-fact', text: manualFact.question };
    await post('feige/messages', manualSource);
    assert.equal((await bridgePost('human-reply', { ...secondAccount, replyId: 'new-operator-reply', sourceId: manualSource.externalId,
      text: manualFact.answer, startedAt: Date.now() })).learned, true);
    const clarification = { ...secondAccount, externalId: 'needs-year', text: '这个能装吗？' };
    await post('feige/messages', clarification);
    assert.equal((await bridgePost('human-reply', { ...secondAccount, replyId: 'operator-clarification', sourceId: clarification.externalId,
      text: '方便提供车型和年款吗？', startedAt: Date.now() })).learned, true);

    await post('feige/listener', { replyMode: 'human_collab' });
    const scan = { ...secondAccount, pairs: [
      { replyId: 'manual-scan-fact', question: 'TEST994 的厚度是多少？', answer: 'TEST994 的厚度是 12mm。' }
    ] };
    await assert.rejects(bridgePost('learning-history', scan), /会话已变化/);
    await assert.rejects(bridgePost('learning-history', scan, { 'x-rcb-feige-history-scan': 'unauthorized' }), /403/);
    const authorization = { 'x-rcb-feige-history-scan': 'fixture-history-scan-key' };
    assert.deepEqual(await bridgePost('learning-history', scan, authorization), { added: 1, published: 1 });
    assert.deepEqual(await bridgePost('learning-history', scan, authorization), { added: 0, published: 0 });
    const report = await operations('learning-assets/summary', 'POST');
    const live = report.sources.find(source => source.source === 'live');
    const historical = report.sources.find(source => source.source === 'history');
    assert.ok(live.examples.some(item => item.question === manualFact.question && item.answer === manualFact.answer));
    assert.equal(live.style, 1);
    assert.equal(historical.published, 2);
    assert.ok(historical.examples.some(item => item.question === scan.pairs[0].question));

    const learned = await operations('self-learning', 'GET');
    const item = learned.samples.find(sample => sample.question === manualFact.question);
    assert.equal(item.knowledge.answer, manualFact.answer);
    const currentBook = await json(`${base}/api/training/knowledge`);
    for (const category of currentBook.categories) {
      category.items = category.items.filter(row => row.id !== item.knowledgeId);
    }
    await json(`${base}/api/training/knowledge`, { method: 'PUT', headers, body: JSON.stringify(currentBook) });
    const afterRemoval = await operations('self-learning', 'GET');
    assert.equal(afterRemoval.samples.find(sample => sample.id === item.id).knowledge, null);
    const updatedReport = await operations('learning-assets/summary', 'POST');
    assert.ok(!updatedReport.sources.find(source => source.source === 'live').examples.some(example => example.question === manualFact.question));

    const ordinarySettings = await json(`${base}/api/settings`);
    assert.equal(ordinarySettings.openaiApiKey, undefined);
    const privateSettings = (input, extra = {}) => json(`${base}/api/settings/private`, {
      headers: { ...headers, 'x-rcb-desktop-settings': 'fixture-desktop-settings-key', ...extra },
      method: 'POST', body: JSON.stringify(input)
    });
    await assert.rejects(post('settings/private', { action: 'reveal', kind: 'model' }), /403/);
    await assert.rejects(privateSettings({ action: 'reveal', kind: 'model' }, { origin: base }), /403/);
    assert.equal((await privateSettings({ action: 'reveal', kind: 'model' })).value, 'integration-test-only');
    const probe = await privateSettings({ action: 'test', provider: 'openai', model: 'temporary-model',
      baseUrl: `http://127.0.0.1:${fakeModelPort}/v1` });
    assert.equal(probe.ok, true);
    assert.equal(probe.model, 'temporary-model');
    const badKey = await privateSettings({ action: 'test', provider: 'openai', model: 'temporary-model',
      baseUrl: `http://127.0.0.1:${fakeModelPort}/v1`, openaiApiKey: 'rejected-draft-key' });
    assert.equal(badKey.ok, false);
    assert.match(badKey.error, /HTTP 401/);
    assert.doesNotMatch(badKey.error, /rejected-draft-key/);
    assert.equal((await json(`${base}/api/settings`)).openaiChatModel, 'test-model');
    const mixed = await privateSettings({ action: 'test', provider: 'openai', model: 'test-model',
      baseUrl: 'https://example.invalid/v1' });
    assert.equal(mixed.ok, false);
    assert.match(mixed.error, /接口地址已变更/);
    await assert.rejects(post('settings', { model: 'untrusted' }), /403/);
    const savedModel = await privateSettings({ action: 'save', provider: 'openai', model: 'saved-model' });
    assert.equal(savedModel.openaiChatModel, 'saved-model');
    assert.equal(savedModel.openaiApiKey, undefined);
    assert.equal((await privateSettings({ action: 'reveal', kind: 'model' })).value, 'integration-test-only');
    console.log('workflow server integration passed');
  } finally {
    child.kill();
    await new Promise(resolve => fakeModel.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
