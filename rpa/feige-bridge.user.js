// ==UserScript==
// @name         OE DESK Feige bridge
// @match        https://im.jinritemai.com/*
// ==/UserScript==

function feigeProps(node, field) {
  const key = node && Object.keys(node).find(name => name.startsWith('__reactInternalInstance$') || name.startsWith('__reactFiber$'));
  for (let fiber = key && node[key], depth = 0; fiber && depth < 10; fiber = fiber.return, depth += 1) {
    const value = fiber.memoizedProps?.[field];
    if (value != null) return value;
  }
  return null;
}

function conversationIdentity(node, useUrl = true) {
  const keys = ['data-conversation-id', 'data-session-id', 'data-chat-id', 'data-user-id', 'data-uid'];
  for (let cursor = node, depth = 0; cursor && depth < 5; cursor = cursor.parentElement, depth += 1) {
    for (const key of keys) {
      const id = cursor.getAttribute?.(key);
      if (id && id.length < 240) return id;
    }
    for (const key of ['cid', 'conversationId', 'sessionId', 'chatId']) {
      const id = feigeProps(cursor, key);
      if ((typeof id === 'string' || typeof id === 'number') && String(id).length < 240) return String(id);
    }
  }
  if (!useUrl) return '';
  const url = new URL(location.href);
  for (const key of ['conversationId', 'sessionId', 'chatId', 'userId']) {
    const id = url.searchParams.get(key);
    if (id && id.length < 240) return id;
  }
  return '';
}

function feigeMessage(node) {
  for (let cursor = node, depth = 0; cursor && depth < 7; cursor = cursor.parentElement, depth += 1) {
    const message = feigeProps(cursor, 'message') || feigeProps(cursor, 'item');
    if (message?.conversationId && (message.serverId || message.id)) return message;
  }
  return null;
}

function messageIdentity(node, position) {
  const message = feigeMessage(node);
  if (message) return String(message.serverId || message.id);
  for (const key of ['data-message-id', 'data-msg-id', 'data-msgid', 'data-id']) {
    const parent = node.parentElement;
    const messageParent = parent && /message|msg/i.test(String(parent.className || '')) ? parent : null;
    const id = node.getAttribute?.(key) || messageParent?.getAttribute?.(key);
    if (id) return id;
  }
  // Positional identities are only valid within a continuously observed list.
  return `visible-${position}`;
}

function boundConversationId(list, editor, messageNodes) {
  if (!list || !editor || list.closest?.('#workspace-chat') !== editor.closest?.('#workspace-chat') ||
    !list.closest?.('#workspace-chat')) return '';
  const id = conversationIdentity(list);
  const messages = messageNodes.map(feigeMessage).filter(Boolean);
  if (!id || !messages.length || messages.some(message => message.conversationId !== id)) return '';
  return id;
}

function feigeSendButton(editor) {
  const workspace = editor?.closest?.('#workspace-chat');
  const button = workspace?.querySelector?.('[data-qa-id="qa-send-message-button"]');
  if (!button || button.getAttribute?.('aria-disabled') === 'true' || button.disabled === true) return null;
  return button;
}

function json(value) { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } }

function valuesOf(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return [];
  const found = [];
  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key) && ['string', 'number'].includes(typeof child)) found.push(String(child));
    else if (child && typeof child === 'object') found.push(...valuesOf(child, keys, depth + 1));
  }
  return found;
}

function platformSendAcknowledgement(request, response, ok, expected) {
  if (!expected || !ok) return null;
  const payload = json(request);
  const reply = json(response);
  if (!payload || !reply || !JSON.stringify(payload).includes(expected.text) ||
    !valuesOf(payload, ['conversationId', 'sessionId', 'chatId']).includes(expected.conversationId)) return null;
  const ids = valuesOf(reply, ['messageId', 'msgId', 'msg_id']);
  const routes = valuesOf(reply, ['conversationId', 'sessionId', 'chatId']);
  if (!ids.length || (routes.length && !routes.includes(expected.conversationId))) return null;
  return { ok: true, messageId: ids[0], conversationId: expected.conversationId };
}

class FeigeHydrationGate {
  constructor(minAgeMs = 2500, quietMs = 1200) {
    this.minAgeMs = minAgeMs;
    this.quietMs = quietMs;
    this.states = new Map();
  }

  observe(id, fingerprints, now = Date.now()) {
    const key = fingerprints.join('\u0000');
    const state = this.states.get(id);
    if (!state) { this.states.set(id, { firstAt: now, changedAt: now, key, ready: false }); return false; }
    if (state.ready) return true;
    if (state.key !== key) { state.key = key; state.changedAt = now; }
    if (now - state.firstAt >= this.minAgeMs && now - state.changedAt >= this.quietMs) state.ready = true;
    return state.ready;
  }

