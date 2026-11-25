const test = require('node:test');
const assert = require('node:assert/strict');

async function retrieval() {
  return import('../server/knowledge-retrieval.js');
}

const documents = [
  { id: 'fl', title: 'RCB S1-FL forged cylinder', text: 'S1-FL specifications' },
  { id: 's1', title: 'RCB S1 rear cylinder', text: 'S1 specifications' },
  { id: 'a3', title: 'RCB A3 reservoir', text: 'A3 specifications' }
];

test('model spelling variants find the exact product, not a neighboring model', async () => {
  const { prepareChunk, searchKnowledge } = await retrieval();
  const chunks = documents.map(prepareChunk);
  for (const question of ['s1fl你们有吗', 's1fl 怎么样', 'S1-FL 怎么样', 's1 fl 怎么样', 's1—fl 怎么样']) {
    assert.deepEqual(searchKnowledge(question, chunks, []).map(result => result.chunk.id), ['fl'], question);
  }
  assert.deepEqual(searchKnowledge('S1 怎么样', chunks, []).map(result => result.chunk.id), ['s1']);
  assert.deepEqual(searchKnowledge('s1f1 怎么样', chunks, []).map(result => result.chunk.id), []);
  assert.deepEqual(searchKnowledge('a30 有吗', chunks, []).map(result => result.chunk.id), []);
});

test('an embedding hit for another model cannot override an exact identifier', async () => {
  const { prepareChunk, searchKnowledge } = await retrieval();
  const chunks = documents.map(prepareChunk);
  const vector = [{ chunk: chunks[1], score: 0.99 }, { chunk: chunks[0], score: 0.55 }];
  assert.deepEqual(searchKnowledge('s1fl 可以吗', chunks, vector).map(result => result.chunk.id), ['fl']);
  assert.deepEqual(searchKnowledge('s1f1 可以吗', chunks, vector), []);
});

test('ordinary questions retain lexical and semantic retrieval', async () => {
  const { prepareChunk, searchKnowledge } = await retrieval();
  const chunks = [prepareChunk({ id: 'faq', title: '发货说明', text: '发货时间以订单页为准' })];
  assert.equal(searchKnowledge('发货时间', chunks, [])[0].chunk.id, 'faq');
});

test('plus-suffixed models are distinct identifiers', async () => {
  const { prepareChunk, searchKnowledge } = await retrieval();
  const chunks = [prepareChunk({ id: 'plus', title: 'S2+ 浮动刹车盘', text: 'S2+ 系列' })];
  assert.deepEqual(searchKnowledge('S2 刹车盘', chunks), []);
  assert.deepEqual(searchKnowledge('S2+ 刹车盘', chunks).map(result => result.chunk.id), ['plus']);
});
