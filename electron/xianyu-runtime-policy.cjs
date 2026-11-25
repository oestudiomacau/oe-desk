'use strict';

function isXianyuSocketUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['ws:', 'wss:'].includes(url.protocol)) return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === 'wss-goofish.dingtalk.com'
      || hostname.endsWith('.goofish.com')
      || (hostname.endsWith('.dingtalk.com') && /goofish|xianyu/.test(`${hostname}${url.pathname}`));
  } catch {
    return false;
  }
}

function classifyXianyuSocketPayload(payloadData) {
  try {
    const payload = JSON.parse(String(payloadData || ''));
    const heartbeat = Boolean(payload && typeof payload === 'object' && !Array.isArray(payload) && !('body' in payload) && Number(payload.code) === 200);
    const syncData = payload?.body?.syncPushPackage?.data;
    // Goofish delivers chat changes in non-empty syncPushPackage batches.
    // Other body-bearing frames are request responses and status traffic; they
    // must not cause the hidden browser to cycle through every conversation.
    const application = Array.isArray(syncData) && syncData.length > 0;
    return { application, heartbeat };
  } catch {
    // Unknown/binary frames still prove that the socket is alive, but should
    // not make the DOM bridge rotate through every conversation.
    return { application: false, heartbeat: false };
  }
}

function xianyuSocketEnvelope(payloadData) {
  try {
    const payload = JSON.parse(String(payloadData || ''));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const headers = payload.headers && typeof payload.headers === 'object' && !Array.isArray(payload.headers) ? payload.headers : {};
    const mid = String(headers.mid || payload.mid || '').trim();
    const lwp = String(payload.lwp || headers.lwp || '').trim();
    const codeValue = payload.code ?? (payload.body && !Array.isArray(payload.body) ? payload.body.code : undefined);
    const hasCode = codeValue !== null && codeValue !== undefined && String(codeValue).trim() !== '';
    const code = hasCode && Number.isFinite(Number(codeValue)) ? Number(codeValue) : null;
    const body = payload.body && typeof payload.body === 'object' && !Array.isArray(payload.body) ? payload.body : null;
    const rejected = Boolean(body?.reason || (code !== null && code !== 200));
    return { mid, lwp, code, rejected };
  } catch {
    return null;
  }
}

