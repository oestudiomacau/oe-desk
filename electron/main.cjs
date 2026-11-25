/*
 * Electron shell for the OE DESK customer-service workbench.
 *
 * A platform page must be top-level for its login cookies and CSP rules to
 * work.  WebContentsView gives us that top-level page inside the app while each
 * store receives its own persistent session partition.  The existing local
 * RPA bridge is injected after every navigation and talks to server.js over
 * the existing /api/xianyu endpoints.
 */
const { app, BrowserWindow, WebContentsView, ipcMain, net, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { cpSync, existsSync, mkdirSync, readdirSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { BridgeRecoveryPolicy, XianyuSocketTracker } = require('./xianyu-runtime-policy.cjs');
const { restoreProfile } = require('./private-profile.cjs');
const { loadRuntimeEnv, runtimePort } = require('../server/runtime-env.cjs');
const { createUpdateChecker } = require('./release-updates.cjs');
const { version: currentVersion } = require('../package.json');

// Electron development builds otherwise share `%APPDATA%/Electron` with every
// other unpackaged app. Give OE DESK its own Chromium profile before any
// session or BrowserWindow is created.
const legacyUserDataPath = app.getPath('userData');
app.setName('OE DESK');
app.setPath('userData', join(app.getPath('appData'), 'OE DESK'));
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function migrateLegacyPlatformSessions() {
  const legacyPartitions = join(legacyUserDataPath, 'Partitions');
  const targetPartitions = join(app.getPath('userData'), 'Partitions');
  if (!existsSync(legacyPartitions)) return;
  const disposableRoots = new Set([
    'blob_storage', 'Cache', 'Code Cache', 'DawnGraphiteCache',
    'DawnWebGPUCache', 'GPUCache', 'Session Storage', 'Shared Dictionary'
  ]);
  mkdirSync(targetPartitions, { recursive: true });
  for (const name of readdirSync(legacyPartitions)) {
    if (!/^(xianyu|tmall|douyin)-/.test(name)) continue;
    const source = join(legacyPartitions, name);
    const target = join(targetPartitions, name);
    if (existsSync(target)) continue;
    try {
      cpSync(source, target, {
        recursive: true,
        filter(candidate) {
          const relative = candidate.slice(source.length).replace(/^[\\/]+/, '');
          const rootName = relative.split(/[\\/]/)[0];
          return !rootName || !disposableRoots.has(rootName);
        }
      });
    } catch (error) {
      console.warn(`Unable to migrate legacy platform session ${name}: ${error.message}`);
    }
  }
}

if (hasSingleInstanceLock) migrateLegacyPlatformSessions();

const root = join(__dirname, '..');
const workbenchRoot = app.isPackaged ? join(app.getPath('userData'), 'workbench') : root;
const port = runtimePort(loadRuntimeEnv(join(workbenchRoot, '.env'), { ...process.env }).PORT);
const feigeHistoryKey = process.env.RCB_FEIGE_HISTORY_KEY || randomUUID();
const desktopSettingsKey = process.env.RCB_DESKTOP_SETTINGS_KEY || randomUUID();
const workbenchUrl = `http://127.0.0.1:${port}/`;
const checkUpdate = createUpdateChecker({ currentVersion, packaged: app.isPackaged, platform: process.platform,
  arch: process.arch, request: (...args) => net.fetch(...args) });
const platformUrls = {
  xianyu: process.env.XIANYU_CHAT_URL || 'https://www.goofish.com/im',
  tmall: process.env.TMALL_CHAT_URL || 'https://myseller.taobao.com/home.htm',
  douyin: process.env.DOUYIN_CHAT_URL || 'https://im.jinritemai.com/pc_seller_v2/main/workspace'
};
const bridgePath = join(root, 'rpa', 'xianyu-bridge.user.js');
const feigeBridgePath = join(root, 'rpa', 'feige-bridge.user.js');

let serverProcess;
let mainWindow;
let xianyuView;
let xianyuStoreId = '';
let otherPlatformView;
const otherPlatformViews = new Map();
const platformPageGroups = new Map();
let otherPlatformId = '';
let otherStoreId = '';
let otherPlatformVisible = false;
let listenerHostWindow;
let currentBounds = null;
let activeStoreId = 'default';
let activePlatform = 'xianyu';
let platformOpenTail = Promise.resolve();
let bridgePulseTimer;
let xianyuViewVisible = false;
let bridgePulseBusy = false;
let lastBridgeHealthAt = 0;
let lastBridgeRecoveryAt = 0;
let bridgeRecoveryInFlight = false;
let xianyuSocketDisconnectTimer;
const xianyuSocketWakeTimers = new Set();
const xianyuSocketInboundHints = new Map();
const monitoredXianyuContents = new WeakSet();
const bridgeRecoveryPolicy = new BridgeRecoveryPolicy();
const xianyuSocketTracker = new XianyuSocketTracker();
let serverRestartTimer;
let serverHealthTimer;
let serverHealthFailures = 0;
let serverRestartAttempts = 0;
let serverRestartInFlight = null;
let appQuitting = false;
const intentionalServerStops = new WeakSet();

function activePlatformUrl() { return platformUrls[activePlatform] || platformUrls.xianyu; }

async function recoverXianyuView(reason, { force = false } = {}) {
  if (bridgeRecoveryInFlight || !xianyuView || xianyuView.webContents.isDestroyed()) return false;
  const now = Date.now();
  if (!force && now - lastBridgeRecoveryAt < 30000) return false;
  bridgeRecoveryInFlight = true;
  const view = xianyuView;
  try {
    if (!force && view.webContents.isLoading()) return false;
    if (!force) {
      const hasDraft = await view.webContents.executeJavaScript(`(() => [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].some(input => {
        if (!input.getClientRects?.().length) return false;
        return Boolean(String(input.isContentEditable ? input.textContent || '' : input.value || '').replace(/\\u200b/g, '').trim());
      }))()`, true).catch(() => false);
      if (hasDraft) {
        pageLog('bridge-recovery-deferred', { reason: `${reason}: active draft` });
        return false;
      }
    }
    lastBridgeRecoveryAt = now;
    lastBridgeHealthAt = 0;
    bridgeRecoveryPolicy.reset();
    xianyuSocketTracker.reset();
    clearTimeout(xianyuSocketDisconnectTimer);
    pageLog('bridge-recovery', { reason });
    view.webContents.reload();
    return true;
  } catch (error) {
    pageLog('bridge-recovery-error', { reason, error: error.message });
    return false;
  } finally {
    bridgeRecoveryInFlight = false;
  }
}

function clearXianyuSocketWakeTimers() {
  for (const timer of xianyuSocketWakeTimers) clearTimeout(timer);
  xianyuSocketWakeTimers.clear();
  xianyuSocketInboundHints.clear();
}

function scheduleXianyuSocketWake(reason = 'websocket-frame', inboundHints = []) {
  const view = xianyuView;
  if (!view || view.webContents.isDestroyed()) return;
  for (const hint of Array.isArray(inboundHints) ? inboundHints : []) {
    const key = `${hint.messageId || ''}|${hint.chatId || ''}|${hint.senderId || ''}|${hint.text || ''}`;
    if (key !== '|||') xianyuSocketInboundHints.set(key, hint);
  }
  if (xianyuSocketWakeTimers.size) return;
  const snapshot = xianyuSocketTracker.snapshot();
  // One incoming package can precede the React conversation-list update by
  // several frames. Wake immediately, then rescan at progressively wider
  // intervals so the rendered message is captured without busy polling.
  for (const delay of [0, 90, 240, 520, 1000, 1800, 3000]) {
    const timer = setTimeout(() => {
      xianyuSocketWakeTimers.delete(timer);
      if (view !== xianyuView || view.webContents.isDestroyed()) return;
      view.webContents.executeJavaScript(`globalThis.__rcbXianyuBridgeSocketEvent?.(${JSON.stringify({
        reason,
        at: Date.now(),
        connected: snapshot.connected,
        lastFrameAt: snapshot.lastFrameAt,
        inboundHints: [...xianyuSocketInboundHints.values()]
      })})`, true).catch(() => {});
      if (delay === 3000) xianyuSocketInboundHints.clear();
    }, delay);
    timer.unref?.();
    xianyuSocketWakeTimers.add(timer);
  }
}

function scheduleXianyuSocketDisconnectRecovery(contents) {
  clearTimeout(xianyuSocketDisconnectTimer);
  xianyuSocketDisconnectTimer = setTimeout(async () => {
    if (!xianyuView || contents !== xianyuView.webContents || contents.isDestroyed() || contents.isLoading() || xianyuSocketTracker.connected) return;
    const health = await contents.executeJavaScript('globalThis.__rcbXianyuBridgeHealth?.() || null', true).catch(() => null);
    // Give the page's own socket client a generous reconnect window. A closed
    // socket plus an enabled listener is a stronger failure signal than a
    // delayed DOM timer, so only this state authorizes page recovery.
    if (health?.listening) await recoverXianyuView('xianyu websocket disconnected');
  }, 12000);
  xianyuSocketDisconnectTimer.unref?.();
}

async function attachXianyuSocketMonitor(contents) {
  if (!contents || contents.isDestroyed() || monitoredXianyuContents.has(contents)) return false;
  monitoredXianyuContents.add(contents);
  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Network.enable');
    contents.debugger.on('message', (_event, method, params) => {
      if (contents !== xianyuView?.webContents) return;
      const event = xianyuSocketTracker.observe(method, params);
      if (!event.target) return;
      if (event.kind === 'open') {
        clearTimeout(xianyuSocketDisconnectTimer);
        pageLog('websocket-open', { url: event.url });
      } else if (event.kind === 'frame') {
        if (event.delivery?.kind === 'delivery-ack') {
          pageLog('delivery-platform-ack', { claimToken: event.delivery.claimToken, mid: event.delivery.mid, code: event.delivery.code });
        }
        // Ignore protocol heartbeats and the initial sync burst. They prove
        // liveness but are not evidence of a newly rendered buyer message.
        if (event.application && event.connectionAgeMs >= 2500) scheduleXianyuSocketWake('websocket-message', event.inboundHints);
      } else if (event.kind === 'sent-frame' && event.delivery?.kind === 'delivery-request') {
        pageLog('delivery-platform-request', { claimToken: event.delivery.claimToken, mid: event.delivery.mid, lwp: event.delivery.lwp });
      } else if (event.kind === 'close' || event.kind === 'error') {
        pageLog('websocket-closed', { kind: event.kind, remaining: xianyuSocketTracker.snapshot().connectionCount });
        if (!xianyuSocketTracker.connected) scheduleXianyuSocketDisconnectRecovery(contents);
      }
    });
    contents.debugger.once('detach', (_event, reason) => {
      pageLog('websocket-monitor-detached', { reason });
      xianyuSocketTracker.reset();
    });
    return true;
  } catch (error) {
    // CDP monitoring is an acceleration layer. The DOM observer and host pulse
    // remain operational if DevTools or an Electron build owns the debugger.
    pageLog('websocket-monitor-unavailable', { error: error.message });
    return false;
  }
}

async function applyBridgeRecoveryAssessment(assessment, view) {
  if (!assessment || assessment.action === 'none' || assessment.action === 'wake') return;
  if (assessment.action === 'reinject') {
    if (view.webContents.isDestroyed() || view.webContents.isLoading()) return;
    await view.webContents.executeJavaScript(`(() => {
      if (typeof globalThis.__rcbXianyuBridgeHealth !== 'function') delete globalThis.__rcbXianyuBridgeLoaded;
    })()`, true).catch(() => {});
    await injectBridge(view.webContents);
    return;
  }
  if (assessment.action === 'reload') await recoverXianyuView(assessment.reason || 'bridge health failed');
}

async function pulseXianyuBridge() {
  if (bridgePulseBusy || !xianyuView || xianyuView.webContents.isDestroyed()) return;
  bridgePulseBusy = true;
  const view = xianyuView;
  try {
    const health = await Promise.race([
      view.webContents.executeJavaScript(`(() => {
        globalThis.__rcbXianyuBridgePulse?.(${JSON.stringify({ operatorVisible: xianyuViewVisible, ...xianyuSocketTracker.snapshot() })});
        return globalThis.__rcbXianyuBridgeHealth?.() || null;
      })()`, true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('bridge pulse timeout')), 3500))
    ]);
    if (health) {
      lastBridgeHealthAt = Date.now();
      await applyBridgeRecoveryAssessment(bridgeRecoveryPolicy.assess({ health, now: Date.now(), pageLoading: view.webContents.isLoading() }), view);
    } else {
      await applyBridgeRecoveryAssessment(bridgeRecoveryPolicy.assess({ health: null, now: Date.now(), pageLoading: view.webContents.isLoading() }), view);
    }
  } catch (error) {
    if (!view.webContents.isDestroyed()) {
      await applyBridgeRecoveryAssessment(bridgeRecoveryPolicy.assess({ health: null, now: Date.now(), pageLoading: view.webContents.isLoading() }), view);
    }
  } finally {
    bridgePulseBusy = false;
  }
}

