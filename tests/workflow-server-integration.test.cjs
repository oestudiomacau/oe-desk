const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, rm } = require('node:fs/promises');
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
  const fakeModel = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    for await (const _chunk of request) { /* consume request body */ }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '这是工作流生成的答复###这是第二段答复' } }] }));
  });
  const fakeModelPort = await listen(fakeModel);
  const portProbe = createServer();
  const appPort = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  const dataDir = await mkdtemp(join(tmpdir(), 'oe-desk-workflow-'));
  const root = join(__dirname, '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      RCB_ALLOW_ENV_OVERRIDES: 'true',
      PORT: String(appPort),
      RCB_DATA_DIR: dataDir,
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
    assert.equal(config.state.flows[0].enabled, true);
    assert.equal(config.validations['default-customer-reply'].valid, true);

    await json(`${base}/api/xianyu/listener`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connected: true, listening: true, replyMode: 'full_auto' })
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
    assert.deepEqual(run.steps.map(step => step.nodeType), ['trigger', 'rag', 'condition', 'reply']);
    assert.ok(run.steps.every(step => step.status === 'completed'));

    const outbox = await json(`${base}/api/xianyu/outbox?conversationId=workflow-test-conversation`);
    assert.equal(outbox.messages.length, 2, 'The real reply node must queue both ### delivery segments.');
    assert.ok(outbox.messages.every(item => item.conversationId === 'workflow-test-conversation'));
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
