// Keep burst coalescing deterministic and independently testable. The caller
// owns persistence because these records are part of the bridge's local state.
export function coalescePendingXianyuMessages(messages, now = Date.now()) {
  if (!Array.isArray(messages)) return [];
  const pendingByConversation = new Map();
  for (const message of messages) {
    if (!message || message.direction !== 'in' || message.status !== 'received') continue;
    const conversationId = String(message.conversationId || 'default');
    const pending = pendingByConversation.get(conversationId) || [];
    pending.push(message);
    pendingByConversation.set(conversationId, pending);
  }

  const latest = [];
  for (const pending of pendingByConversation.values()) {
    pending.sort((left, right) => Number(left.createdAtMs || 0) - Number(right.createdAtMs || 0));
    const newest = pending.at(-1);
    latest.push(newest);
    for (const message of pending.slice(0, -1)) {
      Object.assign(message, {
        status: 'superseded',
        handled: true,
        supersededBy: newest.id,
        supersededAt: new Date(now).toISOString(),
        updatedAtMs: now,
        updatedAt: new Date(now).toISOString()
      });
    }
  }
  return latest.sort((left, right) => Number(left.createdAtMs || 0) - Number(right.createdAtMs || 0));
}

export function supersedeQueuedAutoReplies(sent, messages, conversationId, supersededBy, now = Date.now()) {
  if (!Array.isArray(sent) || !Array.isArray(messages)) return [];
  const superseded = [];
  for (const reply of sent) {
    if (reply?.direction !== 'out' || reply.conversationId !== conversationId || reply.delivery !== 'queued' || reply.origin !== 'auto') continue;
    Object.assign(reply, {
      delivery: 'superseded',
      supersededBy,
      supersededAt: new Date(now).toISOString(),
      updatedAtMs: now,
      updatedAt: new Date(now).toISOString()
    });
    const source = messages.find(message => message?.id === reply.sourceMessageId && message.direction === 'in');
    if (source?.status === 'auto_queued') {
      Object.assign(source, {
        status: 'superseded',
        handled: true,
        supersededBy,
        supersededAt: new Date(now).toISOString(),
        updatedAtMs: now,
        updatedAt: new Date(now).toISOString()
      });
    }
    superseded.push(reply);
  }
  return superseded;
}

export function expireStaleXianyuRuntimeWork(messages, sent, now = Date.now()) {
  if (!Array.isArray(messages) || !Array.isArray(sent)) return 0;
  let changed = 0;
  const expiredReplyIds = new Set();
  for (const reply of sent) {
    if (reply?.direction !== 'out' || reply.delivery !== 'queued') continue;
    Object.assign(reply, {
      delivery: 'superseded',
      releaseReason: 'previous-runtime-expired',
      supersededAt: new Date(now).toISOString(),
      updatedAtMs: now,
      updatedAt: new Date(now).toISOString()
    });
    expiredReplyIds.add(reply.id);
    changed += 1;
  }
  for (const message of messages) {
    if (message?.direction !== 'in') continue;
    const unfinishedInbound = ['received', 'processing'].includes(message.status);
    const expiredSource = message.replyId && expiredReplyIds.has(message.replyId);
    if (!unfinishedInbound && !expiredSource) continue;
    Object.assign(message, {
      status: 'superseded',
      handled: true,
      error: null,
      retryAt: null,
      supersededBy: 'runtime-restart',
      supersededAt: new Date(now).toISOString(),
      updatedAtMs: now,
      updatedAt: new Date(now).toISOString()
    });
    changed += 1;
  }
  return changed;
}

// `##` is the current two-message separator; `###` remains compatible with
// older prompts. Only the first marker splits so one reply cannot create an
// unbounded send burst.
export function splitXianyuReplyForDelivery(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return [];
  const marker = normalized.match(/#{2,3}/)?.[0];
  if (!marker) return [normalized];
  const splitAt = normalized.indexOf(marker);
  const cleanRemainingMarkers = value => value.replace(/#{2,3}/g, '\n').trim();
  const parts = [
    normalized.slice(0, splitAt).trim(),
    cleanRemainingMarkers(normalized.slice(splitAt + marker.length))
  ].filter(Boolean);
  return parts.length === 2 ? parts : [cleanRemainingMarkers(normalized)];
}
