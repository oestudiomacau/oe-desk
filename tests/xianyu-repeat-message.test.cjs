const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const root = join(__dirname, '..');

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitForServer(process, url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch { /* The child is still starting. */ }
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

async function main() {
  const { coalescePendingXianyuMessages, splitXianyuReplyForDelivery, supersedeQueuedAutoReplies } = await import(pathToFileURL(join(root, 'server', 'xianyu-message-queue.js')).href);
  const backlog = [
    { id: 'backlog-1', direction: 'in', conversationId: 'buyer-a', status: 'received', createdAtMs: 1000 },
    { id: 'backlog-2', direction: 'in', conversationId: 'buyer-a', status: 'received', createdAtMs: 1001 },
    { id: 'other-buyer', direction: 'in', conversationId: 'buyer-b', status: 'received', createdAtMs: 1002 }
  ];
  const latest = coalescePendingXianyuMessages(backlog, 2000);
  assert.deepEqual(latest.map(message => message.id).sort(), ['backlog-2', 'other-buyer']);
  assert.equal(backlog[0].status, 'superseded', 'Earlier messages in one burst must not generate their own replies.');
  assert.equal(backlog[0].supersededBy, 'backlog-2');

  const autoSource = { id: 'auto-source', direction: 'in', conversationId: 'buyer-a', status: 'auto_queued' };
  const queuedReplies = [
    { id: 'auto-reply', direction: 'out', conversationId: 'buyer-a', origin: 'auto', delivery: 'queued', sourceMessageId: 'auto-source' },
    { id: 'manual-reply', direction: 'out', conversationId: 'buyer-a', origin: 'manual', delivery: 'queued' }
  ];
  const invalidated = supersedeQueuedAutoReplies(queuedReplies, [autoSource], 'buyer-a', 'backlog-2', 3000);
  assert.deepEqual(invalidated.map(reply => reply.id), ['auto-reply']);
  assert.equal(queuedReplies[0].delivery, 'superseded');
  assert.equal(autoSource.status, 'superseded');
  assert.equal(queuedReplies[1].delivery, 'queued', 'A human-queued reply must remain under the operator’s control.');
  assert.deepEqual(splitXianyuReplyForDelivery('第一段###第二段'), ['第一段', '第二段']);
  assert.deepEqual(splitXianyuReplyForDelivery('第一段###第二段###补充'), ['第一段', '第二段\n补充'], 'One AI reply must create exactly two delivery parts.');

  const port = await freePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'oe-desk-xianyu-repeat-'));
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), RCB_DATA_DIR: dataDir, RCB_ALLOW_ENV_OVERRIDES: 'true' },
    stdio: 'ignore'
  });

  try {
    await waitForServer(child, url);
    const first = await post(url, '/api/xianyu/messages', {
      conversationId: 'repeat-buyer',
      text: '收到',
      messageKey: 'bridge-message-1'
    });
    assert.equal(first.status, 201);

    const crossConversationReply = await post(url, '/api/xianyu/reply', {
      conversationId: 'other-buyer',
      sourceMessageId: first.body.id,
      text: '这条回复不能跨会话排队'
    });
    assert.equal(crossConversationReply.status, 409, 'A reply must use the source message conversation.');

    const reply = await post(url, '/api/xianyu/reply', {
      conversationId: 'repeat-buyer',
      sourceMessageId: first.body.id,
      text: '收到'
    });
    assert.equal(reply.status, 201);

    const splitReply = await post(url, '/api/xianyu/reply', {
      conversationId: 'repeat-buyer',
      sourceMessageId: first.body.id,
      text: '第一段###第二段',
      splitOnMarker: true
    });
    assert.equal(splitReply.status, 201);
    assert.deepEqual(splitReply.body.messages.map(item => item.text), ['第一段', '第二段'], 'An AI draft marker must create two ordered outbox records.');
    assert.equal(splitReply.body.messages[0].deliveryGroupId, splitReply.body.messages[1].deliveryGroupId);
    assert.deepEqual(splitReply.body.messages.map(item => item.deliverySegmentIndex), [1, 2]);
    assert.deepEqual(splitReply.body.messages.map(item => item.deliverySegmentCount), [2, 2]);
    assert.ok(splitReply.body.messages[0].createdAtMs < splitReply.body.messages[1].createdAtMs, 'Delivery cursor ordering must preserve the first segment before the second.');

    const enabled = await post(url, '/api/xianyu/listener', {
      listening: true,
      connected: true
    });
    assert.equal(enabled.status, 200);
    const heldOutbox = await fetch(`${url}/api/xianyu/outbox?since=0&sessionId=bridge-a`).then(response => response.json());
    assert.equal(heldOutbox.messages.length, 0, 'Replies queued before this listener run must not be replayed automatically.');

    const freshReply = await post(url, '/api/xianyu/reply', {
      conversationId: 'repeat-buyer',
      text: '这是本次监听启用后新排队的回复'
    });
    assert.equal(freshReply.status, 201);
    const freshOutbox = await fetch(`${url}/api/xianyu/outbox?since=0&sessionId=bridge-a`).then(response => response.json());
    assert.deepEqual(freshOutbox.messages.map(item => item.id), [freshReply.body.id]);

    const paused = await post(url, '/api/xianyu/listener', {
      listening: false,
      connected: true,
      autoReply: false,
      replyMode: 'human_collab'
    });
    assert.equal(paused.body.listening, false);
    const staleBridgeHeartbeat = await post(url, '/api/xianyu/listener', {
      sessionId: 'bridge-a',
      connected: true,
      listening: true,
      autoReply: true,
      replyMode: 'full_auto',
      diagnostics: { authenticated: true }
    });
    assert.equal(staleBridgeHeartbeat.body.listening, false, 'A bridge heartbeat must never resume a paused listener.');
    assert.equal(staleBridgeHeartbeat.body.autoReply, false, 'A bridge heartbeat must not re-enable automatic replies.');
    assert.equal(staleBridgeHeartbeat.body.replyMode, 'human_collab', 'A bridge heartbeat must not change the reply mode.');

    const wrongClaim = await post(url, '/api/xianyu/outbox/claim', {
      id: reply.body.id,
      conversationId: 'other-buyer',
      sessionId: 'bridge-a'
    });
    assert.equal(wrongClaim.status, 409, 'The bridge must prove the target conversation before claiming a reply.');

    const claim = await post(url, '/api/xianyu/outbox/claim', {
      id: reply.body.id,
      conversationId: 'repeat-buyer',
      sessionId: 'bridge-a'
    });
    assert.equal(claim.status, 200);

    const wrongAck = await post(url, '/api/xianyu/outbox/ack', {
      id: reply.body.id,
      conversationId: 'other-buyer',
      sessionId: 'bridge-a'
    });
    assert.equal(wrongAck.status, 409, 'An acknowledgement must remain bound to the claimed conversation.');

    const repeat = await post(url, '/api/xianyu/messages', {
      conversationId: 'repeat-buyer',
      text: '收到',
      messageKey: 'bridge-message-2'
    });
    assert.equal(repeat.status, 201, 'A new keyed buyer message must not be treated as an outgoing echo.');
    assert.equal(repeat.body.direction, 'in');
    assert.notEqual(repeat.body.id, first.body.id);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().then(() => console.log('xianyu repeated-message regression passed'));
