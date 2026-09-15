const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'rpa', 'xianyu-bridge.user.js'), 'utf8');
const serverSource = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');

async function main() {
assert.match(source, /let listening = false;/, 'The DOM bridge must start paused until the local listener is enabled.');
assert.match(source, /function scheduleScan\(/, 'DOM changes must be coalesced before scanning.');
assert.match(source, /if \(!listening \|\| scanBusy\) return;/, 'Scanning must stop while the listener is paused.');
assert.match(source, /setInterval\(\(\) => scheduleScan\('interval'\), 1000\);/, 'Periodic scans must recover within one second when platform mutations are missed.');
assert.doesNotMatch(source, /subtree: true, childList: true, characterData: true/, 'Character-data observation causes scan storms on React pages.');
assert.doesNotMatch(source, /\[class\*="message"\], \[class\*="Message"\], \[class\*="bubble"\]/, 'Broad whole-document message selectors are unsafe on Goofish.');
assert.doesNotMatch(source, /connected: true, listening: true/, 'The heartbeat must not silently re-enable listening after the operator pauses it.');
assert.match(source, /fm-sms-login-id/, 'The heartbeat must recognize the visible Goofish login form.');
assert.match(source, /connected: authenticated/, 'The bridge must report connected only after an authenticated chat shell is observed.');
assert.match(source, /conversationRoots\(\)\.length[\s\S]*findComposer\(\)[\s\S]*messageNodes\(\)\.length/, 'Login detection must tolerate transient virtualized conversation lists.');
assert.match(source, /setInterval\(heartbeat, 2000\)/, 'Login state must refresh promptly after the platform redirects back from sign-in.');
assert.match(serverSource, /hasOwnProperty\.call\(input, 'listening'\)/, 'The API must preserve listener state for heartbeat requests that omit the control field.');
assert.match(serverSource, /const isOperatorControl = !sessionId;/, 'A bridge heartbeat must never be treated as an operator listener-control request.');
assert.match(serverSource, /replyMode: 'human_collab'/, 'Xianyu state must default to the risk-reviewed collaboration mode.');
assert.match(serverSource, /normalizeXianyuReplyMode/, 'Reply mode input must be normalized for legacy clients.');
assert.match(serverSource, /replyMode === 'full_auto'/, 'Full-auto mode must bypass risk gating when a draft is available.');
assert.match(serverSource, /\/api\/xianyu\/reply-mode/, 'The API must expose an explicit reply-mode control.');
assert.match(serverSource, /wasListening = xianyuState\.listening/, 'Listener enablement must detect a paused-to-active transition.');
assert.match(serverSource, /listener backlog failed/, 'Enabling the listener must drain captured inbound messages.');
assert.match(serverSource, /\/api\/xianyu\/history\/clear/, 'History cleanup must clear durable bridge state through a local API.');
assert.match(serverSource, /xianyuState\.listening = false/, 'History cleanup must pause the listener before clearing messages.');
assert.match(source, /document\.execCommand\('insertText'/, 'Contenteditable composers must receive an editing command so React state updates.');
assert.match(source, /function findSendButton\(input\)/, 'The bridge must locate the send control relative to the active composer.');
assert.match(source, /waitForComposerClear\(input\)/, 'Outbox items must only be acknowledged after the platform clears the composer.');

assert.match(source, /replaceComposerWithNativeText\(input, claimed\.text\)/, 'Failed synthetic edits must have a trusted text insertion fallback.');
assert.match(source, /function conversationRows\(\)/, 'The bridge must discover conversation rows outside the active message pane.');
assert.match(source, /async function scanConversationList\(\)/, 'The bridge must scan the conversation list for new previews.');
assert.match(source, /async function openConversation\(/, 'A newly active conversation must be opened before reading its messages.');
assert.match(source, /captureLatestConversationMessage/, 'The first scan after a conversation switch must capture only the triggering inbound message.');
assert.match(source, /function stableConversationVisualIdentity\(/, 'Rows without a platform ID need a stable visual identity that does not change with the preview.');
assert.match(source, /function refreshConversationMutationObserver\(/, 'Text-only changes in the left conversation list must trigger a targeted scan.');
assert.match(source, /conversationMutationObserver\.observe\(root, \{[\s\S]*characterData: true,[\s\S]*childList: true,[\s\S]*subtree: true,[\s\S]*attributes: true,[\s\S]*\}\)/, 'The scoped conversation-list observer must detect text and attribute-only new-message updates.');
assert.match(source, /entries\.filter\(entry => entry\.unread\)\.forEach\(entry => queueConversationOpen\(entry, null\)\)/, 'Unread rows present when the list first loads must be opened without waiting for a self-sent message.');
assert.doesNotMatch(source, /if \(entry\.active \|\| pendingConversationIds\.has\(entry\.id\)\) return;/, 'Active conversation preview changes must not be ignored by the listener.');
assert.doesNotMatch(source, /debugDom|DEBUG-xianyu/, 'Temporary DOM diagnostics must not be shipped in the bridge.');
assert.match(source, /const routable = pending\.map\(entry => \(\{ entry, target: conversationRows\(\)\.find\(row => row\.id === entry\.conversationId\) \}\)\)\.find\(candidate => candidate\.target\)/, 'Legacy outbox IDs must not block newer routable replies.');
assert.match(source, /renderedText\(row\)\.replace\(\/\\b\\d\{1,2\}:\\d\{2\}/, 'Conversation signatures must ignore clock-only updates.');
assert.match(source, /const nodeConversationId = conversationId;/, 'Messages from the active pane must use the same normalized ID as the selected conversation row.');
assert.doesNotMatch(source, /node\.closest\('\[data-conversation-id\]'\)\?\.getAttribute\('data-conversation-id'\) \|\| conversationId/, 'Raw message attributes must not bypass normalized conversation routing.');
assert.match(source, /return `\$\{conversationId\}\|\$\{text\}\|\$\{stamp\}\|\$\{sequence\}\|/, 'Message repaint keys must prefer platform metadata and DOM order over transient node identity.');
assert.match(source, /if \(entry\.active \|\| entry\.id === currentConversationId\) return false;/, 'Active conversation preview changes must not trigger navigation during automatic replies.');
assert.match(serverSource, /recentOutgoingEcho/, 'Recent seller-message echoes must be ignored before entering the RAG pipeline.');
assert.match(serverSource, /item\.direction === 'out'[\s\S]*item\.conversationId === conversationId[\s\S]*item\.text === text/, 'Echo suppression must be scoped to the same conversation and exact text.');
assert.match(serverSource, /authenticated[\s\S]*sessions/, 'Connection status must track authenticated bridge sessions instead of the last heartbeat writer.');
assert.match(source, /if \(!nodes\.length\) \{[\s\S]*scanState\.noteEmpty\(conversationId\)/, 'An empty message pane must pass a hydration grace period before it is treated as a genuinely empty conversation.');
assert.match(source, /if \(started\)\s*\{[\s\S]*requestPlatformScan\('listener-start'\)/, 'Listener enablement must scan immediately instead of waiting for the first interval tick.');
assert.match(source, /Math\.max\(120,/, 'Mutation scans must run with sub-second latency when a buyer message changes the DOM.');
assert.doesNotMatch(source, /const byText = new Map\(\)/, 'Repeated buyer messages with identical text must remain separate candidates.');
assert.match(source, /messagePositionTokens/, 'Fallback message keys need a DOM-order token when the platform omits message IDs.');
assert.match(source, /rightThreshold = panel\.left \+ panel\.width \* 0\.62/, 'Direction detection must have a layout fallback when Goofish hashes message classes.');
assert.match(source, /bridgeVersion/, 'Heartbeat diagnostics must expose the bridge version so stale userscripts can be identified.');
assert.match(serverSource, /!hasIdentity && item\.conversationId === conversationId/, 'Text-only duplicate suppression must not discard distinct keyed messages.');

const sandbox = { setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const ScanState = sandbox.OEDeskConversationScanState;
assert.equal(typeof ScanState, 'function', 'The per-conversation scan state must be executable outside the page.');
const RouteGuard = sandbox.OEDeskOutboundRouteGuard;
assert.equal(typeof RouteGuard, 'function', 'Outbound delivery needs a testable strict active-conversation guard.');
assert.equal(RouteGuard.matches([{ id: 'buyer-a', active: true }], 'buyer-a'), true);
assert.equal(RouteGuard.matches([{ id: 'buyer-b', active: true }], 'buyer-a'), false, 'A stale cached conversation ID must never authorize sending.');
assert.equal(RouteGuard.matches([{ id: 'buyer-a', active: true }, { id: 'buyer-b', active: true }], 'buyer-a'), false, 'Ambiguous active rows must fail closed.');
const ScanScheduler = sandbox.OEDeskScanScheduler;
assert.equal(typeof ScanScheduler, 'function', 'The bridge needs an executable direct-scan scheduler for background pulses.');
const scheduler = new ScanScheduler();
let scanCalls = 0;
let releaseFirstScan;
const scan = async () => {
  scanCalls += 1;
  if (scanCalls === 1) await new Promise(resolve => { releaseFirstScan = resolve; });
};
const firstScan = scheduler.request(scan);
await Promise.resolve();
const trailingScan = scheduler.request(scan);
releaseFirstScan();
await Promise.all([firstScan, trailingScan]);
assert.equal(scanCalls, 2, 'A pulse arriving during a scan must force one trailing scan instead of being lost.');
const stalledScheduler = new ScanScheduler(35);
const stalledOutcome = await Promise.race([
  stalledScheduler.request(() => new Promise(() => {})).then(() => 'resolved', error => error?.code || 'rejected'),
  new Promise(resolve => setTimeout(() => resolve('external-timeout'), 120))
]);
assert.equal(stalledOutcome, 'SCAN_TIMEOUT', 'A hung platform request must release the scan scheduler without waiting for seller activity.');
let recoveryScans = 0;
await stalledScheduler.request(async () => { recoveryScans += 1; });
assert.equal(recoveryScans, 1, 'The next host pulse must scan normally after a timed-out pass.');
const scanState = new ScanState();
scanState.prime('visual:buyer-a');
scanState.prime('/im');
assert.equal(scanState.isPrimed('visual:buyer-a'), true, 'A transient /im identity must not discard the stable conversation baseline.');
scanState.reset();
assert.equal(scanState.isPrimed('visual:buyer-a'), false, 'A listener restart must clear all conversation baselines.');
assert.equal(scanState.noteEmpty('visual:new-buyer', 1000, 2000), false, 'A briefly empty hydrating pane must not be primed immediately.');
assert.equal(scanState.noteEmpty('visual:new-buyer', 2500, 2000), false, 'The empty-pane grace period must remain active until its full duration elapses.');
assert.equal(scanState.noteEmpty('visual:new-buyer', 3001, 2000), true, 'A genuinely empty conversation must be primed after the grace period.');
assert.match(source, /if \(currentConversationId && currentConversationId !== `\$\{location\.pathname\}/, 'A transient missing active row must retain the last stable conversation ID.');
assert.match(source, /globalThis\.__rcbXianyuBridgePulse/, 'Electron must have a host-triggered scan pulse when page timers stall.');
assert.match(source, /globalThis\.__rcbXianyuBridgePulse = \(\) => \{[\s\S]*requestPlatformScan\('electron-host'\)/, 'The Electron pulse must invoke a scan directly instead of creating a renderer timer.');
assert.match(source, /error\?\.code === 'SCAN_TIMEOUT'[\s\S]*scanBusy = false;[\s\S]*timeout-recovery/, 'A timed-out scan must release stale locks and schedule an automatic recovery pass.');
assert.match(source, /const timer = setTimeout\(\(\) => fail\(new Error\('本地服务响应超时'\)\), timeoutMs\)/, 'The bridge must enforce its own request timeout when the Electron GM shim cannot cancel IPC.');

const electronSource = readFileSync(join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
assert.match(electronSource, /setInterval\(\(\) => \{[\s\S]*__rcbXianyuBridgePulse[\s\S]*\}, 750\)/, 'Electron must trigger bridge scans independently of renderer intervals.');
assert.match(electronSource, /signal: AbortSignal\.timeout\(12000\)/, 'Electron-to-local-server requests must not hang indefinitely.');

console.log('xianyu bridge safety contract passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
