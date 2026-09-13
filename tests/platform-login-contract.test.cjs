const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const htmlSource = readFileSync(join(root, 'index.html'), 'utf8');
const mainSource = readFileSync(join(root, 'electron', 'main.cjs'), 'utf8');
const preloadSource = readFileSync(join(root, 'electron', 'preload.cjs'), 'utf8');

for (const platform of ['tmall', 'douyin', 'xianyu']) {
  assert.match(
    htmlSource,
    new RegExp(`<button class="conversation" data-client="${platform}">`),
    `${platform} must remain selectable before login.`
  );
}

assert.doesNotMatch(
  htmlSource,
  /if \(!isPlatformConnected\(platformId\)\)[\s\S]{0,160}return;/,
  'The platform click handler must not block access to the login surface.'
);
assert.match(htmlSource, /openPlatform\(platformId, platformId\)/, 'Selecting a platform must open its native login surface in Electron.');
assert.match(preloadSource, /openPlatform:[\s\S]*platform:open/, 'The renderer must expose the narrow platform-open IPC API.');
assert.match(mainSource, /tmall:[\s\S]*douyin:[\s\S]*xianyu:/, 'Electron must define login URLs for every homepage platform.');
assert.match(mainSource, /ipcMain\.handle\('platform:open'/, 'Electron must handle platform login requests.');
assert.doesNotMatch(
  htmlSource,
  /if \(currentClientId && !isPlatformConnected\(currentClientId\)\) \{[\s\S]*?showNoConnectedPlatform\(\)/,
  'Connection polling must not close a platform while its login page is open.'
);

console.log('platform login contract passed');