function startBridgePulse() {
  clearInterval(bridgePulseTimer);
  bridgePulseTimer = setInterval(() => { pulseXianyuBridge().catch(() => {}); }, 750);
  bridgePulseTimer.unref?.();
}

function stopBridgePulse() {
  clearInterval(bridgePulseTimer);
  bridgePulseTimer = undefined;
}

function listenerHostBounds(bounds = currentBounds) {
  return {
    x: 0,
    y: 0,
    width: Math.max(900, Number(bounds?.width || 0)),
    height: Math.max(640, Number(bounds?.height || 0))
  };
}

function ensureListenerHostWindow() {
  if (listenerHostWindow && !listenerHostWindow.isDestroyed()) return listenerHostWindow;
  listenerHostWindow = new BrowserWindow({
    x: -20000,
    y: -20000,
    width: 1000,
    height: 700,
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    opacity: 0.01,
    backgroundColor: '#f5f7f4',
    webPreferences: { backgroundThrottling: false }
  });
  listenerHostWindow.setIgnoreMouseEvents(true);
  // A shown offscreen host keeps Page Visibility in the visible state, which
  // Goofish requires before it hydrates the chat shell and opens its live
  // message connection. show:false or an offscreen child of the main window
  // leaves document.visibilityState=hidden on a cold start.
  listenerHostWindow.showInactive();
  listenerHostWindow.on('closed', () => { listenerHostWindow = null; });
  return listenerHostWindow;
}

function detachXianyuView(view = xianyuView) {
  if (!view) return;
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view); } catch { /* Not attached to the main window. */ }
  try { if (listenerHostWindow && !listenerHostWindow.isDestroyed()) listenerHostWindow.contentView.removeChildView(view); } catch { /* Not attached to the listener host. */ }
}

function selectedPlatformView() {
  return activePlatform === 'xianyu' ? xianyuView : otherPlatformView;
}

function mountOtherPlatformView({ reveal = false } = {}) {
  if (!otherPlatformView) return false;
  detachXianyuView(otherPlatformView);
  otherPlatformVisible = Boolean(reveal);
  if (!otherPlatformView.webContents.isDestroyed() && /^https:\/\/im\.jinritemai\.com\//.test(otherPlatformView.webContents.getURL())) {
    otherPlatformView.webContents.executeJavaScript(`globalThis.__oeFeigeVisible = ${Boolean(reveal)}`).catch(() => {});
  }
  if (reveal) {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.contentView.addChildView(otherPlatformView);
    otherPlatformView.webContents.focus();
    scheduleXianyuLayout();
  } else {
    ensureListenerHostWindow().contentView.addChildView(otherPlatformView);
    otherPlatformView.setBounds(listenerHostBounds());
  }
  return true;
}

