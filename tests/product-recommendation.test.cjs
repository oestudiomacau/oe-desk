const test = require('node:test');
const assert = require('node:assert/strict');

const rows = [
  { '商品名称': 'RCB S2+ 浮动刹车盘', '商品类别': '制动系统-浮动刹车盘', '售价_CNY': '953', '适配车型或规格': 'S2+系列', '来源': '测试目录（2026-09-09）' },
  { '商品名称': 'RCB D1 后刹车盘', '商品类别': '制动系统-后刹车盘', '售价_CNY': '650', '适配车型或规格': 'D1系列', '来源': '测试目录（2026-09-09）' },
  { '商品名称': 'RCB VD XMAX 后减震', '商品类别': '减震系统-后减震', '售价_CNY': '2873', '适配车型或规格': 'XMAX；330/350MM', '来源': '测试目录（2026-09-09）' },
  { '商品名称': 'RCB VD NMAX 后减震', '商品类别': '减震系统-后减震', '售价_CNY': '2871', '适配车型或规格': 'NMAX；305MM', '来源': '测试目录（2026-09-09）' },
  { '商品名称': 'RCB R1 卡钳', '商品类别': '制动系统-卡钳', '售价_CNY': '610', '适配车型或规格': 'R1系列', '来源': '测试目录（2026-09-09）' },
  { '商品名称': 'RCB FG560 轮毂', '商品类别': '轮毂系统', '售价_CNY': '7571', '适配车型或规格': 'FG560系列', '来源': '测试目录（2026-09-09）' },
  { '商品名称': 'RCB 气门嘴', '商品类别': '轮毂系统-气门嘴', '售价_CNY': '189', '适配车型或规格': '通用', '来源': '测试目录（2026-09-09）' },
  { '商品名称': 'RCB S1 前刹车上泵', '商品类别': '制动系统-刹车上泵', '售价_CNY': '882', '适配车型或规格': 'S1系列', '来源': '测试目录（2026-09-09）' },
  { '商品名称': 'RCB H1 后制动泵', '商品类别': '制动系统-后制动泵', '售价_CNY': '442', '适配车型或规格': 'H1系列', '来源': '测试目录（2026-09-09）' },
  { '商品名称': 'RCB GP3 碳纤维护弓', '商品类别': '护手配件', '售价_CNY': '699', '适配车型或规格': 'GP3系列；碳纤维', '来源': '测试目录（2026-09-09）' },
  { '商品名称': 'RCB XMAX ABS 刹车油管', '商品类别': '制动系统-刹车油管', '售价_CNY': '1280', '适配车型或规格': 'XMAX；ABS；5件套', '来源': '测试目录（2026-09-09）' },
  { '商品名称': 'RCB S系列油管接头', '商品类别': '制动系统-刹车油管接头', '售价_CNY': '199', '适配车型或规格': 'S系列；通用车型', '来源': '测试目录（2026-09-09）' }
];

async function catalog() {
  const { prepareCatalogProduct, associateProducts, formatProductRecommendations, wantsCatalogSuggestions } =
    await import('../server/product-recommendation.js');
  const { prepareChunk } = await import('../server/knowledge-retrieval.js');
  const products = rows.map((row, i) => prepareCatalogProduct(row,
    prepareChunk({ id: `item-${i}`, title: row['商品名称'], text: `${row['商品类别']} ${row['适配车型或规格']}` })));
  return { products, associateProducts, formatProductRecommendations, wantsCatalogSuggestions };
}

test('category aliases associate only the requested product types and carry catalog prices', async () => {
  const { products, associateProducts, formatProductRecommendations } = await catalog();
  const discs = associateProducts('有什么制动碟推荐？', products);
  assert.deepEqual(discs.map(item => item.category), ['制动系统-浮动刹车盘', '制动系统-后刹车盘']);
  assert.match(formatProductRecommendations(discs), /S2\+.*¥953/);
  assert.match(formatProductRecommendations(discs), /2026-09-09/);
  const shocks = associateProducts('有避震吗？', products);
  assert.deepEqual(shocks.map(item => item.title), ['RCB VD XMAX 后减震', 'RCB VD NMAX 后减震']);
  const mixed = associateProducts('有什么刹车盘和避震？', products);
  assert.equal(mixed.length, 4);
  assert.ok(mixed.some(item => item.category.includes('刹车盘')));
  assert.ok(mixed.some(item => item.category.includes('减震')));
});

test('model and vehicle constraints avoid neighboring products or compatibility claims', async () => {
  const { products, associateProducts, wantsCatalogSuggestions } = await catalog();
  assert.deepEqual(associateProducts('S2+ 刹车盘多少钱', products).map(item => item.title), ['RCB S2+ 浮动刹车盘']);
  assert.deepEqual(associateProducts('S2 刹车盘多少钱', products), []);
  assert.deepEqual(associateProducts('XMAX 避震推荐', products).map(item => item.title), ['RCB VD XMAX 后减震']);
  assert.deepEqual(associateProducts('PCX 避震推荐', products), []);
  assert.deepEqual(associateProducts('MT-07 刹车盘能装吗', products), []);
  assert.deepEqual(associateProducts('有什么轮毂', products).map(item => item.title), ['RCB FG560 轮毂']);
  assert.deepEqual(associateProducts('有气门嘴吗', products).map(item => item.title), ['RCB 气门嘴']);
  assert.deepEqual(associateProducts('有什么后泵', products).map(item => item.title), ['RCB H1 后制动泵']);
  assert.equal(wantsCatalogSuggestions('有什么刹车盘'), true);
  assert.equal(wantsCatalogSuggestions('刹车盘怎么安装'), false);
});

