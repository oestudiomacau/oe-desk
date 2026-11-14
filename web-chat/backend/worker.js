const allowedOrigins = new Set(['https://oestudiomacau.github.io', 'http://localhost:3000', 'http://127.0.0.1:3000']);
const freshnessMs = 30000;
const lifetimeMs = 180000;
const suggestionLifetimeMs = 30 * 86400000;

function json(value, status = 200, origin = '') {
  return Response.json(value, { status, headers: {
    'access-control-allow-origin': allowedOrigins.has(origin) ? origin : 'https://oestudiomacau.github.io',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Origin'
  } });
}

async function readInput(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 48000) { await reader.cancel(); throw new Error('Too large'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { reader.releaseLock(); }
}

async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function token() { return [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
async function authorized(request, secret) {
  if (!secret) return false;
  const a = await hash(request.headers.get('authorization') || '');
  const b = await hash(`Bearer ${secret}`);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
const clean = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, limit) : '';
const cleanAnswer = value => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 2000) : '';
function cleanHistory(value) {
  return (Array.isArray(value) ? value.slice(-24) : []).filter(item => ['user', 'assistant'].includes(item?.role))
    .map(item => ({ role: item.role, content: clean(item.content, 1200) })).filter(item => item.content);
}

async function connectorOnline(db, now) {
  return db.prepare('SELECT instance_id FROM chat_connector WHERE id = 1 AND last_seen > ?').bind(now - freshnessMs).first();
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const origin = request.headers.get('origin') || '';
    if (origin && !allowedOrigins.has(origin)) return json({ error: 'Origin not allowed' }, 403, origin);
    if (request.method === 'OPTIONS') return json(null, 200, origin);
    if (path === '/' && request.method === 'GET') return new Response('OE DESK local chat gateway');
    if (!env.DB || !/^[a-f0-9]{64}$/.test(env.LOCAL_CONNECTOR_TOKEN || '')) return json({ error: '本地客服连接尚未配置。' }, 503, origin);
    const db = env.DB; const now = Date.now();
    try {
      if (path === '/api/health' && request.method === 'GET') {
        return json({ status: 'ok', mode: 'local-oedesk', online: Boolean(await connectorOnline(db, now)) }, 200, origin);
      }
      if (request.method !== 'POST') return json({ error: 'Not found' }, 404, origin);
      const connectorRoute = path.startsWith('/api/connector/');
      if (connectorRoute && !await authorized(request, env.LOCAL_CONNECTOR_TOKEN)) return json({ error: 'Unauthorized' }, 401, origin);
      let input;
      try { input = await readInput(request); } catch { return json({ error: '消息格式无效或内容过长。' }, 400, origin); }

      if (path === '/api/training/suggestions') {
        const question = clean(input?.question, 600);
        const answer = cleanAnswer(input?.answer);
        if (!question || !answer) return json({ error: '请填写客户问题和建议答复。' }, 400, origin);
        const day = Math.floor(now / 86400000);
        const visitor = await hash(`${env.LOCAL_CONNECTOR_TOKEN}:${request.headers.get('cf-connecting-ip') || 'anonymous'}`);
        const rateKey = `training:${visitor}:${day}`;
        const id = await hash(JSON.stringify([rateKey, question, answer]));
        if (await db.prepare('SELECT id FROM training_suggestions WHERE id=?').bind(id).first()) return json({ state: 'pending' }, 202, origin);
        const [, , rate, inserted] = await db.batch([
          db.prepare('DELETE FROM training_suggestions WHERE created_at <= ?').bind(now - suggestionLifetimeMs),
          db.prepare('DELETE FROM chat_rate WHERE expires_at <= ?').bind(now),
          db.prepare(`INSERT INTO chat_rate (id, count, expires_at) VALUES (?, 1, ?)
            ON CONFLICT(id) DO UPDATE SET count=count+1 WHERE count < 12 RETURNING count`)
            .bind(rateKey, (day + 1) * 86400000),
          db.prepare(`INSERT INTO training_suggestions (id, question, answer, created_at)
            SELECT ?, ?, ?, ? WHERE changes() > 0 AND (SELECT COUNT(*) FROM training_suggestions) < 500
            ON CONFLICT(id) DO NOTHING RETURNING id`).bind(id, question, answer, now)
        ]);
        if (!rate.results.length) return json({ error: '今天提交的建议已达上限，请明天再试。' }, 429, origin);
        if (!inserted.results.length && !await db.prepare('SELECT id FROM training_suggestions WHERE id=?').bind(id).first()) {
          return json({ error: '待审核建议较多，请稍后再提交。' }, 429, origin);
        }
        return json({ state: 'pending' }, 202, origin);
      }

      if (connectorRoute) {
        if (path === '/api/connector/training/list') {
          const { results } = await db.prepare(`SELECT id, question, answer, created_at AS createdAt FROM training_suggestions
            WHERE created_at > ? ORDER BY created_at, id LIMIT 25`).bind(now - suggestionLifetimeMs).all();
          return json({ suggestions: results }, 200, origin);
        }
        if (path === '/api/connector/training/get' || path === '/api/connector/training/remove') {
          const id = input?.id;
          if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return json({ error: 'Invalid suggestion' }, 400, origin);
          if (path.endsWith('/remove')) {
            await db.prepare('DELETE FROM training_suggestions WHERE id=?').bind(id).run();
            return json({ removed: true }, 200, origin);
          }
          const suggestion = await db.prepare('SELECT id, question, answer FROM training_suggestions WHERE id=? AND created_at > ?')
            .bind(id, now - suggestionLifetimeMs).first();
          return json({ suggestion }, 200, origin);
        }
        const instance = clean(input?.instanceId, 100);
        if (!/^[a-zA-Z0-9-]{16,100}$/.test(instance)) return json({ error: 'Invalid instance' }, 400, origin);
        if (path === '/api/connector/heartbeat') {
          const row = await db.prepare(`INSERT INTO chat_connector (id, instance_id, last_seen) VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET instance_id=excluded.instance_id, last_seen=excluded.last_seen
            WHERE chat_connector.instance_id=excluded.instance_id OR chat_connector.last_seen <= ? RETURNING id`)
            .bind(instance, now, now - freshnessMs).first();
          return json(row ? { connected: true } : { error: 'Another local connector is active' }, row ? 200 : 409, origin);
        }
        const online = await connectorOnline(db, now);
        if (online?.instance_id !== instance) return json({ error: 'Connector lease expired' }, 409, origin);
        if (path === '/api/connector/pull') {
          const lease = token();
          const job = await db.prepare(`UPDATE chat_jobs SET state='processing', lease_token=?, instance_id=?, claimed_at=?
            WHERE id=(SELECT id FROM chat_jobs WHERE state='queued' AND expires_at > ? ORDER BY created_at LIMIT 1)
            AND state='queued' RETURNING id, payload, lease_token`)
            .bind(lease, instance, now, now).first();
          await db.batch([
            db.prepare('DELETE FROM chat_jobs WHERE expires_at < ?').bind(now),
            db.prepare('DELETE FROM chat_rate WHERE expires_at < ?').bind(now)
          ]);
          return json({ job: job ? { id: job.id, leaseToken: job.lease_token, ...JSON.parse(job.payload) } : null }, 200, origin);
        }
        if (path === '/api/connector/result') {
          const answer = typeof input.answer === 'string' ? input.answer.replace(/\u0000/g, '').trim().slice(0, 12000) : '';
          const failed = input.failed === true || !answer;
          const state = failed ? 'failed' : 'done';
          const row = await db.prepare(`UPDATE chat_jobs SET state=?, answer=?, payload='{}'
            WHERE id=? AND instance_id=? AND lease_token=? AND state IN ('processing', ?) AND expires_at > ? RETURNING id`)
            .bind(state, failed ? '' : answer, clean(input.jobId, 100), instance, clean(input.leaseToken, 100), state, now).first();
          return json(row ? { accepted: true } : { error: 'Job expired or not owned' }, row ? 200 : 409, origin);
        }
        return json({ error: 'Not found' }, 404, origin);
      }

      if (path === '/api/chat') {
        const question = clean(input?.question, 1200);
        if (!question) return json({ error: '请输入咨询内容。' }, 400, origin);
        if (!await connectorOnline(db, now)) return json({ error: '本地 OE DESK 暂未连接，请稍后再试。' }, 503, origin);
        const ip = await hash(`${env.LOCAL_CONNECTOR_TOKEN}:${request.headers.get('cf-connecting-ip') || 'anonymous'}`);
        const rates = await db.batch([
          db.prepare(`INSERT INTO chat_rate (id, count, expires_at) VALUES (?, 1, ?)
            ON CONFLICT(id) DO UPDATE SET count=count+1 WHERE count < 6 RETURNING count`)
            .bind(`${ip}:${Math.floor(now / 60000)}`, now + 120000),
          db.prepare(`INSERT INTO chat_rate (id, count, expires_at) VALUES (?, 1, ?)
            ON CONFLICT(id) DO UPDATE SET count=count+1 WHERE count < 120 RETURNING count`)
            .bind(`hour:${Math.floor(now / 3600000)}`, now + 7200000)
        ]);
        if (rates.some(result => !result.results.length)) return json({ error: '咨询较多，请稍等一分钟再试。' }, 429, origin);
        const id = crypto.randomUUID(); const receipt = token();
        const result = await db.prepare(`INSERT INTO chat_jobs (id, receipt_hash, state, payload, created_at, expires_at)
          SELECT ?, ?, 'queued', ?, ?, ? WHERE (SELECT COUNT(*) FROM chat_jobs WHERE state IN ('queued','processing') AND expires_at > ?) < 8 RETURNING id`)
          .bind(id, await hash(receipt), JSON.stringify({ question, history: cleanHistory(input.history) }), now, now + lifetimeMs, now).first();
        if (!result) return json({ error: '客服正在接待其他咨询，请稍后再试。' }, 429, origin);
        return json({ jobId: id, receiptToken: receipt, state: 'queued' }, 202, origin);
      }
      if (path === '/api/chat/result' || path === '/api/chat/cancel') {
        const job = await db.prepare('SELECT id, state, answer, expires_at FROM chat_jobs WHERE id=? AND receipt_hash=?')
          .bind(clean(input.jobId, 100), await hash(clean(input.receiptToken, 100))).first();
        if (!job) return json({ error: '对话请求不存在或已过期。' }, 404, origin);
        if (path.endsWith('/cancel')) {
          await db.prepare("UPDATE chat_jobs SET state='cancelled', payload='{}', answer='' WHERE id=?").bind(job.id).run();
          return json({ state: 'cancelled' }, 200, origin);
        }
        if (job.expires_at <= now) return json({ error: '回复超时，请重试。' }, 504, origin);
        if (job.state === 'done') return json({ answer: job.answer, state: 'done' }, 200, origin);
        if (job.state === 'failed') return json({ error: '本地客服生成失败，请稍后重试。' }, 502, origin);
        if (job.state === 'cancelled') return json({ error: '请求已停止。' }, 409, origin);
        if (!await connectorOnline(db, now)) return json({ error: '本地 OE DESK 已断开连接，请稍后重试。' }, 503, origin);
        return json({ state: job.state }, 202, origin);
      }
      return json({ error: 'Not found' }, 404, origin);
    } catch { return json({ error: '客服连接暂时不可用，请稍后重试。' }, 503, origin); }
  }
};
