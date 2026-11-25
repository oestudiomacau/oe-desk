const test = require('node:test');
const assert = require('node:assert/strict');

test('customer replies remove internal retrieval and reasoning language', async () => {
  const { sanitizeCustomerReply } = await import('../server/customer-reply.js');
  const reply = sanitizeCustomerReply('<think>先查目录再判断</think>\n思考链路：匹配刹车品类\n已从知识库里搜寻到以下商品：\nS2+ 刹车盘，参考价 ¥953');
  assert.doesNotMatch(reply, /思考|知识库|检索|RAG|搜寻/);
  assert.match(reply, /S2\+ 刹车盘/);
  assert.match(reply, /¥953/);
});

test('customer replies turn no-match internals into a direct clarification', async () => {
  const { sanitizeCustomerReply } = await import('../server/customer-reply.js');
  const reply = sanitizeCustomerReply('当前检索到的资料不足以安全确认这个问题。请补充车型。');
  assert.equal(reply, '这个问题暂时无法确认。请补充车型。');
});
