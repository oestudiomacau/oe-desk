const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const htmlSource = readFileSync(join(root, 'index.html'), 'utf8');
const mainSource = readFileSync(join(root, 'electron', 'main.cjs'), 'utf8');
const preloadSource = readFileSync(join(root, 'electron', 'preload.cjs'), 'utf8');

for (const platform of ['tmall', 'douyin']) {
  assert.match(
    htmlSource,
    new RegExp(`<button class="conversation" data-client="${platform}">`),
    `${platform} must remain selectable before login.`
  );
}

assert.doesNotMatch(htmlSource, /<button class="conversation" data-client="xianyu">/, 'The Xianyu page must not be exposed in the workbench conversation rail.');
assert.doesNotMatch(htmlSource, /id="workbench-xianyu-bridge"/, 'The Xianyu bridge panel must not be rendered in the workbench.');
assert.doesNotMatch(htmlSource, /xianyu:\s*\{ name: '闲鱼店铺'/, 'The renderer must not retain selectable Xianyu client metadata.');

assert.doesNotMatch(
  htmlSource,
  /if \(!isPlatformConnected\(platformId\)\)[\s\S]{0,160}return;/,
  'The platform click handler must not block access to the login surface.'
);
assert.match(htmlSource, /openPlatform\(platformId, platformId\)/, 'Selecting a platform must open its native login surface in Electron.');
assert.match(preloadSource, /openPlatform:[\s\S]*platform:open/, 'The renderer must expose the narrow platform-open IPC API.');
assert.match(mainSource, /tmall:[\s\S]*douyin:[\s\S]*xianyu:/, 'Electron must define login URLs for every homepage platform.');
assert.match(mainSource, /douyin: process\.env\.DOUYIN_CHAT_URL \|\| 'https:\/\/im\.jinritemai\.com\/pc_seller_v2\/main\/workspace'/, 'Douyin must open the live Feige customer-service workspace, while preserving the URL override.');
assert.match(htmlSource, /frameUrl: 'https:\/\/im\.jinritemai\.com\/pc_seller_v2\/main\/workspace', frameLabel: '飞鸽客服'/, 'Workbench metadata must describe the same Feige chat destination.');
assert.match(mainSource, /ipcMain\.handle\('platform:open'/, 'Electron must handle platform login requests.');
assert.doesNotMatch(
  htmlSource,
  /if \(currentClientId && !isPlatformConnected\(currentClientId\)\) \{[\s\S]*?showNoConnectedPlatform\(\)/,
  'Connection polling must not close a platform while its login page is open.'
);

console.log('platform login contract passed');