function mountXianyuView({ reveal = false } = {}) {
  if (!xianyuView) return false;
  detachXianyuView(xianyuView);
  xianyuViewVisible = Boolean(reveal);
  if (reveal) {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.contentView.addChildView(xianyuView);
  } else {
    const host = ensureListenerHostWindow();
    host.contentView.addChildView(xianyuView);
    xianyuView.setBounds(listenerHostBounds());
  }
  return true;
}

/** Focus the platform only when it is already visible; reveal requires an explicit action. */
function activateXianyuView({ reveal = false, allowHiddenFocus = false } = {}) {
  if (!xianyuView || !mainWindow || mainWindow.isDestroyed()) return false;
  try {
    if (reveal) {
      mountXianyuView({ reveal: true });
      if (typeof xianyuView.setVisible === 'function') xianyuView.setVisible(true);
    }
    if (!xianyuViewVisible && !allowHiddenFocus) return false;
    // Electron 31's WebContentsView does not expose setEnabled (newer builds
    // may); do not let an optional API prevent z-order/focus restoration.
    if (typeof xianyuView.setEnabled === 'function') xianyuView.setEnabled(true);
    xianyuView.webContents.focus();
    return true;
  } catch (error) {
    pageLog('view-activation-error', { error: error.message });
    return false;
  }
}

