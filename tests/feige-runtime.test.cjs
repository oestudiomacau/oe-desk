const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

async function createRuntime(t) {
  const directory = await mkdtemp(join(tmpdir(), 'oe-feige-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { FeigeRuntime } = await import('../server/feige-runtime.js');
  const { createDefaultWorkflowState } = await import('../server/workflow-engine.js');
  const runs = [];
  const options = { path: join(directory, 'messages.json'),
    autoSendDelayMs: 0,
    answer: async () => ({ answer: '第一段###第二段', sources: [{ type: 'knowledge' }] }),
    workflow: createDefaultWorkflowState,
    risk: () => ({ level: 'low' }),
    startRun: (_flow, message, platform) => { const run = { message, platform, steps: [] }; runs.push(run); return run; },
    updateRun: (run, node, status) => run.steps.push(`${node.type}:${status}`),
    finishRun: (run, status = 'completed') => { run.status = status; }
  };
  const runtime = new FeigeRuntime(options);
  runtime.state.listening = false;
  await runtime.heartbeat({ sessionId: 'fg-test-session-1', authenticated: true, pageUrl: 'https://im.jinritemai.com/pc_seller_v2/main/workspace' });
  return { runtime, runs, options };
}

test('Feige rules hold a handoff during full auto and use the normal countdown for fixed replies', async t => {
  const { runtime } = await createRuntime(t);
  runtime.autoSendDelayMs = 5000;
  runtime.matchRule = text => text.includes('人工')
    ? { name: '人工处理', action: 'handoff', answer: '' }
    : { name: '固定问答', action: 'reply', answer: '请提供商品型号。' };
  runtime.answer = async () => { throw new Error('A matched rule must not call the model'); };
  const sessionId = 'fg-test-session-1';
  for (const [conversationId, text] of [['handoff', '我要人工'], ['reply', '请问商品']]) {
    runtime.state.listening = false;
    await runtime.receive({ sessionId, conversationId, externalId: conversationId, text });
    runtime.state.listening = true;
    await runtime.process(conversationId);
  }
  assert.equal(runtime.reviewState('handoff').status, 'needs_human');
  assert.equal(runtime.status().needsHuman, 1);
  const reply = runtime.reviewState('reply');
  assert.deepEqual(reply.parts, [{ text: '请提供商品型号。', delivery: 'queued' }]);
  assert.ok(reply.sendAfterMs > Date.now());
  runtime.setReplyMode('human_collab');
  assert.equal(runtime.reviewState('reply').status, 'needs_human');
});

test('Switching to self-learning cancels a reply still being generated', async t => {
  const { runtime } = await createRuntime(t);
  let modelStarted;
  const started = new Promise(resolve => { modelStarted = resolve; });
  let finishModel;
  runtime.answer = () => new Promise(resolve => { finishModel = resolve; modelStarted(); });
  const conversationId = 'mode-switch';
  await runtime.receive({ sessionId: 'fg-test-session-1', conversationId, externalId: 'mode-msg', text: '请问刹车怎么调？' });
  runtime.state.listening = true;
  const processing = runtime.process(conversationId);
  await started;
  runtime.setReplyMode('self_learning');
  finishModel({ answer: '这条必须取消', sources: [] });
  await processing;
  assert.equal(runtime.latestInbound(conversationId).status, 'handled');
  assert.deepEqual(runtime.state.sent, []);
});

test('Feige waits five seconds, permits holding a draft, and sends edits only after confirmation in collaboration mode', async t => {
  const { runtime } = await createRuntime(t);
  const sessionId = 'fg-test-session-1';
  const conversationId = 'buyer-1';
  runtime.autoSendDelayMs = 5000;
  const first = await runtime.receive({ sessionId, conversationId, externalId: 'mid-1', text: '怎么升级刹车' });
  runtime.state.listening = true;
  runtime.heartbeat({ sessionId, authenticated: true, pageUrl: 'https://im.jinritemai.com/', routeReady: true, conversationId });
  clearTimeout(runtime.timers.get(conversationId));
  runtime.timers.delete(conversationId);
  const before = Date.now();
  await runtime.process(conversationId);
  const countdown = runtime.reviewState(conversationId);
  assert.equal(countdown.messageId, first.id);
  assert.deepEqual(countdown.parts, [
    { text: '第一段', delivery: 'queued' }, { text: '第二段', delivery: 'queued' }
  ]);
  assert.ok(countdown.sendAfterMs >= before + 5000);
  assert.deepEqual(runtime.outbox(sessionId), []);
  const queued = runtime.state.sent[0];
  await assert.rejects(runtime.claim({ sessionId, conversationId, id: queued.id }), /does not belong/);
  await runtime.reviewReply({ conversationId, messageId: first.id, action: 'hold' });
  assert.equal(runtime.reviewState(conversationId).status, 'needs_human');
  assert.deepEqual(runtime.reviewState(conversationId).parts, [
    { text: '第一段', delivery: 'draft' }, { text: '第二段', delivery: 'draft' }
  ]);
  assert.equal(queued.delivery, 'superseded');

  const edited = await runtime.reviewReply({ conversationId, messageId: first.id, action: 'send', text: '全托管修改稿' });
  assert.equal(edited.status, 'auto_queued');
  assert.deepEqual(runtime.outbox(sessionId), []);
  runtime.setReplyMode('human_collab');
  assert.equal(runtime.reviewState(conversationId).draft, '全托管修改稿');
  assert.equal(runtime.reviewState(conversationId).status, 'needs_human');
  assert.deepEqual(runtime.outbox(sessionId), []);

  runtime.state.listening = false;
  const second = await runtime.receive({ sessionId, conversationId, externalId: 'mid-2', text: '我要退款' });
  runtime.state.listening = true;
  await runtime.process(conversationId);
  assert.equal(runtime.reviewState(conversationId).status, 'needs_human');
  assert.equal(await runtime.reviewReply({ conversationId, messageId: first.id, action: 'send', text: '旧消息回复' }), null);
  await runtime.reviewReply({ conversationId, messageId: second.id, action: 'send', parts: ['人工确认稿', '下一条补充'] });
  assert.deepEqual(runtime.outbox(sessionId).map(item => [item.origin, item.text]), [['operator', '人工确认稿']]);
  assert.deepEqual(runtime.reviewState(conversationId).parts, [
    { text: '人工确认稿', delivery: 'queued' }, { text: '下一条补充', delivery: 'queued' }
  ]);
  assert.equal(await runtime.reviewReply({ conversationId, messageId: second.id, action: 'send', text: '重复提交' }), null);
});

test('Feige identities dedupe retries but allow repeated text and isolate conversations', async t => {
  const { runtime } = await createRuntime(t);
  const first = await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-1', text: '你好' });
  const duplicate = await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-1', text: '你好' });
  const repeat = await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-2', text: '你好' });
  const different = await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-2', externalId: 'mid-1', text: '你好' });
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.duplicate, true);
  assert.notEqual(repeat.id, first.id);
  assert.notEqual(different.id, first.id);
  const route = runtime.status();
  assert.equal(route.lastInboundConversationId, 'buyer-2');
  assert.equal(route.lastInboundAt, different.createdAtMs);
  assert.equal(runtime.state.messages.find(item => item.id === first.id).status, 'superseded');
  await assert.rejects(runtime.receive({ sessionId: 'fg-test-session-1', conversationId: '', externalId: 'mid-3', text: '你好' }), /requires conversation ID/);
});

test('Feige exposes only the active route and clears completed local history', async t => {
  const { runtime } = await createRuntime(t);
  runtime.heartbeat({ sessionId: 'fg-test-session-1', authenticated: true, routeReady: true,
    conversationId: 'buyer-2', pageUrl: 'https://im.jinritemai.com/pc_seller_v2/main/workspace' });
  runtime.state.messages = [
    { id: 'done-in', conversationId: 'buyer-1', direction: 'in', status: 'handled', updatedAtMs: 1 },
    { id: 'pending-in', conversationId: 'buyer-2', direction: 'in', status: 'received', updatedAtMs: 2 }
  ];
  runtime.state.sent = [
    { id: 'done-out', sourceMessageId: 'done-in', conversationId: 'buyer-1', delivery: 'sent', updatedAtMs: 3 },
    { id: 'queued-out', sourceMessageId: 'pending-in', conversationId: 'buyer-2', delivery: 'queued', updatedAtMs: 4 }
  ];
  assert.equal(runtime.status().activeConversationId, 'buyer-2');
  assert.deepEqual(runtime.messages(0, 'buyer-2').map(item => item.id), ['pending-in', 'queued-out']);
  const result = await runtime.clearHistory();
  assert.deepEqual(result.removed, { messages: 1, sent: 1 });
  assert.deepEqual(runtime.state.messages.map(item => item.id), ['pending-in']);
  assert.deepEqual(runtime.state.sent.map(item => item.id), ['queued-out']);
});

test('Feige executes the canvas workflow and splits ### into exactly two bound replies', async t => {
  const { runtime, runs } = await createRuntime(t);
  const sessionId = 'fg-test-session-1';
  const conversationId = 'buyer-1';
  runtime.autoSendDelayMs = 5000;
  await runtime.receive({ sessionId, conversationId, externalId: 'mid-1', text: '商品规格' });
  runtime.state.listening = true;
  await runtime.process('buyer-1');
  assert.equal(runs[0].platform, 'douyin');
  assert.equal(runs[0].status, 'completed');
  assert.equal(runtime.state.sent.length, 2);
  assert.deepEqual(runtime.state.sent.map(item => item.text), ['第一段', '第二段']);
  assert.ok(runtime.state.sent.every(item => item.conversationId === 'buyer-1' && item.delivery === 'queued'));
  const [first, second] = runtime.state.sent;
  assert.equal(first.sendAfterMs, second.sendAfterMs, 'Both parts share one five-second deadline');
  assert.deepEqual(runtime.outbox(sessionId), []);
  first.sendAfterMs = second.sendAfterMs = Date.now() - 1;
  assert.deepEqual(runtime.outbox(sessionId).map(item => item.text), ['第一段']);
  const claimed = await runtime.claim({ sessionId, conversationId, id: first.id });
  await runtime.acknowledge({ sessionId, conversationId, id: first.id, claimToken: claimed.claimToken,
    evidence: { platformAck: true, platformMessageId: 'platform-1', platformConversationId: conversationId,
      domBubble: true, domConversationId: conversationId, newBubbleId: 'bubble-1' } });
  assert.deepEqual(runtime.outbox(sessionId).map(item => item.text), ['第二段']);
});

test('Feige cannot confirm a wrong route or mark a reply sent without both platform and DOM evidence', async t => {
  const { runtime } = await createRuntime(t);
  await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-1', text: '商品规格' });
  runtime.state.listening = true;
  await runtime.process('buyer-1');
  const id = runtime.state.sent[0].id;
  await assert.rejects(runtime.claim({ sessionId: 'fg-test-session-1', conversationId: 'buyer-2', id }), /does not belong/);
  const claimed = await runtime.claim({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id });
  await assert.rejects(runtime.acknowledge({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id,
    claimToken: claimed.claimToken, evidence: { domBubble: true, domConversationId: 'buyer-1', newBubbleId: 'bubble-1' } }), /both required/);
  assert.equal(runtime.state.sent[0].delivery, 'verifying');
  await assert.rejects(runtime.release({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id, claimToken: claimed.claimToken }), /Cannot retry/);
  await assert.rejects(runtime.acknowledge({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id,
    claimToken: claimed.claimToken, evidence: { platformAck: true, platformMessageId: 'platform-1', platformConversationId: 'buyer-2' } }), /both required/);
  const result = await runtime.acknowledge({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id,
    claimToken: claimed.claimToken, evidence: { platformAck: true, platformMessageId: 'platform-1', platformConversationId: 'buyer-1' } });
  assert.equal(result.delivery, 'sent');
  assert.deepEqual(runtime.reviewState('buyer-1').parts.map(part => part.delivery), ['sent', 'queued']);
  assert.deepEqual(runtime.outbox('fg-test-session-1').map(item => item.text), ['第二段']);
});

test('Feige restart keeps uncertain sends for verification and never resends them', async t => {
  const { runtime, options } = await createRuntime(t);
  await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-1', text: '商品规格' });
  runtime.state.listening = true;
  await runtime.process('buyer-1');
  const item = await runtime.claim({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id: runtime.state.sent[0].id });
  await runtime.verify({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id: item.id, claimToken: item.claimToken, evidence: { platformAck: false } });
  const { FeigeRuntime } = await import('../server/feige-runtime.js');
  const recovered = new FeigeRuntime(options);
  await recovered.load();
  assert.equal(recovered.state.sent[0].delivery, 'verifying');
  assert.deepEqual(recovered.outbox('fg-test-session-1'), []);
});

test('Feige permits a new authenticated session to verify but not resend an old uncertain claim', async t => {
  const { runtime } = await createRuntime(t);
  await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-1', text: '商品规格' });
  runtime.state.listening = true;
  await runtime.process('buyer-1');
  const item = await runtime.claim({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id: runtime.state.sent[0].id });
  const originalToken = item.claimToken;
  await runtime.verify({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id: item.id, claimToken: item.claimToken, evidence: { platformAck: false } });
  runtime.heartbeat({ sessionId: 'fg-test-session-2', authenticated: true, pageUrl: 'https://im.jinritemai.com/pc_seller_v2/main/workspace' });
  const recovered = await runtime.claim({ sessionId: 'fg-test-session-2', conversationId: 'buyer-1', id: item.id });
  assert.equal(recovered.delivery, 'verifying');
  assert.notEqual(recovered.claimToken, originalToken);
  await assert.rejects(runtime.acknowledge({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id: item.id,
    claimToken: originalToken, evidence: {} }), /claim mismatch/);
  await assert.rejects(runtime.claim({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id: item.id }), /does not belong/);
  await assert.rejects(runtime.release({ sessionId: 'fg-test-session-2', conversationId: 'buyer-1', id: item.id,
    claimToken: recovered.claimToken }), /Cannot retry/);
  const sent = await runtime.acknowledge({ sessionId: 'fg-test-session-2', conversationId: 'buyer-1', id: item.id,
    claimToken: recovered.claimToken, evidence: { platformAck: true, platformMessageId: 'server-1',
      platformConversationId: 'buyer-1', domBubble: true, domConversationId: 'buyer-1', newBubbleId: 'local-1' } });
  assert.equal(sent.delivery, 'sent');
  assert.deepEqual(runtime.outbox('fg-test-session-2').map(reply => reply.text), ['第二段']);
});

test('Feige full auto sends a bounded AI first response for high-risk questions', async t => {
  const { runtime } = await createRuntime(t);
  runtime.risk = () => ({ level: 'high' });
  await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-risk', text: '刹车适配吗' });
  runtime.state.listening = true;
  await runtime.process('buyer-1');
  assert.equal(runtime.state.messages[0].status, 'auto_queued');
  assert.equal(runtime.state.sent.length, 2);
  assert.equal(runtime.state.messages[0].risk.level, 'high');
});

test('Feige full auto overrides a saved draft-only reply node', async t => {
  const { runtime } = await createRuntime(t);
  const workflow = runtime.workflow();
  workflow.flows[0].nodes.find(node => node.type === 'reply').config.mode = '仅保存草稿';
  runtime.workflow = () => workflow;
  await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-draft', text: '商品规格' });
  runtime.state.listening = true;
  await runtime.process('buyer-1');
  assert.equal(runtime.state.messages[0].status, 'auto_queued');
  assert.equal(runtime.state.sent.length, 2);
});

test('Feige drops a previous response when another customer message arrives during generation or before dispatch', async t => {
  const { runtime } = await createRuntime(t);
  await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-1', text: '第一条' });
  runtime.state.listening = true;
  runtime.answer = async () => {
    await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-2', text: '第二条' });
    return { answer: '旧回答', sources: [] };
  };
  await runtime.process('buyer-1');
  assert.equal(runtime.state.sent.length, 0);
  assert.equal(runtime.state.messages[0].status, 'superseded');
  runtime.answer = async () => ({ answer: '新回答', sources: [] });
  await runtime.process('buyer-1');
  const old = runtime.state.sent[0];
  await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-3', text: '第三条' });
  assert.equal(old.delivery, 'superseded');
  await assert.rejects(runtime.claim({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id: old.id }), /does not belong/);
});

test('Feige releases an uncertain older reply when a newer inbound message arrives', async t => {
  const { runtime } = await createRuntime(t);
  await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-old', text: '旧问题' });
  runtime.state.listening = true;
  await runtime.process('buyer-1');
  const old = runtime.state.sent[0];
  const claimed = await runtime.claim({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id: old.id });
  await runtime.verify({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id: old.id,
    claimToken: claimed.claimToken, evidence: { platformAck: false } });
  const newer = await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-new', text: '新问题' });
  assert.equal(old.delivery, 'superseded');
  assert.equal(old.supersededBy, newer.id);
  assert.equal(runtime.outbox('fg-test-session-1').some(item => item.id === old.id), false);
});

test('Feige cancels a claimed response when a newer inbound message wins before the click', async t => {
  const { runtime } = await createRuntime(t);
  await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-1', text: '第一条' });
  runtime.state.listening = true;
  await runtime.process('buyer-1');
  const item = await runtime.claim({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id: runtime.state.sent[0].id });
  await runtime.verify({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id: item.id,
    claimToken: item.claimToken, evidence: { platformAck: false, beforeBubbleIds: ['old'] } });
  assert.equal(runtime.dispatchReady({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id: item.id, claimToken: item.claimToken }), true);
  await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-2', text: '第二条' });
  assert.equal(item.delivery, 'superseded');
  assert.equal(item.supersededBy, runtime.state.messages.at(-1).id);
  assert.equal(runtime.dispatchReady({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', id: item.id, claimToken: item.claimToken }), false);
});

test('Feige restores a prepared queue item when the bridge is still before the send click', async t => {
  const { runtime } = await createRuntime(t);
  const sessionId = 'fg-test-session-1';
  const conversationId = 'buyer-before-click';
  await runtime.receive({ sessionId, conversationId, externalId: 'msg-draft', text: '请问规格？' });
  runtime.state.listening = true;
  await runtime.process(conversationId);
  const queued = runtime.outbox(sessionId)[0];
  const item = await runtime.claim({ sessionId, conversationId, id: queued.id });
  const claim = { sessionId, conversationId, id: item.id, claimToken: item.claimToken };
  await runtime.verify({ ...claim, evidence: { platformAck: false } });
  await assert.rejects(runtime.release(claim), /Cannot retry/);
  await runtime.release({ ...claim, beforeClick: true });
  assert.equal(runtime.outbox(sessionId)[0].id, queued.id);
  const fresh = await runtime.claim({ sessionId, conversationId, id: queued.id });
  const freshClaim = { ...claim, claimToken: fresh.claimToken };
  await runtime.verify({ ...freshClaim, evidence: { platformAck: true, platformMessageId: 'receipt' } });
  await assert.rejects(runtime.release({ ...freshClaim, beforeClick: true }), /Cannot retry/);
});

test('Feige full auto responds even when a saved workflow ends in handoff', async t => {
  const { runtime } = await createRuntime(t);
  runtime.workflow = () => ({ version: 2, activeFlowId: 'handoff-flow', flows: [{ id: 'handoff-flow', name: 'handoff', enabled: true,
    nodes: [{ id: 'trigger', type: 'trigger', title: 'trigger', config: { channel: '抖音' } },
      { id: 'rag', type: 'rag', title: 'rag', config: {} }, { id: 'handoff', type: 'handoff', title: 'handoff', config: {} }],
    edges: [{ id: 'e1', from: 'trigger', to: 'rag', label: '' }, { id: 'e2', from: 'rag', to: 'handoff', label: '' }] }] });
  runtime.risk = () => ({ level: 'high' });
  await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-handoff', text: '售后怎么处理' });
  runtime.state.listening = true;
  await runtime.process('buyer-1');
  assert.equal(runtime.state.messages[0].status, 'auto_queued');
  assert.equal(runtime.state.sent.length, 2);
});

test('Feige full auto answers a pure greeting without unsupported product claims', async t => {
  const { runtime } = await createRuntime(t);
  await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-greeting', text: '你好' });
  runtime.state.listening = true;
  await runtime.process('buyer-1');
  assert.equal(runtime.state.messages[0].status, 'auto_queued');
  assert.deepEqual(runtime.state.sent.map(item => item.text), ['您好，请问想了解哪款商品？']);
});

test('Feige resumes received messages after an authenticated restart heartbeat', async t => {
  const { runtime, options } = await createRuntime(t);
  await runtime.receive({ sessionId: 'fg-test-session-1', conversationId: 'buyer-1', externalId: 'mid-resume', text: '商品规格' });
  runtime.state.listening = true;
  await runtime.save();
  const { FeigeRuntime } = await import('../server/feige-runtime.js');
  const recovered = new FeigeRuntime(options);
  await recovered.load();
  recovered.heartbeat({ sessionId: 'fg-test-session-1', authenticated: true, pageUrl: 'https://im.jinritemai.com/pc_seller_v2/main/workspace' });
  assert.ok(recovered.timers.has('buyer-1'));
  clearTimeout(recovered.timers.get('buyer-1'));
});
