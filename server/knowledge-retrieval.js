const genericTerms = new Set(['客服', '咨询', '问题', '什么', '怎么', '是否', '商品', '产品', '您好', '请问', '这个', '那个', '我们', '你们', '今天', '时候', '多少', '价格', '活动', '情况', '一下', '可以', '需要', '雷型', '型宝', '哪些', '有哪', '公开', '介绍', '信息', '相关', '关于', '知道']);

export function modelCodes(text) {
  const normalized = String(text || '').normalize('NFKC').toLowerCase().replace(/[‐‑‒–—−]/g, '-');
  const codes = normalized.match(/\b[a-z]{1,8}\s*-?\s*\d+[a-z0-9]*(?:\s*-\s*[a-z0-9]+|\s+[a-z]{1,3})*\+?(?![a-z0-9])/g) || [];
  return new Set(codes.map(code => code.replace(/[^a-z0-9+]/g, '')));
}

function terms(text) {
  const lower = String(text || '').toLowerCase();
  const result = new Set((lower.match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || []).filter(term => term !== 'rcb'));
  for (const code of modelCodes(text)) result.add(code);
  for (const group of lower.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let index = 0; index < group.length - 1; index += 1) {
      const term = group.slice(index, index + 2);
      if (!genericTerms.has(term)) result.add(term);
    }
  }
  return result;
}

export function prepareChunk(chunk) {
  return { ...chunk, lexicalTerms: terms(`${chunk.title}\n${chunk.text}`),
    titleModelCodes: modelCodes(chunk.title), modelCodes: modelCodes(`${chunk.title}\n${chunk.text}`) };
}

export function hasModelIdentifier(question) { return modelCodes(question).size > 0; }

export function searchKnowledge(question, chunks, vector = [], limit = 4) {
  const codes = modelCodes(question);
  let candidates = chunks;
  if (codes.size) {
    const matches = source => chunks.filter(chunk => [...codes].some(code => source(chunk).has(code)));
    const titleMatches = matches(chunk => chunk.titleModelCodes);
    candidates = titleMatches.length ? titleMatches : matches(chunk => chunk.modelCodes);
    if (!candidates.length) return [];
  }
  const allowed = new Set(candidates.map(chunk => chunk.id));
  const queryTerms = terms(question);
  const lexical = candidates.map(chunk => {
    let score = 0;
    for (const term of queryTerms) if (chunk.lexicalTerms.has(term)) score += term.length > 1 ? 2 : 0.35;
    return { chunk, score };
  }).filter(result => result.score >= 2).sort((left, right) => right.score - left.score).slice(0, 8);
  const combined = new Map();
  for (const [rank, result] of lexical.entries()) combined.set(result.chunk.id, { chunk: result.chunk, score: 1 / (rank + 1) });
  for (const [rank, result] of vector.filter(result => allowed.has(result.chunk.id)).slice(0, 8).entries()) {
    const current = combined.get(result.chunk.id) || { chunk: result.chunk, score: 0 };
    current.score += 1 / (rank + 1); combined.set(result.chunk.id, current);
  }
  return [...combined.values()].sort((left, right) => right.score - left.score).slice(0, limit);
}
