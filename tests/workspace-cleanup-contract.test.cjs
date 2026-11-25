const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const htmlSource = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const preloadSource = readFileSync(join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
const electronSource = readFileSync(join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const workspaceRenderer = readFileSync(join(__dirname, '..', 'client', 'workbench-operations.js'), 'utf8');
const workflowRenderer = readFileSync(join(__dirname, '..', 'client', 'workflow-canvas.js'), 'utf8');

assert.doesNotMatch(htmlSource, /TRAINING CANDIDATES/, 'The training candidate board must not be rendered in the knowledge workspace.');
assert.doesNotMatch(htmlSource, /id="knowledge-batch"/, 'The removed candidate board must not leave a batch-review control behind.');
assert.doesNotMatch(htmlSource, /data-candidate-review/, 'The removed candidate board must not leave candidate-review actions behind.');
const workspaceLinks = [...htmlSource.matchAll(/<button class="workspace-nav-item[^"]*" data-workspace="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(workspaceLinks, ['workbench', 'facts', 'knowledge', 'learning-assets', 'prompts', 'workflow', 'gallery', 'review', 'notifications', 'rules', 'associations']);
assert.doesNotMatch(htmlSource + workspaceRenderer + workflowRenderer, /闲鱼/, 'Retired channel names must not appear in workbench controls.');
assert.doesNotMatch(htmlSource, /id="notify-button"|id="add-store-form"|data-store-test|已自动回复（本地模拟）/);
assert.match(preloadSource, /hideXianyu:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('xianyu:hide'\)/, 'Workspace navigation must expose a non-destructive platform-view hide action.');
assert.match(electronSource, /function hideXianyu\(\)/, 'Electron must be able to hide the platform view without destroying its listener.');
assert.match(electronSource, /ipcMain\.handle\('xianyu:hide'/, 'The renderer must be able to request the non-destructive hide action.');

const openWorkspaceBody = htmlSource.match(/function openWorkspace\(name(?:, [^)]*)?\) \{([\s\S]*?)\n    \}/)?.[1] || '';
assert.match(openWorkspaceBody, /hideXianyu\(\)/, 'Opening any workspace must hide the native platform view while keeping its bridge alive.');
assert.doesNotMatch(openWorkspaceBody, /closeXianyu\(\)/, 'Opening a workspace must never destroy the platform listener.');

console.log('workspace cleanup contract passed');
