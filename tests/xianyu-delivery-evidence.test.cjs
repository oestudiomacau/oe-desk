const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const { XianyuSocketTracker, hashXianyuDeliveryText } = require('../electron/xianyu-runtime-policy.cjs');

const tracker = new XianyuSocketTracker();
tracker.observe('Network.webSocketCreated', {
  requestId: 'xy-delivery-socket',
  url: 'wss://wss-goofish.dingtalk.com/'
}, 1000);

const replyText = '本次 AI 回复';
const started = tracker.beginDeliveryAttempt({ claimToken: 'claim-a', conversationId: 'buyer-a', textHash: hashXianyuDeliveryText(replyText) }, 1100);
assert.equal(started.claimToken, 'claim-a');
assert.equal(started.requestObserved, false);

tracker.observe('Network.webSocketFrameSent', {
  requestId: 'xy-delivery-socket',
  response: { payloadData: JSON.stringify({ lwp: '/!', headers: { mid: 'heartbeat-mid' } }) }
}, 1200);
assert.equal(tracker.deliveryEvidence('claim-a').requestObserved, false, 'Heartbeat frames must not be bound to a delivery attempt.');

tracker.observe('Network.webSocketFrameSent', {
  requestId: 'xy-delivery-socket',
  response: {
    payloadData: JSON.stringify({
      lwp: '/r/MessageSend/sendByReceiverScope',
      headers: { mid: 'manual-mid' },
      body: [{ content: { custom: { data: Buffer.from(JSON.stringify({ contentType: 1, text: { text: '人工同时发送' } })).toString('base64') } } }]
    })
  }
}, 1250);
assert.equal(tracker.deliveryEvidence('claim-a').requestObserved, false, 'A simultaneous manual send with different content must not be bound to the AI claim.');

tracker.observe('Network.webSocketFrameSent', {
  requestId: 'xy-delivery-socket',
  response: {
    payloadData: JSON.stringify({
      lwp: '/r/MessageSend/sendByReceiverScope',
      headers: { mid: 'send-mid-a' },
      body: [{ content: { custom: { data: Buffer.from(JSON.stringify({ contentType: 1, text: { text: replyText } })).toString('base64') } } }]
    })
  }
}, 1300);

let evidence = tracker.deliveryEvidence('claim-a');
assert.equal(evidence.requestObserved, true, 'The real MessageSend frame must be bound to the active outbox claim.');
assert.equal(evidence.platformMid, 'send-mid-a');
assert.equal(evidence.platformAck, false);
assert.equal(JSON.stringify(evidence).includes(replyText), false, 'Delivery diagnostics must never retain customer or reply text.');

tracker.observe('Network.webSocketFrameReceived', {
  requestId: 'xy-delivery-socket',
  response: { payloadData: JSON.stringify({ code: 200, headers: { mid: 'different-mid' } }) }
}, 1400);
assert.equal(tracker.deliveryEvidence('claim-a').platformAck, false, 'An unrelated response must not confirm this reply.');
tracker.observe('Network.webSocketFrameReceived', {
  requestId: 'xy-delivery-socket',
  response: { payloadData: JSON.stringify({ headers: { mid: 'send-mid-a' }, body: {} }) }
}, 1450);
assert.equal(tracker.deliveryEvidence('claim-a').platformCode, null, 'A matching intermediate frame without code must not become a false code 0 rejection.');
assert.equal(tracker.deliveryEvidence('claim-a').platformRejected, false);

tracker.observe('Network.webSocketFrameReceived', {
  requestId: 'xy-delivery-socket',
  response: { payloadData: JSON.stringify({ code: 200, headers: { mid: 'send-mid-a' } }) }
}, 1500);
evidence = tracker.deliveryEvidence('claim-a');
assert.equal(evidence.platformAck, true, 'Only a successful response carrying the exact send mid confirms platform acceptance.');
assert.equal(evidence.platformCode, 200);

const opaqueTracker = new XianyuSocketTracker();
opaqueTracker.observe('Network.webSocketCreated', {
  requestId: 'xy-opaque-socket',
  url: 'wss://wss-goofish.dingtalk.com/'
}, 2000);
opaqueTracker.beginDeliveryAttempt({ claimToken: 'claim-opaque', conversationId: 'buyer-a', textHash: hashXianyuDeliveryText('第二段回复') }, 2100);
opaqueTracker.observe('Network.webSocketFrameSent', {
  requestId: 'xy-opaque-socket',
  response: { payloadData: JSON.stringify({ lwp: '/r/MessageSend/sendByReceiverScope', headers: { mid: 'opaque-mid' }, body: [{ content: { custom: { data: 'not-decodable' } } }] }) }
}, 2200);
assert.equal(opaqueTracker.deliveryEvidence('claim-opaque').requestObserved, true, 'A single serialized delivery must accept an opaque MessageSend request as platform evidence.');
assert.equal(opaqueTracker.deliveryEvidence('claim-opaque').platformMid, 'opaque-mid');

const ambiguousTracker = new XianyuSocketTracker();
ambiguousTracker.observe('Network.webSocketCreated', {
  requestId: 'xy-ambiguous-socket',
  url: 'wss://wss-goofish.dingtalk.com/'
}, 3000);
ambiguousTracker.beginDeliveryAttempt({ claimToken: 'claim-one', conversationId: 'buyer-a', textHash: hashXianyuDeliveryText('回复一') }, 3100);
ambiguousTracker.beginDeliveryAttempt({ claimToken: 'claim-two', conversationId: 'buyer-b', textHash: hashXianyuDeliveryText('回复二') }, 3150);
ambiguousTracker.observe('Network.webSocketFrameSent', {
  requestId: 'xy-ambiguous-socket',
  response: { payloadData: JSON.stringify({ lwp: '/r/MessageSend/sendByReceiverScope', headers: { mid: 'ambiguous-mid' }, body: [] }) }
}, 3200);
assert.equal(ambiguousTracker.deliveryEvidence('claim-one').requestObserved, false, 'An opaque request must not guess between multiple pending deliveries.');
assert.equal(ambiguousTracker.deliveryEvidence('claim-two').requestObserved, false, 'Ambiguous delivery evidence must fail closed.');

const bridgeSource = readFileSync(join(__dirname, '..', 'rpa', 'xianyu-bridge.user.js'), 'utf8');
const sandbox = { setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(bridgeSource, sandbox);
const BubbleState = sandbox.OEDeskOutboundBubbleState;
assert.equal(typeof BubbleState, 'function', 'DOM delivery confirmation must have a testable exact-bubble baseline.');

const baseline = BubbleState.capture([
  { text: '相同回复', id: 'old-message' },
  { text: '其他回复', id: 'other-message' }
], '相同回复');
assert.equal(BubbleState.hasNewExactBubble(baseline, [
  { text: '相同回复', id: 'old-message' },
  { text: '其他回复', id: 'other-message' }
], '相同回复'), false, 'A historical bubble with identical text must not confirm a new send.');
assert.equal(BubbleState.hasNewExactBubble(baseline, [
  { text: '相同回复', id: 'old-message' },
  { text: '其他回复', id: 'other-message' },
  { text: '相同回复', id: 'new-message' }
], '相同回复'), true, 'A new exact outgoing bubble after the baseline is valid DOM evidence.');

console.log('xianyu delivery evidence passed');
