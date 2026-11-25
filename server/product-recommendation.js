import { modelCodes } from './knowledge-retrieval.js';

const categories = [
  { key: 'disc', query: /刹车盘|制动盘|制动碟|碟盘|碟刹盘|刹车碟/, product: /刹车盘|制动盘/ },
  { key: 'shock', query: /避震|减震|悬挂/, product: /减震/ },
  { key: 'caliper-adapter', query: /卡钳转接码|卡钳转接座|转接码/, product: /卡钳转接码|卡钳转接座/ },
  { key: 'caliper', query: /卡钳(?!转接码|转接座)/, product: /制动系统-卡钳$/ },
  { key: 'pump-cover', query: /上泵盖|油壶盖/, product: /上泵盖|油壶盖/ },
  { key: 'front-pump', query: /上泵(?!盖)|前泵|直推泵|侧推泵/, product: /刹车上泵/ },
  { key: 'rear-pump', query: /后泵/, product: /后制动泵/ },
  { key: 'pump', query: /制动泵|刹车泵/, product: /刹车上泵|后制动泵/ },
  { key: 'hose-connector', query: /油管接头|刹车管接头/, product: /油管接头/ },
  { key: 'hose', query: /油管(?!接头)|刹车管(?!接头)/, product: /刹车油管(?!接头)/ },
  { key: 'reservoir', query: /油壶(?!盖)|油杯/, product: /刹车油壶/ },
  { key: 'wheel', query: /轮毂|轮圈|轮框/, product: /^轮毂系统(?!-气门嘴)/ },
  { key: 'valve', query: /气门嘴/, product: /气门嘴/ },
  { key: 'mirror', query: /后视镜|反光镜|倒车镜/, product: /后视镜/ },
  { key: 'grip', query: /手把|把套|握把|车把堵头/, product: /手把/ },
  { key: 'guard', query: /护弓|护手/, product: /护弓|护手/ },
  { key: 'clutch', query: /离合/, product: /离合/ },
  { key: 'footrest', query: /脚踏|脚踏板/, product: /脚踏/ },
  { key: 'stand', query: /边撑|侧撑/, product: /边撑/ },
  { key: 'swingarm', query: /后摇臂/, product: /后摇臂/ }
];

const suggestionPattern = /有什么|有哪些|推荐|介绍|看看|多少钱|价钱|价格|报价|有卖|卖什么|买|选|升级|改装|有没有|想换|要换|换个|想要|需要|找(?:一|个|款)?|配什么|装什么|用哪款|适合哪款/;
const genericProductPattern = /商品|产品|配件|改装件|升级件|改装方案/;
const ignoredAsciiTokens = new Set(['rcb', 'mm']);
const ignoredChinesePhrases = new Set([
  '什么', '有什么', '哪些', '有没有', '推荐', '介绍', '看看', '多少', '多少钱', '价格', '报价',
  '商品', '产品', '配件', '改装', '改装件', '升级', '升级件', '想要', '需要', '摩托', '摩托车',
  '可以', '适合', '能装', '安装', '这个', '那个', '请问', '一下', '一款', '一个'
]);

function requestedCategories(question) {
  const specific = categories.filter(group => group.query.test(question));
  if (specific.length) return specific;
  if (/(过坑|烂路|颠簸|太颠|舒适性|支撑性|车身晃|压不住)/.test(question)) return [categories.find(group => group.key === 'shock')];
  if (/刹车|制动/.test(question)) return [{ key: 'brake', product: /制动系统/ }];
  return [];
}

function normalizedText(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[‐‑‒–—−]/g, '-');
}

const xmax300 = /\bx\s*-?\s*max\s*-?\s*300\b/;
const serviceTopic = /退款|退货|售后|订单|赔偿|故障|事故|物流/;
const vehicleChange = /换成|另一台|别的车|其他车|新车|我的车|车型是|我骑的是|雅马哈|本田|川崎|铃木|光阳|三阳/;