function sanitizeStoreId(value) {
  const sanitized = String(value || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return sanitized || 'default';
}

function pageLog(event, details = {}) {
  // Never print cookies, headers, message bodies or query-string parameters.
  const safe = { event, platform: activePlatform, storeId: activeStoreId, ...details };
  if (safe.url) {
    try { const parsed = new URL(safe.url); safe.url = `${parsed.origin}${parsed.pathname}`; } catch { safe.url = '[invalid-url]'; }
  }
  console.log(`[xianyu] ${JSON.stringify(safe)}`);
}

async function workbenchHealthy(timeoutMs = 2500) {
  try {
    const response = await fetch(`${workbenchUrl}api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch { return false; }
}

function scheduleLocalServerRestart(reason = 'unexpected exit') {
  if (appQuitting || process.env.RCB_ELECTRON_EXTERNAL_SERVER === 'true') return;
  clearTimeout(serverRestartTimer);
  const delay = Math.min(10000, 500 * (2 ** Math.min(serverRestartAttempts, 4)));
  serverRestartAttempts += 1;
  serverRestartTimer = setTimeout(() => {
    restartLocalServer(reason).catch(error => console.error('Unable to recover local RAG service:', error));
  }, delay);
  serverRestartTimer.unref?.();
}

async function startLocalServer({ skipHealthCheck = false } = {}) {
  if (process.env.RCB_ELECTRON_EXTERNAL_SERVER === 'true') return false;
  if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) return true;
  // Reuse a service started with `npm start`; starting a second listener on
  // the same port causes an unhandled EADDRINUSE crash in the Electron shell.
  if (!skipHealthCheck && await workbenchHealthy()) return false;
  mkdirSync(workbenchRoot, { recursive: true });
  const child = spawn(process.execPath, [join(root, 'server.js')], {
    cwd: workbenchRoot,
    // Electron's executable is not Node by default; this flag runs the child
    // with Node semantics instead of opening a second Electron app instance.
    env: { ...process.env, PORT: String(port), RCB_DESKTOP_PORT: String(port), ELECTRON_RUN_AS_NODE: '1', RCB_FEIGE_HISTORY_KEY: feigeHistoryKey,
      RCB_DESKTOP_SETTINGS_KEY: desktopSettingsKey },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  serverProcess = child;
  child.stdout.on('data', data => process.stdout.write(`[server] ${data}`));
  child.stderr.on('data', data => process.stderr.write(`[server] ${data}`));
  child.on('error', error => {
    if (error.code !== 'EADDRINUSE') console.error('Unable to start local RAG service:', error);
  });
  serverProcess.on('exit', (code, signal) => {
    if (serverProcess === child) serverProcess = undefined;
    if (!appQuitting && !intentionalServerStops.has(child)) scheduleLocalServerRestart(`service exited (${code ?? signal ?? 'unknown'})`);
  });
  return true;
}

async function restartLocalServer(reason = 'health check failed') {
  if (serverRestartInFlight) return serverRestartInFlight;
  serverRestartInFlight = (async () => {
    const child = serverProcess;
    if (child && child.exitCode === null && child.signalCode === null) {
      pageLog('server-restart', { reason });
      intentionalServerStops.add(child);
      child.kill();
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 2500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (await workbenchHealthy(1200)) {
      serverHealthFailures = 0;
      serverRestartAttempts = 0;
      return false;
    }
    await startLocalServer({ skipHealthCheck: true });
    await waitForWorkbench();
    serverHealthFailures = 0;
    serverRestartAttempts = 0;
    return true;
  })().finally(() => { serverRestartInFlight = null; });
  return serverRestartInFlight;
}

function startServerHealthMonitor() {
  clearInterval(serverHealthTimer);
  serverHealthTimer = setInterval(async () => {
    if (await workbenchHealthy()) {
      serverHealthFailures = 0;
      serverRestartAttempts = 0;
      return;
    }
    serverHealthFailures += 1;
    if (serverHealthFailures < 3) return;
    if (serverProcess) await restartLocalServer('api/health failed repeatedly').catch(() => {});
    else await startLocalServer().catch(() => {});
  }, 5000);
  serverHealthTimer.unref?.();
}

async function waitForWorkbench() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${workbenchUrl}api/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`RCB service did not start at ${workbenchUrl}`);
}

let layoutTimer;
let layoutInFlight = false;
let layoutQueued = false;

/** Measure the renderer's browser slot instead of guessing grid dimensions. */
async function viewBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    const measurement = await mainWindow.webContents.executeJavaScript(`(() => {
      const node = document.querySelector('[data-platform-anchor="xianyu"]')
        || document.querySelector('#platform-chat-frame .platform-frame-browser');
      if (!node) return { hidden: true };
      const box = node.getBoundingClientRect();
      const shell = document.querySelector('.app-shell');
      const style = getComputedStyle(node);
      const hidden = Boolean(shell?.classList.contains('workspace-open'))
        || Boolean(document.querySelector('#settings-modal.open'))
        || style.display === 'none'
        || style.visibility === 'hidden'
        || !box.width || !box.height;
      return hidden ? { hidden: true } : { hidden: false, x: box.left, y: box.top, width: box.width, height: box.height };
    })()`, true);
    if (!measurement || measurement.hidden) return { hidden: true };
    const [contentWidth, contentHeight] = mainWindow.getContentSize();
    // Clamp both edges. A renderer reflow or platform switch can briefly
    // produce a negative/oversized DOM rect; never let the native surface
    // escape the BrowserWindow content area in that frame.
    const x = Math.min(Math.max(0, Math.round(measurement.x)), Math.max(0, contentWidth - 1));
    const y = Math.min(Math.max(0, Math.round(measurement.y)), Math.max(0, contentHeight - 1));
    const availableWidth = Math.max(1, contentWidth - x);
    const availableHeight = Math.max(1, contentHeight - y);
    return {
      x,
      y,
      width: Math.min(Math.max(1, Math.round(measurement.width)), availableWidth),
      height: Math.min(Math.max(1, Math.round(measurement.height)), availableHeight)
    };
  } catch {
    return null;
  }
}

async function layoutXianyuView() {
  const selected = selectedPlatformView();
  if (!(activePlatform === 'xianyu' ? xianyuViewVisible : otherPlatformVisible) || !selected || !mainWindow || mainWindow.isDestroyed()) return;
  // Renderer measurements are asynchronous.  Coalesce requests so a fast
  // window resize cannot apply an older rect after a newer one.
  if (layoutInFlight) {
    layoutQueued = true;
    return;
  }
  layoutInFlight = true;
  const view = selected;
  try {
    const bounds = await viewBounds();
    if (bounds?.hidden) {
      // The renderer has switched to a workspace or is between platform
      // layouts. Reparent the native page to the offscreen listener host so a
      // stale previous rectangle can never cover the center workspace.
      if (activePlatform === 'xianyu') mountXianyuView({ reveal: false });
      else mountOtherPlatformView({ reveal: false });
      currentBounds = null;
      emitState({ visible: false, bounds: null });
      return;
    }
    if (bounds && selectedPlatformView() === view && !view.webContents.isDestroyed() && mainWindow && !mainWindow.isDestroyed()) {
      // Avoid needless native view invalidations when ResizeObserver fires for
      // unrelated descendants inside the platform slot.
      const unchanged = currentBounds
        && currentBounds.x === bounds.x
        && currentBounds.y === bounds.y
        && currentBounds.width === bounds.width
        && currentBounds.height === bounds.height;
      if (!unchanged) {
        currentBounds = bounds;
        view.setBounds(bounds);
        pageLog('layout', { bounds });
        emitState({ bounds });
      }
    }
  } catch (error) {
    pageLog('layout-error', { error: error.message });
  } finally {
    layoutInFlight = false;
    if (layoutQueued) {
      layoutQueued = false;
      scheduleXianyuLayout();
    }
  }
}

function scheduleXianyuLayout() {
  clearTimeout(layoutTimer);
  // Wait for responsive CSS/grid reflow before measuring the slot.
  layoutTimer = setTimeout(() => { layoutXianyuView().catch(() => {}); }, 20);
}

function emitState(patch = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const fallbackUrl = activePlatformUrl();
  const view = selectedPlatformView();
  const group = platformPageGroups.get(`${activePlatform}:${activeStoreId}`);
  const currentUrl = view && !view.webContents.isDestroyed() ? view.webContents.getURL() : '';
  const url = currentUrl || (group?.selected ? 'about:blank' : fallbackUrl);
  const pages = group && [...group.pages].filter(([, page]) => !page.webContents.isDestroyed()).map(([id, page]) => ({
    id, title: page.webContents.getTitle() || (id === 0 ? '平台首页' : '新页面')
  }));
  mainWindow.webContents.send('xianyu:state', { platform: activePlatform, storeId: activeStoreId, session: `persist:${activePlatform}-${activeStoreId}`, url, embedded: Boolean(view), visible: activePlatform === 'xianyu' ? xianyuViewVisible : otherPlatformVisible, bounds: currentBounds, lastError: null, pages, pageId: group?.selected, ...patch });
}

async function inspectDouyinStructure(contents) {
  if (process.env.RCB_FEIGE_INSPECT !== '1' || contents.isDestroyed()) return;
  const structure = await contents.executeJavaScript(`(() => {
    const candidates = [...document.querySelectorAll('input,textarea,[contenteditable],button,[role="textbox"],[class*="session"],[class*="message"],[class*="conversation"],[class*="chat"]')];
    const shape = (el, depth = 0) => ({ tag: el.tagName.toLowerCase(), id: el.id || '',
      classes: typeof el.className === 'string' ? el.className.slice(0, 140) : '',
      attributes: el.getAttributeNames().filter(name => /^(data-|role|contenteditable)/.test(name)),
      children: depth < 5 ? [...el.children].slice(0, 12).map(child => shape(child, depth + 1)) : el.children.length });
    return { title: document.title, url: location.origin + location.pathname, count: candidates.length,
      state: { permissionDenied: document.body.innerText.includes('暂无会话权限'), loginExpired: document.body.innerText.includes('登录已过期'),
        noCurrentChats: document.body.innerText.includes('暂无会话中用户') },
      chat: (() => {
        const summarize = el => el && ({ tag: el.tagName.toLowerCase(), classes: String(el.className || '').slice(0, 150),
          attrs: [...el.attributes].filter(attr => /^(data-|role|aria-|id$|title$)/.test(attr.name)).map(attr => [attr.name, attr.value.slice(0, 100)]),
          children: [...el.children].slice(0, 8).map(child => ({ tag: child.tagName.toLowerCase(), classes: String(child.className || '').slice(0, 100), attrs: [...child.attributes].filter(attr => /^(data-|id$)/.test(attr.name)).map(attr => [attr.name, attr.value.slice(0, 80)]) })) });
        const list = document.querySelector('.messageList');
        const editor = document.querySelector('textarea[data-qa-id]');
        const messages = [...document.querySelectorAll('.messageList .messageNotMe, .messageList .messageIsMe')];
        return { list: summarize(list), listParent: summarize(list?.parentElement), messageCount: messages.length,
          messages: messages.slice(-3).map(el => ({ self: summarize(el), parent: summarize(el.parentElement),
            descendants: [...el.querySelectorAll('[data-qa-id], [data-message-id], [data-id], [id], time')].slice(0, 8).map(summarize) })),
          editor: summarize(editor), editorParent: summarize(editor?.parentElement),
          likelyRows: [...document.querySelectorAll('[class*="session"], [class*="Session"], [class*="conversation"], [class*="Conversation"]')]
            .filter(el => el.getClientRects().length && el.children.length < 12).slice(0, 16).map(summarize) };
      })(),
      root: [...document.body.children].slice(0, 12).map(el => shape(el)),
      nodes: candidates.slice(0, 180).map(el => ({ tag: el.tagName.toLowerCase(), id: el.id || '',
        classes: typeof el.className === 'string' ? el.className.slice(0, 180) : '',
        role: el.getAttribute('role') || '', attrs: el.getAttributeNames().filter(name => /^(data-|contenteditable|aria-|placeholder)/.test(name)), children: el.children.length })) };
  })()`, true).catch(error => ({ error: error.message }));
  console.log(`[feige-structure] ${JSON.stringify(structure)}`);
}

async function injectFeigeBridge(contents) {
  if (contents.isDestroyed() || !/^https:\/\/im\.jinritemai\.com\//.test(contents.getURL())) return;
  try {
    const source = await readFile(feigeBridgePath, 'utf8');
    const visible = otherPlatformVisible && otherPlatformView?.webContents === contents;
    await contents.executeJavaScript(`globalThis.__oeFeigePort = ${port}; globalThis.__oeFeigeVisible = ${visible};\n${source.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '')}`, true);
    if (activePlatform === 'douyin') emitState({ bridge: 'injected' });
  } catch (error) {
    console.warn('Feige bridge injection failed:', error.message);
    if (activePlatform === 'douyin') emitState({ bridge: 'error', lastError: error.message });
  }
}

function selectPlatformPage(group, id) {
  const page = group.pages.get(id);
  if (!page || page.webContents.isDestroyed()) return false;
  if (otherPlatformView && otherPlatformView !== page && !otherPlatformView.webContents.isDestroyed()) {
    mountOtherPlatformView({ reveal: false });
  }
  group.selected = id;
  otherPlatformView = page;
  mountOtherPlatformView({ reveal: true });
  emitState({ page: 'ready' });
  return true;
}

function webPlatformUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function operatorPlatformUrl(address) {
  const value = String(address || '').trim();
  if (!value) return null;
  // A numeric suffix can be a port on a bare hostname.
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^[a-z][a-z\d+.-]*:(?!\d)/i.test(value);
  return webPlatformUrl(hasScheme ? value : `https://${value}`);
}

function watchPlatformPage(group, id, view) {
  const contents = view.webContents;
  const isSelected = () => otherPlatformVisible && otherPlatformView === view;
  const reportNavigation = () => { if (isSelected()) emitState({ page: 'ready', url: contents.getURL() }); };
  const allowWebNavigation = (event, url) => { if (!webPlatformUrl(url)) event.preventDefault(); };
  contents.on('will-navigate', allowWebNavigation);
  contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
    if (isMainFrame) allowWebNavigation(event, url);
  });
  contents.on('did-navigate', reportNavigation);
  contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) reportNavigation(); });
  contents.on('did-start-loading', () => { if (isSelected()) emitState({ page: 'loading' }); });
  contents.on('page-title-updated', () => {
    if (otherPlatformVisible && group.pages.get(group.selected) === otherPlatformView) emitState();
  });
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && isSelected()) emitState({ page: 'error', url, lastError: `${code}: ${description}` });
  });
  contents.setWindowOpenHandler(({ url, referrer, postBody }) => {
    const destination = webPlatformUrl(url);
    if (!destination && url !== 'about:blank') return { action: 'deny' };
    const loadOptions = { httpReferrer: referrer };
    if (postBody) {
      loadOptions.postData = postBody.data;
      loadOptions.extraHeaders = `Content-Type: ${postBody.contentType}${postBody.boundary ? `; boundary=${postBody.boundary}` : ''}`;
    }
    if (id === 0 && group.platformId === 'douyin' && !group.manualNavigation && isFeigeWorkspace(destination)) {
      setImmediate(() => { if (!contents.isDestroyed()) contents.loadURL(destination, loadOptions).catch(() => {}); });
      return { action: 'deny' };
    }
    const webPreferences = { session: group.session, contextIsolation: true, nodeIntegration: false, sandbox: true };
    return {
      action: 'allow',
      outlivesOpener: true,
      overrideBrowserWindowOptions: { webPreferences },
      createWindow: options => {
        const page = new WebContentsView({ webContents: options.webContents, webPreferences });
        const pageId = ++group.nextPageId;
        group.pages.set(pageId, page);
        watchPlatformPage(group, pageId, page);
        page.webContents.once('destroyed', () => {
          group.pages.delete(pageId);
          if (group.selected === pageId) {
            group.selected = 0;
            if (otherPlatformView === page && otherPlatformVisible) {
              otherPlatformView = null;
              selectPlatformPage(group, 0);
              return;
            }
          }
          if (otherPlatformVisible && group.pages.get(group.selected) === otherPlatformView) emitState();
        });
        if (otherPlatformVisible && group.pages.get(group.selected) === otherPlatformView) selectPlatformPage(group, pageId);
        if (!options.webContents) page.webContents.loadURL(destination || url, loadOptions).catch(() => {});
        return page.webContents;
      }
    };
  });
}

