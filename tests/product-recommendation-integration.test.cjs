const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

test('chat associates catalog products and current imported snapshot with grounded reference prices', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'oe-catalog-association-'));
  const importedDir = join(workdir, 'knowledge-base', 'imported', 'products');
  await mkdir(importedDir, { recursive: true });
  const notesDir = join(workdir, 'knowledge-base', 'products');
  await mkdir(notesDir, { recursive: true });
  await writeFile(join(notesDir, 's2-note.md'), '---\nproduct_name: RCB S2+ 刹车盘说明\nmodel: S2+\ncategory: 制动系统-浮动刹车盘\n---\n# S2+ 刹车盘\n\n浮动款资料。');
  const header = '商品名称,售价_CNY,商品类别,适配车型或规格,促销信息,付款人数,主图URL,来源';
  await writeFile(join(workdir, 'knowledge-base', 'rcb-product-catalog.csv'), [header,
    'RCB S2+ 浮动刹车盘,953,制动系统-浮动刹车盘,S2+系列,,,,测试目录（2026-09-09）',
    'RCB VD XMAX 后减震,2873,减震系统-后减震,XMAX；330MM,,,,测试目录（2026-09-09）',
    'RCB R1 卡钳,610,制动系统-卡钳,R1系列,,,,测试目录（2026-09-09）'].join('\n'));
  await writeFile(join(importedDir, 'new-catalog.md'), `---\nsource: imported\nscope: products\n---\n# catalog\n\n` +
    `商品名称 | 售价_CNY | 商品类别 | 适配车型或规格 | 促销信息 | 付款人数 | 主图URL | 来源\n` +
    ['RCB S2+ 浮动刹车盘', '980', '制动系统-浮动刹车盘', 'S2+系列', '', '', '', '测试目录（2026-09-20）'].join(' | ') + '\n');
  let providerRequests = 0;
  const provider = createServer(async (request, response) => {
    providerRequests += 1;
    let body = '';
    for await (const chunk of request) body += chunk;
    const messages = JSON.parse(body).messages;
    let content = '{"answer":"可以按您的需求继续筛选。","needs_human":false}';
    if (messages[0].content.includes('判断客户的商品或车型叫法')) {
      const input = JSON.parse(messages[1].content);
      content = JSON.stringify({ index: input.candidates.find(([, label]) => label === 'XMAX')?.[0] ?? null });
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [join(__dirname, '..', 'server.js')], {
    cwd: workdir,
    env: { ...process.env, RCB_ALLOW_ENV_OVERRIDES: 'true', PORT: String(port), RAG_PROVIDER: 'openai',
      OPENAI_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, OPENAI_API_KEY: 'test-only',
      RAG_EMBEDDING_ENABLED: 'false', WEB_SEARCH_ENABLED: 'false' },
    stdio: 'ignore', windowsHide: true
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* Starting. */ }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    assert.ok(Date.now() < deadline, 'The isolated server did not start');
    async function ask(question, history = []) {
      const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, history }) });
      assert.equal(response.status, 200);
      return response.json();
    }
    const mixed = await ask('有什么刹车盘和避震推荐？');
    assert.deepEqual(mixed.productMatches.map(item => item.title), ['RCB S2+ 浮动刹车盘', 'RCB VD XMAX 后减震']);
    assert.match(mixed.answer, /S2\+.*¥980.*2026-09-20/);
    assert.match(mixed.answer, /VD XMAX.*¥2873/);
    assert.doesNotMatch(mixed.answer, /¥953|R1 卡钳/);
    assert.ok(mixed.sources.some(source => source.title === 'RCB S2+ 浮动刹车盘'));
    assert.ok(mixed.sources.some(source => source.title === 'RCB S2+ 刹车盘说明'));
    assert.ok(mixed.productMatches[0].linkedKnowledge.some(file => file.endsWith('s2-note.md')));
    assert.equal(mixed.trace.productMatchCount, 2);
    const vehicle = await ask('XMAX 有什么改装件推荐？');
    assert.deepEqual(vehicle.productMatches.map(item => item.title), ['RCB VD XMAX 后减震']);
    assert.match(vehicle.answer, /VD XMAX.*¥2873/);
    assert.doesNotMatch(vehicle.answer, /S2\+.*¥980/);
    const general = await ask('你们有什么产品推荐？');
    assert.equal(general.productMatches.length, 3);
    assert.match(general.answer, /参考价 ¥980/);
    assert.doesNotMatch(general.answer, /知识库|检索|思考/);
    const upgrade = await ask('我想升级刹车');
    assert.deepEqual(new Set(upgrade.productMatches.map(item => item.title)), new Set(['RCB R1 卡钳', 'RCB S2+ 浮动刹车盘']));
    assert.match(upgrade.answer, /参考价/);
    assert.doesNotMatch(upgrade.answer, /没有资料|知识库|检索|思考/);
    assert.equal(providerRequests, 0, 'Catalog recommendations should not wait for the model provider');
    for (const variant of ['XMAX300', 'XMAX 300', 'X-MAX 300']) {
      const lookup = await ask(`我的车是${variant}，可以装什么产品？`);
      assert.equal(lookup.retrieval, 'catalog-linked');
      assert.deepEqual(lookup.productMatches.map(item => item.title), ['RCB VD XMAX 后减震']);
      assert.match(lookup.answer, /具体适配需核对年款/);
    }
    const thread = [{ role: 'user', content: '我的车是 XMAX300，可以装什么？' }];
    assert.deepEqual((await ask('我想看后减震', thread)).productMatches.map(item => item.title), ['RCB VD XMAX 后减震']);
    assert.match((await ask('2023 款', thread)).answer, /核对版本和原车规格/);
    assert.deepEqual((await ask('PCX 后减震推荐', thread)).productMatches, []);
    const associationHeaders = { 'x-oe-desk': 'workbench', 'content-type': 'application/json' };
    const aliasesUrl = `${base}/api/workbench/associations`;
    const alias = '雅马哈大踏板甲';
    const suggestion = await fetch(aliasesUrl + '/suggest', { method: 'POST', headers: associationHeaders, body: JSON.stringify({ alias }) });
    assert.deepEqual(await suggestion.json(), { target: 'term:xmax', method: 'ai' });
    const saved = await fetch(aliasesUrl, { method: 'PUT', headers: associationHeaders, body: JSON.stringify({ alias, target: 'term:xmax' }) });
    assert.equal(saved.status, 200);
    assert.equal((await ask(`${alias}有什么后减震？`)).productMatches[0]?.title, 'RCB VD XMAX 后减震');
    const deleted = await fetch(aliasesUrl, { method: 'DELETE', headers: associationHeaders, body: JSON.stringify({ alias }) });
    assert.equal(deleted.status, 200);
    assert.ok(!(await deleted.json()).aliases.some(item => item.alias === alias));
    const install = await ask('刹车盘怎么安装？');
    assert.doesNotMatch(install.answer, /¥\d/);
    const unknown = await ask('MT-07 的刹车盘能直接装吗？');
    assert.deepEqual(unknown.productMatches, []);
    const unmatchedVehicle = await ask('PCX 刹车盘推荐');
    assert.deepEqual(unmatchedVehicle.productMatches, []);
    assert.ok(unmatchedVehicle.sources.every(source => !source.title.includes('刹车盘')));
    const markdown = [
      '# 新品画册', '## 减震系统', '### 1. Q77 XMAX 前减震（P.3）',
      '- **官方零售价**：4289 元（黑银）/ 4969 元（黑金）',
      '| 产品编码 | 适用车型 | 内管直径 | 零售价 |', '| --- | --- | --- | --- |',
      '| 01A0350 | XMAX | 33MM | 4289元（黑银）/ 4969元（黑金） |',
      '- 高强度锻造底座'
    ].join('\n');
    const upload = await fetch(`${base}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'products', files: [{ name: 'new-products.md', data: Buffer.from(markdown).toString('base64') }] }) });
    assert.equal(upload.status, 200);
    const { imported: [item] } = await upload.json();
    assert.equal(item.organizedProducts, 1);
    assert.equal(item.table[1][3], '4289 元（黑银）/ 4969 元（黑金）');
    const result = await ask('Q77 XMAX 前减震多少钱？');
    assert.equal(result.productMatches[0].title, 'Q77 XMAX 前减震');
    assert.match(result.answer, /4289 元（黑银）.*4969 元（黑金）/);
    assert.ok(result.sources.some(source => source.file === item.file));
    const update = await fetch(`${base}/api/imported/update`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: item.file, rows: [item.table[0], item.table[1].map((value, index) => index === 3 ? '4500 元（黑银）' : value)] }) });
    assert.equal(update.status, 200);
    assert.match((await ask('Q77 XMAX 前减震多少钱？')).answer, /4500 元（黑银）/);
    assert.match(await require('node:fs/promises').readFile(join(workdir, item.file), 'utf8'), /4289 元（黑银）/);
    const { default: XLSX } = await import('xlsx');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['产品', '问题', '回复'],
      ['VD后减震器', 'VD减震的弹簧线径是多少', 'VD减震的出厂弹簧线径是6.5'],
      ['VD后减震器', 'VD减震的弹簧磅数是多少', '标配50磅，附赠40磅'],
      ['FD前减震', 'NMAX装FD前减震需要换什么', '需要核对V3挡泥板和267mm刹车盘'],
      ['S26卡钳', '极核的ae8可以装吗？', '装不了，需核对其他卡钳的安装规格。'],
      ['R34卡钳', '车型pcx160 能用哪个卡钳', 'PCX160 可以选用 R34 的卡钳。'],
      ['A3油壶', 'RCS可以用这个油壶吗', '可以的']
    ]), '问答');
    const faqUpload = await fetch(`${base}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'knowledge', files: [{ name: '客服问答.xlsx', data: XLSX.write(book, { type: 'base64', bookType: 'xlsx' }) }] }) });
    assert.equal(faqUpload.status, 200);
    const { imported: [faqFile] } = await faqUpload.json();
    assert.equal(faqFile.chunks, 6);
    for (const question of ['VD减震的弹簧线径是多少', 'VD避震原厂弹簧线有多粗？']) {
      const faq = await ask(question);
      assert.equal(faq.retrieval, 'imported-faq');
      assert.equal(faq.sources[0].title, 'VD减震的弹簧线径是多少');
      assert.match(faq.answer, /6\.5/);
    }
    assert.notEqual((await ask('S3减震的弹簧线径是多少')).retrieval, 'imported-faq');
    assert.notEqual((await ask('NVX装FD前减震需要换什么')).retrieval, 'imported-faq');
    const ambiguous = await ask('极核的ae8可以装吗？');
    assert.equal(ambiguous.retrieval, 'clarify-product');
    assert.match(ambiguous.answer, /哪款配件/);
    assert.deepEqual(ambiguous.sources, []);
    assert.deepEqual(ambiguous.basis.sources, []);
    const scoped = await ask('极核的ae8可以装吗？', [{ role: 'user', content: '我在看S26卡钳' }]);
    assert.equal(scoped.retrieval, 'imported-faq');
    assert.equal(scoped.basis.product, 'S26');
    assert.equal(scoped.basis.inherited, true);
    assert.equal(scoped.basis.sources[0], '对应的客服问答');
    assert.equal(scoped.basis.route, 'imported-faq');
    assert.deepEqual(scoped.basis.references[0].fields, ['AE8', 'S26']);
    assert.match(scoped.answer, /^装不了/);
    const wrongProduct = await ask('极核的ae8可以装吗？', [{ role: 'user', content: '我在看R1卡钳' }]);
    assert.equal(wrongProduct.retrieval, 'fitment-unverified');
    assert.doesNotMatch(wrongProduct.answer, /装不了|S26/);
    const priced = await ask('多少钱？', [{ role: 'user', content: '我在看 XMAX 300 的 VD 后减震' }]);
    assert.equal(priced.basis.intent, '商品询价');
    assert.equal(priced.basis.product, 'VD');
    assert.equal(priced.basis.vehicle, 'XMAX 300');
    assert.equal(priced.basis.inherited, true);
    assert.equal(priced.basis.vehicleInherited, true);
    assert.deepEqual(priced.productMatches.map(product => product.title), ['RCB VD XMAX 后减震']);
    const pcxQuestion = '车型pcx160 能用哪个卡钳';
    const pcx = await ask(pcxQuestion);
    assert.equal(pcx.retrieval, 'imported-faq');
    assert.match(pcx.answer, /R34/i);
    const pcxFollowUp = await ask('R34', [
      { role: 'user', content: pcxQuestion }, { role: 'assistant', content: '您看的是哪款卡钳？' }
    ]);
    assert.equal(pcxFollowUp.retrieval, 'imported-faq');
    assert.equal(pcxFollowUp.basis.vehicle, 'PCX160');
    assert.equal(pcxFollowUp.basis.vehicleInherited, true);
    assert.equal(pcxFollowUp.basis.product, 'R34');
    assert.match(pcxFollowUp.answer, /R34/i);
    const rcsThread = [{ role: 'user', content: 'RCS可以用这个油壶吗' }, { role: 'assistant', content: '您看的是哪款油壶？' }];
    for (const followUp of ['A3', '是A3油壶']) {
      const rcs = await ask(followUp, rcsThread);
      assert.equal(rcs.retrieval, 'imported-faq');
      assert.match(rcs.answer, /RCS.*A3/);
      assert.deepEqual(rcs.basis.references[0].fields, ['RCS', 'A3', '油壶']);
      assert.doesNotMatch(rcs.answer, /通用|未确认/);
    }
    const otherPump = await ask('A3', [{ role: 'user', content: 'GTS可以用这个油壶吗' }]);
    assert.equal(otherPump.retrieval, 'fitment-unverified');
    const dimension = await ask('VD', [{ role: 'user', content: '弹簧线径是多少？' }]);
    assert.equal(dimension.retrieval, 'imported-faq');
    assert.match(dimension.answer, /6\.5/);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await new Promise(resolve => provider.close(resolve));
    await rm(workdir, { recursive: true, force: true });
  }
});