export const defaultCatalogAliases = [
  ['XMAX 300', 'xmax'], ['X-MAX', 'xmax'],
  ['NMAX 155', 'nmax'], ['NMAX', 'nmax'],
  ['NVX 155', 'nvx'], ['NVX', 'nvx'],
  ['AEROX 155', 'aerox'], ['AEROX', 'aerox'],
  ['PCX 160', 'pcx160'], ['FORZA 350', 'forza350'], ['佛沙350', 'forza350'], ['佛莎350', 'forza350'],
  ['FORZA 250', 'forza250'], ['佛沙250', 'forza250'], ['NSS 250', 'nss250'],
  ['ADV 150', 'adv150'], ['TMAX', 'tmax'], ['Vespa', 'vespa'], ['维斯帕', 'vespa']
].map(([alias, term]) => ({ alias, target: 'term:' + term }));
export const catalogAliasKey = value => normalizedText(value).replace(/[\s-]+/g, '');

function aliasPattern(alias) {
  const key = catalogAliasKey(alias);
  const pattern = [...key].map(character => character.replace(/[^\p{L}\p{N}]/gu, '\\$&')).join('[\\s-]*');
  return new RegExp((/^[a-z0-9]/.test(key) ? '(?<![a-z0-9])' : '') + pattern +
    (/[a-z]$/.test(key) ? '(?![a-z0-9]|[\\s-]*\\d)' : /\d$/.test(key) ? '(?![a-z0-9])' : ''), 'g');
}

export function catalogAssociationTargets(products) {
  const targets = new Map();
  function add(id, label, product) {
    if (!targets.has(id)) targets.set(id, { id, label, products: [] });
    const names = targets.get(id).products;
    if (!names.includes(product.title)) names.push(product.title);
  }
  for (const product of products) {
    add('product:' + product.title, product.title, product);
    for (const term of new Set([...product.tokens, ...product.codes])) {
      if (/^[a-z][a-z0-9+\-]{1,24}$/.test(term)) add('term:' + term, term.toUpperCase(), product);
    }
  }
  return targets;
}

export function catalogLookupContext(question, history = [], aliases = defaultCatalogAliases) {
  const current = normalizedText(question);
  if (serviceTopic.test(current)) return { lookup: question };
  const ordered = [...aliases].sort((a, b) => catalogAliasKey(b.alias).length - catalogAliasKey(a.alias).length);
  const find = text => ordered.find(item => aliasPattern(item.alias).test(text));
  const apply = (item, text, yearFollowUp = false) => {
    const [type, ...parts] = item.target.split(':');
    const target = parts.join(':');
    const term = type === 'term' ? target : '';
    const version = text.match(/\bv\s*([1-9])\b|第\s*([1-9])\s*代/);
    const isVehicle = defaultCatalogAliases.some(alias => alias.target === item.target);
    return { lookup: yearFollowUp ? term : text.replace(aliasPattern(item.alias), ` ${term}，`).trim(),
      ...(type === 'product' ? { exactTitle: target } : {}),
      requiredTerm: term,
      vehicle: isVehicle ? item.alias : '',
      vehicleVersion: isVehicle ? version?.[1] || version?.[2] : undefined,
      alias: item.alias, association: true, yearFollowUp };
  };
  const match = find(current);
  if (match) return apply(match, current);

  const yearOnly = /^(?:是|我的|我是)?\s*20\d{2}\s*(?:年|年款|款)?[。.!！]?$/;
  const followUp = yearOnly.test(current) || requestedCategories(current).length > 0;
  if (!followUp || /[a-z]/i.test(current) || vehicleChange.test(current)) return { lookup: question };
  for (const turn of history.slice(-8).reverse()) {
    if (turn.role !== 'user') continue;
    const text = normalizedText(turn.content);
    if (serviceTopic.test(text) || /换成|另一台|别的车|其他车/.test(text)) break;
    const earlier = find(text);
    if (earlier) {
      const context = apply(earlier, current, yearOnly.test(current));
      context.inherited = true;
      if (!context.yearFollowUp && earlier.target.startsWith('term:')) context.lookup = earlier.target.slice(5) + ' ' + question;
      return context;
    }
    if (/[a-z]/i.test(text) || vehicleChange.test(text)) break;
  }
  return { lookup: question };
}