async function openOtherPlatform(storeId, platformId, { reveal = true } = {}) {
  const nextStoreId = sanitizeStoreId(storeId);
  const key = `${platformId}:${nextStoreId}`;
  if (otherPlatformView && otherPlatformVisible && (otherPlatformId !== platformId || otherStoreId !== nextStoreId)) {
    mountOtherPlatformView({ reveal: false });
  }
  let view = otherPlatformViews.get(key);
  let group = platformPageGroups.get(key);
  let loadInitialPage = false;
  if (!view || view.webContents.isDestroyed()) {
    const storeSession = session.fromPartition(`persist:${platformId}-${nextStoreId}`);
    view = new WebContentsView({ webPreferences: {
      session: storeSession, contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: join(__dirname, 'platform-preload.cjs')
    } });
    otherPlatformViews.set(key, view);
    group = { platformId, session: storeSession, pages: new Map([[0, view]]), selected: 0, nextPageId: 0, manualNavigation: false };
    platformPageGroups.set(key, group);
    view.webContents.setBackgroundThrottling(false);
    let returnedToFeige = false;
    watchPlatformPage(group, 0, view);
    view.webContents.on('did-finish-load', () => {
      if (view.webContents.isDestroyed()) return;
      if (platformId === 'douyin') {
        const currentUrl = view.webContents.getURL();
        if (!group.manualNavigation && isDouyinSellerHome(currentUrl) && !returnedToFeige) {
          returnedToFeige = true;
          setImmediate(() => {
            if (!group.manualNavigation && !view.webContents.isDestroyed() && isDouyinSellerHome(view.webContents.getURL())) {
              view.webContents.loadURL(platformUrls.douyin).catch(() => {});
            }
          });
          return;
        }
        if (isFeigeWorkspace(currentUrl)) returnedToFeige = false;
        inspectDouyinStructure(view.webContents).catch(() => {});
        setTimeout(() => inspectDouyinStructure(view.webContents).catch(() => {}), 6000).unref?.();
        injectFeigeBridge(view.webContents).catch(() => {});
        if (process.env.RCB_FEIGE_INSPECT === '1') {
          const timer = setInterval(async () => {
            if (view.webContents.isDestroyed()) { clearInterval(timer); return; }
            const editorCount = await view.webContents.executeJavaScript('document.querySelectorAll("[contenteditable],textarea").length', true).catch(() => 0);
            if (editorCount) { clearInterval(timer); inspectDouyinStructure(view.webContents).catch(() => {}); }
          }, 5000);
          timer.unref?.();
        }
      }
      if (otherPlatformVisible && otherPlatformView === view) emitState({ page: 'ready', url: view.webContents.getURL() });
    });
    ensureListenerHostWindow().contentView.addChildView(view);
    view.setBounds(listenerHostBounds());
    loadInitialPage = true;
  } else if (reveal && group.selected === 0 && !group.manualNavigation && platformId === 'douyin' &&
      !view.webContents.isLoadingMainFrame() && isDouyinSellerHome(view.webContents.getURL())) {
    loadInitialPage = true;
  }
  if (reveal) {
    otherPlatformId = platformId;
    otherStoreId = nextStoreId;
    if (xianyuViewVisible) mountXianyuView({ reveal: false });
    activePlatform = platformId;
    activeStoreId = nextStoreId;
    currentBounds = null;
    selectPlatformPage(group, group.selected);
  }
  if (loadInitialPage) await view.webContents.loadURL(platformUrls[platformId]);
  const page = group.pages.get(group.selected);
  return { platform: platformId, storeId: nextStoreId, session: `persist:${platformId}-${nextStoreId}`, url: page?.webContents.getURL() || platformUrls[platformId] };
}

