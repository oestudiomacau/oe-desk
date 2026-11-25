(() => {
  const platformNames = { douyin: '飞鸽', tmall: '天猫千牛' };
  const supportedChannel = item => Object.hasOwn(platformNames, item.platform);
  const statusNames = {
    sent: '已确认发送', verifying: '待核验发送结果', needs_human: '待人工处理', error: '处理失败',
    received: '已收到', processing: '处理中', auto_queued: '已进入发送队列', superseded: '已有更新消息', handled: '已处理'
  };
  const views = { gallery, review, notifications, rules, associations, 'learning-assets': learningAssets };
  let selectedReview = null;

  async function request(path, method = 'GET', body) {
    const response = await fetch(path.startsWith('/') ? path : '/api/workbench/' + path, {
      method, cache: 'no-store', headers: { 'content-type': 'application/json', 'x-oe-desk': 'workbench' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '操作失败');
    return data;
  }

  function element(tag, value, className) {
    const node = document.createElement(tag);
    if (value) node.textContent = value;
    if (className) node.className = className;
    return node;
  }

  let latestLearningSummary = null;
  const assetTabs = { overview: '总览', knowledge: '商品知识', experience: '客服经验', review: '待核验' };
  const assetKinds = {
    published: { label: '自动入库', color: 'green', reason: '识别为可复用的知识，已加入客服问答知识库。' },
    confirmed: { label: '确认入库', color: 'green', reason: '人工确认后加入了客服问答知识库。' },
    linked: { label: '已关联', color: 'green', reason: '已有对应问答，这条记录关联到原有资料。' },
    known: { label: '已覆盖', color: 'neutral', reason: '已有资料覆盖该问题，无需重复入库。' },
    style: { label: '表达参考', color: 'neutral', reason: '用于学习人工回复的表达和追问方式。' },
    conflict: { label: '资料冲突', color: 'amber', reason: '这条回复与已有资料或同批学习记录有出入，需要核对。' },
    removed: { label: '链接失效', color: 'amber', reason: '原入库问答已不在客服问答知识库，请核对资料。' },
    review: { label: '待核验', color: 'amber', reason: '当前记录缺少可直接入库的依据。' }
  };
  const getAssetKind = sample => {
    if (sample.knowledgeId) {
      if (sample.knowledge === null) return 'removed';
      if (sample.decision === 'known') return 'linked';
      return sample.decision === 'published' ? 'published' : 'confirmed';
    }
    return ['known', 'style', 'conflict'].includes(sample.decision) ? sample.decision : 'review';
  };
  const assetSource = sample => sample.source === 'history' ? '历史会话' : '人工回复';
  const assetTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
  const assetBadge = sample => {
    const kind = assetKinds[getAssetKind(sample)];
    return element('span', kind.label, 'asset-badge ' + kind.color);
  };

  async function learningAssets(content, status, options = {}) {
    content.classList.add('asset-center');
    status.classList.add('asset-status');
    const header = element('div', '', 'asset-header');
    const tabs = element('nav', '', 'asset-tabs');
    tabs.setAttribute('aria-label', '资产分类');
    const actions = element('div', '', 'asset-actions');
    const overview = element('section', '', 'asset-overview');
    const metrics = element('div', '', 'asset-metrics');
    const summary = element('section', '', 'asset-summaries');
    const recent = element('section', '', 'asset-recent');
    const browser = element('section', '', 'asset-browser');
    const filters = element('div', '', 'asset-filters');
    const source = select({ all: '全部来源', live: '人工回复', history: '历史会话' }, 'all', '按来源筛选');
    const query = element('input');
    query.type = 'search';
    query.placeholder = '搜索型号、问题或回复';
    query.setAttribute('aria-label', '搜索资产');
    const resultCount = element('small', '', 'asset-result-count');
    const rows = element('div', '', 'asset-rows');
    const listing = element('section', '', 'asset-listing');
    const detail = element('section', '', 'asset-detail');
    detail.setAttribute('aria-label', '资产详情');
    const pageSize = 25;
    let tab = 'overview';
    let selectedId = '';
    let limit = pageSize;
    let samples = [];
    let version;
    let refreshing;
    const tabButtons = new Map();

    function entries(section) {
      if (section === 'knowledge') return samples.filter(sample => ['published', 'confirmed', 'linked', 'known'].includes(getAssetKind(sample)));
      if (section === 'experience') return samples.filter(sample => sample.source !== 'history');
      return samples.filter(sample => ['conflict', 'removed', 'review'].includes(getAssetKind(sample)));
    }

    function showTab(next, sampleId = '') {
      tab = next;
      selectedId = sampleId;
      limit = pageSize;
      if (sampleId) {
        query.value = '';
        source.value = 'all';
      }
      render();
    }

    for (const [name, label] of Object.entries(assetTabs)) {
      const control = button(label, () => showTab(name), status, 'asset-tab');
      tabButtons.set(name, control);
      tabs.append(control);
    }

    function renderOverview() {
      metrics.replaceChildren();
      const cards = [
        ['knowledge', '商品知识', entries('knowledge').length, '已入库或已有资料覆盖'],
        ['experience', '客服经验', entries('experience').length, '人工回复的表达和追问'],
        ['review', '待核验', entries('review').length, '待补依据、冲突或失效链接']
      ];
      for (const [target, label, total, description] of cards) {
        const card = button('', () => showTab(target), status, 'asset-metric');
        card.append(element('span', label), element('strong', String(total)), element('small', description));
        metrics.append(card);
      }

      recent.replaceChildren(element('h2', '最近学习'));
      if (!samples.length) {
        recent.append(element('p', '还没有学习记录。可读取飞鸽历史，或在自学习模式下发送人工回复。', 'asset-empty'));
      }
      for (const sample of samples.slice(0, 5)) {
        const target = getAssetKind(sample) === 'style' ? 'experience'
          : entries('review').includes(sample) ? 'review' : 'knowledge';
        recent.append(sampleRow(sample, () => showTab(target, sample.id)));
      }
      renderSummary(latestLearningSummary);
    }

    function sampleRow(sample, action) {
      const row = button('', action, status, 'asset-row');
      row.dataset.assetId = sample.id;
      row.append(element('strong', sample.question), assetBadge(sample),
        element('small', [platformNames[sample.platform], assetSource(sample), assetTime(sample.learnedAt)].join(' · ')));
      return row;
    }

    function renderBrowser() {
      const normalize = value => String(value || '').normalize('NFKC').toLowerCase();
      const terms = normalize(query.value).trim().split(/\s+/).filter(Boolean);
      const visible = entries(tab).filter(sample => {
        if (source.value !== 'all' && (sample.source || 'live') !== source.value) return false;
        const text = normalize([sample.question, sample.answer, ...(sample.models || []), sample.knowledge?.question, sample.knowledge?.answer].join(' '));
        return terms.every(term => text.includes(term));
      });
      if (!visible.some(sample => sample.id === selectedId)) selectedId = visible[0]?.id || '';
      const selected = visible.find(sample => sample.id === selectedId);
      const focusedId = rows.contains(document.activeElement) && document.activeElement.dataset.assetId;
      const scroll = rows.scrollTop;
      rows.replaceChildren();
      resultCount.textContent = '共 ' + visible.length + ' 条';
      if (!visible.length) rows.append(element('p', '没有符合条件的记录。', 'asset-empty'));
      const selectedIndex = visible.findIndex(sample => sample.id === selectedId);
      if (selectedIndex >= limit) limit = Math.ceil((selectedIndex + 1) / pageSize) * pageSize;
      for (const sample of visible.slice(0, limit)) {
        const row = sampleRow(sample, () => {
          selectedId = sample.id;
          for (const item of rows.querySelectorAll('[data-asset-id]')) {
            item.setAttribute('aria-pressed', String(item.dataset.assetId === selectedId));
          }
          renderDetail(sample);
          if (window.matchMedia?.('(max-width: 920px)').matches) detail.scrollIntoView?.({ block: 'nearest' });
        });
        row.setAttribute('aria-pressed', String(sample === selected));
        rows.append(row);
      }
      if (limit < visible.length) rows.append(button('加载更多', () => {
        limit += pageSize;
        renderBrowser();
      }, status, 'quiet-button asset-more'));
      rows.scrollTop = scroll;
      if (focusedId) [...rows.children].find(row => row.dataset.assetId === focusedId)?.focus({ preventScroll: true });
      renderDetail(selected);
    }

    function renderDetail(sample) {
      detail.replaceChildren();
      if (!sample) {
        detail.append(element('p', '筛选后可在这里查看问答和处理结果。', 'asset-empty'));
        return;
      }
      const kind = getAssetKind(sample);
      detail.append(assetBadge(sample), element('h2', sample.question),
        element('p', assetKinds[kind].reason, 'asset-detail-reason'));
      const fields = element('dl', '', 'asset-fields');
      const values = [
        ['学习来源', platformNames[sample.platform] + ' · ' + assetSource(sample)],
        ['学习时间', assetTime(sample.learnedAt)]
      ];
      if (sample.models?.length) values.push(['识别型号', sample.models.join('、')]);
      if (sample.knowledge?.category) values.push(['知识分类', sample.knowledge.category]);
      if (sample.publishedAt && sample.knowledge) values.push(['关联时间', assetTime(sample.publishedAt)]);
      for (const [label, value] of values) fields.append(element('dt', label), element('dd', value));
      detail.append(fields, detailBlock('采集到的回复', sample.answer));
      if (sample.source !== 'history') {
        detail.append(detailBlock('表达参考', '回复 ' + sample.replyLength + ' 字 · ' +
          (sample.asksFollowUp ? '以追问收尾' : '直接回答')));
      }
      if (sample.knowledge && (sample.answer !== sample.knowledge.answer || sample.question !== sample.knowledge.question)) {
        detail.append(detailBlock('知识库当前问答', [sample.knowledge.question, sample.knowledge.answer].join('\n')));
      }
      if (sample.knowledge && options.openKnowledge) detail.append(button('查看知识库问答', () =>
        options.openKnowledge(sample.knowledgeId), status));
      if (kind === 'review') detail.append(button('确认入库', async () => {
        await request('self-learning/publish', 'POST', { id: sample.id });
        await refresh(true);
        status.textContent = '已加入客服问答知识库。';
        showTab('knowledge', sample.id);
      }, status, 'primary'));
    }

    function detailBlock(title, text) {
      const block = element('div', '', 'asset-detail-block');
      block.append(element('h3', title), element('p', text));
      return block;
    }

    function renderSummary(report) {
      summary.replaceChildren();
      if (!report) {
        summary.append(element('p', '点击「生成学习总结」查看两类来源的学习结果。', 'asset-empty'));
        return;
      }
      for (const group of report.sources) {
        const card = element('article', '', 'asset-summary');
        card.append(element('h2', group.source === 'history' ? '历史会话总结' : '人工回复总结'));
        const values = ['学习 ' + group.learned, '入库 ' + group.published, '已覆盖 ' + group.known, '待核验 ' + group.review];
        card.append(element('p', values.join(' · '), 'asset-summary-stats'));
        if (group.source === 'live' && group.learned) {
          card.append(element('p', '回复长度中位数 ' + group.medianReplyLength + ' 字 · ' + group.followUps + ' 条以追问收尾'));
          const fields = (group.followUpFields || []).map(({ field, count }) => field + ' ' + count + ' 次');
          if (fields.length) card.append(element('p', '常追问的信息 · ' + fields.join(' · ')));
        }
        const facts = element('ul');
        for (const fact of group.examples) {
          const item = element('li');
          item.append(element('strong', fact.question), element('p', fact.answer));
          facts.append(item);
        }
        if (facts.childElementCount) card.append(facts);
        summary.append(card);
      }
      summary.append(element('small', '生成于 ' + assetTime(report.generatedAt), 'asset-summary-time'));
    }

    function render() {
      for (const [name, control] of tabButtons) {
        control.setAttribute('aria-pressed', String(name === tab));
        control.classList.toggle('active', name === tab);
      }
      overview.hidden = tab !== 'overview';
      browser.hidden = tab === 'overview';
      if (tab === 'overview') renderOverview();
      else renderBrowser();
    }

    function refresh(afterWrite = false) {
      if (refreshing) return afterWrite ? refreshing.catch(() => {}).then(() => refresh()) : refreshing;
      refreshing = request('self-learning').then(data => {
        const next = data.samples.filter(sample => supportedChannel(sample) && sample.decision !== 'skipped');
        const nextVersion = JSON.stringify(next);
        if (nextVersion !== version) {
          samples = next;
          version = nextVersion;
          render();
        }
      }).finally(() => { refreshing = null; });
      return refreshing;
    }

    for (const [control, event] of [[query, 'input'], [source, 'change']]) {
      control.addEventListener(event, () => { limit = pageSize; renderBrowser(); });
    }
    const scan = button('读取飞鸽历史记录', async () => {
      if (!window.rcbElectron?.readFeigeHistory) throw new Error('请在 OE DESK 桌面版读取已登录账号的历史。');
      status.textContent = '正在读取当前飞鸽账号已加载的会话…';
      const result = await window.rcbElectron.readFeigeHistory();
      await refresh(true);
      status.textContent = result.conversations
        ? '已读取 ' + result.conversations + ' 个会话，新增 ' + result.added +
          ' 条学习记录，自动入库 ' + result.published + ' 条。' + (result.partial ? '本次读取了部分会话。' : '')
        : '未读取到可用会话。请在飞鸽打开一条会话后重试。';
    }, status, 'primary');
    scan.title = '读取当前会话及已加载的已读会话';
    actions.append(scan, button('生成学习总结', async () => {
      status.textContent = '正在生成总结…';
      latestLearningSummary = await request('learning-assets/summary', 'POST');
      await refresh(true);
      showTab('overview');
      status.textContent = '学习总结已更新。';
    }, status));
    header.append(tabs, actions, status);
    overview.append(metrics, summary, recent);
    filters.append(query, source);
    listing.append(resultCount, rows);
    browser.append(filters, listing, detail);
    content.append(header, overview, browser);
    browser.hidden = true;
    const timer = setInterval(() => {
      if (!content.isConnected) { clearInterval(timer); return; }
      if (content.getClientRects().length) refresh().catch(error => { status.textContent = error.message; });
    }, 3500);
    await refresh();
    if (status.textContent === '正在读取…') status.textContent = '';
  }

  function button(label, action, status, className = 'quiet-button') {
    const node = element('button', label, className);
    node.type = 'button';
    node.addEventListener('click', async () => {
      node.disabled = true;
      try { await action(); }
      catch (error) { status.textContent = error.message; }
      finally { node.disabled = false; }
    });
    return node;
  }

  function render(body, name, options) {
    const panel = element('section', '', 'workspace-card operations-panel');
    const status = element('p', '正在读取…');
    status.setAttribute('role', 'status');
    const content = element('div', '', 'operations-content');
    panel.append(content, status);
    body.replaceChildren(panel);
    void (async () => {
      try { await views[name](content, status, options); }
      catch (error) { status.textContent = error.message; }
    })();
  }

  function gallery(content, status) {
    const upload = element('input');
    upload.type = 'file';
    upload.accept = 'image/png,image/jpeg,image/webp';
    upload.setAttribute('aria-label', '选择素材图片');
    const cards = element('div', '', 'operations-gallery');
    const preview = element('div', '', 'operations-preview');
    content.append(upload, button('上传图片', async () => {
      const file = upload.files[0];
      if (!file || file.size > 2 * 1024 * 1024) throw new Error('请选择不超过 2 MB 的图片。');
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('无法读取图片。'));
        reader.readAsDataURL(file);
      });
      show(await request('assets', 'POST', { name: file.name, data }));
      upload.value = '';
      status.textContent = '图片已保存';
    }, status, 'primary'), cards, preview);

    function show(assets) {
      cards.replaceChildren();
      preview.replaceChildren();
      status.textContent = assets.length ? '' : '暂无素材。上传 PNG、JPEG 或 WebP 图片。';
      for (const asset of assets) {
        const item = element('article', '', 'operations-entry');
        item.append(element('strong', asset.name), element('p', Math.ceil(asset.size / 1024) + ' KB'));
        item.append(button('预览与下载', async () => {
          const { data, type } = await request('assets/' + asset.id);
          const image = element('img');
          image.alt = asset.name;
          image.src = 'data:image/' + type + ';base64,' + data;
          const download = element('a', '下载原图', 'quiet-button');
          download.href = image.src;
          download.download = asset.name;
          preview.replaceChildren(image, download);
        }, status), button('删除', async () => {
          if (!window.confirm('删除「' + asset.name + '」？')) return;
          show(await request('assets/' + asset.id, 'DELETE'));
        }, status));
        cards.append(item);
      }
    }
    return request('assets').then(show);
  }

  function heading(item) {
    const time = item.at ? new Date(item.at).toLocaleString('zh-CN') : '';
    return element('small', [platformNames[item.platform], statusNames[item.status] || '待同步', item.rule, time].filter(Boolean).join(' · '));
  }

  async function review(content, status) {
    const selected = selectedReview;
    selectedReview = null;
    const list = element('div', '', 'operations-list');
    const filter = select({ all: '全部渠道', ...platformNames }, 'all', '复盘渠道');
    const outcome = select({ all: '全部状态', sent: '已发送', needs_human: '待人工处理', error: '处理失败', verifying: '待核验' }, 'all', '复盘状态');
    let history = [];
    function show() {
      list.replaceChildren();
      const rows = history.filter(item => (filter.value === 'all' || filter.value === item.platform)
        && (outcome.value === 'all' || outcome.value === item.status));
      status.textContent = rows.length ? '' : '没有符合筛选条件的会话记录。';
      for (const item of rows) {
        const entry = element('article', '', 'operations-entry');
        const question = element('textarea');
        question.value = item.question;
        question.maxLength = 600;
        question.rows = 2;
        question.setAttribute('aria-label', '客户问法，可编辑');
        entry.append(heading(item), question);
        const answer = element('textarea');
        answer.value = item.answer;
        answer.maxLength = 2000;
        answer.rows = 2;
        answer.placeholder = '填写可复用的客服回复';
        answer.setAttribute('aria-label', '复盘后的客服回复');
        const feedback = element('p');
        entry.append(answer, button('保存为训练问答', async () => {
          if (!answer.value.trim()) throw new Error('请先填写客服回复。');
          await request('/api/training/knowledge', 'POST', { platform: item.platform, question: question.value, answer: answer.value });
          feedback.textContent = '已保存并更新知识库';
        }, feedback, 'primary'), feedback);
        list.append(entry);
      }
    }
    const load = async () => {
      const data = await request('history');
      const selectedItem = selected && [...data.history, ...data.notifications].find(item => item.platform === selected.platform && item.id === selected.id);
      history = (selectedItem
        ? [selectedItem, ...data.history.filter(item => item.platform !== selectedItem.platform || item.id !== selectedItem.id)]
        : data.history).filter(supportedChannel);
      show();
    };
    filter.addEventListener('change', show);
    outcome.addEventListener('change', show);
    content.append(filter, outcome, button('刷新', load, status), list);
    await load();
  }

  function noticeKey(item) { return [item.platform, item.id, item.status].join(':'); }

  function readNotices() {
    try { return new Set(JSON.parse(localStorage.getItem('rcb-workbench-notices-read') || '[]')); }
    catch { return new Set(); }
  }

  function updateBadge(items) {
    const badge = document.getElementById('operations-notice-count');
    const read = readNotices();
    const count = items.filter(item => supportedChannel(item) && !read.has(noticeKey(item))).length;
    badge.textContent = count ? ' ' + count : '';
  }

  async function notifications(content, status) {
    const list = element('div', '', 'operations-list');
    let items = [];
    function show() {
      list.replaceChildren();
      updateBadge(items);
      const read = readNotices();
      status.textContent = items.length ? '' : '暂无待人工处理、失败或待核验的消息。';
      for (const item of items) {
        const entry = element('article', '', 'operations-entry');
        const key = noticeKey(item);
        entry.append(heading(item), element('p', item.question));
        if (!read.has(key)) entry.append(button('标为已读', () => {
          read.add(key);
          localStorage.setItem('rcb-workbench-notices-read', JSON.stringify([...read].slice(-500)));
          show();
        }, status));
        else entry.append(element('small', '已读'));
        entry.append(button('查看复盘', () => {
          selectedReview = item;
          document.querySelector('[data-workspace="review"]').click();
        }, status));
        const platform = document.querySelector('[data-client="' + item.platform + '"]');
        if (platform) entry.append(button('打开' + platformNames[item.platform], () => {
          document.querySelector('[data-workspace="workbench"]').click();
          platform.click();
        }, status));
        list.append(entry);
      }
    }
    async function load() {
      ({ notifications: items } = await request('notifications'));
      items = items.filter(supportedChannel);
      show();
    }
    content.append(button('刷新', load, status), list);
    await load();
  }

  function select(options, value, label) {
    const node = element('select');
    node.setAttribute('aria-label', label);
    for (const [key, title] of Object.entries(options)) {
      const option = element('option', title);
      option.value = key;
      node.append(option);
    }
    node.value = value;
    return node;
  }

  async function rules(content, status) {
    const list = element('div', '', 'operations-list');
    const fields = new Map();
    function add(rule = {}) {
      const row = element('article', '', 'operations-entry operations-rule');
      const name = element('input');
      name.value = rule.name || '';
      name.maxLength = 60;
      name.placeholder = '规则名称';
      name.setAttribute('aria-label', name.placeholder);
      const keywords = element('input');
      keywords.value = rule.words?.join('、') || '';
      keywords.placeholder = '关键词，用顿号隔开';
      keywords.setAttribute('aria-label', '关键词');
      const platform = select({ all: '所有已接入渠道', douyin: '飞鸽' }, rule.platform || 'douyin', '生效渠道');
      const action = select({ handoff: '转人工处理', reply: '固定回复' }, rule.action || 'handoff', '命中后执行');
      const answer = element('textarea');
      answer.value = rule.answer || '';
      answer.maxLength = 200;
      answer.placeholder = '输入固定回复';
      answer.setAttribute('aria-label', answer.placeholder);
      answer.hidden = action.value !== 'reply';
      action.addEventListener('change', () => { answer.hidden = action.value !== 'reply'; });
      const enabledLabel = element('label', '启用 ');
      const enabled = element('input');
      enabled.type = 'checkbox';
      enabled.checked = rule.enabled !== false;
      enabledLabel.append(enabled);
      fields.set(row, () => ({ name: name.value, keywords: keywords.value, platform: platform.value,
        action: action.value, answer: answer.value, enabled: enabled.checked }));
      row.append(name, keywords, platform, action, enabledLabel, answer, button('移除', () => {
        fields.delete(row);
        row.remove();
        status.textContent = '请保存规则以应用更改。';
      }, status));
      list.append(row);
    }
    const current = await request('rules');
    const visible = current.filter(rule => ['all', 'douyin'].includes(rule.platform));
    const hidden = current.filter(rule => !visible.includes(rule)).map(rule => ({ ...rule, keywords: rule.words.join('、') }));
    visible.forEach(add);
    content.append(button('新增规则', () => add(), status), button('保存规则', async () => {
      await request('rules', 'PUT', [...hidden, ...[...fields.values()].map(read => read())]);
      status.textContent = '已保存，对后续收到的消息生效。';
    }, status, 'primary'), list);
    status.textContent = visible.length ? '' : '暂无规则。';
  }

  async function associations(content, status) {
    const data = await request('associations');
    let { aliases } = data;
    const targets = new Map(data.targets.map(target => [target.id, target]));
    const alias = element('input');
    alias.maxLength = 60;
    alias.placeholder = '商品或车型叫法，如 XMAX300';
    alias.setAttribute('aria-label', '客户叫法');
    const search = element('input');
    search.placeholder = '筛选目录目标';
    search.setAttribute('aria-label', '筛选目录目标');
    const target = select({ '': '选择目录目标' }, '', '关联目标');
    const preview = element('div', '', 'operations-list');
    const list = element('div', '', 'operations-list');

    function showTargets(selected = target.value) {
      const query = search.value.trim().toLowerCase();
      target.replaceChildren(new Option('选择目录目标', ''));
      for (const item of targets.values()) {
        if (item.id === selected || item.label.toLowerCase().includes(query)) {
          target.append(new Option(item.label, item.id));
        }
      }
      target.value = targets.has(selected) ? selected : '';
      showPreview();
    }

    function showPreview() {
      preview.replaceChildren();
      const matches = targets.get(target.value)?.products ?? [];
      if (!matches.length) return;
      const item = element('article', '', 'operations-entry');
      item.append(element('strong', '目录关联商品（' + matches.length + '）'));
      const names = element('ul');
      for (const name of matches) names.append(element('li', name));
      item.append(names);
      preview.append(item);
    }

    function showSaved() {
      list.replaceChildren();
      for (const item of aliases) {
        const entry = element('article', '', 'operations-entry');
        const linked = targets.get(item.target);
        entry.append(element('strong', item.alias + ' → ' + (linked?.label || '目录目标已移除')));
        entry.append(button('编辑', () => {
          alias.value = item.alias;
          search.value = '';
          showTargets(item.target);
          alias.focus();
        }, status), button('删除', async () => {
          if (!window.confirm('删除「' + item.alias + '」的关联？')) return;
          ({ aliases } = await request('associations', 'DELETE', { alias: item.alias }));
          showSaved();
          status.textContent = '关联已删除';
        }, status));
        list.append(entry);
      }
    }

    search.addEventListener('input', () => showTargets());
    target.addEventListener('change', showPreview);
    content.append(alias, button('智能关联', async () => {
      const value = alias.value.trim();
      if (!value) throw new Error('请先输入客户叫法。');
      status.textContent = '正在匹配目录…';
      const suggestion = await request('associations/suggest', 'POST', { alias: value });
      if (alias.value.trim() !== value) { status.textContent = ''; return; }
      showTargets(suggestion.target || '');
      status.textContent = suggestion.target ? '已找到候选，核对目录商品后保存。' : '没有找到明确关联，可手动筛选目录目标。';
    }, status), search, target, button('保存关联', async () => {
      if (!alias.value.trim() || !target.value) throw new Error('请填写客户叫法并选择目录目标。');
      ({ aliases } = await request('associations', 'PUT', { alias: alias.value.trim(), target: target.value }));
      showSaved();
      status.textContent = '关联已保存，后续客服检索会使用。';
    }, status, 'primary'), preview, list);
    showTargets('');
    showSaved();
    status.textContent = '';
  }

  window.RcbWorkbenchOperations = { render, start() {
    const refresh = () => request('notifications').then(data => updateBadge(data.notifications)).catch(() => {});
    void refresh();
    setInterval(refresh, 10000);
  } };
})();
