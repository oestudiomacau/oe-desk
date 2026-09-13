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
      response.end(JSON.stringify({ choices: [{ message: { content: '{"answer":"已生成测试答复","needs_human":false,"training":{"intent":"测试","suggested_title":"测试","suggested_content":"测试"}}' } }] }));
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
      prompt: '答复要简洁。',
      skills: [
        { id: 'fitment', name: '适配问诊', description: '先收集车型、年份和现有改装信息。', enabled: true },
        { id: 'retired', name: '停用技能', description: '这段内容绝不能出现在模型请求里。', enabled: false }
      ]
    });
    assert.equal(saved.status, 200);

    const result = await post(url, '/api/chat', { question: '这个配件能用吗？', platform: 'tmall' });
    assert.equal(result.status, 200);
    assert.equal(requests.length, 1, 'The provider must receive exactly one model request.');
    const system = requests[0].messages.find(message => message.role === 'system')?.content || '';
    assert.match(system, /适配问诊：先收集车型、年份和现有改装信息。/, 'Enabled skill guidance must reach the live model request.');
    assert.doesNotMatch(system, /停用技能|绝不能出现在模型请求里/, 'Disabled skill guidance must not reach the model request.');
    assert.deepEqual(result.body.trace.appliedSkills, ['适配问诊'], 'The response trace must identify the skills actually applied to this answer.');
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
