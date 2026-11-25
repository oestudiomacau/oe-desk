const normalize = value => String(value || '').normalize('NFKC').toLowerCase()
  .replace(/\([^()]*\)/g, '')
  .replace(/弹簧线(?:有)?多粗|弹簧钢丝直径|弹簧的线径/g, '弹簧线径')
  .replace(/避震|减震器/g, '减震')
  .replace(/标配|出厂|原厂/g, '')
  .replace(/有没有|有无|是否配备|有配备|有配|配备|有(?=垫片)/g, '带')
  .replace(/您好|你好|请问|请教一下|请教|是多少呢|是多少|多少|想问|问一下|想知道|里面|的|吗/g, '')
  .replace(/弹簧磅(?!数)/g, '弹簧磅数')
  .replace(/[^a-z0-9+\u4e00-\u9fff]+/g, '');

function bigrams(text) {
  const terms = new Set();
  for (const word of text.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < word.length - 1; i++) terms.add(word.slice(i, i + 2));
  }
  return terms;
}

const tokens = value => new Set(String(value).normalize('NFKC').toLowerCase().match(/[a-z][a-z0-9+-]+/g) || []);
const vehicle = /^(?:xmax|nmax|nvx|aerox|pcx|forza|nss|adv|tmax|ae)\d*$/;
const family = value => value.replace(/\d+$/, '');
const conditions = value => String(value).normalize('NFKC').match(/\d+(?:\.\d+)?\s*(?:斤|公斤|kg|年款|款|mm|公分)/gi)
  ?.map(item => item.replace(/\s/g, '').toLowerCase()) || [];

export function prepareImportedFaq(faq) {
  return { ...faq, normalized: normalize(faq.question), terms: bigrams(normalize(faq.question)),
    products: tokens(faq.product), identifiers: tokens(faq.product + '\n' + faq.question) };
}

export function matchImportedFaq(question, chunks, { product, requireVehicle, counterpart } = {}) {
  const query = normalize(question);
  if (query.length < 4) return null;
  const queryTerms = bigrams(query);
  const identifiers = tokens(question);
  const productNames = new Set(chunks.flatMap(chunk => [...chunk.faq.products]));
  const scoped = [...identifiers].filter(token => token !== 'rcb' && productNames.has(token));
  const explicitModels = [...identifiers].filter(token => /^[a-z]+\d/.test(token) && !vehicle.test(token) && !/^v\d+$/.test(token));
  const vehicleNames = [...identifiers].filter(token => vehicle.test(token));
  const queryConditions = conditions(question);
  const all = [];
  for (const chunk of chunks) {
    const faq = chunk.faq;
    if (product && !faq.products.has(product.toLowerCase())) continue;
    if (counterpart && !faq.identifiers.has(counterpart.toLowerCase())) continue;
    const rowConditions = conditions(faq.question);
    if (rowConditions.length && !rowConditions.every(condition => queryConditions.includes(condition))) continue;
    if (scoped.length && !scoped.some(token => faq.identifiers.has(token))) continue;
    if (!scoped.length && explicitModels.length && faq.products.size
      && !explicitModels.some(token => faq.identifiers.has(token))) continue;
    const rowVehicles = [...faq.identifiers].filter(token => vehicle.test(token));
    if (requireVehicle && !rowVehicles.length) continue;
    if (vehicleNames.length && rowVehicles.length && vehicleNames.some(token => !rowVehicles.some(candidate =>
      candidate === token || (family(candidate) === family(token) && (token === family(token) || candidate === family(candidate)))))) continue;
    if (query === faq.normalized) { all.push({ chunk, score: 10 }); continue; }
    const shared = [...queryTerms].filter(term => faq.terms.has(term)).length;
    if (shared < 2 || shared / queryTerms.size < 0.45 || shared / faq.terms.size < 0.42) continue;
    const score = (2 * shared) / (queryTerms.size + faq.terms.size) +
      0.12 * [...identifiers].filter(token => faq.identifiers.has(token)).length;
    if (score >= 0.62) all.push({ chunk, score });
  }
  all.sort((a, b) => b.score - a.score);
  if (!all.length) return null;
  const [best, next] = all;
  if (next && best.score - next.score < 0.08 && best.chunk.faq.answer !== next.chunk.faq.answer) return null;
  return best.chunk;
}