  reset(id) { this.states.delete(id); }
}

function deliveryEvidence(expected, ack, bubbles) {
  if (ack?.ok !== true || !ack.messageId || ack.conversationId !== expected.conversationId) return null;
  const evidence = recoveredDeliveryEvidence(expected, bubbles);
  return evidence?.platformMessageId === String(ack.messageId) ? evidence : null;
}

function recoveredDeliveryEvidence(reply, bubbles) {
  const matches = bubbles.filter(bubble => bubble.id && bubble.serverId &&
    bubble.conversationId === reply.conversationId && bubble.text === reply.text &&
    Number(bubble.createdAtMs) >= Number(reply.createdAtMs) && Number(reply.createdAtMs) > 0 &&
    Number(bubble.flightStatus) === 3 && bubble.isFakeMessage === false &&
    !reply.before?.has(bubble.id));
  if (matches.length !== 1) return null;
  const bubble = matches[0];
  return { platformAck: true, platformMessageId: bubble.serverId, platformConversationId: reply.conversationId,
    domBubble: true, domConversationId: reply.conversationId, newBubbleId: bubble.id };
}

function outgoingBubble(node, position) {
  const message = feigeMessage(node);
  return { id: String(message?.id || messageIdentity(node, position)), serverId: String(message?.serverId || ''),
    conversationId: String(message?.conversationId || ''), text: (node.innerText || node.textContent || '').trim(),
    createdAtMs: Number(message?.createTime), flightStatus: Number(message?.flightStatus),
    isFakeMessage: message?.isFakeMessage };
}

function shouldRefreshVerification(item, active, now = Date.now()) {
  return item.delivery === 'verifying' && item.conversationId === active?.id &&
    !item.evidence?.verificationRefreshAt && now - Number(item.updatedAtMs) >= 3500 &&
    active.editor?.value === '';
}

function shouldDispatchToActiveConversation(item, conversationId, newestInboundId) {
  return Boolean(item.conversationId === conversationId && item.sourceExternalId &&
    newestInboundId === item.sourceExternalId && !String(newestInboundId).startsWith('visible-'));
}

function recentHydrationArrivals(items, since, seen, conversationId) {
  return items.filter(item => {
    const timestamp = item.platformCreatedAtMs;
    const milliseconds = since >= 1e12 && timestamp > 0 && timestamp < 1e12 ? timestamp * 1000 : timestamp;
    return milliseconds >= since && !seen.has(`${conversationId}|${item.id}|${item.text}`) && !item.id.startsWith('visible-');
  });
}

function arrivalsAfterBaseline(items, baseline) {
  if (!baseline) return [];
  const identified = items.filter(item => !item.id.startsWith('visible-'));
  if (!baseline.length) return identified;
  const known = new Set(baseline);
  const boundary = identified.findLastIndex(item => known.has(item.id));
  return boundary < 0 ? [] : identified.slice(boundary + 1);
}

function initialUnreadArrival(items, seen, conversationId) {
  const latest = items.at(-1);
  return latest && !latest.id.startsWith('visible-') &&
    !seen.has(`${conversationId}|${latest.id}|${latest.text}`) ? latest : null;
}

function feigeHistoryPairs(list, conversationId, before) {
  const pairs = [];
  let question = null;
  const nodes = list.querySelectorAll('.messageNotMe, .messageIsMe');
  for (const node of nodes) {
    const message = feigeMessage(node);
    const timestamp = Number(message?.createTime);
    const milliseconds = timestamp > 0 && timestamp < 1e12 ? timestamp * 1000 : timestamp;
    const text = (node.innerText || node.textContent || '').trim();
    if (message?.conversationId !== conversationId || !message.serverId || !text || text.length > 600 ||
        message.isFakeMessage === true || !(milliseconds > 0 && milliseconds < before)) {
      question = null;
      continue;
    }
    if (node.matches('.messageNotMe')) {
      question = { text, milliseconds };
    } else if (question) {
      if (question.milliseconds <= milliseconds && (message.flightStatus == null || Number(message.flightStatus) === 3) &&
          !message.isRobot && !message.isAutoReply && !message.isSystemMessage) {
        pairs.push({ replyId: String(message.serverId), question: question.text, answer: text });
      }
      question = null;
    }
  }
  return pairs;
}

