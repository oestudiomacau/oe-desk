// ==UserScript==
// @name         OE DESK 闲鱼 RPA 桥接
// @namespace    rcb.local
// @version      0.7.8
// @description  在闲鱼聊天页监听买家消息，调用本地 RAG 工作流并把低风险 AI 回复发送回当前会话。
// @match        https://www.goofish.com/*
// @match        https://goofish.com/*
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @noframes
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

// Kept outside the browser-only IIFE so the transient-conversation regression
// can be exercised in a Node VM without booting the Goofish page.
var OEDeskConversationScanState = globalThis.OEDeskConversationScanState || class OEDeskConversationScanState {
  constructor() {
    this.primedConversationIds = new Set();
    this.emptySinceByConversation = new Map();
  }
  isPrimed(conversationId) { return this.primedConversationIds.has(conversationId); }
  prime(conversationId) {
    if (!conversationId) return;
    this.primedConversationIds.add(conversationId);
    this.emptySinceByConversation.delete(conversationId);
  }
  noteEmpty(conversationId, now = Date.now(), graceMs = 2000) {
    if (this.isPrimed(conversationId)) return true;
    if (!this.emptySinceByConversation.has(conversationId)) {
      this.emptySinceByConversation.set(conversationId, now);
      return false;
    }
    if (now - this.emptySinceByConversation.get(conversationId) < graceMs) return false;
    this.prime(conversationId);
    return true;
  }
  reset() {
    this.primedConversationIds.clear();
    this.emptySinceByConversation.clear();
  }
};
globalThis.OEDeskConversationScanState = OEDeskConversationScanState;

// Sending is intentionally stricter than message scanning: a cached ID is
// useful while React hydrates, but it is never proof that a specific buyer's
// composer is currently visible.
var OEDeskOutboundRouteGuard = globalThis.OEDeskOutboundRouteGuard || class OEDeskOutboundRouteGuard {
  static activeConversationId(rows) {
    const active = Array.isArray(rows) ? rows.filter(row => row?.active && row?.id) : [];
    return active.length === 1 ? String(active[0].id) : '';
  }
  static matches(rows, conversationId) {
    const target = String(conversationId || '');
    return Boolean(target && this.activeConversationId(rows) === target);
  }
};
globalThis.OEDeskOutboundRouteGuard = OEDeskOutboundRouteGuard;

// Electron can execute a page function while the page's own timers are
// throttled. Coalesce direct pulses, but retain exactly one trailing pass when
// an inbound mutation arrives during an in-flight scan.
var OEDeskScanScheduler = globalThis.OEDeskScanScheduler || class OEDeskScanScheduler {
  constructor(timeoutMs = 20000) {
    this.running = false;
    this.trailing = false;
    this.current = null;
    this.timeoutMs = Math.max(25, Number(timeoutMs) || 20000);
  }
  runWithTimeout(scan) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`scan exceeded ${this.timeoutMs}ms`);
        error.code = 'SCAN_TIMEOUT';
        reject(error);
      }, this.timeoutMs);
    });
    return Promise.race([Promise.resolve().then(scan), timeout]).finally(() => clearTimeout(timer));
  }
  request(scan) {
    if (this.running) {
      this.trailing = true;
      return this.current || Promise.resolve();
    }
    this.running = true;
    this.current = (async () => {
      try {
        do {
          this.trailing = false;
          await this.runWithTimeout(scan);
        } while (this.trailing);
      } finally {
        this.running = false;
        this.current = null;
      }
    })();
    return this.current;
  }
};
globalThis.OEDeskScanScheduler = OEDeskScanScheduler;

