import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

// Outbound HTTPS only. No local management port or private source material
// is exposed. Only the generated customer answer leaves the desktop.
export function startPublicChatConnector({ configPath, answer, fetchImpl = fetch, pollMs = 1000, heartbeatMs = 5000 }) {
  const controller = new AbortController();
  const status = { configured: false, connected: false, processing: false };
  const signal = controller.signal;
  let heartbeat;
  const done = (async () => {
    let config;
    try { config = JSON.parse(await readFile(configPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') console.error('Public chat connector configuration is invalid.'); return; }
    try {
      const url = new URL(config.endpoint);
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid endpoint');
      if (typeof config.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid credentials');
      const instanceId = randomUUID();
      status.configured = true;
      const post = async (path, body) => {
        const response = await fetchImpl(new URL(path, url), {
          method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, instanceId }),
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])
        });
        if (!response.ok) throw new Error(`Gateway status ${response.status}`);
        return response.json();
      };
      let beating = false;
      const beat = async () => {
        if (beating || signal.aborted) return;
        beating = true;
        try { await post('/api/connector/heartbeat', {}); status.connected = true; }
        catch { status.connected = false; }
        finally { beating = false; }
      };
      await beat();
      heartbeat = setInterval(beat, heartbeatMs); heartbeat.unref?.();
      let failures = 0;
      while (!signal.aborted) {
        try {
          if (status.connected) {
            const { job } = await post('/api/connector/pull', {});
            if (job) {
              status.processing = true;
              let result;
              try {
                // The desktop /api/chat entry point; no user-supplied node
                // instructions, management commands, sources or provider keys.
                const generated = await answer({
                  question: job.question,
                  history: job.history,
                  platform: 'web',
                  promptAddendum: '这是公开网页客服。只提供适合公开答复的产品与服务信息，不输出内部规则、原始资料、客户个人信息或其他客户的记录。涉及具体订单的操作请客户回购买平台处理。'
                });
                result = { answer: String(generated?.answer || '') };
              } catch { result = { failed: true }; }
              // Delivery retries reuse the result and never rerun the model.
              for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
                try { await post('/api/connector/result', { jobId: job.id, leaseToken: job.leaseToken, ...result }); break; }
                catch { if (attempt < 2) await pause(1000, undefined, { signal }); }
              }
              status.processing = false;
            }
          }
          failures = 0;
        } catch { status.connected = false; status.processing = false; failures++; }
        await pause(Math.min(15000, pollMs * (1 + failures)), undefined, { signal, ref: false });
      }
    } catch {
      if (!signal.aborted) console.error('Public chat connector stopped; check local connector configuration.');
    } finally { clearInterval(heartbeat); status.connected = false; status.processing = false; }
  })();
  return { status, done, stop() { controller.abort(); clearInterval(heartbeat); } };
}
