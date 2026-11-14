import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createPublicChatReview({ connector, isLocalRequest, readJson, saveAnswer, sendJson }) {
  let reviewTail = Promise.resolve();

  return async (request, response) => {
    // Cross-origin requests cannot supply this header without a CORS preflight.
    const host = request.headers.host || '';
    const origin = request.headers.origin;
    if (!isLocalRequest(request) || !/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) ||
        (origin && origin !== `http://${host}`) || request.headers['x-oe-desk'] !== 'review') {
      sendJson(response, 403, { error: '请从本地 OE DESK 工作台审核。' });
      return;
    }
    try {
      if (request.method === 'GET') {
        sendJson(response, 200, await connector().training('list'));
        return;
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: '不支持此操作。' });
        return;
      }
      const { id, action, answer } = (await readJson(request)) || {};
      const reviewedAnswer = typeof answer === 'string' ? answer.trim().slice(0, 2000) : '';
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) ||
          !['approve', 'dismiss'].includes(action) || (action === 'approve' && !reviewedAnswer)) {
        sendJson(response, 400, { error: '审核内容无效。' });
        return;
      }
      const review = reviewTail.then(async () => {
        const activeConnector = connector();
        const { suggestion } = await activeConnector.training('get', { id });
        if (!suggestion) return { missing: true };
        if (action === 'approve') await saveAnswer({ ...suggestion, answer: reviewedAnswer }, request);
        await activeConnector.training('remove', { id });
        return { state: action === 'approve' ? 'approved' : 'dismissed' };
      });
      reviewTail = review.catch(() => {});
      const result = await review;
      sendJson(response, result.missing ? 404 : 200, result.missing ? { error: '这条建议已处理或已过期，请刷新。' } : result);
    } catch {
      sendJson(response, 503, { error: '暂时无法完成审核。请确认本地连接正常后重试。' });
    }
  };
}

// Workbench versions predating the training Q&A store read imported Markdown.
export async function savePublicChatReviewMarkdown({ root, suggestion, reload }) {
  const directory = join(root, 'knowledge-base', 'imported', 'knowledge');
  await mkdir(directory, { recursive: true });
  const title = `网页训练问答-${suggestion.id.slice(0, 12)}.md`;
  const document = `---\nsource: imported\nscope: knowledge\noriginal_file: ${title}\n---\n# 网页训练问答\n\n客户问法：${suggestion.question}\n\n客服回复：${suggestion.answer}\n`;
  await writeFile(join(directory, title), document, 'utf8');
  await reload();
}