function asciiTokens(text) {
  return new Set((normalizedText(text).match(/\b[a-z][a-z0-9-]{2,}\b/g) || [])
    .filter(token => !ignoredAsciiTokens.has(token) && !/^\d/.test(token)));
}

function chinesePhrases(text) {
  const phrases = new Set();
  for (const source of normalizedText(text).match(/[\u4e00-\u9fff]+/g) || []) {
    let cleaned = source;
    for (const ignored of [...ignoredChinesePhrases].sort((left, right) => right.length - left.length)) {
      cleaned = cleaned.replaceAll(ignored, ' ');
    }
    for (const part of cleaned.split(/\s+/).filter(Boolean)) {
      if (part.length < 2) continue;
      if (part.length <= 8) phrases.add(part);
      for (let size = Math.min(6, part.length); size >= 2; size -= 1) {
        for (let index = 0; index <= part.length - size; index += 1) {
          const phrase = part.slice(index, index + size);
          if (!ignoredChinesePhrases.has(phrase)) phrases.add(phrase);
        }
      }
    }
  }
  return phrases;
}

function productText(product) {
  return normalizedText(`${product.title}\n${product.category}\n${product.specs}`);
}

function longestChineseMatch(questionPhrases, product) {
  const haystack = productText(product);
  let longest = 0;
  for (const phrase of questionPhrases) if (haystack.includes(phrase)) longest = Math.max(longest, phrase.length);
  return longest;
}

function catalogSignals(question, products) {
  const codes = modelCodes(question);
  const queryTokens = asciiTokens(question);
  const productTokens = new Set(products.flatMap(product => [...product.tokens]));
  const knownTokens = [...queryTokens].filter(token => productTokens.has(token) &&
    ![...codes].some(code => code === token.replace(/[^a-z0-9+]/g, '')));
  const phrases = chinesePhrases(question);
  const hasDirectPhrase = [...phrases].some(phrase => products.some(product => productText(product).includes(phrase)));
  return { codes, queryTokens, productTokens, knownTokens, phrases, hasDirectPhrase };
}

export function hasCatalogCategory(question, products = []) {
  if (requestedCategories(question).length > 0 || modelCodes(question).size > 0) return true;
  if (!products.length) return false;
  const signals = catalogSignals(question, products);
  return signals.knownTokens.length > 0 || signals.hasDirectPhrase || genericProductPattern.test(question);
}

export function prepareCatalogProduct(row, chunk) {
  const title = String(row['商品名称'] || '').trim();
  const rawPrice = String(row['售价_CNY'] || '').trim();
  const price = /^\d+(?:\.\d{1,2})?$/.test(rawPrice) && Number(rawPrice) > 0 ? Number(rawPrice) : null;
  const category = String(row['商品类别'] || '').trim();
  const specs = String(row['适配车型或规格'] || '').trim();
  const source = String(row['来源'] || '').trim();
  const priceText = String(row['资料标价'] || '').trim();
  const structuredMarkdown = row.structuredMarkdown === true;
  const codes = structuredMarkdown
    ? modelCodes(`${title}\n${[...specs.matchAll(/(?:产品编码|商品编码|SKU)[：:]\s*([^；\n]+)/gi)].map(match => match[1]).join('\n')}`)
    : modelCodes(`${title}\n${specs}`);
  return { title, category, specs, price, priceText, source, structuredMarkdown,
    sourceDate: source.match(/20\d{2}-\d{2}-\d{2}/)?.[0] || null,
    codes, tokens: asciiTokens(`${title}\n${specs}`), chunk };
}

