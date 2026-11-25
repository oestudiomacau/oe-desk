const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer: createNetServer } = require('node:net');
const { createServer: createHttpServer } = require('node:http');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');

const root = join(__dirname, '..');

async function freePort() {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitForServer(url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch { /* The isolated service is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('Timed out waiting for the isolated RAG service.');
}

async function post(url, path, body) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function requestBody(request) {
  let value = '';
  for await (const chunk of request) value += chunk;
  return JSON.parse(value || '{}');
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await Promise.race([
    exited,
    new Promise(resolve => setTimeout(resolve, 2000))
  ]);
}

async function main() {
  const requests = [];
  const provider = createHttpServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      requests.push(await requestBody(request));
      response.writeHead(200, { 'content-type': 'application/json' });
      // Some OpenAI-compatible gateways intermittently acknowledge a request
      // with a JSON null body. The runtime must retry instead of dereferencing
      // `choices` on null and abandoning the customer message.
      if (requests.length === 1) {
        response.end('null');
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { content: '{"answer":"这款需要先确认车型和年份，确认原车规格后我再帮您推荐合适配件。建议先把原车照片一并发来。","needs_human":false,"training":{"intent":"测试","suggested_title":"测试","suggested_content":"测试"}}' } }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const { port: providerPort } = provider.address();

  const port = await freePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'oe-desk-prompt-skills-'));
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      RCB_DATA_DIR: dataDir,
      RCB_ALLOW_ENV_OVERRIDES: 'true',
      RAG_PROVIDER: 'openai',
      OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
      OPENAI_API_KEY: 'test-key',
      OPENAI_CHAT_MODEL: 'test-model',
      RAG_EMBEDDING_ENABLED: 'false',
      WEB_SEARCH_ENABLED: 'false'
    },
    stdio: 'ignore'
  });

  try {
    await waitForServer(url);
    const saved = await post(url, '/api/prompt-settings', {
      prompt: '答复要简洁。单次回复控制在20字以内，超过用###分隔。',
      skills: [
        { id: 'fitment', name: '适配问诊', description: '先收集车型、年份和现有改装信息。', enabled: true },
        { id: 'retired', name: '停用技能', description: '这段内容绝不能出现在模型请求里。', enabled: false }
      ]
    });
    assert.equal(saved.status, 200);

    const result = await post(url, '/api/chat', { question: '这个配件能用吗？', platform: 'tmall' });
    assert.equal(result.status, 200);
    assert.equal(requests.length, 3, 'Retry the null payload once and request one concise rewrite.');
    assert.match(requests[2].messages.at(-1).content, /每条尽量不超过 20 字/);
    const system = requests[1].messages.find(message => message.role === 'system')?.content || '';
    assert.match(system, /客服总提示词与已挂载技能是最高优先级/, 'The saved prompt and enabled skills must define the reply persona and boundaries.');
    assert.match(system, /适配问诊：先收集车型、年份和现有改装信息。/, 'Enabled skill guidance must reach the live model request.');
    assert.doesNotMatch(system, /停用技能|绝不能出现在模型请求里/, 'Disabled skill guidance must not reach the model request.');
    assert.deepEqual(result.body.trace.appliedSkills, ['适配问诊'], 'The response trace must identify the skills actually applied to this answer.');
    assert.deepEqual(result.body.basis.skills, ['适配问诊']);
    const clarification = await post(url, '/api/chat', { question: '极核 AE8 可以装吗？', platform: 'web' });
    assert.equal(clarification.body.retrieval, 'clarify-product');
    assert.deepEqual(clarification.body.basis.skills, []);
    const deliveryParts = result.body.answer.split('###');
    assert.equal(deliveryParts.length, 2, 'A longer answer with two sentences must split into readable deliveries.');
    assert.deepEqual(deliveryParts, ['这款需要先确认车型和年份，确认原车规格后我再帮您推荐合适配件。', '建议先把原车照片一并发来。'], 'Automatic splitting must prefer a complete sentence over a comma boundary.');
    assert.ok(deliveryParts.every(part => !/[，,]$/.test(part)), 'Automatic splitting must never leave a comma at the end of a delivery part.');
    assert.equal(deliveryParts.join(''), '这款需要先确认车型和年份，确认原车规格后我再帮您推荐合适配件。建议先把原车照片一并发来。', 'Automatic splitting must preserve the complete reply without truncation.');

    const contextResult = await post(url, '/api/chat', {
      question: '不发',
      platform: 'xianyu',
      history: [
        { role: 'user', content: '爆炸了怎么办' },
        { role: 'assistant', content: '先确认有没有受伤，我帮您上报处理。' },
        { role: 'user', content: '没有受伤，赔钱吧' }
      ]
    });
    const contextSystem = requests.at(-1).messages.find(message => message.role === 'system')?.content || '';
    assert.match(contextSystem, /客户当前目的：安全事故\/故障处置、售后与赔付/, 'Recent conversation turns must keep the safety and compensation purpose.');
    assert.match(contextSystem, /不得机械重复同一问题/, 'A refused detail must not trigger a repeated vehicle/year question.');
    assert.doesNotMatch(contextResult.body.answer, /请补充车型|请提供车型/, 'A safety/compensation follow-up must not fall back to a blind vehicle/year question.');
    for (const [question, expected] of [
      ['怎么升级刹车', '升级/商品推荐'],
      ['我没有受伤 我要问刹车', '商品咨询'],
      ['我要退款', '售后与赔付']
    ]) {
      const next = await post(url, '/api/chat', { question, platform: 'douyin', history: [
        { role: 'user', content: '刹车爆开了，炸到我了' },
        { role: 'assistant', content: '请先离开车子。' }
      ] });
      assert.equal(next.body.trace.conversationPurpose, expected);
      assert.ok(!requests.at(-1).messages.some(message => message.content === '请先离开车子。'));
    }
  } finally {
    await stopChild(child);
    provider.closeAllConnections?.();
    await new Promise(resolve => provider.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().then(() => console.log('prompt skill runtime regression passed')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
