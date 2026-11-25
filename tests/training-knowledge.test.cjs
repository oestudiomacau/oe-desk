const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer: createNetServer } = require('node:net');
const { createServer: createHttpServer } = require('node:http');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, isAbsolute } = require('node:path');
const { spawn } = require('node:child_process');

const root = join(__dirname, '..');

async function freePort() {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitForServer(url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('Timed out waiting for isolated RAG service.');
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
}

test('edited training reply is persisted and supplied to later retrieval', async () => {
  const providerRequests = [];
  const provider = createHttpServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw); providerRequests.push(payload);
    const system = payload.messages?.find(message => message.role === 'system')?.content || '';
    const isVariationRetry = system.includes('上一版答复与标准回复过于相似');
    const variedAnswer = system.includes('表格第一段')
      ? (isVariationRetry ? '我换个说法回复您，先看第一步，再补充第二步的信息。' : '表格第一段##表格第二段\n保留换行')
      : (isVariationRetry ? '麻烦发下车型、年份和原车规格，我按这些信息帮您核对。' : '请提供车型##再提供年份和原车规格，我帮您核对。');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: variedAnswer, needs_human: false }) } }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const providerPort = provider.address().port;
  const port = await freePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'oe-desk-training-'));
  const knowledgeDir = join(dataDir, 'training-knowledge');
  const knowledgePath = join(knowledgeDir, 'customer-service-training-qa.json');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), RCB_DATA_DIR: dataDir, RCB_TRAINING_KNOWLEDGE_DIR: knowledgeDir, RCB_TRAINING_KNOWLEDGE_PATH: knowledgePath, RCB_ALLOW_ENV_OVERRIDES: 'true', RAG_PROVIDER: 'openai', OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, OPENAI_API_KEY: 'test-key', OPENAI_CHAT_MODEL: 'test-model', RAG_EMBEDDING_ENABLED: 'false', WEB_SEARCH_ENABLED: 'false' },
    stdio: 'ignore'
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(url);
    const response = await fetch(`${url}/api/training/knowledge`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'XMAX 训练问答', question: 'xmax 330 怎么升级后减震', answer: '请提供车型##再提供年份和原车规格，我帮您核对。', intent: '升级咨询', platform: '天猫客户' })
    });
    assert.equal(response.status, 201);
    const saved = await response.json();
    assert.match(saved.file.replaceAll('\\', '/'), /customer-service-training-qa\.json$/);
    const savedPath = isAbsolute(saved.file) ? saved.file : join(root, saved.file);
    const savedText = await require('node:fs').promises.readFile(savedPath, 'utf8');
    const stored = JSON.parse(savedText);
    assert.equal(stored.categories.length, 1);
    assert.equal(stored.categories[0].items[0].answer, '请提供车型##再提供年份和原车规格，我帮您核对。');
    const answer = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'xmax330想升级后减震', platform: 'tmall' }) });
    assert.equal(answer.status, 200);
    const answerPayload = await answer.json();
    assert.equal(answerPayload.trace.retrieval, 'training-guided');
    assert.equal(answerPayload.answer, '麻烦发下车型、年份和原车规格，我按这些信息帮您核对。');
    assert.notEqual(answerPayload.answer, '请提供车型##再提供年份和原车规格，我帮您核对。', 'The standard reply is a semantic reference, not fixed copy.');
    assert.equal(providerRequests.length, 2, 'An exact-copy model response must trigger one variation retry.');
    const trainingSystem = providerRequests[0].messages.find(message => message.role === 'system')?.content || '';
    assert.match(trainingSystem, /请提供车型##再提供年份和原车规格，我帮您核对。/, 'The saved standard reply must be supplied as grounded model context.');
    assert.match(trainingSystem, /不能逐字照抄|自然改写/, 'The model must be told to preserve meaning while varying the wording.');
    const retrySystem = providerRequests[1].messages.find(message => message.role === 'system')?.content || '';
    assert.match(retrySystem, /必须换一种自然说法/, 'The retry must explicitly reject an exact copy of the standard reply.');
    const similar = await fetch(`${url}/api/training/knowledge`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'XMAX 类似问法', question: 'xmax330升级后减震怎么做', answer: '相似问法的独立回复', intent: '升级咨询', platform: '抖音客户' })
    });
    assert.equal(similar.status, 201);
    let library = await fetch(`${url}/api/training/knowledge`).then(response => response.json());
    assert.equal(library.categories.length, 1);
    assert.equal(library.categories[0].items.length, 2, 'Similar but different questions must remain separate rows in one category.');
    const duplicate = await fetch(`${url}/api/training/knowledge`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'XMAX 相同问法', question: 'XMAX 330，怎么升级后减震？', answer: '相同问题更新后的回复##第二段', intent: '升级咨询', platform: '闲鱼客户' })
    });
    assert.equal(duplicate.status, 201);
    library = await fetch(`${url}/api/training/knowledge`).then(response => response.json());
    assert.equal(library.categories[0].items.length, 2, 'The same normalized question must merge into its existing row.');
    assert.equal(library.categories[0].items.find(item => item.question.includes('XMAX 330')).answer, '相同问题更新后的回复##第二段');
    const editedLibrary = { ...library, categories: library.categories.map(category => ({ ...category, items: category.items.map((item, index) => ({ ...item, question: index ? item.question : 'xmax后减震升级咨询', answer: index ? item.answer : '表格第一段##表格第二段\n保留换行' })) })) };
    const updated = await fetch(`${url}/api/training/knowledge`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(editedLibrary) });
    assert.equal(updated.status, 200);
    const editedAnswer = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'xmax后减震升级咨询', platform: 'tmall' }) }).then(response => response.json());
    assert.equal(editedAnswer.answer, '我换个说法回复您，先看第一步，再补充第二步的信息。');
    const editedSystem = providerRequests.at(-1).messages.find(message => message.role === 'system')?.content || '';
    assert.match(editedSystem, /表格第一段##表格第二段\n保留换行/, 'Table edits must update the semantic reference passed to the model.');
  } finally {
    await stopChild(child);
    provider.closeAllConnections?.();
    await new Promise(resolve => provider.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