function selectPendingConversationRow(rows, activeId, outbox = []) {
  const ready = outbox.filter(reply => reply.delivery === 'queued');
  const awaitingReceipt = outbox.filter(reply => reply.delivery === 'verifying' && !reply.evidence?.verificationRefreshAt);
  for (const reply of [...ready, ...awaitingReceipt]) {
    if (reply.conversationId === activeId) continue;
    const destination = rows.find(row => row.id === reply.conversationId) ||
      rows.find(row => feigeRowMatches(row, reply.conversationId) && !feigeRowMatches(row, activeId));
    if (destination) return destination;
  }
  return rows.find(row => row.unread && !feigeRowMatches(row, activeId)) || (!activeId ? rows[0] || null : null);
}

function feigeRowMatches(row, conversationId) {
  if (!conversationId) return false;
  if (row.id === conversationId) return true;
  const route = /^(.+):([^:]+)::\d+:\d+:pigeon$/.exec(conversationId);
  return Boolean(route && (row.serviceIdentity === route[1] || row.serviceIdentity === `${route[1]}:${route[2]}`));
}

function feigeRowServiceIdentity(node) {
  const handlerKey = Object.keys(node).find(name => name.startsWith('__reactProps$') || name.startsWith('__reactEventHandlers$'));
  if (typeof node[handlerKey]?.onClick !== 'function' || !node.getAttribute?.('data-qa-id')) return '';
  const identity = feigeProps(node, 'buyerAndServiceEntityId');
  return typeof identity === 'string' && identity && identity.length < 240 ? identity : '';
}

function feigeRowIdentity(node) {
  for (const key of ['data-conversation-id', 'data-session-id', 'data-chat-id']) {
    const value = node.getAttribute?.(key);
    if (value && value.length < 240) return value;
  }
  for (const field of ['conversation', 'session', 'conversationInfo', 'sessionInfo', 'item', 'record']) {
    const props = feigeProps(node, field);
    const value = props?.conversationId ?? props?.cid ?? props?.conversation?.id;
    if ((typeof value === 'string' || typeof value === 'number') && String(value).length < 240) return String(value);
  }
  return conversationIdentity(node, false);
}

function waitForDeliveryEvidence(check, subscribe, timeoutMs = 1600) {
  return new Promise(resolve => {
    let finished = false;
    let checking = false;
    let dirty = false;
    let unsubscribe = () => {};
    let interval;
    let timeout;
    function finish(confirmed) {
      if (finished) return;
      finished = true;
      clearInterval(interval);
      clearTimeout(timeout);
      unsubscribe();
      resolve(confirmed);
    }
    async function wake() {
      if (finished) return;
      if (checking) { dirty = true; return; }
      checking = true;
      try {
        if (await check()) { finish(true); return; }
      } catch { /* An uncertain send remains in the verification queue. */ }
      finally { checking = false; }
      if (dirty) { dirty = false; wake(); }
    }
    unsubscribe = subscribe(wake);
    interval = setInterval(wake, 180);
    timeout = setTimeout(() => finish(false), timeoutMs);
    wake();
  });
}