function isFeigeWorkspace(value) {
  return /^https:\/\/im\.jinritemai\.com\/pc_seller_v2\/main\/workspace(?:[/?#]|$)/i.test(value);
}

function isDouyinSellerHome(value) {
  return /^https:\/\/fxg\.jinritemai\.com\/ffa\/mshop\/homepage\/index(?:[/?#]|$)/i.test(value);
}

// Goofish login can temporarily navigate through Taobao passport and several
// auth subdomains. Keep those pages inside the same WebContentsView/session so a
// QR/mobile login can complete and return to the chat page with its cookies.
function isPlatformUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return /(^|\.)((goofish|taobao|tmall|alicdn|alibaba|jinritemai|douyinvod)\.com)$/.test(url.hostname)
      || /(^|\.)(passport|login|sso)\.(goofish|taobao|tmall|alibaba|jinritemai|douyin)\.com$/.test(url.hostname);
  } catch {
    return false;
  }
}

async function injectBridge(contents) {
  // Read on every page load so an already-running Electron shell picks up a
  // bridge hotfix after navigation/reload instead of retaining a stale source
  // string captured when the app first opened.
  const bridgeSource = await readFile(bridgePath, 'utf8');
  // Remove userscript metadata only.  The executable body remains unchanged,
  // including its DOM listener, RAG calls, outbox claim and sender logic.
  const executable = `
    // Electron has no Tampermonkey runtime. Keep the userscript's existing
    // GM_xmlhttpRequest path while routing it through page fetch.
    if (typeof globalThis.GM_xmlhttpRequest !== 'function') {
      globalThis.GM_xmlhttpRequest = function (options) {
        const request = typeof globalThis.rcbPlatformRequest === 'function'
          ? globalThis.rcbPlatformRequest({ url: options.url, method: options.method || 'GET', headers: options.headers || {}, data: options.data || '' })
          : fetch(options.url, { method: options.method || 'GET', headers: options.headers || {}, body: options.data || undefined })
              .then(async response => ({ status: response.status, responseText: await response.text() }));
        Promise.resolve(request)
          .then(response => options.onload && options.onload({ status: response.status, responseText: response.responseText || '' }))
          .catch(error => options.onerror && options.onerror(error));
      };
    }
  ${bridgeSource.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '')}`;
  try {
    await contents.executeJavaScript(executable, true);
    lastBridgeHealthAt = Date.now();
    pageLog('bridge-injected', { url: contents.getURL() });
    emitState({ bridge: 'injected' });
  } catch (error) {
    pageLog('bridge-error', { url: contents.getURL(), error: error.message });
    console.error('Unable to inject Xianyu bridge:', error);
    emitState({ bridge: 'error', lastError: `bridge injection failed: ${error.message}` });
  }
}

async function openXianyu(storeId = 'default', platformId = 'xianyu', { reveal = true } = {}) {
  const nextPlatform = Object.prototype.hasOwnProperty.call(platformUrls, platformId) ? platformId : 'xianyu';
  if (nextPlatform !== 'xianyu') return openOtherPlatform(storeId, nextPlatform, { reveal });
  const nextStoreId = sanitizeStoreId(storeId);
  if (xianyuView && !xianyuView.webContents.isDestroyed() && xianyuStoreId === nextStoreId) {
    if (reveal) {
      if (otherPlatformVisible) mountOtherPlatformView({ reveal: false });
      activePlatform = 'xianyu';
      activeStoreId = nextStoreId;
      mountXianyuView({ reveal: true });
      activateXianyuView({ reveal: true });
      scheduleXianyuLayout();
    }
    startBridgePulse();
    emitState({ embedded: true, visible: xianyuViewVisible });
    return { platform: activePlatform, storeId: activeStoreId, session: `persist:${activePlatform}-${activeStoreId}`, url: xianyuView.webContents.getURL() || activePlatformUrl(), reused: true };
  }
  activePlatform = nextPlatform;
  activeStoreId = nextStoreId;
  xianyuStoreId = nextStoreId;
  if (xianyuView) {
    detachXianyuView(xianyuView);
    if (!xianyuView.webContents.isDestroyed()) xianyuView.webContents.close();
    xianyuView = null;
    xianyuStoreId = '';
    xianyuViewVisible = false;
  }
  currentBounds = null;
  // persist:<store> is a separate cookie/localStorage/cache namespace.  A
  // second store can therefore be logged in without replacing this account.
  const storeSession = session.fromPartition(`persist:${activePlatform}-${activeStoreId}`);
  xianyuView = new WebContentsView({
    webPreferences: {
      session: storeSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'platform-preload.cjs'),
      }
  });
  xianyuStoreId = nextStoreId;
  // The embedded platform view must keep its listener/heartbeat timers alive
  // while the operator works in the sidebar or context panel.
  xianyuView.webContents.setBackgroundThrottling(false);
  // Some Goofish builds gate interactive controls on the browser UA and
  // otherwise render a read-only shell when Electron is detected.
  xianyuView.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  bridgeRecoveryPolicy.reset();
  xianyuSocketTracker.reset();
  clearXianyuSocketWakeTimers();
  clearTimeout(xianyuSocketDisconnectTimer);
  // CDP may wait for the first renderer target before Network.enable resolves.
  // Attach in the background so a cold page load can never be blocked by the
  // optional socket-observation layer.
  if (activePlatform === 'xianyu') attachXianyuSocketMonitor(xianyuView.webContents).catch(() => {});
  mountXianyuView({ reveal });
  if (reveal) {
    activateXianyuView({ reveal: true });
    scheduleXianyuLayout();
  }
  xianyuView.webContents.setWindowOpenHandler(({ url }) => {
    if (isPlatformUrl(url)) {
      // Preserve window.opener for Taobao/Goofish QR login callbacks. Electron
      // inherits the opener's session when no partition override is supplied,
      // so the popup shares persist:xianyu-<store> cookies automatically.
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  xianyuView.webContents.on('did-create-window', (childWindow) => {
    childWindow.on('closed', () => {
      activateXianyuView();
    });
    childWindow.webContents.on('did-finish-load', () => childWindow.webContents.focus());
  });
  xianyuView.webContents.on('did-start-loading', () => {
    pageLog('did-start-loading', { url: xianyuView.webContents.getURL() || activePlatformUrl() });
    emitState({ page: 'loading', bridge: 'waiting', url: xianyuView.webContents.getURL() || activePlatformUrl() });
  });
  xianyuView.webContents.on('did-navigate', (_event, url) => { pageLog('did-navigate', { url }); emitState({ page: 'navigated', url }); });
  xianyuView.webContents.on('did-navigate-in-page', (_event, url) => {
    pageLog('did-navigate-in-page', { url });
    emitState({ page: 'navigated', url });
  });
  xianyuView.webContents.on('did-finish-load', () => {
    // WebContentsView normally receives pointer events, but explicitly focusing it
    // after navigation fixes the first-click/keyboard issue on Windows.
    activateXianyuView();
    const url = xianyuView.webContents.getURL();
    pageLog('did-finish-load', { url });
    if (/^(www\.)?goofish\.com$/i.test(new URL(url).hostname)) injectBridge(xianyuView.webContents);
    else emitState({ bridge: 'waiting', lastError: null });
  });
  xianyuView.webContents.on('dom-ready', () => { pageLog('dom-ready', { url: xianyuView.webContents.getURL() }); activateXianyuView(); });
  xianyuView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return;
    pageLog('did-fail-load', { url: validatedURL || activePlatformUrl(), errorCode, error: errorDescription });
    emitState({ page: 'error', url: validatedURL || activePlatformUrl(), lastError: `${errorCode}: ${errorDescription}` });
  });
  xianyuView.webContents.on('render-process-gone', (_event, details) => {
    pageLog('render-process-gone', { reason: details.reason });
    emitState({ page: 'error', lastError: `render-process-gone: ${details.reason || 'unknown'}` });
    recoverXianyuView(`render-process-gone: ${details.reason || 'unknown'}`, { force: true }).catch(() => {});
  });
  xianyuView.webContents.on('unresponsive', () => {
    pageLog('unresponsive');
    emitState({ page: 'error', lastError: 'platform view unresponsive' });
    setTimeout(() => recoverXianyuView('platform view unresponsive', { force: true }).catch(() => {}), 5000);
  });
  xianyuView.webContents.on('responsive', () => emitState({ page: 'ready', lastError: null }));
  let loaded = false;
  try {
    await xianyuView.webContents.loadURL(activePlatformUrl());
    loaded = true;
  } catch (error) {
    emitState({ page: 'error', lastError: error.message || 'platform page failed to load' });
  }
  activateXianyuView();
  if (loaded) emitState({ page: 'ready', session: `persist:${activePlatform}-${activeStoreId}`, lastError: null });
  if (activePlatform === 'xianyu') startBridgePulse();
  else stopBridgePulse();
  return { platform: activePlatform, storeId: activeStoreId, session: `persist:${activePlatform}-${activeStoreId}`, url: activePlatformUrl() };
}

function hideXianyu() {
  if (activePlatform !== 'xianyu') {
    if (!otherPlatformView || otherPlatformView.webContents.isDestroyed()) return false;
    mountOtherPlatformView({ reveal: false });
    currentBounds = null;
    emitState({ embedded: true, visible: false, bounds: null });
    return true;
  }
  if (!xianyuView || xianyuView.webContents.isDestroyed()) return false;
  try {
    xianyuViewVisible = false;
    // WebContentsView.setVisible(false), or moving it outside its visible host,
    // makes Goofish report document.visibilityState=hidden and eventually stop
    // hydrating live messages. Reparent it into the shown offscreen listener
    // host so other workspaces remain unobstructed without suspending the page.
    mountXianyuView({ reveal: false });
    currentBounds = null;
    // Deliberately keep both the WebContents and bridge pulse alive. The
    // platform listener is a background service, not a property of the visible
    // workspace tab.
    startBridgePulse();
    emitState({ embedded: true, visible: false, bounds: null });
    return true;
  } catch (error) {
    pageLog('view-hide-error', { error: error.message });
    return false;
  }
}

function closeXianyu() {
  stopBridgePulse();
  clearXianyuSocketWakeTimers();
  clearTimeout(xianyuSocketDisconnectTimer);
  bridgeRecoveryPolicy.reset();
  xianyuSocketTracker.reset();
  xianyuViewVisible = false;
  if (xianyuView) {
    detachXianyuView(xianyuView);
    if (!xianyuView.webContents.isDestroyed()) {
      xianyuView.webContents.closeDevTools();
      xianyuView.webContents.close();
    }
    xianyuView = null;
  }
  currentBounds = null;
  lastBridgeHealthAt = 0;
  emitState({ embedded: false });
}

async function createWindow() {
  await waitForWorkbench();
  const initialWidth = Math.max(980, Number(process.env.RCB_WINDOW_WIDTH) || 1440);
  const initialHeight = Math.max(650, Number(process.env.RCB_WINDOW_HEIGHT) || 900);
  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: 980,
    minHeight: 650,
    title: 'OE DESK',
    // Keep the utility shell clean; platform controls remain inside the page.
    autoHideMenuBar: true,
    backgroundColor: '#f5f7f4',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }
  });
  // autoHideMenuBar still allows the menu to appear after pressing Alt on
  // Windows. Disable visibility explicitly so the shell never exposes it.
  mainWindow.setMenuBarVisibility(false);
  // Windows may give focus back to the host renderer after a toolbar click or
  // resize. Restore the native page as the active input target when the app
  // window itself becomes focused again.
  mainWindow.on('focus', () => {
    if (activePlatform === 'xianyu') activateXianyuView();
    else if (otherPlatformVisible) otherPlatformView?.webContents.focus();
    if (xianyuViewVisible || otherPlatformVisible) scheduleXianyuLayout();
  });
  mainWindow.on('resize', scheduleXianyuLayout);
  mainWindow.on('maximize', scheduleXianyuLayout);
  mainWindow.on('unmaximize', scheduleXianyuLayout);
  mainWindow.on('closed', () => {
    stopBridgePulse();
    clearXianyuSocketWakeTimers();
    clearTimeout(xianyuSocketDisconnectTimer);
    bridgeRecoveryPolicy.reset();
    xianyuSocketTracker.reset();
    if (xianyuView && !xianyuView.webContents.isDestroyed()) xianyuView.webContents.close();
    otherPlatformVisible = false;
    for (const group of platformPageGroups.values()) {
      for (const view of group.pages.values()) if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    if (listenerHostWindow && !listenerHostWindow.isDestroyed()) listenerHostWindow.close();
    mainWindow = null;
    xianyuView = null;
    otherPlatformView = null;
    otherPlatformViews.clear();
    platformPageGroups.clear();
    listenerHostWindow = null;
    xianyuViewVisible = false;
    currentBounds = null;
    layoutQueued = false;
    layoutInFlight = false;
  });
  await mainWindow.loadURL(workbenchUrl);
  // Keep the HTML browser slot as a sizing anchor while the native WebContentsView
  // provides the only interactive platform page in that slot.
  // The native WebContentsView is the only platform surface in this slot.
  // Remove the HTML iframe from layout and hit testing; leaving a hidden iframe
  // in place can still steal pointer/keyboard events on some Chromium builds.
  await mainWindow.webContents.insertCSS('#platform-chat-frame .platform-frame-main{display:grid!important;grid-template-columns:minmax(0,1fr)!important;gap:0!important;padding:0!important;min-width:0!important;min-height:0!important} #platform-chat-frame .platform-frame-browser{display:flex!important;min-width:0!important;min-height:0!important;position:relative!important;border:0!important;border-radius:0!important} #platform-chat-frame .platform-frame-browser iframe,#platform-chat-frame .platform-embed-fallback{display:none!important;pointer-events:none!important} #platform-chat-frame .platform-frame-note{display:none!important;pointer-events:none!important} #platform-chat-frame .platform-bridge-panel{display:flex!important;}');
  await openOtherPlatform('douyin', 'douyin', { reveal: false }).catch(error => console.warn('Feige background page failed:', error.message));
}

