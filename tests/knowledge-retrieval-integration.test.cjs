const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

test('the chat API retrieves normalized model identifiers without contacting embeddings', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'oe-model-retrieval-'));
  const productDir = join(workdir, 'knowledge-base', 'products');
  await mkdir(productDir, { recursive: true });
  await writeFile(join(productDir, 'fl.md'), '# RCB S1-FL\n\nS1-FL 合成测试资料。');
  await writeFile(join(productDir, 's1.md'), '# RCB S1\n\nS1 合成测试资料。');
  let embeddingCalls = 0;
  const provider = createServer(async (request, response) => {
    for await (const _ of request) { /* Consume the model request. */ }
    if (request.url === '/v1/embeddings') embeddingCalls += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '{"answer":"合成答复","needs_human":false}' } }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [join(__dirname, '..', 'server.js')], {
    cwd: workdir,
    env: { ...process.env, RCB_ALLOW_ENV_OVERRIDES: 'true', PORT: String(port),
      RAG_PROVIDER: 'openai', OPENAI_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
      OPENAI_API_KEY: 'test-only', RAG_EMBEDDING_ENABLED: 'true', WEB_SEARCH_ENABLED: 'false' },
    stdio: 'ignore', windowsHide: true
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* Starting. */ }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    assert.ok(Date.now() < deadline, 'The isolated server did not start');
    for (const question of ['s1fl', 'S1-FL', 's1 fl']) {
      const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }) });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(result.sources.map(source => source.title), ['RCB S1-FL'], question);
    }
    const unknown = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 's1f1' }) }).then(response => response.json());
    assert.deepEqual(unknown.sources, []);
    assert.equal(embeddingCalls, 0);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await new Promise(resolve => provider.close(resolve));
    await rm(workdir, { recursive: true, force: true });
  }
});