if (typeof document !== 'undefined' && !globalThis.__oeFeigeBridge) (function () {
  globalThis.__oeFeigeBridge = true;
  const sessionId = `fg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const base = `http://127.0.0.1:${globalThis.__oeFeigePort || 3000}/api/feige`;
  const seen = new Set();
  const primed = new Map();
  const pendingInbound = new Map();
  const startedAt = Date.now() - 5000;
  const hydration = new FeigeHydrationGate();
  const pending = new Map();
  const initialUnreadConversations = new Set();
  const historyHydration = new FeigeHydrationGate();
  const importedHistory = new Set();
  const visitedHistory = new Set();
  let importingHistory = false;
  let manualHistory = false;
  let replyMode = 'off';
  let lastHistoryClickAt = 0;
  let attempt = null;
  let busy = false;
  let scanning = false;
  let allowAutoNavigation = false;
  let lastConversation = '';
  let lastList = null;
  let pendingNavigation = null;
  let announcedConversation;
  let announcing;
  const lastRowClick = new Map();
  let routeSearch;
  let retryRouteSearchAt = 0;

  function notePlatformResponse(request, response, ok) {
    const current = attempt;
    const ack = platformSendAcknowledgement(request, response, ok, current);
    if (ack) {
      current.ack = ack;
      current.wake?.();
    }
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    const response = await originalFetch.apply(this, arguments);
    if (attempt && !String(input?.url || input).includes('/api/feige/')) {
      const requestBody = init?.body || (input instanceof Request ? await input.clone().text().catch(() => '') : '');
      response.clone().text().then(body => notePlatformResponse(requestBody, body, response.ok)).catch(() => {});
    }
    return response;
  };
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__oeFeigeUrl = String(url); return xhrOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    if (attempt && !this.__oeFeigeUrl?.includes('/api/feige/')) {
      this.addEventListener('load', () => {
        try { notePlatformResponse(body, this.responseText, this.status >= 200 && this.status < 300); } catch { /* Binary platform response. */ }
      }, { once: true });
    }
    return xhrSend.apply(this, arguments);
  };

  async function call(path, method = 'GET', data) {
    const url = base + path;
    const result = typeof globalThis.rcbFeigeRequest === 'function'
      ? await globalThis.rcbFeigeRequest({ url, method, data: data === undefined ? '' : JSON.stringify(data) })
      : await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) })
        .then(async response => ({ status: response.status, responseText: await response.text() }));
    const body = JSON.parse(result.responseText || '{}');
    if (result.status < 200 || result.status >= 300) throw new Error(body.error || `Feige API ${result.status}`);
    return body;
  }

  function activeConversation({ readOnly = false } = {}) {
    const list = document.querySelector('.messageList');
    const editor = document.querySelector('textarea[data-qa-id="qa-send-message-textarea"]');
    if (!list || (!readOnly && (!editor || editor.disabled))) return null;
    if (!editor && readOnly) {
      const id = conversationIdentity(list, false);
      const messages = [...list.querySelectorAll('.messageNotMe, .messageIsMe')].map(feigeMessage).filter(Boolean);
      return id && messages.length && messages.every(message => message.conversationId === id) ? { id, list } : null;
    }
    const id = boundConversationId(list, editor, [...list.querySelectorAll('.messageNotMe, .messageIsMe')]);
    return id ? { id, list, editor } : null;
  }

  function sessionScroller() {
    return document.querySelector('#chantListScrollArea .scroller, #chatListScrollArea .scroller');
  }

  function conversationRows() {
    const scroller = sessionScroller();
    if (!scroller) return [];
    const identified = new Map();
    const serviceRows = new Map();
    for (const candidate of scroller.querySelectorAll('*')) {
      const serviceIdentity = feigeRowServiceIdentity(candidate);
      if (serviceIdentity && !serviceRows.has(serviceIdentity)) {
        serviceRows.set(serviceIdentity, { id: '', serviceIdentity, node: candidate });
      }
      const id = feigeRowIdentity(candidate);
      if (!id || identified.has(id)) continue;
      let node = candidate;
      while (node.parentElement && node.parentElement !== scroller && feigeRowIdentity(node.parentElement) === id) node = node.parentElement;
      identified.set(id, node);
    }
    const nodes = identified.size || serviceRows.size
      ? [...serviceRows.values(), ...[...identified.entries()].map(([id, node]) => ({ id, node }))]
      : [...scroller.children].map(node => ({ id: '', node }));
    const unreadSelector = '[class*="unread" i], .auxo-badge-count, [data-unread="true"], [data-unread="1"]';
    return nodes.filter(row => row.node.getClientRects().length).map(row => ({ ...row, unread: Boolean(
      row.node.matches(unreadSelector) || row.node.querySelector(unreadSelector)) }));
  }

  function activatePendingConversation(activeId, outbox) {
    if (attempt || pendingNavigation) return false;
    const now = Date.now();
    for (const [key, until] of lastRowClick) if (until <= now) lastRowClick.delete(key);
    const available = conversationRows().filter(row => !lastRowClick.has(row.id || row.serviceIdentity || row.node));
    const target = selectPendingConversationRow(available, activeId, outbox);
    if (!target) return false;
    const key = target.id || target.serviceIdentity || target.node;
    const requested = outbox.find(reply => reply.conversationId !== activeId &&
      (reply.delivery === 'queued' || reply.delivery === 'verifying' && !reply.evidence?.verificationRefreshAt) &&
      feigeRowMatches(target, reply.conversationId));
    pendingNavigation = { id: target.id, serviceIdentity: target.serviceIdentity, previousId: activeId,
      expectedConversationId: requested?.conversationId, unread: target.unread, key, deadline: now + 8000 };
    lastRowClick.set(key, now + 15000);
    routeSearch = null;
    target.node.click();
    return true;
  }

  function seekQueuedConversation(activeId, outbox) {
    const needed = outbox.some(reply => reply.delivery === 'queued' && reply.conversationId !== activeId);
    if (!needed || routeSearch?.steps >= 12) {
      if (routeSearch?.viewport.isConnected) routeSearch.viewport.scrollTop = routeSearch.initialTop;
      if (needed) retryRouteSearchAt = Date.now() + 15000;
      routeSearch = null;
      return;
    }
    if (Date.now() < retryRouteSearchAt) return;
    if (!routeSearch?.viewport.isConnected) {
      let viewport = sessionScroller();
      for (let depth = 0; viewport && depth < 6; depth += 1, viewport = viewport.parentElement) {
        if (viewport.clientHeight > 0 && viewport.scrollHeight > viewport.clientHeight &&
            /^(auto|scroll)$/.test(getComputedStyle(viewport).overflowY)) break;
      }
      if (!viewport?.clientHeight || viewport.scrollHeight <= viewport.clientHeight ||
          !/^(auto|scroll)$/.test(getComputedStyle(viewport).overflowY)) return;
      routeSearch = { viewport, initialTop: viewport.scrollTop, steps: 0 };
      viewport.scrollTop = 0;
      return;
    }
    const { viewport } = routeSearch;
    const previousTop = viewport.scrollTop;
    viewport.scrollTop += Math.max(1, Math.floor(viewport.clientHeight * 0.8));
    routeSearch.steps = viewport.scrollTop === previousTop ? 12 : routeSearch.steps + 1;
  }

  function rows(list, direction) {
    return [...list.querySelectorAll(`.${direction}`)].map((node, position) => ({ node, position,
      id: messageIdentity(node, position), platformCreatedAtMs: Number(feigeMessage(node)?.createTime || 0),
      text: (node.innerText || node.textContent || '').trim() }))
      .filter(item => item.text);
  }

  async function receiveRow(active, item) {
    const key = `${active.id}|${item.id}|${item.text}`;
    if (item.id.startsWith('visible-') || seen.has(key)) return;
    await call('/messages', 'POST', { sessionId, conversationId: active.id, externalId: item.id,
      text: item.text, sender: '飞鸽客户' });
    seen.add(key);
    pendingInbound.delete(key);
  }

  async function scan() {
    if (scanning || manualHistory) return;
    scanning = true;
    try {
      const active = activeConversation();
      if (active) {
        const visible = rows(active.list, 'messageNotMe');
        const items = visible.filter(item => !item.id.startsWith('visible-'));
        if (active.id !== lastConversation || active.list !== lastList) {
          hydration.reset(active.id);
          lastConversation = active.id;
          lastList = active.list;
        }
        const navigation = pendingNavigation;
        const arrived = navigation && active.id !== navigation.previousId &&
          (navigation.expectedConversationId ? active.id === navigation.expectedConversationId
            : !navigation.id && !navigation.serviceIdentity || feigeRowMatches(navigation, active.id));
        if (arrived && navigation.unread && !navigation.marked) {
          initialUnreadConversations.add(active.id);
          navigation.marked = true;
        }
        const snapshot = items.map(item => item.id);
        const ready = hydration.observe(active.id, visible.map(item => item.id));
        const arrivals = new Set([
          ...recentHydrationArrivals(items, startedAt, seen, active.id),
          ...arrivalsAfterBaseline(items, primed.get(active.id))
        ]);
        const latestVisible = visible.at(-1);
        if (initialUnreadConversations.has(active.id) && latestVisible &&
            !latestVisible.id.startsWith('visible-') && (ready || arrivals.has(latestVisible))) {
          const latest = initialUnreadArrival(visible, seen, active.id);
          if (latest) arrivals.add(latest);
          initialUnreadConversations.delete(active.id);
        }
        for (const item of items) {
          const key = `${active.id}|${item.id}|${item.text}`;
          if (arrivals.has(item) && !seen.has(key)) pendingInbound.set(key, { conversationId: active.id, item });
        }
        if (ready && (snapshot.length || !primed.has(active.id))) primed.set(active.id, snapshot);
        if (arrived && ready && !initialUnreadConversations.has(active.id)) {
          pendingNavigation = null;
          lastRowClick.delete(navigation.key);
        }
      }
      for (const { conversationId, item } of pendingInbound.values()) await receiveRow({ id: conversationId }, item);
    } catch (error) { console.warn('[feige-bridge] scan:', error.message); }
    finally { scanning = false; }
  }

  function bubbleSnapshot(active) {
    return [...active.list.querySelectorAll('.messageIsMe')].map(outgoingBubble).filter(item => item.text);
  }

  async function observeHumanReply(event) {
    if (!event.isTrusted || attempt) return;
    const active = activeConversation();
    if (!active) return;
    const send = feigeSendButton(active.editor);
    const click = event.type === 'click' && send?.contains(event.target);
    const enter = event.type === 'keydown' && event.target === active.editor && event.key === 'Enter'
      && !event.isComposing && !event.repeat;
    if (!click && !enter) return;
    const text = active.editor.value.trim();
    const source = rows(active.list, 'messageNotMe').at(-1);
    if (!text || !source || source.id.startsWith('visible-')) return;
    const startedAt = Date.now();
    const previous = new Set(bubbleSnapshot(active).map(item => item.id));
    try {
      const status = await call('/session', 'POST', { sessionId, authenticated: true, routeReady: true,
        conversationId: active.id, pageUrl: location.href });
      applyRoutingStatus(status);
      if (status.replyMode !== 'self_learning') return;
      await receiveRow(active, source);
      while (Date.now() - startedAt < 10000) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const current = activeConversation();
        const sent = bubbleSnapshot(current?.id === active.id ? current : active).find(item => item.serverId && item.conversationId === active.id &&
          !previous.has(item.id) && item.flightStatus === 3 && item.isFakeMessage === false && item.text === text);
        if (!sent) continue;
        await call('/human-reply', 'POST', { sessionId, conversationId: active.id, sourceId: source.id,
          replyId: sent.serverId, text, startedAt });
        return;
      }
    } catch (error) { console.warn('[feige-bridge] human reply:', error.message); }
  }
  document.addEventListener('click', observeHumanReply, true);
  document.addEventListener('keydown', observeHumanReply, true);

  async function saveVisibleHistory(active, before, scanId) {
    const pairs = feigeHistoryPairs(active.list, active.id, before).filter(pair => !importedHistory.has(active.id + '|' + pair.replyId));
    const result = { added: 0, published: 0 };
    if (!pairs.length) return result;
    const status = await call('/session', 'POST', { sessionId, authenticated: true, routeReady: true,
      conversationId: active.id, pageUrl: location.href });
    if (!scanId && status.replyMode !== 'self_learning') return result;
    for (let offset = 0; offset < pairs.length; offset += 24) {
      if (activeConversation({ readOnly: true })?.id !== active.id) break;
      const batch = pairs.slice(offset, offset + 24);
      const learned = await call('/learning-history', 'POST', { sessionId, conversationId: active.id, pairs: batch, scanId });
      result.added += learned.added || 0;
      result.published += learned.published || 0;
      for (const pair of batch) importedHistory.add(active.id + '|' + pair.replyId);
    }
    return result;
  }

  async function importHistory() {
    if (replyMode !== 'self_learning' || importingHistory || manualHistory || !globalThis.rcbFeigeRequest) return;
    importingHistory = true;
    try {
      const active = activeConversation({ readOnly: true });
      if (active) {
        const ready = historyHydration.observe(active.id, [...active.list.querySelectorAll('.messageNotMe, .messageIsMe')].map(messageIdentity));
        if (!ready) return;
        await saveVisibleHistory(active, startedAt);
        visitedHistory.add(active.id);
      }
      if (globalThis.__oeFeigeVisible !== false || Date.now() - lastHistoryClickAt < 4000) return;
      const target = conversationRows().find(row => row.id && !row.unread && row.id !== active?.id && !visitedHistory.has(row.id));
      if (!target) return;
      lastHistoryClickAt = Date.now();
      visitedHistory.add(target.id);
      historyHydration.reset(target.id);
      target.node.click();
    } catch (error) { console.warn('[feige-bridge] learning history:', error.message); }
    finally { importingHistory = false; }
  }

  globalThis.__oeReadFeigeHistory = async scanId => {
    if (manualHistory) throw new Error('飞鸽历史会话正在读取。');
    if (!document.querySelector('#imroot') || /登录已过期/.test(document.body?.innerText || '')) {
      throw new Error('请先在飞鸽客服页面登录。');
    }
    manualHistory = true;
    const before = Date.now();
    const original = activeConversation({ readOnly: true })?.id;
    const result = { conversations: 0, added: 0, published: 0, partial: false };
    const tried = new Set();
    const hidden = () => globalThis.__oeFeigeVisible === false;
    const delay = () => new Promise(resolve => setTimeout(resolve, 200));
    try {
      while ((busy || importingHistory || scanning) && Date.now() - before < 5000) await delay();
      if (busy || importingHistory || scanning) throw new Error('飞鸽仍在处理消息，请稍后再读历史。');
      let targetId = original;
      while (Date.now() - before < 55000 && tried.size < 24) {
        if (!targetId) {
          if (!hidden()) { result.partial = true; break; }
          const available = conversationRows().filter(row => row.id && !row.unread && !tried.has(row.id));
          const target = available.find(row => !visitedHistory.has(row.id)) || available[0];
          if (!target) break;
          targetId = target.id;
          target.node.click();
        }
        tried.add(targetId);
        const gate = new FeigeHydrationGate();
        const deadline = Date.now() + 5000;
        let read = false;
        while (Date.now() < deadline) {
          const active = activeConversation({ readOnly: true });
          if (active?.id === targetId && gate.observe(active.id,
            [...active.list.querySelectorAll('.messageNotMe, .messageIsMe')].map(messageIdentity))) {
            const learned = await saveVisibleHistory(active, before, scanId);
            result.conversations += 1;
            result.added += learned.added;
            result.published += learned.published;
            visitedHistory.add(active.id);
            read = true;
            break;
          }
          if (!hidden() && active?.id !== targetId) break;
          await delay();
        }
        if (!read) result.partial = true;
        targetId = '';
      }
      result.partial ||= Date.now() - before >= 55000 || tried.size >= 24;
      return result;
    } finally {
      if (hidden() && original && activeConversation({ readOnly: true })?.id !== original) {
        conversationRows().find(row => row.id === original && !row.unread)?.node.click();
      }
      manualHistory = false;
    }
  };

  function latestInboundId(active) {
    return rows(active.list, 'messageNotMe').at(-1)?.id || '';
  }

  function latestInbound(active) {
    return rows(active.list, 'messageNotMe').at(-1) || null;
  }

  async function confirm(item, expected, active) {
    const bubbles = bubbleSnapshot(active);
    const evidence = deliveryEvidence(expected, expected.ack, bubbles) || recoveredDeliveryEvidence(expected, bubbles);
    if (!evidence) return false;
    await call('/outbox/ack', 'POST', { sessionId, conversationId: active.id, id: item.id,
      claimToken: expected.claimToken, evidence });
    pending.delete(item.id);
    return true;
  }

  async function send(item, active) {
    if (active.editor.value) return;
    const visibleInbound = latestInbound(active);
    if (visibleInbound && !visibleInbound.id.startsWith('visible-')) await receiveRow(active, visibleInbound);
    if (!shouldDispatchToActiveConversation(item, active.id, latestInboundId(active))) return;
    const claimed = await call('/outbox/claim', 'POST', { sessionId, conversationId: active.id, id: item.id });
    const claim = { sessionId, conversationId: active.id, id: item.id, claimToken: claimed.claimToken };
    const isCurrent = () => {
      const current = activeConversation();
      return current?.id === active.id && current.editor === active.editor &&
        shouldDispatchToActiveConversation(item, active.id, latestInboundId(active));
    };
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    let filled = false;
    let clicked = false;
    try {
      if (!setter || !isCurrent() || active.editor.value) return;
      const before = new Set(bubbleSnapshot(active).map(bubble => bubble.id));
      const expected = { conversationId: active.id, text: item.text, createdAtMs: item.createdAtMs,
        before, ack: null, claimToken: claimed.claimToken };
      pending.set(item.id, expected);
      // After a crash, treat a prepared send as uncertain until the platform confirms it.
      await call('/outbox/verify', 'POST', { ...claim, evidence: { platformAck: false, beforeBubbleIds: [...before] } });
      if (!isCurrent() || active.editor.value) return;
      attempt = expected;
      setter.call(active.editor, item.text);
      filled = true;
      active.editor.dispatchEvent(new Event('input', { bubbles: true }));
      active.editor.focus();
      await new Promise(resolve => setTimeout(resolve, 80));
      if (!isCurrent() || active.editor.value !== item.text) return;
      const currentInbound = latestInbound(active);
      if (currentInbound && !currentInbound.id.startsWith('visible-')) await receiveRow(active, currentInbound);
      const ready = await call('/outbox/ready', 'POST', claim);
      if (!ready.ready || !isCurrent() || active.editor.value !== item.text) return;
      const button = feigeSendButton(active.editor);
      if (!button) return;
      clicked = true;
      button.click();
      await waitForDeliveryEvidence(async () => {
        const current = activeConversation();
        return current?.id === active.id && confirm(item, expected, current);
      }, wake => {
        const observer = new MutationObserver(wake);
        observer.observe(active.list, { childList: true, subtree: true, characterData: true, attributes: true });
        expected.wake = wake;
        return () => { observer.disconnect(); delete expected.wake; };
      });
    } finally {
      attempt = null;
      if (!clicked) {
        pending.delete(item.id);
        const current = activeConversation();
        if (filled && current?.id === active.id && current.editor === active.editor && active.editor.value === item.text) {
          setter.call(active.editor, '');
          active.editor.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await call('/outbox/release', 'POST', { ...claim, beforeClick: true });
      }
    }
    return clicked;
  }

  async function readOutbox() {
    const { messages, ...status } = await call(`/outbox?sessionId=${encodeURIComponent(sessionId)}`);
    if (typeof status.listening === 'boolean') applyRoutingStatus(status);
    return messages || [];
  }

  async function sendNextPart(previous, active) {
    if (!previous.sourceMessageId) return;
    const messages = await readOutbox();
    const current = activeConversation();
    if (!allowAutoNavigation || current?.id !== active.id || current.editor !== active.editor) return;
    const next = messages.find(item => item.delivery === 'queued' && item.conversationId === previous.conversationId &&
      item.sourceMessageId === previous.sourceMessageId && item.createdAtMs > previous.createdAtMs);
    if (next) await send(next, current);
  }

  async function drain() {
    if (busy || scanning || manualHistory || pendingInbound.size) return;
    busy = true;
    try {
      if (pendingNavigation && pendingNavigation.deadline <= Date.now()) pendingNavigation = null;
      if (pendingNavigation) return;
      const active = activeConversation();
      if (announcedConversation !== (active?.id || '')) await heartbeat();
      const messages = await readOutbox();
      const current = activeConversation();
      if (current?.id !== active?.id || current?.editor !== active?.editor) return;
      if (document.querySelector('textarea[data-qa-id="qa-send-message-textarea"]')?.value) return;
      if (active && !hydration.states.get(active.id)?.ready) return;
      let handledCurrent = false;
      for (const item of messages) {
        if (!active || item.conversationId !== active.id) continue;
        if (item.delivery === 'verifying') {
          let expected = pending.get(item.id);
          if (!expected?.claimToken || expected.claimToken !== item.claimToken || item.claimedBy !== sessionId) {
            const claimed = await call('/outbox/claim', 'POST', { sessionId, conversationId: active.id, id: item.id });
            expected = { conversationId: active.id, text: item.text, createdAtMs: item.createdAtMs,
              before: new Set(item.evidence?.beforeBubbleIds || []), ack: null, claimToken: claimed.claimToken };
            pending.set(item.id, expected);
          }
          if (await confirm(item, expected, active)) {
            handledCurrent = true;
            await sendNextPart(item, active);
            continue;
          }
          if (shouldRefreshVerification(item, active) && activeConversation()?.id === active.id) {
            handledCurrent = true;
            await call('/outbox/verify', 'POST', { sessionId, conversationId: active.id, id: item.id,
              claimToken: expected.claimToken, evidence: { verificationRefreshAt: Date.now() } });
            location.reload();
            break;
          }
          continue;
        }
        if (pending.has(item.id)) continue;
        if (await send(item, active)) {
          handledCurrent = true;
          if (!pending.has(item.id)) await sendNextPart(item, active);
        }
      }
      if (!handledCurrent && allowAutoNavigation) {
        const activeId = active?.id || '';
        if (!activatePendingConversation(activeId, messages)) seekQueuedConversation(activeId, messages);
      }
    } catch (error) { console.warn('[feige-bridge] outbox:', error.message); }
    finally { busy = false; }
  }

  function applyRoutingStatus(status) {
    replyMode = status.replyMode;
    allowAutoNavigation = status.listening === true && ['human_collab', 'full_auto'].includes(replyMode);
  }

  async function heartbeat() {
    if (manualHistory) return;
    if (announcing) return announcing;
    announcing = (async () => {
      const active = activeConversation({ readOnly: replyMode === 'self_learning' });
      const authenticated = Boolean(active || document.querySelector('#imroot') && !/登录已过期|请登录/.test(document.body?.innerText || ''));
      const status = await call('/session', 'POST', { sessionId, authenticated, routeReady: Boolean(active),
        conversationId: active?.id || '', pageUrl: location.href });
      announcedConversation = active?.id || '';
      applyRoutingStatus({ ...status, listening: authenticated && status.listening });
    })().catch(error => { console.warn('[feige-bridge] heartbeat:', error.message); })
      .finally(() => { announcing = null; });
    return announcing;
  }

  const observer = new MutationObserver(() => { scan(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'data-unread', 'data-message-id', 'data-msg-id', 'data-msgid', 'data-id'] });
  heartbeat().then(scan);
  setInterval(heartbeat, 10000);
  setInterval(scan, 250);
  setInterval(drain, 250);
  setInterval(importHistory, 1500);
})();