function queuePlatformOpen(input = {}) {
  const task = platformOpenTail.then(() => openXianyu(input.storeId, input.platform), () => openXianyu(input.storeId, input.platform));
  platformOpenTail = task.catch(() => {});
  return task;
}

ipcMain.handle('platform:open', (_event, input) => queuePlatformOpen(input));
ipcMain.handle('workbench:update', async (event, action) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
      event.senderFrame.url !== workbenchUrl) throw new Error('请在 OE DESK 桌面端检查更新。');
  if (!['startup', 'check', 'download', 'notes'].includes(action)) throw new Error('未知的更新操作。');
  const result = await checkUpdate(action === 'check');
  if (result.status === 'available' && action === 'download') await shell.openExternal(result.downloadUrl);
  if (result.status === 'available' && action === 'notes') await shell.openExternal(result.releaseUrl);
  return result;
});
ipcMain.handle('workbench:model-settings', async (event, input) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
      event.senderFrame.url !== workbenchUrl) throw new Error('请从 OE DESK 桌面应用操作。');
  try {
    const response = await fetch(new URL('/api/settings/private', workbenchUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rcb-desktop-settings': desktopSettingsKey },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(20000)
    });
    if (response.status === 403 || response.status === 404) {
      return { ok: false, error: '本机服务尚未启用此功能，请完全退出 OE DESK 后重新打开。' };
    }
    if (!response.ok) return { ok: false, error: '连接配置操作失败，请重试。' };
    return await response.json();
  } catch {
    return { ok: false, error: '本机 OE DESK 服务未响应，请重新打开应用后再试。' };
  }
});
ipcMain.handle('platform:page', async (event, input = {}) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== new URL(workbenchUrl).origin) throw new Error('请从 OE DESK 工作台操作');
  if (input.platform !== activePlatform || !otherPlatformVisible) throw new Error('请先打开飞鸽或千牛');
  const group = platformPageGroups.get(`${activePlatform}:${activeStoreId}`);
  if (!group) throw new Error('平台页面尚未就绪');
  if (input.action === 'select') return selectPlatformPage(group, input.pageId);
  if (input.action === 'close') {
    const view = input.pageId === 0 ? null : group.pages.get(input.pageId);
    if (!view || view.webContents.isDestroyed()) return false;
    view.webContents.close();
    return true;
  }
  if (input.action !== 'navigate' && input.action !== 'home') throw new Error('无效的页面操作');
  if (input.action === 'navigate' && input.pageId !== group.selected) throw new Error('页面已切换，请重新输入网址');
  const address = input.action === 'home' ? webPlatformUrl(platformUrls[activePlatform]) : operatorPlatformUrl(input.address);
  if (!address) throw new Error('请输入有效的 HTTP 或 HTTPS 网址');
  if (input.action === 'home') {
    group.manualNavigation = false;
    selectPlatformPage(group, 0);
  } else if (group.selected === 0) {
    group.manualNavigation = true;
  }
  await otherPlatformView.webContents.loadURL(address);
  return true;
});
ipcMain.handle('xianyu:open', (_event, input) => queuePlatformOpen({ ...input, platform: 'xianyu' }));
ipcMain.handle('xianyu:hide', () => hideXianyu());
ipcMain.handle('xianyu:close', () => closeXianyu());
ipcMain.handle('xianyu:layout', () => layoutXianyuView());
ipcMain.handle('xianyu:refresh', () => selectedPlatformView()?.webContents.reload());
ipcMain.handle('xianyu:back', () => selectedPlatformView()?.webContents.canGoBack() ? selectedPlatformView().webContents.goBack() : false);
ipcMain.handle('xianyu:forward', () => selectedPlatformView()?.webContents.canGoForward() ? selectedPlatformView().webContents.goForward() : false);
ipcMain.handle('xianyu:request', async (event, input = {}) => {
  if (!xianyuView || event.sender !== xianyuView.webContents) throw new Error('invalid platform request sender');
  const target = new URL(String(input.url || ''));
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.startsWith('/api/xianyu')) {
    throw new Error('platform request target is not allowed');
  }
  const response = await fetch(target, {
    method: String(input.method || 'GET').toUpperCase(),
    headers: { 'content-type': 'application/json' },
    body: input.data ? String(input.data) : undefined,
    signal: AbortSignal.timeout(12000)
  });
  return { status: response.status, responseText: await response.text() };
});
let feigeHistoryScan = null;
ipcMain.handle('feige:read-history', async event => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== new URL(workbenchUrl).origin) throw new Error('请从本机 OE DESK 工作台操作。');
  const contents = otherPlatformViews.get('douyin:douyin')?.webContents;
  if (!contents || contents.isDestroyed() || !/^https:\/\/im\.jinritemai\.com\//.test(contents.getURL())) {
    throw new Error('请先在飞鸽客服页面登录。');
  }
  if (feigeHistoryScan) throw new Error('飞鸽历史会话正在读取。');
  const scan = { contents, id: randomUUID() };
  feigeHistoryScan = scan;
  try {
    const result = await contents.executeJavaScript(`globalThis.__oeReadFeigeHistory?.(${JSON.stringify(scan.id)})`);
    if (!result) throw new Error('飞鸽桥接未就绪，请打开飞鸽客服页面后再试。');
    return result;
  } finally {
    feigeHistoryScan = null;
  }
});
ipcMain.handle('feige:request', async (event, input = {}) => {
  const view = otherPlatformViews.get('douyin:douyin');
  if (!view || view.webContents.isDestroyed() || event.sender !== view.webContents ||
      event.senderFrame !== view.webContents.mainFrame || !/^https:\/\/im\.jinritemai\.com\//i.test(event.senderFrame.url)) {
    throw new Error('invalid Feige bridge sender');
  }
  const target = new URL(String(input.url || ''));
  const allowed = new Set(['/api/feige/session', '/api/feige/messages', '/api/feige/status', '/api/feige/outbox',
    '/api/feige/outbox/claim', '/api/feige/outbox/verify', '/api/feige/outbox/ready', '/api/feige/outbox/cancel',
    '/api/feige/outbox/release', '/api/feige/outbox/ack', '/api/feige/human-reply', '/api/feige/learning-history']);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.port !== String(port) || !allowed.has(target.pathname)) {
    throw new Error('Feige bridge request target is not allowed');
  }
  if (['/api/feige/human-reply', '/api/feige/learning-history'].includes(target.pathname) &&
      (input.method !== 'POST' || typeof input.data !== 'string' || input.data.length > 65536)) {
    throw new Error('Invalid Feige learning request');
  }
  const headers = { 'content-type': 'application/json', 'x-rcb-platform-bridge': 'feige' };
  if (target.pathname === '/api/feige/learning-history') {
    const { scanId } = JSON.parse(input.data);
    if (scanId && feigeHistoryScan?.id === scanId && feigeHistoryScan.contents === event.sender) {
      headers['x-rcb-feige-history-scan'] = feigeHistoryKey;
    }
  }
  const response = await fetch(target, { method: String(input.method || 'GET').toUpperCase(),
    headers,
    body: input.data ? String(input.data) : undefined, signal: AbortSignal.timeout(12000) });
  return { status: response.status, responseText: await response.text() };
});
function validateDeliveryIpc(event, input = {}) {
  if (!xianyuView || event.sender !== xianyuView.webContents) throw new Error('invalid platform delivery sender');
  const claimToken = String(input.claimToken || '').trim();
  if (!/^xy-claim-[a-z0-9-]{8,120}$/i.test(claimToken)) throw new Error('invalid delivery claim token');
  const textHash = String(input.textHash || '').trim();
  if (textHash && !/^[a-z0-9]{1,24}$/i.test(textHash)) throw new Error('invalid delivery text hash');
  return { claimToken, conversationId: String(input.conversationId || '').trim().slice(0, 240), textHash };
}
ipcMain.handle('xianyu:delivery-begin', (event, input = {}) => {
  const delivery = validateDeliveryIpc(event, input);
  return xianyuSocketTracker.beginDeliveryAttempt(delivery);
});
ipcMain.handle('xianyu:delivery-query', (event, input = {}) => {
  const delivery = validateDeliveryIpc(event, input);
  return xianyuSocketTracker.deliveryEvidence(delivery.claimToken);
});
ipcMain.handle('xianyu:delivery-finish', (event, input = {}) => {
  const delivery = validateDeliveryIpc(event, input);
  return xianyuSocketTracker.finishDeliveryAttempt(delivery.claimToken);
});
ipcMain.handle('xianyu:input', async (event, input = {}) => {
  if (!xianyuView || event.sender !== xianyuView.webContents) throw new Error('invalid platform input sender');
  const type = String(input.type || '');
  if (!['keyDown', 'keyUp', 'char', 'mouseDown', 'mouseUp', 'mouseMove', 'insertText'].includes(type)) throw new Error('platform input type is not allowed');
  // The workbench renderer can keep OS focus after a sidebar action. Native
  // input events are delivered to the focused WebContents, so restore focus
  // immediately before every trusted fallback event.
  activateXianyuView({ allowHiddenFocus: true });
  if (type === 'insertText') {
    const text = String(input.text || '').slice(0, 12000);
    if (!text) throw new Error('platform text is empty');
    await xianyuView.webContents.insertText(text);
    return { ok: true };
  }
  if (type.startsWith('mouse')) {
    const x = Number(input.x); const y = Number(input.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10000 || y > 10000) throw new Error('platform input coordinates are invalid');
    await xianyuView.webContents.sendInputEvent({ type, x, y, button: input.button === 'right' ? 'right' : 'left', clickCount: 1 });
  } else {
    const keyCode = String(input.keyCode || input.key || 'ENTER').slice(0, 32);
    await xianyuView.webContents.sendInputEvent({ type, keyCode, modifiers: Array.isArray(input.modifiers) ? input.modifiers.filter(value => ['shift', 'control', 'alt', 'meta'].includes(value)) : [] });
  }
  return { ok: true };
});
ipcMain.handle('xianyu:session', () => ({ platform: activePlatform, storeId: activeStoreId, session: `persist:${activePlatform}-${activeStoreId}`, embedded: Boolean(selectedPlatformView()), url: selectedPlatformView()?.webContents.getURL() || activePlatformUrl(), bounds: currentBounds }));

