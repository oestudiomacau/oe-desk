const assert = require('node:assert/strict');

const {
  BridgeRecoveryPolicy,
  XianyuSocketTracker,
  classifyXianyuSocketPayload,
  extractXianyuInboundHints,
  isXianyuSocketUrl
} = require('../electron/xianyu-runtime-policy.cjs');

assert.equal(isXianyuSocketUrl('wss://wss-goofish.dingtalk.com/'), true);
assert.equal(isXianyuSocketUrl('wss://example.com/socket'), false);
assert.deepEqual(classifyXianyuSocketPayload('{"code":200,"headers":{"mid":"1"}}'), { application: false, heartbeat: true });
assert.deepEqual(classifyXianyuSocketPayload('{"body":{"syncPushPackage":{"data":[{}]}}}'), { application: true, heartbeat: false });
const inboundHints = extractXianyuInboundHints(JSON.stringify({
  body: {
    syncPushPackage: {
      data: [{
        payload: JSON.stringify({
          messageId: 'buyer-message-1',
          chatId: 'chat-1',
          senderId: 'buyer-1',
          receiverId: 'seller-1',
          reminderContent: '唯一漏收测试消息'
        })
      }]
    }
  }
}));
assert.deepEqual(inboundHints, [{
  messageId: 'buyer-message-1',
  chatId: 'chat-1',
  senderId: 'buyer-1',
  receiverId: 'seller-1',
  text: '唯一漏收测试消息'
}], 'Socket sync payloads must expose bounded inbound routing hints even when their payload is nested JSON text.');

const policy = new BridgeRecoveryPolicy({
  scanStaleMs: 30000,
  heartbeatStaleMs: 20000,
  staleChecksBeforeReload: 3,
  missingHealthMs: 10000,
  reinjectAfterFailures: 2,
  reloadAfterFailures: 4,
  softRecoveryCooldownMs: 0
});

let result = policy.assess({
  now: 100000,
  health: { listening: true, lastSuccessfulScanAt: 99000, lastHeartbeatSucceededAt: 70000 }
});
assert.equal(result.action, 'none', 'A delayed local heartbeat must not reload a page whose DOM scans are still healthy.');

result = policy.assess({
  now: 101000,
  health: { listening: true, lastSuccessfulScanAt: 60000, lastHeartbeatSucceededAt: 100500 }
});
assert.equal(result.action, 'none', 'A slow DOM pass must not reload a page whose bridge heartbeat is still healthy.');

for (const now of [140000, 141000]) {
  result = policy.assess({
    now,
    health: { listening: true, lastSuccessfulScanAt: 100000, lastHeartbeatSucceededAt: 100000 }
  });
  assert.equal(result.action, 'wake', 'Simultaneously stale signals should receive a non-destructive wake before reload.');
}
result = policy.assess({
  now: 142000,
  health: { listening: true, lastSuccessfulScanAt: 100000, lastHeartbeatSucceededAt: 100000 }
});
assert.equal(result.action, 'reload', 'A page may reload only after both health signals stay stale across repeated checks.');

const missingPolicy = new BridgeRecoveryPolicy({
  missingHealthMs: 10000,
  reinjectAfterFailures: 2,
  reloadAfterFailures: 4,
  softRecoveryCooldownMs: 0
});
missingPolicy.assess({ now: 1000, health: { listening: true, lastSuccessfulScanAt: 1000, lastHeartbeatSucceededAt: 1000 } });
assert.equal(missingPolicy.assess({ now: 4000, health: null }).action, 'none');
assert.equal(missingPolicy.assess({ now: 12000, health: null }).action, 'reinject', 'Missing bridge functions should be reinjected before the whole page is reloaded.');
assert.equal(missingPolicy.assess({ now: 13000, health: null }).action, 'reinject');
assert.equal(missingPolicy.assess({ now: 14000, health: null }).action, 'reload', 'Persistent missing health may eventually reload the page.');

const sockets = new XianyuSocketTracker();
assert.equal(sockets.observe('Network.webSocketCreated', { requestId: 'other', url: 'wss://example.com/socket' }, 1000).target, false);
assert.equal(sockets.observe('Network.webSocketCreated', { requestId: 'xy-1', url: 'wss://wss-goofish.dingtalk.com/' }, 2000).kind, 'open');
assert.equal(sockets.connected, true);
const frame = sockets.observe('Network.webSocketFrameReceived', { requestId: 'xy-1', response: { payloadData: '{"body":{"syncPushPackage":{"data":[{}]}}}' } }, 2500);
assert.equal(frame.kind, 'frame');
assert.equal(frame.application, true);
assert.deepEqual(frame.inboundHints, []);
assert.equal(frame.connectionAgeMs, 500);
assert.equal(sockets.lastFrameAt, 2500);
assert.equal(sockets.observe('Network.webSocketClosed', { requestId: 'xy-1' }, 3000).kind, 'close');
assert.equal(sockets.connected, false);
assert.equal(sockets.disconnectedAt, 3000);

console.log('xianyu runtime recovery policy passed');
