import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { nextWorkflowNode, renderWorkflowTemplate, selectPlatformWorkflow, createDefaultWorkflowState } from './workflow-engine.js';
import { splitXianyuReplyForDelivery } from './xianyu-message-queue.js';
import { sanitizeCustomerReply } from './customer-reply.js';
import { automatedReplyMode } from './self-learning.js';

const freshSessionMs = 45000;
const greetingPattern = /^(你好|您好|在吗|嗨|hi|hello|有人吗)[\s!！?？。.,，]*$/i;
const feigeReplyGuidance = '请只回答当前客户最新一条消息。优先给出可核实的答复；车型适配、制动、售后订单、价格库存或时效缺少可靠资料时，先请客户提供必要信息或查看商品/订单页面，不要编造结论或承诺，也不要只说转人工。';

export class FeigeRuntime {
  constructor({ path, answer, workflow, risk, startRun, updateRun, finishRun,
    autoSendDelayMs = 5000, useFixedGreeting = () => true, formatReply = text => text, matchRule = () => null }) {
    this.path = path;
    this.answer = answer;
    this.workflow = workflow;
    this.risk = risk;
    this.startRun = startRun;
    this.updateRun = updateRun;
    this.finishRun = finishRun;
    this.autoSendDelayMs = autoSendDelayMs;
    this.useFixedGreeting = useFixedGreeting;
    this.formatReply = formatReply;
    this.matchRule = matchRule;
    this.state = { listening: true, replyMode: 'full_auto', sessions: {}, messages: [], sent: [] };
    this.timers = new Map();
    this.tails = new Map();
    this.nextSessionOrder = 0;
    this.saveTail = Promise.resolve();
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      this.state = { ...this.state, ...saved, sessions: {} };
      let changed = false;
      for (const item of this.state.sent) {
        if (item.delivery === 'sending' || item.delivery === 'verifying') item.delivery = 'verifying';
        if (item.delivery === 'queued' && !Number.isFinite(item.sendAfterMs)) {
          item.sendAfterMs = Date.now() + this.autoSendDelayMs;
          changed = true;
        }
      }
      for (const item of this.state.messages) {
        if (item.direction === 'in' && item.status === 'processing') item.status = 'received';
      }
      if (this.reconcileStaleReplies() || changed) await this.save();
    } catch { /* First launch has no Feige history. */ }
  }

  reconcileStaleReplies() {
    let changed = false;
    for (const conversationId of new Set(this.state.sent.map(item => item.conversationId))) {
      const latest = [...this.state.messages].reverse().find(message => message.direction === 'in' && message.conversationId === conversationId);
      if (!latest) continue;
      for (const reply of this.state.sent) {
        if (reply.conversationId !== conversationId || reply.sourceMessageId === latest.id || !['sending', 'verifying'].includes(reply.delivery)) continue;
        const evidence = reply.evidence || {};
        if (evidence.platformAck === true || evidence.platformMessageId || evidence.domBubble === true) continue;
        reply.delivery = 'superseded';
        reply.supersededBy = latest.id;
        reply.updatedAtMs = Date.now();
        changed = true;
      }
    }
    return changed;
  }

  save() {
    const snapshot = JSON.stringify({ ...this.state, sessions: {} }, null, 2);
    this.saveTail = this.saveTail.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, snapshot, 'utf8');
    });
    return this.saveTail;
  }

  session(id) {
    const session = this.state.sessions[String(id || '')];
    return session?.authenticated && Date.now() - session.lastSeenMs < freshSessionMs ? session : null;
  }

  status() {
    const sessions = Object.values(this.state.sessions).filter(item => Date.now() - item.lastSeenMs < freshSessionMs);
    const connected = sessions.some(item => item.authenticated);
    const activeConversationId = sessions.filter(item => item.authenticated && item.conversationId)
      .sort((left, right) => right.lastSeenMs - left.lastSeenMs)[0]?.conversationId || null;
    const latestInbound = [...this.state.messages].reverse().find(item => item.direction === 'in');
    return { connected, listening: connected && this.state.listening, routeReady: sessions.some(item => item.authenticated && item.routeReady), replyMode: this.state.replyMode,
      activeConversationId,
      lastInboundAt: Number(latestInbound?.createdAtMs || 0),
      lastInboundConversationId: latestInbound?.conversationId || null,
      sessions: sessions.map(({ id, authenticated, routeReady, conversationId, lastSeenMs }) => ({ id, authenticated, routeReady, conversationId, lastSeenMs })),
      pending: this.state.messages.filter(item => item.direction === 'in' && ['received', 'processing'].includes(item.status)).length,
      needsHuman: this.state.messages.filter(item => item.direction === 'in' && item.status === 'needs_human').length,
      queuedReplies: this.state.sent.filter(item => item.delivery === 'queued').length,
      verifyingReplies: this.state.sent.filter(item => item.delivery === 'verifying').length };
  }

  heartbeat({ sessionId, authenticated, pageUrl, routeReady, conversationId }) {
    if (!/^fg-[a-z0-9-]{8,100}$/i.test(String(sessionId || ''))) throw new Error('Invalid Feige session');
    if (!String(pageUrl || '').startsWith('https://im.jinritemai.com/')) throw new Error('Invalid Feige page');
    const now = Date.now();
    const previous = this.state.sessions[sessionId];
    this.state.sessions[sessionId] = { id: sessionId, authenticated: authenticated === true, routeReady: routeReady === true,
      conversationId: String(conversationId || '').trim().slice(0, 240) || null,
      order: previous?.order || ++this.nextSessionOrder, lastSeenMs: now };
    if (authenticated && this.state.listening) {
      for (const item of this.state.messages.filter(entry => entry.direction === 'in' && entry.status === 'received')) {
        if (!this.timers.has(item.conversationId) && !this.tails.has(item.conversationId)) this.schedule(item.conversationId, 0);
      }
    }
    return this.status();
  }

  async receive({ sessionId, conversationId, externalId, text, sender }) {
    if (!this.session(sessionId)) throw new Error('Feige bridge is not authenticated');
    const conversation = String(conversationId || '').trim().slice(0, 240);
    const external = String(externalId || '').trim().slice(0, 240);
    const body = String(text || '').trim().slice(0, 12000);
    if (!conversation || !external || !body) throw new Error('Feige message requires conversation ID, platform message ID and text');
    const duplicate = this.state.messages.find(item => item.direction === 'in' && item.conversationId === conversation && item.externalId === external);
    if (duplicate) return { ...duplicate, duplicate: true };
    const now = Date.now();
    const message = { id: `fg-in-${now}-${Math.random().toString(36).slice(2, 8)}`, conversationId: conversation,
      externalId: external, sessionId, sender: String(sender || '飞鸽客户').slice(0, 80), text: body,
      direction: 'in', status: automatedReplyMode(this.state.replyMode) ? 'received' : 'handled', createdAtMs: now, updatedAtMs: now };
    this.state.messages.push(message);
    for (const older of this.state.messages) {
      if (older !== message && older.direction === 'in' && older.conversationId === conversation &&
          ['received', 'needs_human'].includes(older.status)) {
        older.status = 'superseded';
        older.updatedAtMs = now;
      }
    }
    for (const reply of this.state.sent) {
      if (reply.conversationId !== conversation || !['queued', 'sending', 'verifying'].includes(reply.delivery)) continue;
      const evidence = reply.evidence || {};
      if (evidence.platformAck === true || evidence.platformMessageId || evidence.domBubble === true) continue;
      // A reply that has no platform evidence and belongs to an older inbound
      // message can never be the correct next response. Close it so a newer
      // customer message cannot remain blocked behind stale verification.
      if (reply.delivery === 'queued' || reply.sourceMessageId !== message.id) {
        reply.delivery = 'superseded';
        reply.supersededBy = message.id;
        reply.updatedAtMs = now;
      }
    }
    await this.save();
    if (this.state.listening) this.schedule(conversation);
    return { ...message, duplicate: false };
  }

  latestInbound(conversationId) {
    return this.state.messages.findLast(item => item.direction === 'in' && item.conversationId === conversationId);
  }

  conversationHistory(message) {
    const inbound = this.state.messages.slice(0, this.state.messages.indexOf(message))
      .filter(item => item.conversationId === message.conversationId).slice(-8);
    return inbound.flatMap(item => {
      const delivered = this.state.sent.filter(reply => reply.sourceMessageId === item.id && reply.delivery === 'sent');
      const turns = [{ role: 'user', content: item.text }];
      if (delivered.length) turns.push({ role: 'assistant', content: delivered.map(reply => reply.text).join('\n') });
      return turns;
    }).slice(-8);
  }

  queueReply(message, parts, origin, delay = 0) {
    const now = Date.now();
    message.draft = parts.join('###');
    message.status = parts.length ? 'auto_queued' : 'needs_human';
    message.updatedAtMs = now;
    const replies = parts.map((part, index) => ({
      id: `fg-out-${now}-${Math.random().toString(36).slice(2, 8)}`,
      conversationId: message.conversationId, sourceMessageId: message.id, sourceExternalId: message.externalId,
      direction: 'out', text: part, origin, delivery: 'queued', sendAfterMs: now + delay,
      createdAtMs: now + index, updatedAtMs: now
    }));
    this.state.sent.push(...replies);
  }

  holdReply(message) {
    const replies = this.state.sent.filter(item => item.sourceMessageId === message.id &&
      ['queued', 'sending', 'verifying', 'sent'].includes(item.delivery));
    if (!replies.length || replies.some(item => item.delivery !== 'queued' || item.origin === 'operator')) return false;
    const now = Date.now();
    message.draft ||= replies.map(item => item.text).join('###');
    message.status = 'needs_human';
    message.updatedAtMs = now;
    for (const reply of replies) {
      reply.delivery = 'superseded';
      reply.updatedAtMs = now;
    }
    return true;
  }

  setReplyMode(mode) {
    if (this.state.replyMode === mode) return;
    this.state.replyMode = mode;
    if (!automatedReplyMode(mode)) {
      this.state.replyModeChangedAt = Date.now();
      for (const message of this.state.messages) {
        if (message.direction === 'in' && ['received', 'processing', 'needs_human', 'auto_queued'].includes(message.status)) {
          message.status = 'handled';
          message.updatedAtMs = Date.now();
        }
      }
      for (const reply of this.state.sent) {
        if (reply.delivery === 'queued') reply.delivery = 'superseded';
        if (['sending', 'verifying'].includes(reply.delivery)) reply.cancelledByMode = true;
      }
    }
    if (mode === 'human_collab') {
      for (const message of this.state.messages.filter(item => item.status === 'auto_queued')) {
        if (this.latestInbound(message.conversationId)?.id === message.id) this.holdReply(message);
      }
    }
  }

  reviewState(conversationId) {
    const message = this.latestInbound(conversationId);
    if (!message) return null;
    const replies = this.state.sent.filter(item => item.sourceMessageId === message.id && item.delivery !== 'superseded');
    const canHold = replies.length > 0 && replies.every(item => item.delivery === 'queued' && item.origin !== 'operator');
    const parts = replies.length
      ? replies.map(({ text, delivery }) => ({ text, delivery }))
      : splitXianyuReplyForDelivery(message.draft).filter(Boolean).map(text => ({ text, delivery: 'draft' }));
    return { messageId: message.id, draft: message.draft || (canHold ? replies.map(item => item.text).join('###') : ''),
      parts, status: message.status, canHold, sendAfterMs: canHold ? replies[0].sendAfterMs || 0 : 0,
      delivered: replies.length > 0 && replies.every(item => item.delivery === 'sent') };
  }

  async reviewReply({ conversationId, messageId, text, parts, action }) {
    if (!automatedReplyMode(this.state.replyMode)) return null;
    const status = this.status();
    const message = this.latestInbound(conversationId);
    if (!status.listening || status.activeConversationId !== conversationId || !message || message.id !== messageId) return null;
    if (action === 'hold') {
      if (!this.holdReply(message)) return null;
    } else {
      const inputParts = Array.isArray(parts)
        ? parts.map(part => typeof part === 'string' ? part.trim() : '')
        : [typeof text === 'string' ? text.trim().slice(0, 4000) : ''];
      const messages = inputParts.length === 1 ? splitXianyuReplyForDelivery(inputParts[0]) : inputParts;
      if (!messages.length || messages.length > 2 || messages.some(part => !part || part.length > 4000)
          || !['needs_human', 'error', 'handled'].includes(message.status)) return null;
      const delayed = this.state.replyMode === 'full_auto';
      this.queueReply(message, messages, delayed ? 'auto' : 'operator', delayed ? this.autoSendDelayMs : 0);
    }
    await this.save();
    return message;
  }

  schedule(conversationId, delay = 450) {
    clearTimeout(this.timers.get(conversationId));
    const timer = setTimeout(() => {
      this.timers.delete(conversationId);
      const previous = this.tails.get(conversationId) || Promise.resolve();
      const next = previous.catch(() => {}).then(() => this.process(conversationId))
        .catch(error => console.error('Feige workflow failed:', error))
        .finally(() => { if (this.tails.get(conversationId) === next) this.tails.delete(conversationId); });
      this.tails.set(conversationId, next);
    }, delay);
    timer.unref?.();
    this.timers.set(conversationId, timer);
  }

  async process(conversationId) {
    if (!this.state.listening || !automatedReplyMode(this.state.replyMode)) return null;
    const modeChangedAt = this.state.replyModeChangedAt;
    const message = [...this.state.messages].reverse().find(item => item.direction === 'in' && item.conversationId === conversationId && item.status === 'received');
    if (!message) return null;
    message.status = 'processing';
    message.updatedAtMs = Date.now();
    await this.save();
    if (modeChangedAt !== this.state.replyModeChangedAt) return null;
    const rule = this.matchRule(message.text);
    if (rule && this.latestInbound(conversationId)?.id === message.id) {
      message.matchedRule = rule.name;
      message.draft = rule.answer;
      if (rule.action === 'reply' && this.state.replyMode === 'full_auto') {
        this.queueReply(message, splitXianyuReplyForDelivery(rule.answer).filter(Boolean), 'auto', this.autoSendDelayMs);
      } else {
        message.status = 'needs_human';
      }
      message.updatedAtMs = Date.now();
      await this.save();
      return message;
    }
    const flow = selectPlatformWorkflow(this.workflow(), 'douyin') || selectPlatformWorkflow(createDefaultWorkflowState(), 'douyin');
    const run = this.startRun(flow, message, 'douyin');
    const greeting = this.useFixedGreeting() && greetingPattern.test(message.text) ? '您好，请问想了解哪款商品？' : '';
    const context = { message, output: message.text, draft: greeting,
      result: greeting ? { answer: greeting, sources: [] } : null,
      risk: greeting ? { level: 'low', label: '固定问候', reason: '不涉及商品事实或交易承诺。' } : null,
      variables: {}, intent: null, replyMode: this.state.replyMode };
    let node = flow.nodes.find(item => item.type === 'trigger');
    try {
      for (let steps = 0; node && steps < 100; steps += 1) {
        if (modeChangedAt !== this.state.replyModeChangedAt) {
          this.finishRun(run, 'superseded');
          return null;
        }
        this.updateRun(run, node, 'running');
        if (['rag', 'knowledge', 'llm', 'custom', 'condition'].includes(node.type) && !context.result) {
          const instruction = String(node.config?.prompt || node.config?.system || '').trim();
          context.result = await this.answer({ question: message.text, platform: 'douyin', history: this.conversationHistory(message),
            promptAddendum: [feigeReplyGuidance, instruction ? `当前工作流节点指令：${instruction}` : ''].filter(Boolean).join('\n') });
          context.result.answer = sanitizeCustomerReply(context.result.answer);
          context.draft = String(context.result.answer || '').trim();
          context.output = context.draft;
          context.risk = this.risk(message.text, context.result);
        } else if (node.type === 'classifier') {
          const text = message.text;
          context.intent = /(退款|退货|保修|换货|改地址|订单)/.test(text) ? '订单售后'
            : /(适配|能装|车型|孔距|刹车|制动|减震)/.test(text) ? '车型适配'
              : /(价格|库存|商品|规格|优惠|发货|物流)/.test(text) ? '商品咨询' : '其他';
        } else if (node.type === 'template') {
          context.output = renderWorkflowTemplate(node.config?.template, context);
        } else if (node.type === 'variable') {
          const name = String(node.config?.name || '').trim();
          if (name) context.variables[name] = renderWorkflowTemplate(node.config?.value, context);
        } else if (node.type === 'extract') {
          for (const field of String(node.config?.fields || '').split(/\r?\n|[,，、]/).map(item => item.trim()).filter(Boolean)) {
            context.variables[field] = /年份/.test(field) ? message.text.match(/20\d{2}/)?.[0] || '' : '';
          }
        } else if (node.type === 'delay') {
          const multiplier = node.config?.unit === '分钟' ? 60000 : node.config?.unit === '小时' ? 3600000 : 1000;
          await new Promise(resolve => setTimeout(resolve, Math.min(30000, Math.max(0, Number(node.config?.duration || 0) * multiplier))));
        } else if (node.type === 'reply') {
          if (!context.result) context.result = await this.answer({ question: message.text, platform: 'douyin', history: this.conversationHistory(message), promptAddendum: feigeReplyGuidance });
          context.result.answer = sanitizeCustomerReply(context.result.answer);
          if (modeChangedAt !== this.state.replyModeChangedAt) { this.finishRun(run, 'superseded'); return null; }
          const newer = this.state.messages.slice(this.state.messages.indexOf(message) + 1)
            .find(item => item.direction === 'in' && item.conversationId === conversationId);
          if (newer) { message.status = 'superseded'; this.finishRun(run, 'superseded'); await this.save(); this.schedule(conversationId, 0); return message; }
          const answer = context.draft || context.result.answer;
          const appendix = renderWorkflowTemplate(node.config?.template, context).trim();
          const draft = appendix ? this.formatReply([answer, appendix].filter(Boolean).join('\n')) : answer.trim();
          const risk = context.risk || this.risk(message.text, context.result);
          if (draft && this.state.replyMode === 'full_auto') {
            this.queueReply(message, splitXianyuReplyForDelivery(draft).filter(Boolean), 'auto', this.autoSendDelayMs);
          } else { message.status = 'needs_human'; message.draft = draft; }
          message.risk = risk;
          message.updatedAtMs = Date.now();
          this.updateRun(run, node, 'completed'); this.finishRun(run); await this.save();
          return message;
        } else if (node.type === 'handoff' || node.type === 'stop') {
          if (node.type === 'handoff') {
            if (!context.result) context.result = await this.answer({ question: message.text, platform: 'douyin', history: this.conversationHistory(message), promptAddendum: feigeReplyGuidance });
            context.result.answer = sanitizeCustomerReply(context.result.answer);
            const draft = sanitizeCustomerReply(context.draft || context.result.answer);
            if (modeChangedAt !== this.state.replyModeChangedAt) { this.finishRun(run, 'superseded'); return null; }
            const newer = this.state.messages.slice(this.state.messages.indexOf(message) + 1)
              .find(item => item.direction === 'in' && item.conversationId === conversationId);
            if (newer) { message.status = 'superseded'; this.finishRun(run, 'superseded'); await this.save(); this.schedule(conversationId, 0); return message; }
            if (this.state.replyMode === 'full_auto') this.queueReply(message, splitXianyuReplyForDelivery(draft).filter(Boolean), 'auto', this.autoSendDelayMs);
            else { message.status = 'needs_human'; message.draft = draft; message.updatedAtMs = Date.now(); }
            message.risk = context.risk || this.risk(message.text, context.result);
          } else {
            message.status = node.type === 'handoff' ? 'needs_human' : 'handled';
            message.draft = context.draft;
          }
          this.updateRun(run, node, 'completed'); this.finishRun(run); await this.save();
          return message;
        }
        this.updateRun(run, node, 'completed');
        node = nextWorkflowNode(flow, node, context);
      }
      throw new Error('飞鸽工作流未到达结束节点');
    } catch (error) {
      if (modeChangedAt !== this.state.replyModeChangedAt) { this.finishRun(run, 'superseded'); return null; }
      message.status = 'error'; message.error = error.message;
      this.updateRun(run, node, 'error', error.message); this.finishRun(run, 'error', error.message);
      await this.save();
      return message;
    }
  }

  outbox(sessionId) {
    if (!this.session(sessionId) || !this.state.listening) return [];
    if (this.reconcileStaleReplies()) this.save();
    const now = Date.now();
    return this.state.sent.filter(item => ['queued', 'verifying'].includes(item.delivery) && (item.delivery !== 'queued' ||
      (automatedReplyMode(this.state.replyMode) && (this.state.replyMode === 'full_auto' || item.origin === 'operator') &&
        (!item.sendAfterMs || item.sendAfterMs <= now))) &&
      !this.state.sent.some(previous => previous.conversationId === item.conversationId && previous.createdAtMs < item.createdAtMs && ['queued', 'sending', 'verifying'].includes(previous.delivery)));
  }

  dispatchReady({ sessionId, conversationId, id, claimToken }) {
    if (!this.session(sessionId) || !this.state.listening || !automatedReplyMode(this.state.replyMode)) return false;
    const item = this.state.sent.find(reply => reply.id === id);
    const latest = [...this.state.messages].reverse().find(message => message.direction === 'in' && message.conversationId === conversationId);
    return Boolean(item && item.conversationId === conversationId && item.claimedBy === sessionId &&
      item.claimToken === claimToken && item.delivery === 'verifying' && !item.cancelledByMode &&
      (this.state.replyMode === 'full_auto' || item.origin === 'operator') && latest?.id === item.sourceMessageId &&
      !this.state.sent.some(previous => previous !== item && previous.conversationId === conversationId &&
        previous.createdAtMs < item.createdAtMs && ['queued', 'sending', 'verifying'].includes(previous.delivery)));
  }

  async cancelBeforeDispatch({ sessionId, conversationId, id, claimToken }) {
    const item = this.state.sent.find(reply => reply.id === id);
    const latest = [...this.state.messages].reverse().find(message => message.direction === 'in' && message.conversationId === conversationId);
    if (!this.session(sessionId) || !item || item.conversationId !== conversationId || item.claimedBy !== sessionId ||
      item.claimToken !== claimToken || item.delivery !== 'verifying' || item.evidence?.platformAck === true ||
      item.evidence?.platformMessageId || item.evidence?.domBubble === true ||
      latest?.id === item.sourceMessageId) {
      throw new Error('Cannot cancel a Feige reply after platform dispatch');
    }
    item.delivery = 'superseded';
    item.updatedAtMs = Date.now();
    await this.save();
    return item;
  }

  async claim({ sessionId, conversationId, id }) {
    if (!this.session(sessionId)) throw new Error('Feige bridge is not authenticated');
    const item = this.outbox(sessionId).find(reply => reply.id === id && reply.conversationId === conversationId);
    const previousOwner = this.state.sessions[item?.claimedBy];
    const latest = [...this.state.messages].reverse().find(message => message.direction === 'in' && message.conversationId === conversationId);
    if (!item || (item.delivery === 'queued' && latest?.id !== item.sourceMessageId) ||
      (item.claimedBy && item.claimedBy !== sessionId && (item.delivery !== 'verifying' ||
      (previousOwner && previousOwner.order > this.state.sessions[sessionId].order)))) {
      throw new Error('Reply does not belong to this Feige conversation');
    }
    if (!item.claimToken || item.claimedBy !== sessionId) {
      item.claimToken = `fg-claim-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    }
    item.claimedBy = sessionId;
    item.delivery = item.delivery === 'verifying' ? 'verifying' : 'sending';
    item.updatedAtMs = Date.now();
    await this.save();
    return item;
  }

  async verify({ sessionId, conversationId, id, claimToken, evidence = {} }) {
    const item = this.state.sent.find(reply => reply.id === id);
    if (!this.session(sessionId) || !item || item.conversationId !== conversationId || item.claimedBy !== sessionId ||
      item.claimToken !== claimToken || !['sending', 'verifying'].includes(item.delivery)) throw new Error('Feige delivery claim mismatch');
    item.delivery = 'verifying';
    item.evidence = { ...item.evidence, ...evidence };
    item.updatedAtMs = Date.now();
    await this.save();
    return item;
  }

  async release({ sessionId, conversationId, id, claimToken, beforeClick = false }) {
    const item = this.state.sent.find(reply => reply.id === id);
    const evidence = item?.evidence;
    const prepared = beforeClick === true && item?.delivery === 'verifying' &&
      !evidence?.platformAck && !evidence?.platformMessageId && !evidence?.domBubble && !evidence?.verificationRefreshAt;
    if (!this.session(sessionId) || !item || item.conversationId !== conversationId || item.claimedBy !== sessionId ||
      item.claimToken !== claimToken) throw new Error('Feige delivery claim mismatch');
    if (item.delivery === 'superseded') return item;
    if (!(item.delivery === 'sending' && !evidence) && !prepared) throw new Error('Cannot retry a Feige reply after a possible platform send');
    const latest = this.latestInbound(conversationId);
    item.delivery = item.cancelledByMode || latest?.id !== item.sourceMessageId ? 'superseded' : 'queued';
    item.claimedBy = null;
    item.claimToken = null;
    delete item.evidence;
    item.updatedAtMs = Date.now();
    if (item.delivery === 'queued' && this.state.replyMode === 'human_collab' && item.origin !== 'operator' && !this.holdReply(latest)) {
      item.delivery = 'superseded';
    }
    await this.save();
    return item;
  }

  async acknowledge(input) {
    const item = await this.verify(input);
    const evidence = item.evidence || {};
    if (!(evidence.platformAck === true && evidence.platformMessageId && evidence.platformConversationId === item.conversationId &&
      evidence.domBubble === true && evidence.domConversationId === item.conversationId && evidence.newBubbleId)) {
      throw new Error('Feige platform receipt and new outgoing bubble are both required');
    }
    item.delivery = 'sent';
    item.deliveredAt = new Date().toISOString();
    item.updatedAtMs = Date.now();
    await this.save();
    return item;
  }

  messages(since = 0, conversationId = '') {
    const target = String(conversationId || '').trim();
    const belongs = item => (!target || item.conversationId === target) && item.updatedAtMs > since;
    return this.state.messages.filter(belongs).concat(this.state.sent.filter(belongs));
  }

  async clearHistory() {
    const unfinishedDeliveries = new Set(['queued', 'sending', 'verifying']);
    const sent = this.state.sent.filter(item => unfinishedDeliveries.has(item.delivery));
    const protectedSources = new Set(sent.map(item => item.sourceMessageId).filter(Boolean));
    const messages = this.state.messages.filter(item => protectedSources.has(item.id) ||
      (item.direction === 'in' && ['received', 'processing'].includes(item.status)));
    const removed = { messages: this.state.messages.length - messages.length, sent: this.state.sent.length - sent.length };
    this.state.messages = messages;
    this.state.sent = sent;
    await this.save();
    return { cleared: true, removed, messages: messages.length, sent: sent.length };
  }
}