async function importBundledProfile() {
  if (process.platform !== 'darwin' || !app.isPackaged || existsSync(workbenchRoot)) return;
  const archive = join(process.resourcesPath, 'oe-desk-profile.bin');
  if (!existsSync(archive)) return;
  const prompt = new BrowserWindow({
    width: 470, height: 305, resizable: false, minimizable: false, maximizable: false, show: false,
    webPreferences: { preload: join(__dirname, 'profile-import-preload.cjs'), contextIsolation: true, sandbox: true }
  });
  const channel = 'workbench:unlock-private-profile';
  const pageClosed = new Promise(resolve => prompt.once('closed', resolve));
  let pending;
  ipcMain.handle(channel, (event, password) => {
    if (event.sender !== prompt.webContents || event.senderFrame !== prompt.webContents.mainFrame ||
        typeof password !== 'string' || !/^[0-9a-f]{24}$/.test(password)) {
      return { ok: false, error: '请输入完整的 24 位安装密码。' };
    }
    if (pending) return pending;
    pending = (async () => {
      try {
        await restoreProfile(await readFile(archive), workbenchRoot, password);
        setImmediate(() => { if (!prompt.isDestroyed()) prompt.close(); });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error.message };
      } finally {
        pending = null;
      }
    })();
    return pending;
  });
  try {
    await prompt.loadFile(join(__dirname, 'profile-import.html'));
    prompt.show();
    await pageClosed;
  } catch {
    if (!prompt.isDestroyed()) prompt.destroy();
  } finally {
    ipcMain.removeHandler(channel);
    await pending;
  }
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(async () => {
    await importBundledProfile();
    await startLocalServer();
    startServerHealthMonitor();
    try { await createWindow(); } catch (error) { console.error(error); app.quit(); }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  appQuitting = true;
  clearTimeout(serverRestartTimer);
  clearInterval(serverHealthTimer);
  stopBridgePulse();
  if (listenerHostWindow && !listenerHostWindow.isDestroyed()) listenerHostWindow.close();
  if (serverProcess) serverProcess.kill();
});
