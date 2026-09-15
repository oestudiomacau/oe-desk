const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const htmlSource = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const preloadSource = readFileSync(join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
const electronSource = readFileSync(join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');

assert.doesNotMatch(htmlSource, /TRAINING CANDIDATES/, 'The training candidate board must not be rendered in the knowledge workspace.');
assert.doesNotMatch(htmlSource, /id="knowledge-batch"/, 'The removed candidate board must not leave a batch-review control behind.');
assert.doesNotMatch(htmlSource, /data-candidate-review/, 'The removed candidate board must not leave candidate-review actions behind.');
assert.match(htmlSource, /const demoNotificationIds = new Set\(\['n1', 'n2', 'n3'\]\)/, 'Known demo notifications must be identified for cleanup.');
assert.match(htmlSource, /loadState\('rcb-notifications', \[\]\)/, 'Notification state must start empty without demo content.');
assert.doesNotMatch(htmlSource, /训练场新增候选知识|抖音店铺尚未启动监听|RAG 服务已连接/, 'Virtual notification copy must not remain in the UI.');
assert.match(htmlSource, /暂无通知/, 'The notification workspace must provide an empty state.');
assert.match(htmlSource, /id="notify-count" hidden>0<\/span>/, 'The notification badge must start hidden at zero.');
assert.match(preloadSource, /hideXianyu:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('xianyu:hide'\)/, 'Workspace navigation must expose a non-destructive platform-view hide action.');
assert.match(electronSource, /function hideXianyu\(\)/, 'Electron must be able to hide the platform view without destroying its listener.');
assert.match(electronSource, /ipcMain\.handle\('xianyu:hide'/, 'The renderer must be able to request the non-destructive hide action.');

const openWorkspaceBody = htmlSource.match(/function openWorkspace\(name\) \{([\s\S]*?)\n    \}/)?.[1] || '';
assert.match(openWorkspaceBody, /hideXianyu\(\)/, 'Opening any workspace must hide the native platform view while keeping its bridge alive.');
assert.doesNotMatch(openWorkspaceBody, /closeXianyu\(\)/, 'Opening a workspace must never destroy the platform listener.');

console.log('workspace cleanup contract passed');
