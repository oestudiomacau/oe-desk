const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const source = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

test('workbench routes a new inbound platform event to the matching platform view', () => {
  assert.match(source, /function autoOpenIncomingPlatform\(platformId, status\)/);
  assert.match(source, /autoOpenIncomingPlatform\('douyin', status\)/);
  assert.doesNotMatch(source, /autoOpenIncomingPlatform\('xianyu', status\)/, 'Background Xianyu events must never reveal a removed Xianyu page.');
  assert.match(source, /lastInboundConversationId/);
  assert.match(source, /return activatePlatform\(platformId\)/);
});

test('background platform events never cover a workspace or open modal', () => {
  assert.match(source, /function platformSurfaceMayAutoOpen\(\)/);
  assert.match(source, /\.app-shell'\)\?\.classList\.contains\('workspace-open'\)/);
  assert.match(source, /\.modal-backdrop\.open/);
  assert.match(source, /if \(!platformSurfaceMayAutoOpen\(\)\) return false;/);
});
