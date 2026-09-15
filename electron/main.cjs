/*
 * Electron shell for the OE DESK customer-service workbench.
 *
 * A platform page must be top-level for its login cookies and CSP rules to
 * work.  WebContentsView gives us that top-level page inside the app while each
 * store receives its own persistent session partition.  The existing local
 * RPA bridge is injected after every navigation and talks to server.js over
 * the existing /api/xianyu endpoints.
 */
const { app, BrowserWindow, WebContentsView, ipcMain, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const { cpSync, existsSync, mkdirSync, readdirSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

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
const port = Number(process.env.PORT || 3000);
const workbenchUrl = `http://127.0.0.1:${port}/`;
const platformUrls = {
  xianyu: process.env.XIANYU_CHAT_URL || 'https://www.goofish.com/im',
  tmall: process.env.TMALL_CHAT_URL || 'https://myseller.taobao.com/home.htm',
  douyin: process.env.DOUYIN_CHAT_URL || 'https://fxg.jinritemai.com/ffa/microapp/homepage'
};
const bridgePath = join(root, 'rpa', 'xianyu-bridge.user.js');

let serverProcess;
let mainWindow;
let xianyuView;
let currentBounds = null;
let activeStoreId = 'default';
let activePlatform = 'xianyu';
let bridgePulseTimer;

function activePlatformUrl() { return platformUrls[activePlatform] || platformUrls.xianyu; }

function startBridgePulse() {
  clearInterval(bridgePulseTimer);
  bridgePulseTimer = setInterval(() => {
    if (activePlatform !== 'xianyu' || !xianyuView || xianyuView.webContents.isDestroyed()) return;
    xianyuView.webContents.executeJavaScript('globalThis.__rcbXianyuBridgePulse?.()', true).catch(() => {});
  }, 750);
  bridgePulseTimer.unref?.();
}

function stopBridgePulse() {
  clearInterval(bridgePulseTimer);
  bridgePulseTimer = undefined;
}

/** Keep the native platform view visible and focused after an explicit action. */
function activateXianyuView() {
  if (!xianyuView || !mainWindow || mainWindow.isDestroyed()) return false;
  try {
    if (typeof xianyuView.setVisible === 'function') xianyuView.setVisible(true);
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

async function startLocalServer() {
  if (process.env.RCB_ELECTRON_EXTERNAL_SERVER === 'true') return false;
  // Reuse a service started with `npm start`; starting a second listener on
  // the same port causes an unhandled EADDRINUSE crash in the Electron shell.
  try {
    // Any HTTP response means another process already owns the port. Reuse
    // it and let waitForWorkbench report a genuine health failure if needed.
    await fetch(`${workbenchUrl}api/health`);
    return false;
  } catch { /* No service is running yet. */ }
  serverProcess = spawn(process.execPath, [join(root, 'server.js')], {
    cwd: root,
    // Electron's executable is not Node by default; this flag runs the child
    // with Node semantics instead of opening a second Electron app instance.
    env: { ...process.env, PORT: String(port), ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  serverProcess.stdout.on('data', data => process.stdout.write(`[server] ${data}`));
  serverProcess.stderr.on('data', data => process.stderr.write(`[server] ${data}`));
  serverProcess.on('error', error => {
    if (error.code !== 'EADDRINUSE') console.error('Unable to start local RAG service:', error);
  });
  return true;
}

async function waitForWorkbench() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${workbenchUrl}api/health`);
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
    const rect = await mainWindow.webContents.executeJavaScript(`(() => {
      const node = document.querySelector('[data-platform-anchor="xianyu"]')
        || document.querySelector('#platform-chat-frame .platform-frame-browser');
      if (!node) return null;
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      return { x: box.left, y: box.top, width: box.width, height: box.height };
    })()`, true);
    if (!rect) return null;
    const [contentWidth, contentHeight] = mainWindow.getContentSize();
    const availableWidth = Math.max(1, contentWidth - Math.max(0, rect.x));
    const availableHeight = Math.max(1, contentHeight - Math.max(0, rect.y));
    return {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      // Keep the native surface inside the BrowserWindow content area.  This
      // matters when a centered max-width shell or a transient scrollbar makes
      // the DOM rect extend a fraction beyond the native viewport.
      width: Math.min(Math.max(1, Math.round(rect.width)), availableWidth),
      height: Math.min(Math.max(1, Math.round(rect.height)), availableHeight)
    };
  } catch {
    return null;
  }
}

async function layoutXianyuView() {
  if (!xianyuView || !mainWindow || mainWindow.isDestroyed()) return;
  // Renderer measurements are asynchronous.  Coalesce requests so a fast
  // window resize cannot apply an older rect after a newer one.
  if (layoutInFlight) {
    layoutQueued = true;
    return;
  }
  layoutInFlight = true;
  const view = xianyuView;
  try {
    const bounds = await viewBounds();
    if (bounds && xianyuView === view && !view.webContents.isDestroyed() && mainWindow && !mainWindow.isDestroyed()) {
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
  const url = xianyuView && !xianyuView.webContents.isDestroyed() ? xianyuView.webContents.getURL() || fallbackUrl : fallbackUrl;
  mainWindow.webContents.send('xianyu:state', { platform: activePlatform, storeId: activeStoreId, session: `persist:${activePlatform}-${activeStoreId}`, url, embedded: Boolean(xianyuView), bounds: currentBounds, lastError: null, ...patch });
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
    pageLog('bridge-injected', { url: contents.getURL() });
    emitState({ bridge: 'injected' });
  } catch (error) {
    pageLog('bridge-error', { url: contents.getURL(), error: error.message });
    console.error('Unable to inject Xianyu bridge:', error);
    emitState({ bridge: 'error', lastError: `bridge injection failed: ${error.message}` });
  }
}

async function openXianyu(storeId = 'default', platformId = 'xianyu') {
  const nextPlatform = Object.prototype.hasOwnProperty.call(platformUrls, platformId) ? platformId : 'xianyu';
  const nextStoreId = sanitizeStoreId(storeId);
  if (xianyuView && !xianyuView.webContents.isDestroyed() && activePlatform === nextPlatform && activeStoreId === nextStoreId) {
    activateXianyuView();
    scheduleXianyuLayout();
    if (activePlatform === 'xianyu') startBridgePulse();
    emitState({ embedded: true, visible: true });
    return { platform: activePlatform, storeId: activeStoreId, session: `persist:${activePlatform}-${activeStoreId}`, url: xianyuView.webContents.getURL() || activePlatformUrl(), reused: true };
  }
  activePlatform = nextPlatform;
  activeStoreId = nextStoreId;
  if (xianyuView) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(xianyuView);
    if (!xianyuView.webContents.isDestroyed()) xianyuView.webContents.close();
    xianyuView = null;
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
  // The embedded platform view must keep its listener/heartbeat timers alive
  // while the operator works in the sidebar or context panel.
  xianyuView.webContents.setBackgroundThrottling(false);
  // Some Goofish builds gate interactive controls on the browser UA and
  // otherwise render a read-only shell when Electron is detected.
  xianyuView.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  mainWindow.contentView.addChildView(xianyuView);
  activateXianyuView();
  scheduleXianyuLayout();
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
      if (xianyuView && !xianyuView.webContents.isDestroyed()) xianyuView.webContents.focus();
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
    if (activePlatform === 'xianyu' && isPlatformUrl(url)) injectBridge(xianyuView.webContents);
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
  });
  xianyuView.webContents.on('unresponsive', () => { pageLog('unresponsive'); emitState({ page: 'error', lastError: 'platform view unresponsive' }); });
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
  if (!xianyuView || xianyuView.webContents.isDestroyed()) return false;
  try {
    if (typeof xianyuView.setVisible === 'function') xianyuView.setVisible(false);
    else xianyuView.setBounds({ x: -10000, y: -10000, width: 1, height: 1 });
    currentBounds = null;
    // Deliberately keep both the WebContents and bridge pulse alive. The
    // platform listener is a background service, not a property of the visible
    // workspace tab.
    if (activePlatform === 'xianyu') startBridgePulse();
    emitState({ embedded: true, visible: false, bounds: null });
    return true;
  } catch (error) {
    pageLog('view-hide-error', { error: error.message });
    return false;
  }
}

function closeXianyu() {
  stopBridgePulse();
  if (xianyuView) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(xianyuView);
    if (!xianyuView.webContents.isDestroyed()) {
      xianyuView.webContents.closeDevTools();
      xianyuView.webContents.close();
    }
    xianyuView = null;
  }
  currentBounds = null;
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
  mainWindow.on('focus', () => { activateXianyuView(); scheduleXianyuLayout(); });
  mainWindow.on('resize', scheduleXianyuLayout);
  mainWindow.on('maximize', scheduleXianyuLayout);
  mainWindow.on('unmaximize', scheduleXianyuLayout);
  mainWindow.on('closed', () => {
    stopBridgePulse();
    if (xianyuView && !xianyuView.webContents.isDestroyed()) xianyuView.webContents.close();
    mainWindow = null;
    xianyuView = null;
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
  // Do not open a platform page during shell startup. The renderer checks the
  // The renderer opens the selected platform only after an explicit click so
  // the main workbench remains lightweight during startup.
}

ipcMain.handle('platform:open', (_event, input) => openXianyu(input?.storeId, input?.platform));
ipcMain.handle('xianyu:open', (_event, input) => openXianyu(input?.storeId, 'xianyu'));
ipcMain.handle('xianyu:hide', () => hideXianyu());
ipcMain.handle('xianyu:close', () => closeXianyu());
ipcMain.handle('xianyu:layout', () => layoutXianyuView());
ipcMain.handle('xianyu:refresh', () => xianyuView?.webContents.reload());
ipcMain.handle('xianyu:back', () => xianyuView?.webContents.canGoBack() ? xianyuView.webContents.goBack() : false);
ipcMain.handle('xianyu:forward', () => xianyuView?.webContents.canGoForward() ? xianyuView.webContents.goForward() : false);
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
ipcMain.handle('xianyu:input', async (event, input = {}) => {
  if (!xianyuView || event.sender !== xianyuView.webContents) throw new Error('invalid platform input sender');
  const type = String(input.type || '');
  if (!['keyDown', 'keyUp', 'char', 'mouseDown', 'mouseUp', 'mouseMove', 'insertText'].includes(type)) throw new Error('platform input type is not allowed');
  // The workbench renderer can keep OS focus after a sidebar action. Native
  // input events are delivered to the focused WebContents, so restore focus
  // immediately before every trusted fallback event.
  activateXianyuView();
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
ipcMain.handle('xianyu:session', () => ({ platform: activePlatform, storeId: activeStoreId, session: `persist:${activePlatform}-${activeStoreId}`, embedded: Boolean(xianyuView), url: xianyuView?.webContents.getURL() || activePlatformUrl(), bounds: currentBounds }));

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
    await startLocalServer();
    try { await createWindow(); } catch (error) { console.error(error); app.quit(); }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => { if (serverProcess) serverProcess.kill(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (serverProcess) serverProcess.kill(); });