test('vehicle aliases require the corresponding catalog vehicle and keep distinct displacements separate', async () => {
  const { products, associateProducts } = await catalog();
  const { catalogLookupContext, prepareCatalogProduct } = await import('../server/product-recommendation.js');
  const wheels = [
    prepareCatalogProduct({ 商品名称: 'FG560 FORZA350 轮毂', 商品类别: '轮毂系统', 适配车型或规格: 'FORZA350' }, {}),
    prepareCatalogProduct({ 商品名称: 'CT600 AEROX V3 轮毂', 商品类别: '轮毂系统', 适配车型或规格: 'AEROX V3' }, {}),
    prepareCatalogProduct({ 商品名称: 'SP500 AEROX V2 轮毂', 商品类别: '轮毂系统', 适配车型或规格: 'AEROX V2' }, {})
  ];
  const titles = question => {
    const context = catalogLookupContext(question);
    return associateProducts(context.lookup, [...products, ...wheels], 4, context).map(item => item.title);
  };
  assert.deepEqual(titles('NMAX155 有后减震吗？'), ['RCB VD NMAX 后减震']);
  assert.deepEqual(titles('NMAX 125 有后减震吗？'), []);
  assert.deepEqual(titles('佛沙350有哪款锻造轮毂？'), ['FG560 FORZA350 轮毂']);
  assert.deepEqual(titles('Aerox 155 V3 有哪些轮毂？'), ['CT600 AEROX V3 轮毂']);
});

test('catalog data without a verified price does not invent a number', async () => {
  const { associateProducts, formatProductRecommendations } = await catalog();
  const { prepareCatalogProduct } = await import('../server/product-recommendation.js');
  const missing = prepareCatalogProduct({ ...rows[0], '售价_CNY': '' }, { id: 'no-price', title: rows[0]['商品名称'] });
  assert.match(formatProductRecommendations(associateProducts('刹车盘多少钱', [missing])), /价格请以商品页面为准/);
  assert.doesNotMatch(formatProductRecommendations(associateProducts('刹车盘多少钱', [missing])), /¥\d/);
});

test('free-form discovery links vehicle, description and accessory questions to catalog products', async () => {
  const { products, associateProducts, formatProductRecommendations } = await catalog();
  assert.deepEqual(associateProducts('XMAX 有什么改装件推荐？', products).map(item => item.title), [
    'RCB VD XMAX 后减震',
    'RCB XMAX ABS 刹车油管'
  ]);
  assert.deepEqual(associateProducts('有没有碳纤维护弓？', products).map(item => item.title), ['RCB GP3 碳纤维护弓']);
  assert.deepEqual(associateProducts('油管接头推荐', products).map(item => item.title), ['RCB S系列油管接头']);
  assert.deepEqual(associateProducts('我想给XMAX换个减震器', products).map(item => item.title), ['RCB VD XMAX 后减震']);
  const general = associateProducts('你们有什么产品推荐？', products);
  assert.equal(general.length, 4);
  assert.equal(new Set(general.map(item => item.category)).size, general.length);
  const recommendation = formatProductRecommendations(associateProducts('XMAX 避震多少钱？', products));
  assert.match(recommendation, /可以参考/);
  assert.match(recommendation, /规格：XMAX；330\/350MM/);
  assert.match(recommendation, /参考价 ¥2873/);
  assert.doesNotMatch(recommendation, /知识库|检索|关联|思考/);
});

test('upgrade intent prioritizes core brake components over minor accessories', async () => {
  const { products, associateProducts, formatProductRecommendations } = await catalog();
  const upgrades = associateProducts('我想升级刹车', products);
  assert.equal(upgrades.length, 4);
  assert.ok(upgrades.slice(0, 3).every(item => /卡钳|刹车盘/.test(`${item.title} ${item.category}`)));
  const recommendation = formatProductRecommendations(upgrades);
  assert.match(recommendation, /参考价/);
  assert.doesNotMatch(recommendation, /没有资料|知识库|检索|思考/);
});

test('product notes link only to the same category and exact model or vehicle', async () => {
  const { products } = await catalog();
  const { linkProductDocuments } = await import('../server/product-recommendation.js');
  const documents = [
    { chunk: { id: 's2-note' }, category: '制动系统-浮动刹车盘', title: 'RCB S2+ 刹车盘说明', model: 'S2+' },
    { chunk: { id: 's2-other' }, category: '制动系统-浮动刹车盘', title: 'RCB S2 刹车盘说明', model: 'S2' },
    { chunk: { id: 'xmax-note' }, category: '减震系统-后减震', title: 'RCB VD 后减震说明', heading: 'RCB VD XMAX 后减震', model: 'VD系列' },
    { chunk: { id: 'nmax-note' }, category: '减震系统-后减震', title: 'RCB VD 后减震说明', heading: 'RCB VD NMAX 后减震', model: 'VD系列' }
  ];
  assert.deepEqual(linkProductDocuments(products[0], documents).map(item => item.chunk.id), ['s2-note']);
  assert.deepEqual(linkProductDocuments(products[2], documents).map(item => item.chunk.id), ['xmax-note']);
});