if (typeof document !== 'undefined') (function () {
  'use strict';

  const bridgeVersion = '0.7.8';

  // Electron may reinject after SPA navigation or a watchdog tick. Keep a
  // single observer/heartbeat set per document so reinjection is idempotent.
  if (globalThis.__rcbXianyuBridgeLoaded) return;
  globalThis.__rcbXianyuBridgeLoaded = true;

  // server.js binds to 127.0.0.1; using the numeric host avoids Windows
  // localhost resolving to an unavailable IPv6 ::1 listener.
  const API = 'http://127.0.0.1:3000/api/xianyu';
  const sessionId = `xy-rpa-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const seen = new Map();
  const attemptedOutbox = new Set();
  let outboxCursor = 0;
  let listening = false;
  let scanBusy = false;
  let scanTimer = null;
  let lastScanAt = 0;
  const scanScheduler = new OEDeskScanScheduler();
  const scanState = new OEDeskConversationScanState();
  let currentConversationId = '';
  let conversationListPrimed = false;
  let conversationListBusy = false;
  let outboxBusy = false;
  const conversationSnapshots = new Map();
  const pendingConversationOpens = [];
  const pendingConversationIds = new Set();
  let conversationMutationObserver = null;
  let observedConversationRoot = null;
  let messageMutationObserver = null;
  let observedMessageRoot = null;
  let lastConversationOpenAt = 0;
  let conversationNavigation = Promise.resolve();
  const rowIdentityTokens = new WeakMap();
  let nextRowIdentityToken = 1;
  // React may replace a message element during virtualization. The ordinal is
  // stable across a repaint and distinguishes repeated text when Goofish omits
  // an external message ID.
  const messagePositionTokens = new WeakMap();
  let scanCount = 0;
  let forwardedCount = 0;
  let lastForwardError = '';
  let lastHeartbeatStartedAt = 0;
  let heartbeatBusy = false;
  let lastSuccessfulScanAt = 0;
  let scanRecoveryCount = 0;
  let lastCandidateStats = { raw: 0, unique: 0, outgoing: 0, invisible: 0, selected: 0 };

  const bridge = document.createElement('div');
  bridge.textContent = 'OE DESK 闲鱼桥接启动中';
  Object.assign(bridge.style, { position: 'fixed', zIndex: 2147483647, right: '16px', bottom: '16px', padding: '7px 10px', maxWidth: '300px', borderRadius: '999px', color: '#fff', background: '#19855d', font: '12px sans-serif', boxShadow: '0 3px 14px rgba(0,0,0,.2)', pointerEvents: 'none' });
  document.documentElement.appendChild(bridge);

  function call(path, options = {}) {
    const method = options.method || 'GET';
    const body = options.body || '';
    const timeoutMs = Math.max(1000, Number(options.timeout || 12000));
    if (typeof GM_xmlhttpRequest === 'function') return new Promise((resolve, reject) => {
      let settled = false;
      const finish = callback => value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const accept = finish(resolve);
      const fail = finish(reject);
      // Electron's GM shim cannot cancel ipcRenderer.invoke, so enforce the
      // deadline here as well as passing it to a real userscript manager.
      const timer = setTimeout(() => fail(new Error('本地服务响应超时')), timeoutMs);
      try {
        GM_xmlhttpRequest({ method, url: `${API}${path}`, data: body, headers: { 'content-type': 'application/json' }, timeout: timeoutMs, onload: response => { if (response.status < 200 || response.status >= 300) { let detail = ''; try { detail = JSON.parse(response.responseText || '{}').error || ''; } catch {} return fail(new Error(`HTTP ${response.status}${detail ? ` · ${detail}` : ''}`)); } try { accept(JSON.parse(response.responseText || '{}')); } catch { fail(new Error('桥接响应不是 JSON')); } }, onerror: () => fail(new Error('无法连接本地服务')), ontimeout: () => fail(new Error('本地服务响应超时')) });
      } catch (error) { fail(error); }
    });
    return fetch(`${API}${path}`, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json', ...(options.headers || {}) } }).then(response => response.json().then(payload => { if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`); return payload; }));
  }

  function pageConversationId() {
    const url = new URL(location.href);
    const params = ['conversationId', 'conversation_id', 'chatId', 'chat_id', 'sessionId', 'userId', 'uid'];
    for (const key of params) if (url.searchParams.get(key)) return `${key}:${url.searchParams.get(key)}`;
    const activeRow = conversationRows().find(entry => entry.active);
    if (activeRow?.id) return activeRow.id;
    // The active row briefly disappears while React updates its preview. Keep
    // the last normalized row identity during that repaint; falling back to
    // `/im` would make the first new bubble look like history twice.
    if (currentConversationId && currentConversationId !== `${location.pathname}${location.hash || ''}`) return currentConversationId;
    return `${location.pathname}${location.hash || ''}`;
  }

  function updateConversationId() {
    currentConversationId = pageConversationId();
    return currentConversationId;
  }

  function renderedText(node) {
    return String(node?.innerText || node?.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function nodeIsVisible(node) {
    const rect = node?.getBoundingClientRect?.();
    return Boolean(rect && rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth);
  }

  function hashText(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function conversationRowIsActive(row) {
    for (let cursor = row; cursor && cursor !== document.body; cursor = cursor.parentElement) {
      if (cursor.getAttribute?.('aria-selected') === 'true') return true;
      const ariaCurrent = cursor.getAttribute?.('aria-current');
      if (ariaCurrent && ariaCurrent !== 'false') return true;
      const className = String(cursor.className || '').toLowerCase();
      if (/(^|[-_\s])(active|selected|current)(?:$|[-_\s])/.test(className)) return true;
    }
    return false;
  }

  function conversationLineParts(row) {
    const raw = String(row?.innerText || row?.textContent || '').replace(/\u00a0/g, ' ').trim();
    const parts = raw.split(/[\r\n]+/).map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const nonStatusParts = parts.filter(value => !/^(未读|unread|已读|read|置顶|pinned|免打扰|muted)$/i.test(value) && !/^(\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日天]|\d{1,2}[/-]\d{1,2})$/.test(value));
    return nonStatusParts.length ? nonStatusParts : parts;
  }

  function stableConversationVisualIdentity(row) {
    // Goofish's current conversation rows do not expose an ID. The avatar URL
    // is stable for a buyer while the row text changes with every new preview.
    const avatar = [...(row?.querySelectorAll?.('img[src]') || [])]
      .map(image => image.getAttribute('src') || '')
      .find(src => src && !src.startsWith('data:'));
    let avatarId = '';
    if (avatar) {
      try {
        const url = new URL(avatar, location.origin);
        avatarId = hashText(`${url.origin}${url.pathname}`);
      } catch { avatarId = hashText(avatar.split('?')[0]); }
    }
    // Do not include aria/title/name text in this fallback: avatar metadata is
    // populated asynchronously and those labels can change while a row is
    // being rendered, which would make one buyer look like two conversations.
    if (avatarId) return `visual:${avatarId}`;
    const semanticId = ['data-user-id', 'data-uid', 'data-conversation-id', 'data-session-id', 'data-chat-id']
      .map(attribute => row?.getAttribute?.(attribute) || row?.querySelector?.(`[${attribute}]`)?.getAttribute(attribute) || '')
      .find(value => value && value.length <= 160);
    if (semanticId) return `visual:${hashText(semanticId)}`;
    if (!rowIdentityTokens.has(row)) rowIdentityTokens.set(row, nextRowIdentityToken++);
    return `row:${rowIdentityTokens.get(row)}`;
  }

  function conversationHasUnread(row) {
    const rowText = `${row?.className || ''} ${row?.getAttribute?.('aria-label') || ''} ${renderedText(row)}`.toLowerCase();
    if (/未读|unread|\bnew\b/.test(rowText)) return true;
    return [...(row?.querySelectorAll?.('sup, [class*="badge-dot"], [class*="badge-count"], [class*="scroll-number"], [class*="unread"]') || [])]
      .some(node => nodeIsVisible(node));
  }

  function conversationRowId(row, label) {
    const attributes = ['data-conversation-id', 'data-session-id', 'data-chat-id', 'data-conversationid', 'data-sessionid', 'data-chatid'];
    for (const scope of [row, row?.parentElement].filter(Boolean)) {
      for (const attribute of attributes) {
        const value = scope.getAttribute?.(attribute);
        if (value) return `id:${String(value).trim()}`;
      }
    }
    const link = row?.matches?.('a[href]') ? row : row?.querySelector?.('a[href]');
    const href = link?.getAttribute?.('href') || '';
    if (href && !/^javascript:/i.test(href)) {
      try {
        const target = new URL(href, location.origin);
        const queryId = ['conversationId', 'conversation_id', 'chatId', 'chat_id', 'sessionId', 'session_id', 'uid', 'userId']
          .map(key => target.searchParams.get(key)).find(Boolean);
        if (queryId) return `id:${queryId}`;
        if (target.pathname && target.pathname !== '/im' && target.pathname !== '/im/') return `href:${target.pathname}${target.search}`;
      } catch { /* A malformed client-side href is not a usable identity. */ }
    }
    const visualIdentity = stableConversationVisualIdentity(row);
    if (visualIdentity) return visualIdentity;
    return `label:${hashText(label)}`;
  }

  function conversationRoots() {
    const selectors = [
      'aside', '[role="navigation"]', '[role="list"]',
      '[class*="conversation-list"]', '[class*="conversationList"]', '[class*="session-list"]', '[class*="sessionList"]',
      '[class*="chat-list"]', '[class*="chatList"]'
    ];
    const roots = [...new Set([...document.querySelectorAll(selectors.join(','))])];
    return roots.filter(root => {
      const rect = root.getBoundingClientRect?.();
      const hint = `${root.className || ''} ${root.getAttribute?.('aria-label') || ''} ${root.getAttribute?.('data-testid') || ''}`.toLowerCase();
      const hasConversationSemantics = root.matches?.('aside, [role="navigation"]') || /(conversation|session|chat[-_]?list|dialog|contact)/.test(hint);
      return Boolean(rect && hasConversationSemantics && rect.width >= 120 && rect.height >= 120 && rect.left < window.innerWidth * 0.62 && !root.closest('[data-message-id], [data-msg-id], [class*="message-pane"], [class*="messagePanel"]'));
    });
  }

  function conversationRowTarget(candidate, root) {
    const marker = /conversation|session|chat[-_]?item|dialog|contact/i;
    let fallback = null;
    for (let cursor = candidate; cursor && cursor !== root; cursor = cursor.parentElement) {
      const attrs = `${cursor.getAttribute?.('data-conversation-id') || ''} ${cursor.getAttribute?.('data-session-id') || ''} ${cursor.getAttribute?.('data-chat-id') || ''} ${cursor.getAttribute?.('data-testid') || ''}`;
      const className = String(cursor.className || '');
      if (marker.test(`${attrs} ${className}`) || cursor.matches?.('a[href], button, [role="option"], [role="listitem"]')) return cursor;
      fallback = cursor;
    }
    return fallback || candidate;
  }

  function conversationRows() {
    const candidates = '[data-conversation-id], [data-session-id], [data-chat-id], [data-testid*="conversation"], [data-testid*="session"], [class*="conversation-item"], [class*="conversationItem"], [class*="session-item"], [class*="sessionItem"], [class*="chat-item"], [class*="chatItem"], [class*="dialog-item"], [class*="contact-item"], a[href*="conversation"], a[href*="session"], a[href*="chat"], [role="option"], [role="listitem"], button';
    const rows = [];
    const seenRows = new Set();
    for (const root of conversationRoots()) {
      for (const candidate of root.querySelectorAll(candidates)) {
        const row = conversationRowTarget(candidate, root);
        if (!row || seenRows.has(row) || !nodeIsVisible(row)) continue;
        const rect = row.getBoundingClientRect();
        if (rect.height < 24 || rect.height > 240 || rect.left > window.innerWidth * 0.68) continue;
        const parts = conversationLineParts(row);
        const label = parts[0] || renderedText(row);
        if (!label || label.length > 220 || /^(搜索|search|设置|更多|消息|聊天|会话)$/i.test(label)) continue;
        // Some Goofish layouts render nickname and preview in one visual line.
        // Keep the complete rendered row as a private change signature so a
        // text-only preview update is observable, while the stable ID above
        // remains independent of that preview.
        const rowText = renderedText(row).replace(/\b\d{1,2}:\d{2}\b|昨天|前天|星期[一二三四五六日天]|\d{1,2}[/-]\d{1,2}/g, '').replace(/\s+/g, ' ').trim();
        const preview = (parts.length > 1 ? parts.slice(1).join(' ') : rowText).slice(0, 500);
        const unread = conversationHasUnread(row);
        const id = conversationRowId(row, label);
        seenRows.add(row);
        rows.push({ id, row, label: label.slice(0, 220), preview, unread, active: conversationRowIsActive(row), signature: `${rowText}\n${unread ? 'unread' : 'read'}` });
      }
    }
    return rows;
  }

  function activeConversationEntry() {
    const rows = conversationRows();
    const id = OEDeskOutboundRouteGuard.activeConversationId(rows);
    return id ? rows.find(entry => entry.id === id && entry.active) || null : null;
  }

  // Never use `currentConversationId` here. It deliberately survives a React
  // repaint for inbound scanning, so it is unsafe as a sending authorization.
  function composerForActiveConversation(conversationId, expectedInput = null) {
    if (!OEDeskOutboundRouteGuard.matches(conversationRows(), conversationId)) return null;
    const input = findComposer();
    if (!input || !input.isConnected || !nodeIsVisible(input)) return null;
    if (expectedInput && input !== expectedInput) return null;
    return input;
  }

  function refreshConversationMutationObserver() {
    const root = conversationRoots()[0] || null;
    if (root === observedConversationRoot) return;
    conversationMutationObserver?.disconnect();
    observedConversationRoot = root;
    if (!root) return;
    conversationMutationObserver = new MutationObserver(records => {
      if (records.some(record => record.target !== bridge && !bridge.contains(record.target))) scheduleScan('conversation-text');
    });
    conversationMutationObserver.observe(root, {
      characterData: true,
      childList: true,
      subtree: true,
      // Some Goofish builds toggle unread state with class/ARIA attributes
      // without changing the preview text or inserting a new node.
      attributes: true,
      attributeFilter: ['class', 'aria-label', 'aria-selected', 'aria-current', 'title', 'data-unread', 'data-count']
    });
  }

  function messageMutationRoot() {
    const seed = [...document.querySelectorAll('[class*="message-text-left"], [class*="message-text-right"], [class*="message-content-text"], [data-message-id], [data-msg-id]')]
      .find(node => nodeIsVisible(node));
    if (!seed) return null;
    let candidate = seed.parentElement;
    for (let depth = 0; candidate && depth < 7; depth += 1, candidate = candidate.parentElement) {
      const rect = candidate.getBoundingClientRect?.();
      const hint = `${candidate.className || ''} ${candidate.getAttribute?.('role') || ''} ${candidate.getAttribute?.('aria-live') || ''}`.toLowerCase();
      if (rect && rect.width >= 260 && rect.height >= 180 && rect.left > window.innerWidth * 0.18
        && (/(message|chat|conversation|dialog|panel|list|log|scroll)/.test(hint) || candidate.scrollHeight > candidate.clientHeight + 20)) return candidate;
    }
    return seed.parentElement || seed;
  }

  function refreshMessageMutationObserver() {
    const root = messageMutationRoot();
    if (root === observedMessageRoot) return;
    messageMutationObserver?.disconnect();
    observedMessageRoot = root;
    if (!root) return;
    messageMutationObserver = new MutationObserver(records => {
      if (records.some(record => record.target !== bridge && !bridge.contains(record.target))) scheduleScan('message-mutation');
    });
    // This observer is scoped to the active message panel. It catches
    // virtualized rows that update text/class attributes without inserting a
    // new element, while the body observer below remains child-list only.
    messageMutationObserver.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-hidden', 'data-message-id', 'data-msg-id', 'data-direction', 'data-role']
    });
  }

  function visibleText(node) {
    if (!node || !node.isConnected) return '';
    // Message bubbles often contain avatar, status and action children. Read the
    // rendered text instead of rejecting nodes merely because they have children.
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 1 || text.length > 1200) return '';
    if (/^(发送|复制|删除|更多|设置|搜索|首页|商品|订单|我的|消息|已读|未读|收起|展开|加载中|暂无消息)$/.test(text)) return '';
    const rect = node.getBoundingClientRect?.();
    if (!rect || (!rect.width && !rect.height)) return '';
    return text;
  }

  function isOutgoing(node) {
    const classHints = [];
    const explicitHints = [];
    let cursor = node;
    // Direction is applied to a wrapper around the text bubble on goofish.
    // Keep class and semantic attributes separate: a nickname or generic
    // `seller` label must not make an inbound bubble disappear.
    for (let depth = 0; cursor && depth < 5; depth += 1, cursor = cursor.parentElement) {
      classHints.push(String(cursor.className || ''));
      explicitHints.push(cursor.getAttribute?.('data-direction') || '', cursor.getAttribute?.('data-role') || '', cursor.getAttribute?.('aria-label') || '');
    }
    const explicit = explicitHints.join(' ').toLowerCase();
    if (/(outgoing|sent|self|mine|assistant|seller|\u5356\u5bb6|\u6211\u65b9)/.test(explicit)) return true;
    const classes = classHints.join(' ').toLowerCase();
    if (/(^|[-_\s])(outgoing|sent|self|mine|my-message|seller-message|sellermessage|message-text-right|message-right)(?:$|[-_\s])/.test(classes)) return true;
    // Some Goofish builds hash all class names and expose no direction
    // attribute. Seller bubbles are consistently right-aligned inside the
    // wider message panel, while buyer bubbles are left-aligned.
    const bubble = node.getBoundingClientRect?.();
    if (!bubble || !bubble.width) return false;
    for (let parent = node.parentElement, depth = 0; parent && depth < 8; parent = parent.parentElement, depth += 1) {
      const panel = parent.getBoundingClientRect?.();
      if (!panel || panel.width < 280 || panel.width < bubble.width * 1.8) continue;
      const rightThreshold = panel.left + panel.width * 0.62;
      if (bubble.left >= rightThreshold) return true;
      // The first sufficiently wide ancestor is the active message panel; do
      // not continue to the full document where both sides become ambiguous.
      break;
    }
    return false;
  }

  function messageNodes() {
    const selectors = [
      '[data-message-id]', '[data-msg-id]', '[data-messageid]', '[data-testid*="message"]',
      '.msg-item', '.message-item', '.chat-message', '.im-message',
      '[class*="MessageItem"]', '[class*="messageItem"]', '[class*="msgItem"]', '[class*="chatMsg"]', '[class*="conversationMessage"]',
      // Current goofish.com/im build (CSS Modules): message text is rendered
      // as message-text-left--<hash> / message-text-right--<hash>.
      '[class*="message-text-left"], [class*="message-text-right"]', '[class*="message-content-text"]', '[class*="text-content-"]', '[class*="voice-to-text-container-"]'
    ];
    const candidates = [...document.querySelectorAll(selectors.join(','))];
    const stats = { raw: candidates.length, unique: 0, outgoing: 0, invisible: 0, selected: 0 };
    const seenNodes = new Set();
    const filtered = candidates.filter(node => {
      if (seenNodes.has(node)) return false;
      seenNodes.add(node);
      stats.unique += 1;
      if (isOutgoing(node)) { stats.outgoing += 1; return false; }
      // When a broad message-row selector matched, prefer its concrete text
      // child; otherwise a whole row (nickname + time + status) is submitted.
      const hasConcreteClass = /message-text-left|message-text-right|message-content-text|text-content-/.test(String(node.className || ''));
      if (!hasConcreteClass) {
        const concrete = node.querySelector('[class*="message-text-left"], [class*="message-content-text"], [class*="text-content-"]');
        if (concrete) return false;
      }
      const text = visibleText(node);
      if (!text) stats.invisible += 1;
      return Boolean(text);
    });
    // Parent rows are excluded above when they contain a concrete text child,
    // so preserve every remaining node. Text-based collapsing loses repeated
    // buyer messages such as two consecutive "你好" messages.
    filtered.forEach((node, index) => messagePositionTokens.set(node, index));
    stats.selected = filtered.length;
    lastCandidateStats = stats;
    return filtered;
  }

  function stableMessageKey(node, text, conversationId) {
    const explicit = ['data-message-id', 'data-msg-id', 'data-messageid', 'data-id', 'data-key', 'data-message-key', 'data-item-key']
      .map(attribute => node.getAttribute(attribute) || node.closest?.(`[${attribute}]`)?.getAttribute(attribute) || '')
      .find(Boolean) || '';
    if (explicit) return `${conversationId}|${explicit}`;
    const stamp = node.querySelector('time, [datetime], [class*="time"], [class*="Time"]')?.getAttribute('datetime') || node.querySelector('time')?.textContent || '';
    // React frequently replaces message DOM nodes during list virtualization.
    // Use the rendered content as the fallback identity so a repaint cannot
    // be mistaken for a new buyer message. Explicit platform IDs/timestamps
    // still distinguish genuinely repeated text when available.
    const sequence = ['data-index', 'data-seq', 'data-sequence', 'aria-posinset', 'data-timestamp']
      .map(attribute => node.getAttribute(attribute) || node.closest?.(`[${attribute}]`)?.getAttribute(attribute) || '')
      .find(Boolean) || '';
    const position = messagePositionTokens.get(node);
    // React frequently replaces message DOM nodes during list virtualization.
    // Prefer platform timestamps/sequence metadata, then rendered order. The
    // order token distinguishes repeated text without relying on node identity.
    return `${conversationId}|${text}|${stamp}|${sequence}|${Number.isInteger(position) ? position : ''}`;
  }

  function messageSender(node) {
    return node.getAttribute('data-sender') || node.querySelector('[class*="name"], [class*="nick"], [class*="sender"]')?.textContent?.trim() || '闲鱼客户';
  }

  function rememberMessage(node, text, conversationId) {
    const key = stableMessageKey(node, text, conversationId);
    seen.set(key, Date.now());
    if (seen.size > 3000) seen.delete(seen.keys().next().value);
    return key;
  }

  async function forwardBuyerMessage(node, conversationId) {
    const text = visibleText(node);
    if (!text) return false;
    const key = stableMessageKey(node, text, conversationId);
    if (seen.has(key)) return false;
    rememberMessage(node, text, conversationId);
    try {
      await call('/messages', {
        method: 'POST',
        body: JSON.stringify({
          text,
          sender: messageSender(node),
          conversationId,
          messageKey: key,
          externalId: node.getAttribute('data-message-id') || node.getAttribute('data-msg-id') || '',
          sessionId,
          pageUrl: location.href
        })
      });
      forwardedCount += 1;
      lastForwardError = '';
      return true;
    } catch (error) {
      // Permit a later retry when the local service was temporarily unavailable.
      seen.delete(key);
      lastForwardError = error.message || '消息上报失败';
      return false;
    }
  }

  async function scanMessages() {
    if (!listening || scanBusy) return;
    scanBusy = true;
    try {
      const conversationId = updateConversationId();
      const nodes = messageNodes();
      scanCount += 1;
      if (!nodes.length) {
        // Goofish briefly renders an empty pane before hydrating chat history.
        // Only accept it as a genuinely empty conversation after a short stable
        // period; otherwise the hydrated history would all look newly arrived.
        const ready = scanState.noteEmpty(conversationId);
        bridge.textContent = `OE DESK 监听中 · ${conversationId.slice(0, 24)} · ${ready ? '等待消息' : '正在加载历史消息'}`;
        return;
      }
      // Establish a baseline for the active conversation. This prevents a
      // freshly enabled bridge from replaying the entire existing chat history.
      if (!scanState.isPrimed(conversationId)) {
        nodes.forEach(node => {
          const text = visibleText(node);
          if (!text) return;
          const nodeConversationId = conversationId;
          rememberMessage(node, text, nodeConversationId);
        });
        scanState.prime(conversationId);
        bridge.textContent = `OE DESK 监听中 · ${conversationId.slice(0, 24)} · 已建立消息基线`;
        return;
      }
      for (const node of nodes) {
        const nodeConversationId = conversationId;
        await forwardBuyerMessage(node, nodeConversationId);
      }
      bridge.textContent = lastForwardError ? `OE DESK 上报失败 · ${lastForwardError.slice(0, 42)}` : `OE DESK 监听中 · ${conversationId.slice(0, 24)} · 已扫描 ${scanCount} · 已同步 ${forwardedCount}`;
    } catch (error) { bridge.textContent = `OE DESK 桥接异常：${error.message}`; }
    finally { scanBusy = false; lastScanAt = Date.now(); }
  }

  function conversationChangeLooksInbound(entry, previous) {
    if (!previous) return false;
    if (entry.unread && !previous.unread) return true;
    // A seller reply also changes the active row preview. The message pane
    // already handles that conversation, so reopening it here makes the page
    // jump during automatic sending. Only non-active rows are list triggers.
    if (entry.active || entry.id === currentConversationId) return false;
    return entry.preview !== previous.preview || entry.signature !== previous.signature;
  }

  function queueConversationOpen(entry, previous) {
    if (pendingConversationIds.has(entry.id)) return;
    pendingConversationIds.add(entry.id);
    pendingConversationOpens.push({ entry, previous });
  }

  async function waitForConversation(entry, timeoutMs = 2600) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = conversationRows().find(candidate => candidate.id === entry.id);
      if (current?.active) return current;
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    return conversationRows().find(candidate => candidate.id === entry.id && candidate.active) || null;
  }

  // List updates and outbox delivery can request navigation at the same time.
  // Serialize those requests so two async scans cannot make the page bounce
  // between buyers.
  async function openConversation(entry) {
    const task = conversationNavigation.then(() => performOpenConversation(entry), () => performOpenConversation(entry));
    conversationNavigation = task.catch(() => {});
    return task;
  }

  async function performOpenConversation(entry) {
    if (!entry?.row?.isConnected) return false;
    if (conversationRowIsActive(entry.row)) return true;
    const elapsed = Date.now() - lastConversationOpenAt;
    if (elapsed < 1200) await new Promise(resolve => setTimeout(resolve, 1200 - elapsed));
    lastConversationOpenAt = Date.now();
    bridge.textContent = `OE DESK 发现新消息 · 正在打开 ${entry.label.slice(0, 18)}`;
    try { entry.row.click(); } catch { /* Try Electron's trusted input next. */ }
    let opened = await waitForConversation(entry, 800);
    if (opened) return true;
    // Electron's BrowserView can issue a trusted pointer sequence when the
    // platform ignores synthetic DOM clicks. Browser users retain the regular
    // click path above.
    await nativeClickFallback(entry.row);
    opened = await waitForConversation(entry, 2600);
    return Boolean(opened);
  }

  async function captureLatestConversationMessage(entry) {
    const deadline = Date.now() + 3000;
    let nodes = messageNodes();
    while (!nodes.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 140));
      nodes = messageNodes();
    }
    if (!nodes.length) {
      lastForwardError = '已打开会话，但未读取到买家消息';
      return false;
    }
    // The list preview tells us the conversation changed. Only post its last
    // buyer bubble, then baseline the older history so it cannot be replayed.
    const preview = String(entry.preview || '').replace(/\s+/g, ' ').trim();
    const candidates = nodes.filter(node => {
      const text = visibleText(node);
      return preview && text && (preview.includes(text) || text.includes(preview));
    });
    const latest = (candidates.length ? candidates : nodes).at(-1);
    const sent = await forwardBuyerMessage(latest, entry.id);
    for (const node of nodes) {
      if (node === latest) continue;
      const text = visibleText(node);
      if (text) rememberMessage(node, text, entry.id);
    }
    scanState.prime(entry.id);
    return sent;
  }

  async function drainPendingConversations() {
    // Process one target per scan. A burst of unread rows should be handled
    // sequentially instead of causing rapid visible tab switching.
    if (!listening || !pendingConversationOpens.length) return;
    const pending = pendingConversationOpens.shift();
    pendingConversationIds.delete(pending.entry.id);
    const current = conversationRows().find(entry => entry.id === pending.entry.id) || pending.entry;
    if (!(await openConversation(current))) {
      lastForwardError = `无法打开会话：${current.label.slice(0, 24)}`;
      return;
    }
    await captureLatestConversationMessage(current);
  }

  async function scanConversationList() {
    if (!listening || conversationListBusy) return;
    conversationListBusy = true;
    try {
      updateConversationId();
      refreshConversationMutationObserver();
      const entries = conversationRows();
      if (!entries.length) return;
      if (!conversationListPrimed) {
        entries.forEach(entry => conversationSnapshots.set(entry.id, { signature: entry.signature, preview: entry.preview, unread: entry.unread }));
        conversationListPrimed = true;
        // If the list populated after the bridge started, an already-unread
        // row is actionable even though there is no previous snapshot to
        // compare. Open it now instead of waiting for another buyer event.
        entries.filter(entry => entry.unread).forEach(entry => queueConversationOpen(entry, null));
        await drainPendingConversations();
        return;
      }
      for (const entry of entries) {
        const previous = conversationSnapshots.get(entry.id);
        conversationSnapshots.set(entry.id, { signature: entry.signature, preview: entry.preview, unread: entry.unread });
        if (conversationChangeLooksInbound(entry, previous)) queueConversationOpen(entry, previous);
      }
      if (conversationSnapshots.size > 1200) {
        const visibleIds = new Set(entries.map(entry => entry.id));
        for (const id of conversationSnapshots.keys()) if (!visibleIds.has(id)) conversationSnapshots.delete(id);
      }
      await drainPendingConversations();
    } finally { conversationListBusy = false; }
  }

  async function scanPlatform() {
    refreshMessageMutationObserver();
    await scanConversationList();
    await scanMessages();
    lastSuccessfulScanAt = Date.now();
  }

  function requestPlatformScan(reason = 'direct') {
    if (!listening) return Promise.resolve(false);
    return scanScheduler.request(async () => {
      if (!listening) return;
      await scanPlatform();
    }).catch(error => {
      if (error?.code === 'SCAN_TIMEOUT') {
        // A stuck local request used to leave scanBusy=true forever, so only a
        // seller-side DOM mutation appeared to wake the listener. Release the
        // stale pass and let the next Electron pulse perform a fresh scan.
        scanBusy = false;
        conversationListBusy = false;
        scanRecoveryCount += 1;
        lastForwardError = '扫描超时，已自动恢复';
        observedConversationRoot = null;
        observedMessageRoot = null;
        setTimeout(() => requestPlatformScan('timeout-recovery'), 80);
      }
      bridge.textContent = `OE DESK 桥接异常：${error.message}`;
      return false;
    });
  }

  function scheduleScan(_reason = 'mutation') {
    if (!listening || scanTimer) return;
    const wait = Math.max(120, 320 - (Date.now() - lastScanAt));
    scanTimer = setTimeout(() => {
      scanTimer = null;
      requestPlatformScan('timer');
    }, wait);
  }

  function setInputValue(input, value) {
    input.focus();
    if (input.isContentEditable) {
      // Goofish uses a React controlled contenteditable. Setting textContent
      // alone changes pixels but not React state, so the subsequent send click
      // sees an empty draft. Use the editing command when available, then
      // dispatch the same beforeinput/input sequence as real typing.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection?.removeAllRanges();
      selection?.addRange(range);
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, value); } catch { /* Chromium may disable execCommand. */ }
      if (!inserted || String(input.textContent || '') !== value) input.textContent = value;
      try { input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: value })); } catch { /* Older WebViews. */ }
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    } else {
      const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value')?.set;
      setter ? setter.call(input, value) : (input.value = value);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function findComposer() {
    const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"], input[placeholder*="消息"], input[placeholder*="回复"], input[placeholder*="发送"], [role="textbox"]')];
    const visible = candidates.filter(input => input.getClientRects?.().length && !input.disabled && !input.readOnly && !input.closest('[aria-hidden="true"]'));
    const score = input => {
      const hint = `${input.getAttribute('placeholder') || ''} ${input.getAttribute('aria-label') || ''} ${input.getAttribute('data-testid') || ''} ${input.className || ''}`.toLowerCase();
      if (/(搜索|search|筛选|filter)/.test(hint)) return -1000;
      let value = input.isContentEditable ? input.textContent : input.value;
      let points = input.isContentEditable ? 80 : (input.tagName === 'TEXTAREA' ? 60 : 20);
      if (/(消息|回复|发送|聊天|输入|composer|editor|message|chat)/.test(hint)) points += 80;
      const rect = input.getBoundingClientRect?.();
      if (rect) points += Math.min(40, Math.max(0, rect.top / Math.max(1, window.innerHeight) * 40));
      if (String(value || '').trim()) points += 10;
      return points;
    };
    return visible.sort((left, right) => score(right) - score(left))[0];
  }

  function findSendButton(input) {
    const scope = input?.closest('form, [class*="composer"], [class*="Composer"], [class*="editor"], [class*="Editor"], [class*="input"], [class*="Input"], [class*="footer"], [class*="Footer"]');
    const roots = scope ? [scope, scope.parentElement, scope.parentElement?.parentElement].filter(Boolean) : [document];
    const candidates = [...new Set(roots.flatMap(root => [...root.querySelectorAll('button, [role="button"], [aria-label*="发送"], [data-testid*="send"], [class*="send"], [class*="Send"]')]))];
    const score = button => {
      if (!button.getClientRects?.().length || button.disabled || button.getAttribute('aria-disabled') === 'true') return -1e6;
      const label = (button.innerText || button.textContent || button.getAttribute('aria-label') || button.getAttribute('title') || '').replace(/\s+/g, '').trim();
      const attrs = `${label} ${button.getAttribute('data-testid') || ''} ${button.className || ''}`.toLowerCase();
      if (!/(发送|send|reply|回复)/.test(attrs) && !(button.type === 'submit' && scope?.contains(button))) return -1e6;
      let points = /^(发送|发送消息|回复|发送给买家|send)$/i.test(label) ? 100 : 50;
      if (scope?.contains(button)) points += 100;
      if (button.type === 'submit') points += 25;
      return points;
    };
    return candidates.map(button => ({ button, points: score(button) })).sort((left, right) => right.points - left.points)[0]?.button || null;
  }

  function composerText(input) {
    return String(input?.isContentEditable ? input.textContent || '' : input?.value || '').replace(/\u200b/g, '').trim();
  }

  async function waitForComposerClear(input, timeoutMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!composerText(input)) return true;
      await new Promise(resolve => setTimeout(resolve, 180));
    }
    return !composerText(input);
  }

  async function nativeEnterFallback(conversationId = '', expectedInput = null) {
    // Synthetic keyboard events have isTrusted=false and are ignored by some
    // Goofish React builds. Electron exposes a narrowly-scoped native input
    // bridge in the embedded view; Tampermonkey/browser use simply skips it.
    if (typeof globalThis.rcbPlatformSendInput !== 'function') return false;
    try {
      if (conversationId && !composerForActiveConversation(conversationId, expectedInput)) return false;
      await globalThis.rcbPlatformSendInput({ type: 'keyDown', keyCode: 'ENTER' });
      if (conversationId && !composerForActiveConversation(conversationId, expectedInput)) return false;
      await globalThis.rcbPlatformSendInput({ type: 'keyUp', keyCode: 'ENTER' });
      return true;
    } catch { return false; }
  }

  async function nativeInsertText(text) {
    if (typeof globalThis.rcbPlatformSendInput !== 'function' || !text) return false;
    try {
      await globalThis.rcbPlatformSendInput({ type: 'insertText', text: String(text).slice(0, 12000) });
      return true;
    } catch { return false; }
  }

  async function replaceComposerWithNativeText(input, text) {
    input?.focus?.();
    // Select the current draft before asking Chromium to insert trusted text.
    // The input event keeps React's controlled state aligned with the DOM.
    try { document.execCommand('selectAll'); } catch { /* Selection is best effort. */ }
    const inserted = await nativeInsertText(text);
    if (!inserted) return false;
    input?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(text) }));
    return true;
  }

  async function nativeClickFallback(button, conversationId = '', expectedInput = null) {
    if (typeof globalThis.rcbPlatformSendInput !== 'function' || !button?.getBoundingClientRect) return false;
    if (conversationId && !composerForActiveConversation(conversationId, expectedInput)) return false;
    const rect = button.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    try {
      const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      await globalThis.rcbPlatformSendInput({ type: 'mouseMove', ...point });
      if (conversationId && !composerForActiveConversation(conversationId, expectedInput)) return false;
      await globalThis.rcbPlatformSendInput({ type: 'mouseDown', ...point, button: 'left' });
      if (conversationId && !composerForActiveConversation(conversationId, expectedInput)) return false;
      await globalThis.rcbPlatformSendInput({ type: 'mouseUp', ...point, button: 'left' });
      return true;
    } catch { return false; }
  }

  async function releaseOutboxClaim(item, reason) {
    attemptedOutbox.delete(item.id);
    await call('/outbox/release', {
      method: 'POST',
      body: JSON.stringify({ id: item.id, sessionId, conversationId: item.conversationId, reason })
    }).catch(() => null);
  }

  function holdClaimedOutbox(item, message) {
    attemptedOutbox.add(item.id);
    bridge.textContent = message;
  }

  async function flushOutbox() {
    if (!listening || outboxBusy) return;
    outboxBusy = true;
    try {
      // Do not advance a cursor past a reply for another conversation. The
      // current page may switch while the model is generating, so inspect all
      // undelivered work and route to its exact conversation before claiming.
      const result = await call(`/outbox?since=0&sessionId=${encodeURIComponent(sessionId)}`);
      const pending = (result.messages || []).filter(item => !attemptedOutbox.has(item.id));
      if (!pending.length) return;
      const active = activeConversationEntry();
      let item = active ? pending.find(entry => entry.conversationId === active.id) : null;
      if (!item) {
        // Ignore legacy queue records whose old text-derived ID no longer
        // maps to a visible Goofish row. They must not block newer replies
        // that can be routed to a real conversation.
        const routable = pending.map(entry => ({ entry, target: conversationRows().find(row => row.id === entry.conversationId) })).find(candidate => candidate.target);
        const target = routable?.target;
        item = routable?.entry;
        if (!target) {
          bridge.textContent = '已生成回复，等待对应闲鱼会话加载';
          return;
        }
        await openConversation(target);
        return;
      }
      let input = composerForActiveConversation(item.conversationId);
      if (!input) { bridge.textContent = '已生成回复，等待闲鱼聊天输入框'; return; }
      const claimed = await call('/outbox/claim', { method: 'POST', body: JSON.stringify({ id: item.id, sessionId, conversationId: item.conversationId }) }).catch(() => null);
      if (!claimed) return;
      // Re-read the active DOM row after every async boundary. The cached
      // conversation ID can be stale while Goofish swaps virtualized rows.
      input = composerForActiveConversation(claimed.conversationId);
      if (!input) {
        await releaseOutboxClaim(claimed, 'route-lost-after-claim');
        bridge.textContent = '会话已切换，回复将等待目标会话恢复';
        return;
      }
      setInputValue(input, claimed.text);
      input = composerForActiveConversation(claimed.conversationId, input);
      if (!input) {
        await releaseOutboxClaim(claimed, 'route-lost-before-send');
        bridge.textContent = '会话已切换，未发送回复将等待目标会话恢复';
        return;
      }
      const send = findSendButton(input);
      if (send) {
        input = composerForActiveConversation(claimed.conversationId, input);
        if (!input) {
          await releaseOutboxClaim(claimed, 'route-lost-before-click');
          bridge.textContent = '会话已切换，未发送回复将等待目标会话恢复';
          return;
        }
        send.focus?.();
        if (!composerForActiveConversation(claimed.conversationId, input)) {
          await releaseOutboxClaim(claimed, 'route-lost-before-click');
          bridge.textContent = '会话已切换，未发送回复将等待目标会话恢复';
          return;
        }
        try {
          send.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          send.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        } catch { /* WebView may not expose MouseEvent. */ }
        send.click();
      } else {
        input = composerForActiveConversation(claimed.conversationId, input);
        if (!input) {
          await releaseOutboxClaim(claimed, 'route-lost-before-enter');
          bridge.textContent = '会话已切换，未发送回复将等待目标会话恢复';
          return;
        }
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }
      let sent = await waitForComposerClear(input);
      if (!sent) {
        input = composerForActiveConversation(claimed.conversationId, input);
        if (!input) {
          holdClaimedOutbox(claimed, '发送状态未确认，已停止自动重试');
          return;
        }
        if (composerText(input)) await replaceComposerWithNativeText(input, claimed.text);
        input = composerForActiveConversation(claimed.conversationId, input);
        if (!input) {
          holdClaimedOutbox(claimed, '发送状态未确认，已停止自动重试');
          return;
        }
        input.focus?.();
        await nativeEnterFallback(claimed.conversationId, input);
        sent = await waitForComposerClear(input, 2200);
      }
      if (!sent) {
        input = composerForActiveConversation(claimed.conversationId, input);
        if (!input) {
          holdClaimedOutbox(claimed, '发送状态未确认，已停止自动重试');
          return;
        }
        await nativeClickFallback(findSendButton(input), claimed.conversationId, input);
        sent = await waitForComposerClear(input, 2200);
      }
      if (!sent) {
        holdClaimedOutbox(claimed, '发送状态未确认，已停止自动重试');
        return;
      }
      if (!composerForActiveConversation(claimed.conversationId)) {
        holdClaimedOutbox(claimed, '发送状态未确认，已停止自动重试');
        return;
      }
      const acknowledged = await call('/outbox/ack', { method: 'POST', body: JSON.stringify({ id: claimed.id, sessionId, conversationId: claimed.conversationId, pageUrl: location.href }) }).catch(() => null);
      if (!acknowledged) {
        holdClaimedOutbox(claimed, '发送状态未确认，已停止自动重试');
        return;
      }
      outboxCursor = Math.max(outboxCursor, Number(claimed.createdAtMs || 0));
      bridge.textContent = '已发送 AI 回复';
    } catch (error) { bridge.textContent = `OE DESK 桥接异常：${error.message}`; }
    finally { outboxBusy = false; }
  }

  async function heartbeat() {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    lastHeartbeatStartedAt = Date.now();
    try {
      const loginForm = document.querySelector('#fm-sms-login-id, #fm-smscode, iframe[src*="mini_login"], [class*="login-form"], [class*="loginForm"]');
      const loginVisible = Boolean(loginForm && nodeIsVisible(loginForm));
      // Goofish injects the bridge on both the authenticated chat shell and
      // the public login page.  Only the former should make the workbench
      // appear connected; a stale cookie/DOM flag must never imply login.
      // The conversation list can be temporarily empty while Goofish swaps
      // virtualized rows after login. Treat the authenticated chat shell as
      // ready when any of its stable surfaces is present.
      const authenticated = !loginVisible && (
        conversationRows().length > 0
        || conversationRoots().length > 0
        || Boolean(findComposer())
        || messageNodes().length > 0
      );
      const candidateCount = listening ? messageNodes().length : 0;
      const result = await call('/listener', { method: 'POST', body: JSON.stringify({ connected: authenticated, sessionId, conversationId: updateConversationId(), pageUrl: location.href, chatUrl: location.href, diagnostics: { bridgeVersion, scanCount, forwardedCount, lastForwardError, candidateCount, candidateStats: lastCandidateStats, conversationCount: conversationRows().length, authenticated, lastSuccessfulScanAt, scanRecoveryCount } }) });
      const nextListening = authenticated && Boolean(result.listening);
      const started = nextListening && !listening;
      listening = nextListening;
      if (started) {
        scanState.reset();
        conversationListPrimed = false;
        conversationSnapshots.clear();
        pendingConversationOpens.length = 0;
        pendingConversationIds.clear();
        // Prime immediately after enabling the listener so an operator's first
        // message cannot race the delayed interval scan and become baseline.
        requestPlatformScan('listener-start');
      }
      bridge.textContent = !authenticated ? 'OE DESK 未登录 · 等待登录' : nextListening ? `OE DESK 监听中 · ${currentConversationId.slice(0, 32)}` : 'OE DESK 已连接 · 监听暂停';
    } catch (error) { bridge.textContent = `本地服务未启动：${error.message}`; }
    finally { heartbeatBusy = false; }
  }

  // The Electron host can invoke this pulse when Chromium throttles page
  // timers while the embedded view is backgrounded.
  globalThis.__rcbXianyuBridgeHeartbeat = heartbeat;
  globalThis.__rcbXianyuBridgePulse = () => {
    requestPlatformScan('electron-host');
    flushOutbox();
    if (Date.now() - lastHeartbeatStartedAt > 2500) heartbeat();
  };
  heartbeat();
  setInterval(heartbeat, 2000);
  const observer = new MutationObserver(records => {
    if (records.some(record => record.target !== bridge && !bridge.contains(record.target))) scheduleScan('mutation');
  });
  observer.observe(document.body || document.documentElement, { subtree: true, childList: true });
  setInterval(() => scheduleScan('interval'), 1000);
  setInterval(flushOutbox, 900);
  setInterval(refreshConversationMutationObserver, 1500);
  setInterval(refreshMessageMutationObserver, 1500);
}());
