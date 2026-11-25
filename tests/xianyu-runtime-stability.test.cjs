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
      if (!output.includes(text)) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Server exited early with ${code}.\n${output}`));
    });
  });
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  return null;
}

(async () => {
  const fakeModel = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw || '{}');
    const content = payload.messages?.map(message => message.content).join('\n') || '';
    if (content.includes('慢请求')) await new Promise(resolve => setTimeout(resolve, 4200));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: content.includes('快速请求') ? '快速答复' : '慢速答复' } }] }));
  });
  const fakeModelPort = await listen(fakeModel);
  const portProbe = createServer();
  const appPort = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  const dataDir = await mkdtemp(join(tmpdir(), 'oe-desk-stability-'));
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
      OPENAI_API_KEY: 'stability-test-only',
      OPENAI_CHAT_MODEL: 'test-model',
      RAG_EMBEDDING_ENABLED: 'false',
      WEB_SEARCH_ENABLED: 'false',
      XIANYU_OUTBOX_CLAIM_LEASE_MS: '120',
      XIANYU_SESSION_FRESH_MS: '80'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  try {
    await waitForOutput(child, `http://localhost:${appPort}`);
    const base = `http://127.0.0.1:${appPort}`;
    await json(`${base}/api/xianyu/listener`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connected: true, listening: true, replyMode: 'full_auto' })
    });

    await json(`${base}/api/xianyu/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '慢请求', conversationId: 'slow-conversation', externalId: 'slow-message' })
    });
    await json(`${base}/api/xianyu/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '快速请求', conversationId: 'fast-conversation', externalId: 'fast-message' })
    });

    const fastReply = await waitFor(async () => {
      const outbox = await json(`${base}/api/xianyu/outbox?conversationId=fast-conversation`);
      return outbox.messages.find(item => item.text === '快速答复') || null;
    }, 2800);
    assert.ok(fastReply, 'One slow model request must not block automatic replies for every other conversation.');

    const manual = await json(`${base}/api/xianyu/reply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '领取恢复测试', conversationId: 'lease-conversation' })
    });
    const claimed = await json(`${base}/api/xianyu/outbox/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: manual.id, conversationId: 'lease-conversation', sessionId: 'dead-bridge' })
    });
    assert.ok(claimed.claimToken, 'Every sending claim needs an identity for safe acknowledgement recovery.');
    await new Promise(resolve => setTimeout(resolve, 180));
    const recovered = await json(`${base}/api/xianyu/outbox?conversationId=lease-conversation`);
    assert.ok(recovered.messages.some(item => item.id === manual.id), 'A claim owned by a dead bridge must return to the queue during the same server run.');

    const reclaimed = await json(`${base}/api/xianyu/outbox/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: manual.id, conversationId: 'lease-conversation', sessionId: 'live-bridge' })
    });
    const missingEvidence = await fetch(`${base}/api/xianyu/outbox/ack`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: manual.id, conversationId: 'lease-conversation', sessionId: 'live-bridge', claimToken: reclaimed.claimToken })
    });
    assert.equal(missingEvidence.status, 409, 'Composer clearing alone must never be accepted as successful platform delivery.');
    const ackBody = JSON.stringify({
      id: manual.id,
      conversationId: 'lease-conversation',
      sessionId: 'live-bridge',
      claimToken: reclaimed.claimToken,
      evidence: {
        requestObserved: true,
        platformAck: true,
        platformMid: 'runtime-test-mid',
        platformCode: 200,
        domBubble: true,
        domConversationId: 'lease-conversation'
      }
    });
    const acked = await json(`${base}/api/xianyu/outbox/ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ackBody });
    const ackedAgain = await json(`${base}/api/xianyu/outbox/ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ackBody });
    assert.equal(acked.delivery, 'sent');
    assert.equal(ackedAgain.delivery, 'sent', 'A retried acknowledgement must be idempotent after a local-service interruption.');

    const uncertain = await json(`${base}/api/xianyu/reply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '双重确认中', conversationId: 'uncertain-conversation' })
    });
    const uncertainClaim = await json(`${base}/api/xianyu/outbox/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: uncertain.id, conversationId: 'uncertain-conversation', sessionId: 'uncertain-bridge' })
    });
    await json(`${base}/api/xianyu/outbox/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: uncertain.id,
        conversationId: 'uncertain-conversation',
        sessionId: 'uncertain-bridge',
        claimToken: uncertainClaim.claimToken,
        baseline: { count: 0, fingerprints: [] },
        evidence: { requestObserved: true, platformMid: 'uncertain-mid', platformAck: false, domBubble: false }
      })
    });
    const uncertainAck = await fetch(`${base}/api/xianyu/outbox/ack`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: uncertain.id,
        conversationId: 'uncertain-conversation',
        sessionId: 'uncertain-bridge',
        claimToken: uncertainClaim.claimToken,
        evidence: {
          requestObserved: true,
          platformAck: true,
          platformMid: 'uncertain-mid',
          platformCode: 200,
          domBubble: true,
          domConversationId: 'uncertain-conversation'
        }
      })
    });
    assert.equal(uncertainAck.status, 200, 'A later platform 200 response must clear the initial no-response state and acknowledge delivery.');
    const uncertainAckPayload = await uncertainAck.json();
    assert.equal(uncertainAckPayload.delivery, 'sent');
    await new Promise(resolve => setTimeout(resolve, 180));
    const uncertainOutbox = await json(`${base}/api/xianyu/outbox?conversationId=uncertain-conversation`);
    assert.equal(uncertainOutbox.messages.some(item => item.id === uncertain.id), false, 'A verified reply must leave the retry queue after the later platform response.');

    console.log('xianyu runtime stability passed');
  } finally {
    child.kill();
    fakeModel.closeAllConnections?.();
    await new Promise(resolve => fakeModel.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
