const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'rpa', 'feige-bridge.user.js'), 'utf8');
const context = vm.createContext({ URL, setTimeout, clearTimeout, setInterval, clearInterval,
  location: { href: 'https://im.jinritemai.com/pc_seller_v2/main/workspace' } });
vm.runInContext(`${source}\nglobalThis.testApi = { conversationIdentity, messageIdentity, boundConversationId, feigeSendButton, FeigeHydrationGate, deliveryEvidence, recoveredDeliveryEvidence, outgoingBubble, platformSendAcknowledgement, shouldRefreshVerification, shouldDispatchToActiveConversation, recentHydrationArrivals, initialUnreadArrival, selectPendingConversationRow, waitForDeliveryEvidence };`, context);
const { conversationIdentity, messageIdentity, boundConversationId, feigeSendButton, FeigeHydrationGate, deliveryEvidence, recoveredDeliveryEvidence, outgoingBubble, platformSendAcknowledgement, shouldRefreshVerification, shouldDispatchToActiveConversation, recentHydrationArrivals, initialUnreadArrival, selectPendingConversationRow, waitForDeliveryEvidence } = context.testApi;
const arrivalsAfterBaseline = vm.runInContext('arrivalsAfterBaseline', context);

test('Electron permits Feige to submit a confirmed human reply to self-learning', () => {
  const main = readFileSync(join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  assert.match(main, /ipcMain\.handle\('feige:request'[\s\S]*?const allowed = new Set\(\[[^\]]*'\/api\/feige\/human-reply'/);
});

test('history learns only a persisted reply after a question in the same conversation', () => {
  const createPairs = vm.runInContext('feigeHistoryPairs', context);
  const before = 1750000000000;
  const node = (direction, id, text, overrides) => ({
    innerText: text, matches: selector => selector === '.messageNotMe' && direction === 'in',
    __reactFiber$test: { memoizedProps: { message: {
      id, serverId: id, conversationId: 'shop-two-chat', createTime: before - 5000, flightStatus: 3, ...overrides
    } } }
  });
  const list = { querySelectorAll: () => [
    node('out', 'no-question', '你好'),
    node('in', 'q1', 'QX55 的宽度是多少？'),
    node('out', 'a1', '120mm'),
    node('in', 'q2', 'QX55 的高度是多少？'),
    node('out', 'foreign', '200mm', { conversationId: 'shop-one-chat' }),
    node('in', 'q3', 'QX55 的长度是多少？'),
    node('out', 'fake', '300mm', { isFakeMessage: true }),
    node('in', 'q4', 'QX55 的厚度是多少？'),
    node('out', 'bot', '10mm', { isRobot: true }),
    node('in', 'q5', 'QX55 的净重是多少？'),
    node('out', 'live', '1kg', { createTime: before + 1000 })
  ] };
  assert.deepEqual(Array.from(createPairs(list, 'shop-two-chat', before), pair => ({ ...pair })), [
    { replyId: 'a1', question: 'QX55 的宽度是多少？', answer: '120mm' }
  ]);
});

function element(attributes = {}, className = '') {
  return { className, getAttribute: key => attributes[key] || null,
    closest: () => null, querySelector: () => null };
}

test('Feige never routes by a display name and distinguishes repeated text by platform message ID', () => {
  assert.equal(conversationIdentity(element({ 'data-conversation-id': 'buyer-123' })), 'buyer-123');
  assert.equal(conversationIdentity(element({ title: '张先生' })), '');
  assert.equal(messageIdentity(element({ 'data-message-id': 'm-1' }), 0), 'm-1');
  assert.equal(messageIdentity(element({ 'data-message-id': 'm-2' }), 0), 'm-2');
});

test('Feige requires both a bound platform acknowledgement and a new outgoing bubble', () => {
  const expected = { conversationId: 'buyer-123', text: '回复', createdAtMs: 1000, before: new Set(['old']) };
  const bubble = { id: 'new', serverId: 'm-3', conversationId: 'buyer-123', text: '回复',
    createdAtMs: 1100, flightStatus: 3, isFakeMessage: false };
  assert.equal(deliveryEvidence(expected, { ok: true, messageId: 'm-3', conversationId: 'other' }, [bubble]), null);
  assert.equal(deliveryEvidence(expected, { ok: true, messageId: 'm-3', conversationId: 'buyer-123' }, [{ ...bubble, id: 'old' }]), null);
  assert.equal(deliveryEvidence(expected, { ok: true, messageId: 'other-id', conversationId: 'buyer-123' }, [bubble]), null);
  const evidence = deliveryEvidence(expected, { ok: true, messageId: 'm-3', conversationId: 'buyer-123' }, [bubble]);
  assert.equal(evidence.platformMessageId, 'm-3');
  assert.equal(evidence.newBubbleId, 'new');
});

test('Feige binds a send receipt without a redundant response route to the exact request route and text', () => {
  const expected = { conversationId: 'buyer-123', text: '回复内容' };
  const request = JSON.stringify({ conversationId: 'buyer-123', content: '回复内容' });
  assert.deepEqual({ ...platformSendAcknowledgement(request, '{"messageId":"server-1"}', true, expected) },
    { ok: true, messageId: 'server-1', conversationId: 'buyer-123' });
  assert.equal(platformSendAcknowledgement(JSON.stringify({ conversationId: 'buyer-2', content: '回复内容' }),
    '{"messageId":"server-1"}', true, expected), null);
  assert.equal(platformSendAcknowledgement(request, '{"messageId":"server-1","conversationId":"buyer-2"}', true, expected), null);
});

test('Feige reads actual React message/list IDs and rejects stale messages from another route', () => {
  const id = 'buyer-A:shop:2:1:pigeon';
  const list = element();
  list.__reactInternalInstance$test = { memoizedProps: { cid: id, currentCustomerId: 'buyer-A' } };
  const editor = element();
  const workspace = { id: 'workspace-chat' };
  list.closest = selector => selector === '#workspace-chat' ? workspace : null;
  editor.closest = list.closest;
  const incoming = element();
  incoming.__reactInternalInstance$test = { memoizedProps: { children: null }, return: {
    memoizedProps: { message: { id: 'local-1', serverId: 'server-1', conversationId: id } } } };
  assert.equal(conversationIdentity(list), id);
  assert.equal(messageIdentity(incoming, 0), 'server-1');
  assert.equal(boundConversationId(list, editor, [incoming]), id);
  incoming.__reactInternalInstance$test.return.memoizedProps.message.conversationId = 'buyer-B:shop:2:1:pigeon';
  assert.equal(boundConversationId(list, editor, [incoming]), '');
});

test('Feige clicks only the real send control in the editor workspace', () => {
  const button = element({ 'data-qa-id': 'qa-send-message-button' });
  const workspace = { querySelector: selector => selector === '[data-qa-id="qa-send-message-button"]' ? button : null };
  const editor = { closest: selector => selector === '#workspace-chat' ? workspace : null };
  assert.equal(feigeSendButton(editor), button);
  assert.equal(feigeSendButton({ closest: () => null }), null);
  button.getAttribute = key => key === 'aria-disabled' ? 'true' : null;
  assert.equal(feigeSendButton(editor), null);
});

test('Feige primes a paged history only after the message window settles', () => {
  const gate = new FeigeHydrationGate(2500, 1200);
  assert.equal(gate.observe('buyer-A', ['old-1'], 0), false);
  assert.equal(gate.observe('buyer-A', ['old-1', 'old-2'], 2000), false);
  assert.equal(gate.observe('buyer-A', ['old-1', 'old-2'], 2900), false);
  assert.equal(gate.observe('buyer-A', ['old-1', 'old-2'], 3300), true);
  assert.equal(gate.observe('buyer-A', ['old-1', 'old-2', 'new-1'], 3500), true);
  gate.reset('buyer-A');
  assert.equal(gate.observe('buyer-A', ['old-1', 'old-2', 'new-1'], 3600), false);
});

test('Feige reconciles a restart only from one later platform-persisted outgoing message', () => {
  const item = { conversationId: 'buyer-1', text: '安全回复', createdAtMs: 1000 };
  const bubble = { id: 'local-1', serverId: 'server-1', conversationId: 'buyer-1', text: '安全回复',
    createdAtMs: 1100, flightStatus: 3, isFakeMessage: false };
  assert.equal(recoveredDeliveryEvidence(item, [{ ...bubble, createdAtMs: 900 }]), null);
  assert.equal(recoveredDeliveryEvidence(item, [{ ...bubble, conversationId: 'buyer-2' }]), null);
  assert.equal(recoveredDeliveryEvidence(item, [{ ...bubble, serverId: '' }]), null);
  assert.equal(recoveredDeliveryEvidence(item, [{ ...bubble, flightStatus: 1 }]), null);
  assert.equal(recoveredDeliveryEvidence(item, [{ ...bubble, flightStatus: 4 }]), null);
  assert.equal(recoveredDeliveryEvidence(item, [{ ...bubble, isFakeMessage: true }]), null);
  assert.equal(recoveredDeliveryEvidence(item, [bubble, { ...bubble, id: 'local-2', serverId: 'server-2' }]), null);
  const evidence = recoveredDeliveryEvidence(item, [bubble]);
  assert.equal(evidence.platformMessageId, 'server-1');
  assert.equal(evidence.newBubbleId, 'local-1');
});

test('Feige reads persisted delivery fields from the outgoing React message', () => {
  const node = element();
  node.innerText = '安全回复';
  node.__reactInternalInstance$test = { memoizedProps: { message: { id: 'local-1', serverId: 'server-1',
    conversationId: 'buyer-1', createTime: 1100, flightStatus: 3, isFakeMessage: false } } };
  const bubble = outgoingBubble(node, 0);
  assert.deepEqual({ ...bubble }, { id: 'local-1', serverId: 'server-1', conversationId: 'buyer-1',
    text: '安全回复', createdAtMs: 1100, flightStatus: 3, isFakeMessage: false });
  assert.equal(bubble.serverId, 'server-1');
  assert.equal(bubble.createdAtMs, 1100);
  assert.equal(bubble.flightStatus, 3);
  assert.equal(recoveredDeliveryEvidence({ conversationId: 'buyer-1', text: '安全回复', createdAtMs: 1000 }, [bubble]).platformMessageId, 'server-1');
});

test('Feige refreshes once to recover a stale receipt without resending or discarding a draft', () => {
  const item = { delivery: 'verifying', conversationId: 'buyer-1', updatedAtMs: 1000, evidence: {} };
  const active = { id: 'buyer-1', editor: { value: '' } };
  assert.equal(shouldRefreshVerification(item, active, 4499), false);
  assert.equal(shouldRefreshVerification(item, { ...active, id: 'buyer-2' }, 4500), false);
  assert.equal(shouldRefreshVerification(item, { ...active, editor: { value: 'draft' } }, 4500), false);
  assert.equal(shouldRefreshVerification({ ...item, delivery: 'sending' }, active, 4500), false);
  assert.equal(shouldRefreshVerification(item, active, 4500), true);
  assert.equal(shouldRefreshVerification({ ...item, evidence: { verificationRefreshAt: 4500 } }, active, 9000), false);
});

test('Feige refuses an old reply when the visible customer has sent a newer message', () => {
  const item = { conversationId: 'buyer-1', sourceExternalId: 'mid-1' };
  assert.equal(shouldDispatchToActiveConversation(item, 'buyer-1', 'mid-1'), true);
  assert.equal(shouldDispatchToActiveConversation(item, 'buyer-1', 'mid-2'), false);
  assert.equal(shouldDispatchToActiveConversation(item, 'buyer-2', 'mid-1'), false);
  assert.equal(shouldDispatchToActiveConversation(item, 'buyer-1', 'visible-0'), false);
});

test('Feige detects fresh platform messages while older history is still hydrating', () => {
  const old = { id: 'old', text: 'old', platformCreatedAtMs: 500 };
  const recent = { id: 'new', text: 'new', platformCreatedAtMs: 1200 };
  assert.deepEqual([...recentHydrationArrivals([old, recent], 1000, new Set(), 'buyer-1')], [recent]);
  assert.equal(recentHydrationArrivals([old, recent], 1000, new Set(['buyer-1|new|new']), 'buyer-1').length, 0);
});

test('Feige captures messages after a remount without replaying prepended history or position-only rows', () => {
  const items = ['old-history', 'last-known', 'new-1', 'new-2', 'visible-4'].map(id => ({ id }));
  assert.deepEqual([...arrivalsAfterBaseline(items, ['older', 'last-known'])].map(item => item.id), ['new-1', 'new-2']);
  assert.deepEqual([...arrivalsAfterBaseline(items, ['unrelated'])], []);
  const recent = { id: 'new-1', text: '新消息', platformCreatedAtMs: 1794750001 };
  assert.equal(recentHydrationArrivals([recent], 1794750000000, new Set(), 'buyer-1').length, 1);
  assert.equal(initialUnreadArrival(items.slice(0, 4), new Set(['buyer-1|new-2|undefined']), 'buyer-1'), null);
});

test('Feige captures the first customer message from an unread conversation during hydration', () => {
  const old = { id: 'old-1', text: '旧消息', platformCreatedAtMs: 100 };
  const first = { id: 'new-1', text: '我想升级刹车', platformCreatedAtMs: 0 };
  assert.equal(initialUnreadArrival([old, first], new Set(['buyer-1|old-1|旧消息']), 'buyer-1'), first);
  assert.equal(initialUnreadArrival([old, first], new Set(['buyer-1|old-1|旧消息', 'buyer-1|new-1|我想升级刹车']), 'buyer-1'), null);
});

test('Feige selects an unread background conversation without replacing an active route arbitrarily', () => {
  const first = { id: 'buyer-1', unread: false };
  const second = { id: 'buyer-2', unread: true };
  assert.equal(selectPendingConversationRow([first, second], 'buyer-1'), second);
  assert.equal(selectPendingConversationRow([first, second], ''), second);
  assert.equal(selectPendingConversationRow([first], ''), first);
  assert.equal(selectPendingConversationRow([first], 'buyer-1'), null);
});

test('Feige selects the real clickable row by its buyer and service key', () => {
  const serviceIdentity = vm.runInContext('feigeRowServiceIdentity', context);
  const row = {
    getAttribute: name => name === 'data-qa-id' ? 'session-card' : null,
    __reactEventHandlers$fixture: { onClick() {} },
    __reactInternalInstance$fixture: { memoizedProps: {}, return: {
      memoizedProps: { selected: false, buyerAndServiceEntityId: 'obfuscated-buyer' }
    } }
  };
  assert.equal(serviceIdentity(row), 'obfuscated-buyer');
  assert.equal(serviceIdentity({ ...row, __reactEventHandlers$fixture: {} }), '');
  const record = { id: '', serviceIdentity: serviceIdentity(row), node: row };
  const other = { id: '', serviceIdentity: 'another-buyer', unread: true };
  assert.equal(selectPendingConversationRow([other, record], 'different', [{
    delivery: 'queued', conversationId: 'obfuscated-buyer:123456789::2:1:pigeon'
  }]), record);
});

test('Feige switches to the target and sends both due parts in the same drain cycle', async () => {
  const callbacks = new Map();
  const selected = [];
  const sent = [];
  let conversation = 'buyer-B';
  let now = 10000;
  const outgoing = [];
  let acknowledged = 0;
  class Textarea {
    get value() { return this.text || ''; }
    set value(value) { this.text = value; }
    closest() { return workspace; }
    focus() {}
    dispatchEvent() {}
  }
  const editor = new Textarea();
  const bubble = (route, id, text) => ({
    innerText: text,
    __reactFiber$test: { memoizedProps: { message: { serverId: id, conversationId: route,
      createTime: now, flightStatus: 3, isFakeMessage: false } } }
  });
  const workspace = { querySelector: () => ({ click() {
    sent.push({ conversation, text: editor.value });
    outgoing.push(bubble(conversation, 'sent-A-' + sent.length, editor.value));
    editor.value = '';
  } }) };
  const lists = new Map(['A', 'B'].map(letter => {
    const route = 'buyer-' + letter;
    const incoming = bubble(route, 'message-' + letter, '客户 ' + letter + ' 的问题');
    incoming.__reactFiber$test.memoizedProps.message.createTime = 0;
    return [route, {
      ...element({ 'data-conversation-id': route }),
      closest: () => workspace,
      querySelectorAll: selector => selector === '.messageIsMe'
        ? (conversation === route ? outgoing : []) : [incoming]
    }];
  }));
  const scroller = { children: [], querySelectorAll: () => scroller.children };
  scroller.children = ['buyer-A', 'buyer-B'].map(id => ({
    ...element({ 'data-conversation-id': id }), parentElement: scroller,
    getClientRects: () => [{}], matches: () => false,
    click: () => selected.push(id)
  }));
  const requested = [];
  const reply = { id: 'due-A', delivery: 'queued', conversationId: 'buyer-A', sourceMessageId: 'in-A', sourceExternalId: 'message-A',
    createdAtMs: now, text: '给客户 A 的答复' };
  const second = { ...reply, id: 'due-A-2', createdAtMs: now + 1, text: '给客户 A 的补充答复' };
  const replies = [reply, second];
  const sandbox = vm.createContext({
    URL, setTimeout, clearTimeout, clearInterval() {}, Date: { now: () => now },
    setInterval: (callback, delay) => callbacks.set(callback.name, { callback, delay }),
    location: { href: 'https://im.jinritemai.com/pc_seller_v2/main/workspace' },
    console: { warn() {} }, MutationObserver: class { observe() {} disconnect() {} },
    XMLHttpRequest: class { open() {} send() {} },
    HTMLTextAreaElement: Textarea, Event: class {},
    document: {
      documentElement: {}, body: { innerText: '' }, addEventListener() {},
      querySelector(selector) {
        if (selector === '#imroot') return {};
        if (selector === '.messageList') return lists.get(conversation);
        if (selector.startsWith('textarea')) return editor;
        return scroller;
      }
    },
    rcbFeigeRequest: async ({ url, data: payload }) => {
      const path = new URL(url).pathname;
      requested.push(path);
      if (path === '/api/feige/outbox/claim') assert.equal(JSON.parse(payload).conversationId, conversation);
      if (path === '/api/feige/outbox/ack') acknowledged += 1;
      const data = path === '/api/feige/outbox' ? { messages: replies.slice(acknowledged, acknowledged + 1) }
        : { listening: true, replyMode: 'full_auto', claimToken: 'fixture-claim', ready: true };
      return { status: 200, responseText: JSON.stringify(data) };
    }
  });
  vm.runInContext(source, sandbox);
  await callbacks.get('heartbeat').callback();
  await callbacks.get('scan').callback();
  now += 3000;
  await callbacks.get('scan').callback();
  editor.value = '人工草稿';
  await callbacks.get('drain').callback();
  assert.deepEqual(selected, []);
  editor.value = '';
  await callbacks.get('drain').callback();
  assert.deepEqual(selected, ['buyer-A']);
  assert.ok(!requested.includes('/api/feige/outbox/claim'), 'A click is not enough to bind a send to the new route');
  conversation = 'buyer-A';
  await callbacks.get('scan').callback();
  await callbacks.get('drain').callback();
  assert.deepEqual(sent, []);
  now += 3000;
  await callbacks.get('scan').callback();
  await callbacks.get('drain').callback();
  assert.deepEqual(sent, replies.map(item => ({ conversation: 'buyer-A', text: item.text })));
  assert.equal(acknowledged, 2);
});

test('Feige verifies as soon as both signals arrive, without waiting for the polling cycle', async () => {
  let wake;
  let checks = 0;
  let ready = false;
  const start = Date.now();
  const result = waitForDeliveryEvidence(async () => { checks += 1; return ready; },
    notify => { wake = notify; return () => {}; }, 800);
  await new Promise(resolve => setTimeout(resolve, 30));
  ready = true;
  wake();
  assert.equal(await result, true);
  assert.ok(Date.now() - start < 250);
  assert.ok(checks >= 2);
});

test('Feige keeps an uncertain delivery pending when only one evidence signal appears', async () => {
  let wake;
  let platformAck = false;
  let domBubble = false;
  const result = waitForDeliveryEvidence(async () => platformAck && domBubble,
    notify => { wake = notify; return () => {}; }, 70);
  platformAck = true;
  wake();
  assert.equal(await result, false);
});
