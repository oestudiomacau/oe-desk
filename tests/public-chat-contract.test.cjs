const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const page = readFileSync(join(__dirname, '..', 'web-chat', 'public', 'index.html'), 'utf8');
const script = readFileSync(join(__dirname, '..', 'web-chat', 'public', 'chat.js'), 'utf8');
const config = readFileSync(join(__dirname, '..', 'web-chat', 'public', 'chat-config.js'), 'utf8');

assert.match(page, /chat\.js/, 'The public page must load its chat behavior.');
assert.match(script, /fetch\(endpoint/, 'The public chat must call the configured API endpoint.');
assert.match(script, /history\.slice\(0, -1\)\.slice\(-24\)/, 'Only recent conversation context may be sent.');
assert.match(script, /AbortController/, 'The public chat must allow a pending response to be stopped.');
assert.match(script, /maxlength="1200"|slice\(0, 1200\)/, 'Visitor input must have a bounded length.');
assert.match(config, /oe-desk-chat-api\.exquisiteclove2\.chatgpt\.site/, 'The public page must point at the deployed backend.');
assert.doesNotMatch(page + script + config, /sk-[A-Za-z0-9]{20,}/, 'The public bundle must not contain an API key.');

console.log('public chat contract passed');
