const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const mainSource = readFileSync(join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const htmlSource = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

assert.match(mainSource, /layoutInFlight/, 'Native platform layout must coalesce async measurements.');
assert.match(mainSource, /layoutQueued/, 'A resize arriving during measurement must trigger a trailing layout.');
assert.match(mainSource, /mainWindow\.on\('resize', scheduleXianyuLayout\)/, 'Window resize must schedule native view bounds recalculation.');
assert.match(htmlSource, /html, body \{ width: 100%; height: 100%; \}/, 'The renderer viewport must have an explicit height anchor.');
assert.match(htmlSource, /\.platform-frame-main[^}]*overflow: hidden/, 'The platform slot must not introduce an independent clipping scrollbar.');
assert.doesNotMatch(htmlSource, /分级发送策略/, 'The retired graded-send banner must not consume workbench space.');
assert.match(htmlSource, /\.workspace-view \{ display: none; grid-column: 3 \/ -1;/, 'Management workspaces must span the former context-rail area.');
assert.match(htmlSource, /workspace-open \.chat, \.app-shell\.workspace-open \.context-panel, \.app-shell\.workspace-open \.column-resizer\.right \{ display: none;/, 'The unused context rail must be hidden while a management workspace is open.');
assert.match(htmlSource, /\.workspace-body \{ width: 100%; max-width: none;/, 'Management content must use the full available workspace width.');
assert.match(htmlSource, /new ResizeObserver\(requestPlatformLayout\)/, 'Platform anchor changes must trigger a coalesced native layout request.');
assert.match(htmlSource, /visualViewport\?\.addEventListener\('resize', requestPlatformLayout/, 'Viewport scale changes must trigger a native layout request.');
assert.doesNotMatch(htmlSource, /store-strip|reception-toggle|active-store-name|active-store-meta/, 'The redundant sidebar store-listening status strip must not be rendered.');
assert.match(htmlSource, /sidebar-bridge-panel \.xianyu-message-list \{ min-height: 240px; max-height: 380px;/, 'The sidebar bridge must reserve a large scrollable live-message area.');
assert.match(htmlSource, /xianyuMessages\.slice\(-80\)/, 'The bridge renderer must retain more recent messages for review.');
assert.doesNotMatch(htmlSource, /<section class="chat-handoff">/, 'The sidebar bridge must not render the retired human-handoff panel.');
assert.match(htmlSource, /AI 思考中[\s\S]*回复生成中[\s\S]*已发送/, 'The bridge must render the three-stage AI workflow status.');
assert.match(htmlSource, /function renderXianyuWorkflow\(latest\)/, 'The AI workflow status must follow the latest bridge message.');
assert.match(mainSource, /ipcMain\.handle\('xianyu:input'[\s\S]*?activateXianyuView\(\)/, 'Trusted platform input must restore WebContents focus before delivery.');

assert.match(mainSource, /webContents\.insertText\(text\)/, 'The platform input bridge must support trusted text insertion for React composers.');
assert.match(mainSource, /app\.setPath\('userData',[\s\S]*OE DESK/, 'OE DESK must not share Electron\'s generic Chromium profile.');
assert.match(mainSource, /app\.requestSingleInstanceLock\(\)/, 'Only one OE DESK main process may own the profile at a time.');
assert.match(mainSource, /app\.on\('second-instance',[\s\S]*mainWindow[\s\S]*focus\(\)/, 'A second launch must focus the existing OE DESK window.');

console.log('electron layout contract passed');