export function associateProducts(question, products, limit = 4, { vehicle, vehicleVersion, exactTitle, requiredTerm, modelTerm } = {}) {
  if (vehicleVersion) question = question.replace(/\bv\s*[1-9]\b|第\s*[1-9]\s*代/gi, '');
  const groups = requestedCategories(question);
  const { codes, queryTokens, productTokens, knownTokens: vehicleTokens, phrases } = catalogSignals(question, products);
  const suggestsProducts = suggestionPattern.test(question) || genericProductPattern.test(question);
  const genericCatalogInquiry = genericProductPattern.test(question) && suggestionPattern.test(question);
  if (!groups.length && !codes.size && !vehicleTokens.length && !suggestsProducts && !exactTitle && !modelTerm) return [];
  if ([...queryTokens].some(token => !productTokens.has(token) &&
    ![...codes].some(code => code === token.replace(/[^a-z0-9+]/g, '')))) return [];
  const inCategory = (group, product) => group.product.test(product.category)
    || (product.structuredMarkdown && group.query?.test(product.title));
  const positions = new Set([...question.matchAll(/([前后]{1,2})(?:减震|避震)/g)].flatMap(match => [...match[1]]));
  const position = positions.size === 1 ? [...positions][0] : undefined;
  const matchesVersion = product => {
    if (!vehicleVersion) return true;
    const versions = [...productText(product).matchAll(/\bv\s*([1-9])\b|第\s*([1-9])\s*代/g)].map(match => match[1] || match[2]);
    return !versions.length || versions.includes(vehicleVersion);
  };
  let candidates = products.filter(product => product.title && (!exactTitle || product.title === exactTitle) &&
    (!modelTerm || (normalizedText(product.title).match(/[a-z][a-z0-9+-]*/g) || []).some(term => catalogAliasKey(term) === catalogAliasKey(modelTerm))) &&
    (!requiredTerm || product.tokens.has(requiredTerm) || product.codes.has(requiredTerm)) &&
    matchesVersion(product) &&
    (!position || !productText(product).includes((position === '后' ? '前' : '后') + '减震') ||
      productText(product).includes(position + '减震')) &&
    (!codes.size || [...codes].some(code => product.codes.has(code))) &&
    (!groups.length || groups.some(group => inCategory(group, product))) &&
    (!vehicleTokens.length || vehicleTokens.every(token => product.tokens.has(token))) &&
    (!xmax300.test(normalizedText(vehicle)) || !/\bx\s*-?\s*max\s*-?\s*(?:125|250)\b/.test(productText(product)) ||
      xmax300.test(productText(product))));
  if (!exactTitle && !modelTerm && !groups.length && !codes.size && !vehicleTokens.length) {
    const matching = candidates.filter(product => longestChineseMatch(phrases, product) >= 2);
    candidates = matching.length || !genericCatalogInquiry ? matching : [...products];
  }
  // A vehicle/model absent from the catalog is not evidence of compatibility.
  if (queryTokens.size && !vehicleTokens.length &&
    /适配|能装|适合|装在/.test(question) && !codes.size) candidates = [];
  const originalOrder = new Map(products.map((product, index) => [product, index]));
  const score = product => longestChineseMatch(phrases, product) * 2 +
    [...codes].filter(code => product.codes.has(code)).length * 12 +
    vehicleTokens.filter(token => product.tokens.has(token)).length * 8 +
    (/升级|改装|提升|加强|改善|更灵|刹不住/.test(question) && /刹车|制动/.test(question)
      ? (/制动系统-卡钳$/.test(product.category) ? 30
          : /刹车盘/.test(product.category) ? 28
            : /刹车上泵|后制动泵/.test(product.category) ? 18
              : /刹车油管(?!接头)/.test(product.category) ? 12 : 0)
      : 0) +
    (question.includes('后') && product.category.includes('后') ? 3 : 0) +
    (question.includes('前') && product.category.includes('前') ? 3 : 0);
  candidates.sort((left, right) => score(right) - score(left) || originalOrder.get(left) - originalOrder.get(right));
  if (genericCatalogInquiry && !groups.length && !codes.size && !vehicleTokens.length) {
    const diverse = [];
    const seenCategories = new Set();
    for (const product of candidates) {
      if (seenCategories.has(product.category)) continue;
      seenCategories.add(product.category);
      diverse.push(product);
      if (diverse.length >= limit) break;
    }
    return diverse;
  }
  if (groups.length < 2) return candidates.slice(0, limit);
  const buckets = groups.map(group => candidates.filter(product => inCategory(group, product)));
  const selected = [];
  while (selected.length < limit && buckets.some(bucket => bucket.length)) {
    for (const bucket of buckets) {
      const next = bucket.shift();
      if (next && !selected.includes(next)) selected.push(next);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

export function linkProductDocuments(product, documents) {
  return documents.filter(document => {
    if (!document.category || document.category !== product.category) return false;
    const codes = modelCodes(`${document.title} ${document.heading || ''} ${document.model || ''}`);
    if (codes.size) return [...codes].some(code => product.codes.has(code));
    return [...asciiTokens(`${document.title} ${document.heading || ''}`)].some(token => product.tokens.has(token));
  });
}

export function wantsCatalogSuggestions(question) {
  if (/怎么安装|怎么修|故障|退货|退款|售后/.test(question)) return false;
  return suggestionPattern.test(question) || genericProductPattern.test(question) ||
    (question.length <= 12 && requestedCategories(question).length > 0 && !/适配|能装|适合/.test(question));
}

export function formatProductRecommendations(products, { vehicle, yearKnown = false } = {}) {
  if (!products.length) return '';
  const lines = products.map((product, index) => {
    const specs = product.specs && (!product.structuredMarkdown || product.specs.length <= 100) ? `；规格：${product.specs}` : '';
    const price = product.priceText && product.priceText.length <= 240 ? `资料标价：${product.priceText.replace(/\n/g, '；')}`
      : product.price === null ? '价格请以商品页面为准' : `参考价 ¥${product.price}`;
    const recordedAt = product.sourceDate ? `（${product.sourceDate} 记录）` : '';
    return `${index + 1}. ${product.title}${specs}；${price}${recordedAt}`;
  });
  const nextStep = vehicle
    ? `${vehicle} 的具体适配需核对${yearKnown ? '版本和原车规格' : '年款、版本和原车规格'}。`
    : '告诉我车型、年份和想升级的部位，我可以继续帮您缩小范围。';
  return `可以参考以下商品：\n${lines.join('\n')}\n价格以当前商品页面为准。${nextStep}`;
}

function productShortName(product) {
  const patterns = ['前减震', '后减震', '减震', '轮毂', '刹车油管', '刹车盘', '卡钳', '后摇臂', '后视镜', '刹车上泵'];
  const kind = patterns.find(pattern => product.title.includes(pattern)) || '';
  const knownVehicles = new Set(defaultCatalogAliases.map(item => item.target.slice(5)));
  const label = (product.title.match(/[A-Z][A-Z0-9]*(?:[-+][A-Z0-9]+)*\+?/g) || [])
    .find(word => word !== 'RCB' && !knownVehicles.has(word.toLowerCase()));
  return label && kind ? label + kind : product.title;
}

export function catalogAnswerMentionsProduct(answer, products) {
  const text = catalogAliasKey(answer);
  return products.some(product => {
    const label = productShortName(product);
    const model = label.match(/^[A-Z][A-Z0-9+\-]*/)?.[0];
    return text.includes(catalogAliasKey(label)) || (model && text.includes(catalogAliasKey(model)));
  });
}

export function formatBriefCatalogReply(product, { lengthTarget, yearKnown, question }) {
  const label = productShortName(product);
  const priceAsked = /多少钱|价格|售价|报价|价钱/.test(question);
  const price = product.price !== null ? `参考价 ${product.price} 元` : product.priceText && product.priceText.length <= (lengthTarget || 60)
    ? product.priceText : '价格需按规格核对';
  const parts = ['可先看' + label, priceAsked ? price : yearKnown ? '适配需核对版本和原车规格' : '请提供年款，核对适配'];
  return lengthTarget ? parts.join('###') : parts.join('。') + '。';
}