function hashXianyuDeliveryText(value) {
  let hash = 2166136261;
  for (const char of String(value || '').replace(/\s+/g, ' ').trim()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function extractXianyuSentTextHash(payloadData) {
  try {
    const payload = JSON.parse(String(payloadData || ''));
    if (String(payload?.lwp || '') !== '/r/MessageSend/sendByReceiverScope') return '';
    const encoded = payload?.body?.[0]?.content?.custom?.data;
    if (typeof encoded !== 'string' || !encoded || encoded.length > 100000) return '';
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    const text = decoded?.text?.text;
    return typeof text === 'string' && text.trim() ? hashXianyuDeliveryText(text) : '';
  } catch {
    return '';
  }
}

function extractXianyuInboundHints(payloadData) {
  let payload;
  try { payload = JSON.parse(String(payloadData || '')); } catch { return []; }
  const syncData = payload?.body?.syncPushPackage?.data;
  if (!Array.isArray(syncData) || !syncData.length) return [];
  const hints = [];
  const seen = new Set();
  const cleanId = value => String(value || '').trim().slice(0, 240);
  const first = (object, keys) => keys.map(key => object?.[key]).find(value => typeof value === 'string' || typeof value === 'number') || '';
  const walk = (value, inherited = {}, depth = 0) => {
    if (depth > 7 || hints.length >= 12 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      const text = value.trim();
      if ((text.startsWith('{') || text.startsWith('[')) && text.length <= 100000) {
        try { walk(JSON.parse(text), inherited, depth + 1); } catch { /* Not embedded JSON. */ }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, inherited, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    const context = {
      messageId: cleanId(first(value, ['messageId', 'message_id', 'msgId', 'msg_id', 'uuid']) || inherited.messageId),
      chatId: cleanId(first(value, ['chatId', 'chat_id', 'cid', 'conversationId', 'conversation_id']) || inherited.chatId),
      senderId: cleanId(first(value, ['senderId', 'sender_id', 'fromUserId', 'from_user_id', 'from']) || inherited.senderId),
      receiverId: cleanId(first(value, ['receiverId', 'receiver_id', 'toUserId', 'to_user_id', 'to']) || inherited.receiverId)
    };
    const candidateText = first(value, ['reminderContent', 'reminder_content', 'messageText', 'message_text', 'text', 'summary']);
    const text = typeof candidateText === 'string' ? candidateText.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    if (text && text.length <= 500 && !/^[A-Za-z0-9+/=_-]{80,}$/.test(text)) {
      const key = `${context.messageId}|${context.chatId}|${context.senderId}|${text}`;
      if (!seen.has(key)) {
        seen.add(key);
        hints.push({ ...context, text });
      }
    }
    for (const child of Object.values(value)) {
      if (child && (typeof child === 'object' || typeof child === 'string')) walk(child, context, depth + 1);
    }
  };
  walk(syncData);
  return hints;
}

class BridgeRecoveryPolicy {
  constructor(options = {}) {
    this.scanStaleMs = Math.max(1000, Number(options.scanStaleMs || 30000));
    this.heartbeatStaleMs = Math.max(1000, Number(options.heartbeatStaleMs || 20000));
    this.staleChecksBeforeReload = Math.max(2, Number(options.staleChecksBeforeReload || 10));
    this.missingHealthMs = Math.max(1000, Number(options.missingHealthMs || 18000));
    this.reinjectAfterFailures = Math.max(2, Number(options.reinjectAfterFailures || 4));
    this.reloadAfterFailures = Math.max(this.reinjectAfterFailures + 1, Number(options.reloadAfterFailures || 12));
    this.softRecoveryCooldownMs = Math.max(0, Number(options.softRecoveryCooldownMs ?? 5000));
    this.reset();
  }

  reset() {
    this.lastHealthAt = 0;
    this.lastSoftRecoveryAt = 0;
    this.probeFailures = 0;
    this.staleChecks = 0;
  }

  assess({ health, now = Date.now(), pageLoading = false } = {}) {
    const at = Number(now) || Date.now();
    if (pageLoading) return { action: 'none', reason: 'page-loading' };

    if (health && typeof health === 'object') {
      this.lastHealthAt = at;
      this.probeFailures = 0;
      if (!health.listening) {
        this.staleChecks = 0;
        return { action: 'none', reason: 'listener-paused' };
      }
      const lastScan = Number(health.lastSuccessfulScanAt || 0);
      const lastHeartbeat = Number(health.lastHeartbeatSucceededAt || 0);
      const scanStale = Boolean(lastScan && at - lastScan > this.scanStaleMs);
      const heartbeatStale = Boolean(lastHeartbeat && at - lastHeartbeat > this.heartbeatStaleMs);

      // One delayed signal is expected during React rendering, AI work or a
      // short local-service pause. Reload only when both independent signals
      // remain stale, mirroring a real connection state machine.
      if (!(scanStale && heartbeatStale)) {
        this.staleChecks = 0;
        return { action: 'none', reason: scanStale || heartbeatStale ? 'single-signal-stale' : 'healthy' };
      }

      this.staleChecks += 1;
      if (this.staleChecks >= this.staleChecksBeforeReload) {
        return { action: 'reload', reason: 'bridge-signals-stale' };
      }
      return { action: 'wake', reason: 'bridge-signals-stale' };
    }

    this.probeFailures += 1;
    const missingFor = this.lastHealthAt ? at - this.lastHealthAt : Number.POSITIVE_INFINITY;
    if (this.probeFailures >= this.reloadAfterFailures && missingFor >= this.missingHealthMs) {
      return { action: 'reload', reason: 'bridge-health-missing' };
    }
    if (this.probeFailures >= this.reinjectAfterFailures && missingFor >= this.missingHealthMs) {
      if (!this.lastSoftRecoveryAt || at - this.lastSoftRecoveryAt >= this.softRecoveryCooldownMs) {
        this.lastSoftRecoveryAt = at;
        return { action: 'reinject', reason: 'bridge-health-missing' };
      }
    }
    return { action: 'none', reason: 'transient-probe-failure' };
  }
}

class XianyuSocketTracker {
  constructor() {
    this.sockets = new Map();
    this.deliveryAttempts = new Map();
    this.pendingDeliveryTokens = [];
    this.lastOpenedAt = 0;
    this.lastFrameAt = 0;
    this.lastClosedAt = 0;
    this.disconnectedAt = 0;
  }

  get connected() { return this.sockets.size > 0; }

  beginDeliveryAttempt(input = {}, now = Date.now()) {
    const claimToken = String(input.claimToken || '').trim();
    if (!claimToken) throw new Error('claimToken is required');
    const at = Number(now) || Date.now();
    const attempt = {
      claimToken,
      conversationId: String(input.conversationId || '').trim(),
      textHash: String(input.textHash || '').trim(),
      startedAt: at,
      requestObserved: false,
      requestObservedAt: 0,
      platformMid: '',
      platformLwp: '',
      platformAck: false,
      platformAckAt: 0,
      platformCode: null,
      platformRejected: false
    };
    this.deliveryAttempts.set(claimToken, attempt);
    this.pendingDeliveryTokens = this.pendingDeliveryTokens.filter(token => token !== claimToken);
    this.pendingDeliveryTokens.push(claimToken);
    return this.deliveryEvidence(claimToken);
  }

  deliveryEvidence(claimToken) {
    const token = String(claimToken || '').trim();
    const attempt = this.deliveryAttempts.get(token);
    if (!attempt) return {
      claimToken: token,
      trackingActive: this.connected,
      requestObserved: false,
      platformMid: '',
      platformLwp: '',
      platformAck: false,
      platformCode: null,
      platformRejected: false
    };
    return {
      claimToken: attempt.claimToken,
      conversationId: attempt.conversationId,
      trackingActive: this.connected,
      startedAt: attempt.startedAt,
      requestObserved: attempt.requestObserved,
      requestObservedAt: attempt.requestObservedAt,
      platformMid: attempt.platformMid,
      platformLwp: attempt.platformLwp,
      platformAck: attempt.platformAck,
      platformAckAt: attempt.platformAckAt,
      platformCode: attempt.platformCode,
      platformRejected: attempt.platformRejected
    };
  }

  finishDeliveryAttempt(claimToken) {
    const token = String(claimToken || '').trim();
    const evidence = this.deliveryEvidence(token);
    this.deliveryAttempts.delete(token);
    this.pendingDeliveryTokens = this.pendingDeliveryTokens.filter(entry => entry !== token);
    return evidence;
  }

  observeDeliveryFrame(direction, payloadData, at) {
    const envelope = xianyuSocketEnvelope(payloadData);
    if (!envelope?.mid) return null;
    if (direction === 'sent') {
      if (envelope.lwp !== '/r/MessageSend/sendByReceiverScope') return null;
      const textHash = extractXianyuSentTextHash(payloadData);
      const eligibleTokens = this.pendingDeliveryTokens.filter(candidate => {
        const attempt = this.deliveryAttempts.get(candidate);
        return attempt && !attempt.requestObserved && at - attempt.startedAt <= 30000;
      });
      let token = eligibleTokens.find(candidate => {
        const attempt = this.deliveryAttempts.get(candidate);
        return !attempt.textHash || (textHash && attempt.textHash === textHash);
      });
      // Some Goofish MessageSend variants do not expose the reply text in the
      // decodable custom payload. FastWork also serializes sends, so bind an
      // opaque request only when one and only one delivery transaction is in
      // flight. A parsed different-text request or multiple candidates still
      // fails closed to avoid confirming a manual/wrong-conversation send.
      if (!token && !textHash && eligibleTokens.length === 1) token = eligibleTokens[0];
      if (!token) return null;
      const attempt = this.deliveryAttempts.get(token);
      attempt.requestObserved = true;
      attempt.requestObservedAt = at;
      attempt.platformMid = envelope.mid;
      attempt.platformLwp = envelope.lwp;
      this.pendingDeliveryTokens = this.pendingDeliveryTokens.filter(entry => entry !== token);
      return { claimToken: token, kind: 'delivery-request', mid: envelope.mid, lwp: envelope.lwp };
    }
    const attempt = [...this.deliveryAttempts.values()].find(candidate => candidate.platformMid === envelope.mid);
    if (!attempt) return null;
    if (envelope.code !== null) attempt.platformCode = envelope.code;
    if (envelope.rejected) attempt.platformRejected = true;
    if (envelope.code === 200 && !envelope.rejected) {
      attempt.platformAck = true;
      attempt.platformAckAt = at;
      attempt.platformRejected = false;
    }
    return {
      claimToken: attempt.claimToken,
      kind: attempt.platformAck ? 'delivery-ack' : 'delivery-response',
      mid: envelope.mid,
      code: envelope.code,
      rejected: envelope.rejected
    };
  }

  observe(method, params = {}, now = Date.now()) {
    const at = Number(now) || Date.now();
    const requestId = String(params.requestId || '');
    if (method === 'Network.webSocketCreated') {
      const url = String(params.url || '');
      if (!requestId || !isXianyuSocketUrl(url)) return { target: false, kind: 'ignore' };
      this.sockets.set(requestId, { url, openedAt: at, lastFrameAt: 0 });
      this.lastOpenedAt = at;
      this.disconnectedAt = 0;
      return { target: true, kind: 'open', requestId, url };
    }

    const socket = this.sockets.get(requestId);
    if (!socket) return { target: false, kind: 'ignore' };
    if (method === 'Network.webSocketFrameReceived') {
      socket.lastFrameAt = at;
      this.lastFrameAt = at;
      const payloadData = String(params.response?.payloadData || '');
      const delivery = this.observeDeliveryFrame('received', payloadData, at);
      const inboundHints = extractXianyuInboundHints(payloadData);
      return {
        target: true,
        kind: 'frame',
        requestId,
        payloadData,
        connectionAgeMs: Math.max(0, at - Number(socket.openedAt || at)),
        delivery,
        inboundHints,
        ...classifyXianyuSocketPayload(payloadData)
      };
    }
    if (method === 'Network.webSocketFrameSent') {
      const payloadData = String(params.response?.payloadData || '');
      const delivery = this.observeDeliveryFrame('sent', payloadData, at);
      return { target: true, kind: 'sent-frame', requestId, delivery };
    }
    if (method === 'Network.webSocketClosed' || method === 'Network.webSocketFrameError') {
      this.sockets.delete(requestId);
      this.lastClosedAt = at;
      if (!this.connected) this.disconnectedAt = at;
      return { target: true, kind: method.endsWith('Error') ? 'error' : 'close', requestId };
    }
    return { target: true, kind: 'ignore', requestId };
  }

  reset() {
    this.sockets.clear();
    this.deliveryAttempts.clear();
    this.pendingDeliveryTokens = [];
    this.lastOpenedAt = 0;
    this.lastFrameAt = 0;
    this.lastClosedAt = 0;
    this.disconnectedAt = 0;
  }

  snapshot() {
    return {
      connected: this.connected,
      connectionCount: this.sockets.size,
      lastOpenedAt: this.lastOpenedAt,
      lastFrameAt: this.lastFrameAt,
      lastClosedAt: this.lastClosedAt,
      disconnectedAt: this.disconnectedAt,
      activeDeliveryAttempts: this.deliveryAttempts.size
    };
  }
}

module.exports = { BridgeRecoveryPolicy, XianyuSocketTracker, classifyXianyuSocketPayload, extractXianyuInboundHints, hashXianyuDeliveryText, isXianyuSocketUrl, xianyuSocketEnvelope };
