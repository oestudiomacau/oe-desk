(() => {
  const STORAGE_KEY = 'rcb-workflow-canvas';
  const NODE_WIDTH = 202;
  const NODE_HEIGHT = 94;
  const WORLD_WIDTH = 3600;
  const WORLD_HEIGHT = 2200;
  const GRID_SIZE = 20;
  const MIN_ZOOM = 0.35;
  const MAX_ZOOM = 1.7;
  const EXECUTABLE_NODE_TYPES = new Set(['trigger', 'rag', 'knowledge', 'llm', 'extract', 'condition', 'classifier', 'delay', 'merge', 'variable', 'template', 'custom', 'reply', 'handoff', 'stop']);
  let mountedEditor = null;

  const nodeTypes = {
    trigger: {
      category: '触发器', role: 'trigger', input: false, quick: true,
      label: '触发器',
      icon: 'radio',
      color: 'green',
      title: '收到平台消息',
      description: '从已接入的店铺接收买家消息。',
      config: [
        { key: 'channel', label: '触发渠道', type: 'select', options: ['所有已接入店铺', '天猫', '抖音', '闲鱼'] },
        { key: 'event', label: '触发事件', type: 'select', options: ['收到新买家消息', '会话状态变化'] }
      ]
    },
    webhook: {
      category: '触发器', role: 'trigger', input: false,
      label: 'Webhook', icon: 'webhook', color: 'green', title: 'Webhook 事件',
      description: '收到外部系统事件后启动流程。',
      config: [
        { key: 'path', label: '事件路径', type: 'text', placeholder: '/events/order-updated' },
        { key: 'method', label: '请求方式', type: 'select', options: ['POST', 'GET'] },
        { key: 'note', label: '事件说明', type: 'textarea', placeholder: '说明事件来源、字段与使用边界' }
      ]
    },
    rag: {
      category: 'AI 与知识', quick: true,
      label: 'AI 处理',
      icon: 'bot',
      color: 'violet',
      title: 'RAG 检索与答复',
      description: '结合本地资料、提示词和启用的技能生成答复草稿。',
      config: [
        { key: 'strategy', label: '检索策略', type: 'select', options: ['本地 RAG 优先', '仅本地知识', '联网参考兜底'] },
        { key: 'prompt', label: '输出指令', type: 'text', placeholder: '例如：简洁说明并保留证据边界' }
      ]
    },
    knowledge: {
      category: 'AI 与知识',
      label: '知识检索', icon: 'database-zap', color: 'violet', title: '检索知识库',
      description: '按问题检索指定知识范围并输出证据。',
      config: [
        { key: 'scope', label: '检索范围', type: 'select', options: ['全部已启用知识', '商品事实库', '客服问答知识'] },
        { key: 'topK', label: '返回条数', type: 'number', default: 5, min: 1, max: 20 },
        { key: 'query', label: '检索表达式', type: 'text', placeholder: '{{customer.message}}' }
      ]
    },
    llm: {
      category: 'AI 与知识',
      label: '大模型', icon: 'sparkles', color: 'violet', title: '大模型生成',
      description: '使用模型和自定义指令生成结构化结果。',
      config: [
        { key: 'model', label: '模型', type: 'select', options: ['deepseek-flash'] },
        { key: 'system', label: '系统指令', type: 'textarea', placeholder: '填写此节点的角色、任务和输出约束' },
        { key: 'temperature', label: '创造性', type: 'number', default: 0.2, min: 0, max: 2, step: 0.1 }
      ]
    },
    extract: {
      category: 'AI 与知识',
      label: '信息提取', icon: 'scan-text', color: 'violet', title: '提取结构化信息',
      description: '从对话中提取车型、订单号或用户意图。',
      config: [
        { key: 'fields', label: '提取字段', type: 'textarea', placeholder: '例如：车型、年份、订单号，每行一个' },
        { key: 'missing', label: '字段缺失时', type: 'select', options: ['保留为空', '请求客户补充', '转入下一节点'] }
      ]
    },
    condition: {
      category: '逻辑控制', branching: true, quick: true,
      label: '条件判断',
      icon: 'git-branch',
      color: 'amber',
      title: '风险与证据判断',
      description: '按风险等级和检索证据决定回复或转人工。',
      config: [
        { key: 'condition', label: '通过条件', type: 'select', options: ['低风险且命中资料', '命中资料即可', '人工协同模式'] },
        { key: 'otherwise', label: '未通过处理', type: 'select', options: ['转人工', '生成草稿等待确认', '停止流程'] }
      ]
    },
    classifier: {
      category: '逻辑控制', branching: true,
      label: '意图分类', icon: 'tags', color: 'amber', title: '识别客户意图',
      description: '将消息分流到咨询、售后、适配或其他路径。',
      config: [
        { key: 'labels', label: '分类标签', type: 'textarea', placeholder: '商品咨询\n车型适配\n订单售后\n其他' },
        { key: 'fallback', label: '无法判断时', type: 'select', options: ['进入其他分支', '转人工', '停止流程'] }
      ]
    },
    delay: {
      category: '逻辑控制',
      label: '等待', icon: 'timer', color: 'amber', title: '等待指定时间',
      description: '在继续处理前等待一段时间。',
      config: [
        { key: 'duration', label: '等待时长', type: 'number', default: 5, min: 0, max: 86400 },
        { key: 'unit', label: '时间单位', type: 'select', options: ['秒', '分钟', '小时'] }
      ]
    },
    merge: {
      category: '逻辑控制',
      label: '合并', icon: 'combine', color: 'amber', title: '合并上游结果',
      description: '将多个上游结果整理为一个输出。',
      config: [
        { key: 'mode', label: '合并方式', type: 'select', options: ['等待全部上游', '任一上游完成', '按优先级选择'] },
        { key: 'separator', label: '文本分隔符', type: 'text', placeholder: '\\n' }
      ]
    },
    variable: {
      category: '数据处理',
      label: '变量', icon: 'braces', color: 'cyan', title: '设置流程变量',
      description: '创建、覆盖或映射流程中的变量。',
      config: [
        { key: 'name', label: '变量名称', type: 'text', placeholder: 'customer_intent' },
        { key: 'value', label: '变量值', type: 'textarea', placeholder: '{{previous.output}}' },
        { key: 'operation', label: '操作', type: 'select', options: ['设置', '追加', '删除'] }
      ]
    },
    template: {
      category: '数据处理',
      label: '文本模板', icon: 'text-cursor-input', color: 'cyan', title: '拼装文本内容',
      description: '使用变量和固定文案生成下一步输入。',
      config: [
        { key: 'template', label: '模板内容', type: 'textarea', placeholder: '客户问题：{{customer.message}}\n检索结果：{{knowledge.output}}' },
        { key: 'empty', label: '空变量处理', type: 'select', options: ['保留为空', '显示变量名', '停止流程'] }
      ]
    },
    http: {
      category: '工具调用',
      label: 'HTTP 请求', icon: 'globe-2', color: 'indigo', title: '调用外部接口',
      description: '配置接口地址、方法、请求头和请求体。',
      config: [
        { key: 'method', label: '请求方式', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        { key: 'url', label: '接口地址', type: 'text', placeholder: 'https://api.example.com/resource' },
        { key: 'headers', label: '请求头 JSON', type: 'textarea', placeholder: '{"content-type":"application/json"}' },
        { key: 'body', label: '请求体', type: 'textarea', placeholder: '{"question":"{{customer.message}}"}' }
      ]
    },
    code: {
      category: '工具调用',
      label: '代码处理', icon: 'square-code', color: 'indigo', title: '执行自定义逻辑',
      description: '编写数据转换或规则计算逻辑的配置草稿。',
      config: [
        { key: 'language', label: '语言', type: 'select', options: ['JavaScript'] },
        { key: 'code', label: '代码', type: 'textarea', placeholder: 'return { result: input };' },
        { key: 'timeout', label: '超时毫秒', type: 'number', default: 3000, min: 100, max: 30000 }
      ]
    },
    custom: {
      category: '自定义', custom: true,
      label: '自定义功能', icon: 'blocks', color: 'slate', title: '自定义功能节点',
      description: '定义自己的节点名称、输入输出和处理规则。',
      config: [
        { key: 'functionKey', label: '功能标识', type: 'text', placeholder: 'my_custom_action' },
        { key: 'instructions', label: '处理规则', type: 'textarea', placeholder: '说明此节点接收什么、执行什么、输出什么' },
        { key: 'inputs', label: '输入字段', type: 'textarea', placeholder: '每行一个输入字段，例如 question:string' },
        { key: 'outputs', label: '输出字段', type: 'textarea', placeholder: '每行一个输出字段，例如 answer:string' }
      ]
    },
    reply: {
      category: '动作与输出', terminal: true, output: false, quick: true,
      label: '回复动作',
      icon: 'send',
      color: 'blue',
      title: '提交回复草稿',
      description: '把生成结果交给人工确认或写入发送队列。',
      config: [
        { key: 'mode', label: '发送方式', type: 'select', options: ['人工确认后发送', 'AI 全托管队列', '仅保存草稿'] },
        { key: 'template', label: '附加文案', type: 'text', placeholder: '可选：发送前补充提醒' }
      ]
    },
    handoff: {
      category: '动作与输出', terminal: true, output: false, quick: true,
      label: '转人工',
      icon: 'headset',
      color: 'rose',
      title: '转入人工队列',
      description: '整理问题和证据边界后交给相应人工队列。',
      config: [
        { key: 'queue', label: '目标队列', type: 'select', options: ['技术核对', '售后订单', '人工确认'] },
        { key: 'note', label: '交接说明', type: 'text', placeholder: '例如：附上车型、订单或已命中资料' }
      ]
    },
    stop: {
      category: '动作与输出', terminal: true, output: false,
      label: '结束流程', icon: 'circle-stop', color: 'rose', title: '结束当前流程',
      description: '不发送内容，记录原因后结束此路径。',
      config: [
        { key: 'reason', label: '结束原因', type: 'textarea', placeholder: '说明为什么在此处结束流程' },
        { key: 'result', label: '结束状态', type: 'select', options: ['正常结束', '信息不足', '规则拦截'] }
      ]
    }
  };

  const escapeHtml = value => String(value ?? '').replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character]));
  const escapeAttr = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const nodeId = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  function defaultsFor(type) {
    const metadata = nodeTypes[type];
    return Object.fromEntries(metadata.config.map(field => [field.key, field.default ?? field.options?.[0] ?? (field.type === 'checkbox' ? false : '')]));
  }

  function makeNode(type, x, y) {
    const metadata = nodeTypes[type];
    return {
      id: nodeId(type),
      type,
      title: metadata.title,
      description: metadata.description,
      x: Math.round(x),
      y: Math.round(y),
      config: defaultsFor(type)
    };
  }

  function defaultFlow() {
    const trigger = makeNode('trigger', 320, 620);
    const rag = makeNode('rag', 650, 620);
    const condition = makeNode('condition', 980, 620);
    const reply = makeNode('reply', 1320, 470);
    const handoff = makeNode('handoff', 1320, 780);
    trigger.id = 'default-trigger';
    rag.id = 'default-rag';
    condition.id = 'default-condition';
    reply.id = 'default-reply';
    handoff.id = 'default-handoff';
    return {
      id: 'default-customer-reply',
      name: '客户消息自动处理',
      description: '对收到的客户消息进行检索、风险判断，并路由至回复或人工队列。',
      enabled: true,
      nodes: [trigger, rag, condition, reply, handoff],
      edges: [
        { id: 'default-edge-trigger-rag', from: trigger.id, to: rag.id, label: '' },
        { id: 'default-edge-rag-condition', from: rag.id, to: condition.id, label: '' },
        { id: 'default-edge-condition-reply', from: condition.id, to: reply.id, label: '低风险' },
        { id: 'default-edge-condition-handoff', from: condition.id, to: handoff.id, label: '需核对' }
      ]
    };
  }

  function createInitialState() {
    return { version: 1, activeFlowId: 'default-customer-reply', flows: [defaultFlow()] };
  }

  function normalizeNode(node) {
    if (!node || !nodeTypes[node.type]) return null;
    const metadata = nodeTypes[node.type];
    return {
      id: String(node.id || nodeId(node.type)),
      type: node.type,
      title: String(node.title || metadata.title),
      description: String(node.description || metadata.description),
      x: Number.isFinite(Number(node.x)) ? Number(node.x) : 480,
      y: Number.isFinite(Number(node.y)) ? Number(node.y) : 420,
      config: { ...defaultsFor(node.type), ...(node.config && typeof node.config === 'object' ? node.config : {}) }
    };
  }

  function normalizeState(value) {
    if (!value || !Array.isArray(value.flows) || !value.flows.length) return createInitialState();
    const flows = value.flows.map(flow => {
      const nodes = Array.isArray(flow.nodes) ? flow.nodes.map(normalizeNode).filter(Boolean) : [];
      const validIds = new Set(nodes.map(node => node.id));
      const knownPairs = new Set();
      const edges = Array.isArray(flow.edges)
        ? flow.edges.filter(edge => {
          if (!edge || !validIds.has(edge.from) || !validIds.has(edge.to) || edge.from === edge.to) return false;
          const pair = `${edge.from}:${edge.to}`;
          if (knownPairs.has(pair)) return false;
          knownPairs.add(pair);
          return true;
        }).map(edge => ({ id: String(edge.id || nodeId('edge')), from: edge.from, to: edge.to, label: String(edge.label || '') }))
        : [];
      return {
        id: String(flow.id || nodeId('flow')),
        name: String(flow.name || '未命名工作流'),
        description: String(flow.description || ''),
        enabled: flow.enabled === true,
        nodes,
        edges
      };
    }).filter(flow => flow.nodes.length);
    if (!flows.length) return createInitialState();
    const activeFlowId = flows.some(flow => flow.id === value.activeFlowId) ? value.activeFlowId : flows[0].id;
    return { version: 1, activeFlowId, flows };
  }

  class WorkflowCanvas {
    constructor(root) {
      this.root = root;
      this.state = this.load();
      this.selectedNodeId = null;
      this.selectedEdgeId = null;
      this.connectSourceId = null;
      this.connectionPreview = null;
      this.view = { x: 48, y: 24, zoom: 0.78 };
      this.snapToGrid = true;
      this.nodeQuery = '';
      this.history = [];
      this.future = [];
      this.historyInput = null;
      this.notice = '';
      this.validation = null;
      this.runtime = null;
      this.runtimePollTimer = null;
      this.saveTimer = null;
      this.persistTail = Promise.resolve();
      this.destroyed = false;
      this.boundRootClick = event => this.onRootClick(event);
      this.boundRootInput = event => this.onRootInput(event);
      this.boundRootFocusIn = event => this.onRootFocusIn(event);
      this.boundRootFocusOut = () => { this.historyInput = null; };
      this.boundKeyDown = event => this.onKeyDown(event);
      this.boundDragStart = event => this.onDragStart(event);
      this.root.addEventListener('click', this.boundRootClick);
      this.root.addEventListener('input', this.boundRootInput);
      this.root.addEventListener('focusin', this.boundRootFocusIn);
      this.root.addEventListener('focusout', this.boundRootFocusOut);
      this.root.addEventListener('keydown', this.boundKeyDown);
      this.root.addEventListener('dragstart', this.boundDragStart);
      this.render();
      this.fitToFlow();
      this.syncConfigFromServer();
      this.startRuntimePolling();
    }

    destroy() {
      this.destroyed = true;
      this.root.removeEventListener('click', this.boundRootClick);
      this.root.removeEventListener('input', this.boundRootInput);
      this.root.removeEventListener('focusin', this.boundRootFocusIn);
      this.root.removeEventListener('focusout', this.boundRootFocusOut);
      this.root.removeEventListener('keydown', this.boundKeyDown);
      this.root.removeEventListener('dragstart', this.boundDragStart);
      clearInterval(this.runtimePollTimer);
      clearTimeout(this.saveTimer);
      this.root.innerHTML = '';
    }

    load() {
      try { return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); }
      catch { return createInitialState(); }
    }

    save() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); }
      catch { /* The editor remains usable even when browser storage is unavailable. */ }
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.persistConfig(), 220);
    }

    async syncConfigFromServer() {
      let localDraft = null;
      try { localDraft = localStorage.getItem(STORAGE_KEY); } catch { /* Local storage can be unavailable. */ }
      try {
        const response = await fetch('/api/workflow/config', { cache: 'no-store' });
        if (!response.ok) throw new Error('工作流服务未就绪');
        const payload = await response.json();
        if (this.destroyed) return;
        if (payload.persisted || !localDraft) {
          this.state = normalizeState(payload.state);
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch { /* Keep the server state in memory. */ }
          this.selectedNodeId = null;
          this.selectedEdgeId = null;
          this.notice = payload.persisted ? '已载入本机正在执行的工作流配置。' : '已启用默认客户消息处理工作流。';
          this.render();
          this.fitToFlow();
          return;
        }
        // Previous versions stored canvas drafts only in localStorage. Preserve
        // them during the one-time migration, while ensuring the built-in flow
        // starts as an actual executable workflow instead of a decorative draft.
        if (!this.state.flows.some(flow => flow.enabled)) {
          const defaultItem = this.state.flows.find(flow => flow.id === 'default-customer-reply') || this.state.flows[0];
          if (defaultItem) defaultItem.enabled = true;
        }
        await this.persistConfig(true);
        this.notice = '已把原有画布迁移到本机工作流服务，自动回复将按启用流程执行。';
        this.render();
      } catch (error) {
        if (this.destroyed) return;
        this.notice = `工作流服务暂不可用：${error.message}`;
        const notice = this.root.querySelector('[data-workflow-notice]');
        if (notice) notice.textContent = this.notice;
      }
    }

    persistConfig(immediate = false) {
      if (immediate) clearTimeout(this.saveTimer);
      const snapshot = JSON.stringify(this.state);
      this.persistTail = this.persistTail.then(async () => {
        const response = await fetch('/api/workflow/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state: JSON.parse(snapshot) })
        });
        if (!response.ok) throw new Error('工作流保存失败');
        return response.json();
      }).catch(error => {
        this.notice = `本地画布已保存，但执行配置同步失败：${error.message}`;
        const notice = this.root.querySelector('[data-workflow-notice]');
        if (notice) notice.textContent = this.notice;
      });
      return this.persistTail;
    }

    startRuntimePolling() {
      clearInterval(this.runtimePollTimer);
      this.refreshRuntime();
      this.runtimePollTimer = setInterval(() => this.refreshRuntime(), 500);
    }

    async refreshRuntime() {
      try {
        const response = await fetch('/api/workflow/runtime', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = await response.json();
        if (this.destroyed) return;
        const flowId = this.activeFlow()?.id;
        this.runtime = Array.isArray(payload.runs) ? payload.runs.find(run => run.flowId === flowId) || null : null;
        this.updateRuntimeClasses();
      } catch { /* Runtime highlighting resumes automatically with the service. */ }
    }

    runtimeStatusForNode(node) {
      if (!this.runtime) return '';
      const step = this.runtime.steps?.find(item => item.nodeId === node.id)
        || (this.runtime.currentNodeType === node.type ? this.runtime.steps?.find(item => item.nodeType === node.type) : null);
      if (!step) return '';
      if (step.status === 'error') return 'runtime-error';
      if (step.status === 'running' && this.runtime.status === 'running') return 'runtime-running';
      if (step.status === 'completed') return 'runtime-completed';
      return '';
    }

    updateRuntimeClasses() {
      if (!this.nodesLayer) return;
      const flow = this.activeFlow();
      this.nodesLayer.querySelectorAll('[data-workflow-node]').forEach(element => {
        const node = flow.nodes.find(item => item.id === element.dataset.workflowNode);
        const status = node ? this.runtimeStatusForNode(node) : '';
        element.classList.toggle('runtime-running', status === 'runtime-running');
        element.classList.toggle('runtime-completed', status === 'runtime-completed');
        element.classList.toggle('runtime-error', status === 'runtime-error');
      });
      const runtimeLabel = this.root.querySelector('[data-workflow-runtime-status]');
      if (runtimeLabel) {
        if (!this.runtime) runtimeLabel.textContent = '等待客户消息';
        else if (this.runtime.status === 'running') runtimeLabel.textContent = `执行中 · ${this.runtime.steps?.at(-1)?.title || '准备处理'}`;
        else if (this.runtime.status === 'error') runtimeLabel.textContent = `执行失败 · ${this.runtime.error || '未知错误'}`;
        else runtimeLabel.textContent = `最近运行 · ${this.runtime.status === 'superseded' ? '已合并新消息' : '已完成'}`;
      }
    }

    activeFlow() {
      return this.state.flows.find(flow => flow.id === this.state.activeFlowId) || this.state.flows[0];
    }

    selectedNode() {
      return this.activeFlow().nodes.find(node => node.id === this.selectedNodeId) || null;
    }

    selectedEdge() {
      return this.activeFlow().edges.find(edge => edge.id === this.selectedEdgeId) || null;
    }

    nodeLibraryMarkup() {
      const groupOrder = ['触发器', 'AI 与知识', '数据处理', '逻辑控制', '工具调用', '动作与输出', '自定义'];
      const groups = groupOrder.map(label => ({ label, types: Object.keys(nodeTypes).filter(type => nodeTypes[type].category === label) }));
      const query = this.nodeQuery.trim().toLowerCase();
      return `<section class="workflow-node-library" aria-label="节点库">
        <div class="workflow-node-library-title"><span class="section-kicker">NODE LIBRARY</span><b>节点库</b></div>
        <label class="workflow-node-search"><i data-lucide="search"></i><input type="search" value="${escapeAttr(this.nodeQuery)}" placeholder="搜索节点" data-workflow-node-search></label>
        <div class="workflow-node-catalog">${groups.map(group => {
          const types = group.types.filter(type => {
            const item = nodeTypes[type];
            return !query || [item.label, item.title, item.description].join(' ').toLowerCase().includes(query);
          });
          if (!types.length) return '';
          return `<details class="workflow-node-group" open><summary><span>${group.label}</span><small>${types.length}</small><i data-lucide="chevron-down"></i></summary><div>${types.map(type => {
            const item = nodeTypes[type];
            return `<button type="button" draggable="true" data-workflow-add="${type}" title="${escapeAttr(item.title)}：拖到画布或点击添加"><i data-lucide="${item.icon}"></i><b>${item.label}</b></button>`;
          }).join('')}</div></details>`;
        }).join('') || '<p class="workflow-node-library-empty">没有匹配的节点</p>'}</div>
      </section>`;
    }

    minimapMarkup() {
      const flow = this.activeFlow();
      const width = 176;
      const height = 108;
      const scaleX = width / WORLD_WIDTH;
      const scaleY = height / WORLD_HEIGHT;
      const canvasWidth = this.canvas?.clientWidth || 720;
      const canvasHeight = this.canvas?.clientHeight || 460;
      const viewX = clamp(-this.view.x / this.view.zoom, 0, WORLD_WIDTH);
      const viewY = clamp(-this.view.y / this.view.zoom, 0, WORLD_HEIGHT);
      const viewWidth = clamp(canvasWidth / this.view.zoom, 0, WORLD_WIDTH);
      const viewHeight = clamp(canvasHeight / this.view.zoom, 0, WORLD_HEIGHT);
      return `<button type="button" class="workflow-minimap" data-workflow-minimap title="点击定位画布" aria-label="工作流缩略图，点击定位画布"><svg viewBox="0 0 ${width} ${height}" aria-hidden="true"><rect class="workflow-minimap-bg" width="${width}" height="${height}"></rect>${flow.edges.map(edge => {
        const from = flow.nodes.find(node => node.id === edge.from);
        const to = flow.nodes.find(node => node.id === edge.to);
        return from && to ? `<line x1="${(from.x + NODE_WIDTH / 2) * scaleX}" y1="${(from.y + NODE_HEIGHT / 2) * scaleY}" x2="${(to.x + NODE_WIDTH / 2) * scaleX}" y2="${(to.y + NODE_HEIGHT / 2) * scaleY}"></line>` : '';
      }).join('')}${flow.nodes.map(node => `<rect class="${node.id === this.selectedNodeId ? 'selected' : ''}" x="${node.x * scaleX}" y="${node.y * scaleY}" width="${Math.max(5, NODE_WIDTH * scaleX)}" height="${Math.max(4, NODE_HEIGHT * scaleY)}" rx="2"></rect>`).join('')}<rect class="workflow-minimap-viewport" x="${viewX * scaleX}" y="${viewY * scaleY}" width="${viewWidth * scaleX}" height="${viewHeight * scaleY}"></rect></svg></button>`;
    }

    render() {
      const flow = this.activeFlow();
      if (!flow.nodes.some(node => node.id === this.selectedNodeId)) this.selectedNodeId = null;
      this.root.innerHTML = `
        <section class="workflow-studio" aria-label="可视化工作流编辑器" tabindex="0">
          <aside class="workflow-library">
            <div class="workflow-library-head"><div><span class="section-kicker">WORKFLOWS</span><h2>工作流</h2></div><button class="icon-btn" type="button" data-workflow-action="new-flow" title="新建工作流"><i data-lucide="plus"></i></button></div>
            <div class="workflow-list">${this.state.flows.map(item => `<button type="button" class="workflow-list-item ${item.id === flow.id ? 'active' : ''}" data-workflow-flow="${escapeAttr(item.id)}"><span class="workflow-list-icon"><i data-lucide="${item.enabled ? 'play' : 'workflow'}"></i></span><span><b>${escapeHtml(item.name)}</b><small>${item.enabled ? '正在参与自动回复' : '未启用' } · ${item.nodes.length} 个节点</small></span></button>`).join('')}</div>
            ${this.nodeLibraryMarkup()}
            <div class="workflow-library-tip"><i data-lucide="server-cog"></i><span>配置自动同步到本机服务；已启用流程会直接处理新客户消息。</span></div>
          </aside>
          <section class="workflow-editor">
            <header class="workflow-toolbar">
              <div class="workflow-flow-summary"><span class="section-kicker">VISUAL FLOW</span><strong>${escapeHtml(flow.name)}</strong><span class="status-chip ${flow.enabled ? 'approved' : 'archived'}">${flow.enabled ? '执行中配置' : '未启用'}</span><span class="workflow-runtime-status" data-workflow-runtime-status>等待客户消息</span></div>
              <div class="workflow-toolbar-actions"><div class="workflow-history-actions"><button type="button" class="icon-btn" data-workflow-action="undo" title="撤销 Ctrl/⌘+Z" ${this.history.length ? '' : 'disabled'}><i data-lucide="undo-2"></i></button><button type="button" class="icon-btn" data-workflow-action="redo" title="重做 Ctrl/⌘+Shift+Z" ${this.future.length ? '' : 'disabled'}><i data-lucide="redo-2"></i></button></div><button type="button" class="quiet-button" data-workflow-action="layout" title="自动排版"><i data-lucide="git-fork"></i>自动排版</button><button type="button" class="quiet-button ${this.snapToGrid ? 'active' : ''}" data-workflow-action="snap" title="切换网格对齐"><i data-lucide="grid-3x3"></i>对齐</button><button type="button" class="quiet-button" data-workflow-action="validate" title="校验流程"><i data-lucide="shield-check"></i>校验流程</button><button type="button" class="quiet-button" data-workflow-action="fit" title="适应画布"><i data-lucide="scan"></i>适应画布</button><div class="workflow-zoom"><button type="button" class="icon-btn" data-workflow-action="zoom-out" title="缩小"><i data-lucide="minus"></i></button><span data-workflow-zoom>${Math.round(this.view.zoom * 100)}%</span><button type="button" class="icon-btn" data-workflow-action="zoom-in" title="放大"><i data-lucide="plus"></i></button></div></div>
            </header>
            <div class="workflow-node-tools" aria-label="添加节点">
              ${Object.entries(nodeTypes).filter(([, metadata]) => metadata.quick).map(([type, metadata]) => `<button type="button" data-workflow-add="${type}"><i data-lucide="${metadata.icon}"></i>添加${metadata.label}</button>`).join('')}
              <span class="workflow-more-nodes"><i data-lucide="panel-left"></i>更多节点可从左侧节点库拖入</span>
              ${this.connectSourceId ? `<span class="workflow-connect-hint"><i data-lucide="mouse-pointer-click"></i>正在连接「${escapeHtml(flow.nodes.find(node => node.id === this.connectSourceId)?.title || '')}」：点击目标节点或输入端</span>` : '<span class="workflow-connect-hint"><i data-lucide="mouse-pointer-click"></i>从节点右侧端口拖到目标左侧端口创建连线</span>'}
            </div>
            <div class="workflow-canvas" data-workflow-canvas aria-label="无限工作流画布。拖动空白处平移，滚轮缩放，拖动节点调整位置。">
              <div class="workflow-world" data-workflow-world>
                <svg class="workflow-connections" data-workflow-edges width="${WORLD_WIDTH}" height="${WORLD_HEIGHT}" viewBox="0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}" aria-hidden="true"></svg>
                <div class="workflow-node-layer" data-workflow-nodes></div>
              </div>
              ${this.minimapMarkup()}
              <div class="workflow-canvas-guide"><i data-lucide="move"></i><span>拖拽空白处平移 · 滚轮缩放</span></div>
            </div>
            <footer class="workflow-footer"><span data-workflow-notice>${escapeHtml(this.notice || '已启用流程会在后台持续处理新客户消息，打开画布时可查看实时执行节点。')}</span><span>${flow.nodes.length} 节点 · ${flow.edges.length} 连线 · Del 删除 · Ctrl/⌘ Z 撤销</span></footer>
          </section>
          <aside class="workflow-inspector" data-workflow-inspector></aside>
        </section>`;
      this.canvas = this.root.querySelector('[data-workflow-canvas]');
      this.world = this.root.querySelector('[data-workflow-world]');
      this.edgesLayer = this.root.querySelector('[data-workflow-edges]');
      this.nodesLayer = this.root.querySelector('[data-workflow-nodes]');
      this.inspector = this.root.querySelector('[data-workflow-inspector]');
      this.bindCanvas();
      this.syncCanvas();
      this.drawGraph();
      this.renderInspector();
      this.updateRuntimeClasses();
      globalThis.lucide?.createIcons?.();
    }

    syncCanvas() {
      // CSS transforms rasterise the whole node tree and make text fuzzy at
      // fractional zoom levels.  Chromium's layout zoom keeps each node and
      // SVG edge vector-rendered at the active scale instead.
      this.world.style.left = `${this.view.x / this.view.zoom}px`;
      this.world.style.top = `${this.view.y / this.view.zoom}px`;
      this.world.style.zoom = String(this.view.zoom);
      this.world.style.transform = 'none';
      const zoom = this.root.querySelector('[data-workflow-zoom]');
      if (zoom) zoom.textContent = `${Math.round(this.view.zoom * 100)}%`;
      this.updateMinimapViewport();
    }

    updateMinimapViewport() {
      const viewport = this.root.querySelector('.workflow-minimap-viewport');
      if (!viewport || !this.canvas) return;
      const scaleX = 176 / WORLD_WIDTH;
      const scaleY = 108 / WORLD_HEIGHT;
      viewport.setAttribute('x', String(clamp(-this.view.x / this.view.zoom, 0, WORLD_WIDTH) * scaleX));
      viewport.setAttribute('y', String(clamp(-this.view.y / this.view.zoom, 0, WORLD_HEIGHT) * scaleY));
      viewport.setAttribute('width', String(clamp(this.canvas.clientWidth / this.view.zoom, 0, WORLD_WIDTH) * scaleX));
      viewport.setAttribute('height', String(clamp(this.canvas.clientHeight / this.view.zoom, 0, WORLD_HEIGHT) * scaleY));
    }

    edgePath(from, to) {
      const startX = from.x + NODE_WIDTH;
      const startY = from.y + NODE_HEIGHT / 2;
      const endX = to.x;
      const endY = to.y + NODE_HEIGHT / 2;
      const bend = Math.max(74, Math.abs(endX - startX) * .46);
      return { startX, startY, endX, endY, middleX: (startX + endX) / 2, middleY: (startY + endY) / 2, d: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}` };
    }

    edgeMarkup(edge, nodesById) {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      if (!from || !to) return '';
      const path = this.edgePath(from, to);
      const selected = edge.id === this.selectedEdgeId ? ' selected' : '';
      return `<g class="workflow-edge${selected}" data-workflow-edge="${escapeAttr(edge.id)}"><path class="workflow-edge-hit" d="${path.d}"></path><path class="workflow-edge-line" d="${path.d}" marker-end="url(#workflow-arrow)"></path>${edge.label ? `<text x="${path.middleX}" y="${path.middleY - 9}">${escapeHtml(edge.label)}</text>` : ''}</g>`;
    }

    renderEdges() {
      const flow = this.activeFlow();
      const nodesById = new Map(flow.nodes.map(node => [node.id, node]));
      let markup = flow.edges.map(edge => this.edgeMarkup(edge, nodesById)).join('');
      if (this.connectionPreview) {
        const from = nodesById.get(this.connectionPreview.from);
        if (from) {
          const preview = this.edgePath(from, { x: this.connectionPreview.x, y: this.connectionPreview.y - NODE_HEIGHT / 2 });
          markup += `<path class="workflow-edge-preview ${this.connectionPreview.valid ? 'valid' : 'invalid'}" d="${preview.d}"></path>`;
        }
      }
      this.edgesLayer.innerHTML = markup + `<defs><marker id="workflow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 8 4 L 0 8 z"></path></marker></defs>`;
      this.edgesLayer.querySelectorAll('[data-workflow-edge]').forEach(edgeElement => edgeElement.addEventListener('click', event => {
        event.stopPropagation();
        this.root.querySelector('.workflow-studio')?.focus({ preventScroll: true });
        this.selectedEdgeId = edgeElement.dataset.workflowEdge;
        this.selectedNodeId = null;
        this.connectSourceId = null;
        this.updateEdgeSelection();
        this.renderInspector();
      }));
    }

    drawGraph() {
      const flow = this.activeFlow();
      const invalidNodeIds = new Set(this.validation?.invalidNodeIds || []);
      this.renderEdges();
      this.nodesLayer.innerHTML = flow.nodes.map(node => {
        const metadata = nodeTypes[node.type];
        const selected = node.id === this.selectedNodeId;
        const connecting = node.id === this.connectSourceId;
        const canInput = metadata.input !== false;
        const canOutput = metadata.output !== false;
        const runtimeStatus = this.runtimeStatusForNode(node);
        return `<article class="workflow-node ${metadata.color} ${selected ? 'selected' : ''} ${connecting ? 'connecting' : ''} ${invalidNodeIds.has(node.id) ? 'invalid' : ''} ${runtimeStatus}" data-workflow-node="${escapeAttr(node.id)}" style="transform:translate(${node.x}px, ${node.y}px)">
          <div class="workflow-node-head"><span class="workflow-node-icon"><i data-lucide="${metadata.icon}"></i></span><span class="workflow-node-type">${metadata.label}</span>${canInput ? `<button type="button" class="workflow-node-port in" data-workflow-port="in" data-workflow-port-node="${escapeAttr(node.id)}" aria-label="连接到 ${escapeAttr(node.title)}"></button>` : ''}${canOutput ? `<button type="button" class="workflow-node-port out" data-workflow-port="out" data-workflow-port-node="${escapeAttr(node.id)}" aria-label="从 ${escapeAttr(node.title)} 创建连线"></button>` : ''}</div>
          <strong data-workflow-node-title>${escapeHtml(node.title)}</strong><p data-workflow-node-description>${escapeHtml(node.description)}</p>
        </article>`;
      }).join('');
      this.nodesLayer.querySelectorAll('[data-workflow-node]').forEach(element => this.bindNodeDrag(element));
      this.nodesLayer.querySelectorAll('[data-workflow-port="out"]').forEach(element => this.bindOutputPort(element));
      this.nodesLayer.querySelectorAll('[data-workflow-port="in"]').forEach(element => this.bindInputPort(element));
      globalThis.lucide?.createIcons?.();
    }

    renderInspector() {
      const flow = this.activeFlow();
      const node = this.selectedNode();
      const edge = this.selectedEdge();
      const validation = this.validationMarkup();
      if (edge) {
        const source = flow.nodes.find(item => item.id === edge.from);
        const target = flow.nodes.find(item => item.id === edge.to);
        const canLabel = nodeTypes[source?.type]?.branching === true;
        this.inspector.innerHTML = `<div class="workflow-inspector-head"><span class="section-kicker">CONNECTION SETTINGS</span><h2>连线设置</h2><p>配置分支名称或删除不需要的连接。</p></div><div class="workflow-edge-summary"><div><i data-lucide="${nodeTypes[source?.type]?.icon || 'circle'}"></i><span>${escapeHtml(source?.title || '起点')}</span></div><i data-lucide="arrow-right"></i><div><i data-lucide="${nodeTypes[target?.type]?.icon || 'circle'}"></i><span>${escapeHtml(target?.title || '终点')}</span></div></div><div class="workflow-form"><label>连线名称<input type="text" value="${escapeAttr(edge.label)}" placeholder="${canLabel ? '例如：商品咨询 / 订单售后' : '可选：为这条连线添加说明'}" data-workflow-edge-field="label"></label>${canLabel ? '<p class="workflow-form-help">分支节点的每条出线应使用不同名称，便于检查路由。</p>' : ''}</div><div class="workflow-inspector-actions"><button type="button" class="quiet-button danger" data-workflow-action="delete-edge">删除连线</button></div>${validation}`;
      } else if (!node) {
        this.inspector.innerHTML = `<div class="workflow-inspector-head"><span class="section-kicker">FLOW SETTINGS</span><h2>流程设置</h2><p>配置流程名称和状态，点击画布节点可编辑节点参数。</p></div><div class="workflow-form"><label>流程名称<input type="text" value="${escapeAttr(flow.name)}" data-workflow-flow-field="name"></label><label>流程说明<textarea data-workflow-flow-field="description" placeholder="说明此流程用于处理什么业务场景">${escapeHtml(flow.description)}</textarea></label><label class="workflow-switch"><span><b>启用并执行此流程</b><small>通过校验后会同步到本机服务，并用于处理之后收到的客户消息。</small></span><input type="checkbox" data-workflow-flow-field="enabled" ${flow.enabled ? 'checked' : ''}></label><div class="workflow-inspector-actions"><button type="button" class="quiet-button danger" data-workflow-action="delete-flow" ${this.state.flows.length === 1 ? 'disabled' : ''}>删除流程</button></div></div>${validation}<div class="workflow-inspector-empty"><i data-lucide="mouse-pointer-2"></i><b>选择一个节点</b><span>可编辑名称、说明和节点参数；拖动节点调整画布布局。</span></div>`;
      } else {
        const metadata = nodeTypes[node.type];
        const configFields = metadata.config.map(field => {
          const value = node.config[field.key] ?? '';
          let control = `<input type="text" value="${escapeAttr(value)}" placeholder="${escapeAttr(field.placeholder || '')}" data-workflow-node-field="config.${field.key}">`;
          if (field.type === 'select') control = `<select data-workflow-node-field="config.${field.key}">${field.options.map(option => `<option ${option === value ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select>`;
          if (field.type === 'textarea') control = `<textarea placeholder="${escapeAttr(field.placeholder || '')}" data-workflow-node-field="config.${field.key}">${escapeHtml(value)}</textarea>`;
          if (field.type === 'number') control = `<input type="number" value="${escapeAttr(value)}" min="${escapeAttr(field.min ?? '')}" max="${escapeAttr(field.max ?? '')}" step="${escapeAttr(field.step ?? 1)}" data-workflow-node-field="config.${field.key}">`;
          if (field.type === 'checkbox') control = `<input type="checkbox" ${value ? 'checked' : ''} data-workflow-node-field="config.${field.key}">`;
          return `<label>${escapeHtml(field.label)}${control}</label>`;
        }).join('');
        this.inspector.innerHTML = `<div class="workflow-inspector-head"><span class="section-kicker">NODE SETTINGS</span><div class="workflow-node-inspector-title"><span class="workflow-node-icon ${metadata.color}"><i data-lucide="${metadata.icon}"></i></span><div><h2>${metadata.label}</h2><p>修改后会立即保存到本机画布。</p></div></div></div><div class="workflow-form"><label>节点名称<input type="text" value="${escapeAttr(node.title)}" data-workflow-node-field="title"></label><label>节点说明<textarea data-workflow-node-field="description">${escapeHtml(node.description)}</textarea></label>${configFields}</div><div class="workflow-inspector-actions"><button type="button" class="quiet-button ${this.connectSourceId === node.id ? 'active' : ''}" data-workflow-action="connect">${this.connectSourceId === node.id ? '取消连线' : '连接到节点'}</button><button type="button" class="quiet-button danger" data-workflow-action="delete-node">删除节点</button></div><div class="workflow-form-help"><i data-lucide="waypoints"></i>从节点右侧圆点拖到目标左侧圆点，即可直接连线。</div><div class="workflow-node-position"><i data-lucide="crosshair"></i>位置 X ${Math.round(node.x)} · Y ${Math.round(node.y)}</div>${validation}`;
      }
      globalThis.lucide?.createIcons?.();
    }

    validationMarkup() {
      if (!this.validation) return '';
      if (this.validation.valid) return `<section class="workflow-validation valid" aria-live="polite"><div><i data-lucide="circle-check-big"></i><b>校验通过</b></div><p>所有节点均可从触发器到达有效终点。现在可以标记为已启用配置。</p></section>`;
      const errors = this.validation.errors.map((error, index) => {
        const focusId = error.nodeIds[0];
        const action = focusId ? `<button type="button" data-workflow-focus-node="${escapeAttr(focusId)}">定位节点</button>` : '';
        return `<li><span>${index + 1}. ${escapeHtml(error.message)}</span>${action}</li>`;
      }).join('');
      return `<section class="workflow-validation invalid" aria-live="polite"><div><i data-lucide="triangle-alert"></i><b>发现 ${this.validation.errors.length} 项待修复问题</b></div><ul class="validation-errors">${errors}</ul></section>`;
    }

    bindCanvas() {
      this.canvas.addEventListener('wheel', event => {
        event.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const cursorX = event.clientX - rect.left;
        const cursorY = event.clientY - rect.top;
        const worldX = (cursorX - this.view.x) / this.view.zoom;
        const worldY = (cursorY - this.view.y) / this.view.zoom;
        const factor = event.deltaY > 0 ? .9 : 1.11;
        const nextZoom = clamp(this.view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        this.view.x = cursorX - worldX * nextZoom;
        this.view.y = cursorY - worldY * nextZoom;
        this.view.zoom = nextZoom;
        this.syncCanvas();
      }, { passive: false });

      this.canvas.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target.closest('[data-workflow-node], [data-workflow-edge], [data-workflow-minimap]')) return;
        this.root.querySelector('.workflow-studio')?.focus({ preventScroll: true });
        this.canvas.setPointerCapture?.(event.pointerId);
        const start = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: this.view.x, panY: this.view.y };
        this.canvas.classList.add('panning');
        const move = moveEvent => {
          if (moveEvent.pointerId !== start.pointerId) return;
          this.view.x = start.panX + moveEvent.clientX - start.x;
          this.view.y = start.panY + moveEvent.clientY - start.y;
          this.syncCanvas();
        };
        const finish = finishEvent => {
          if (finishEvent.pointerId !== start.pointerId) return;
          this.canvas.classList.remove('panning');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
      });

      this.canvas.addEventListener('dragover', event => {
        if (event.dataTransfer?.types.includes('application/x-rcb-workflow-node')) event.preventDefault();
      });
      this.canvas.addEventListener('drop', event => {
        const type = event.dataTransfer?.getData('application/x-rcb-workflow-node');
        if (!nodeTypes[type]) return;
        event.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        this.addNodeAt(type, (event.clientX - rect.left - this.view.x) / this.view.zoom - NODE_WIDTH / 2, (event.clientY - rect.top - this.view.y) / this.view.zoom - NODE_HEIGHT / 2);
      });
    }

    worldPoint(event) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: (event.clientX - rect.left - this.view.x) / this.view.zoom, y: (event.clientY - rect.top - this.view.y) / this.view.zoom };
    }

    snap(value) {
      return this.snapToGrid ? Math.round(value / GRID_SIZE) * GRID_SIZE : Math.round(value);
    }

    canCreateEdge(fromId, toId) {
      const flow = this.activeFlow();
      const source = flow.nodes.find(node => node.id === fromId);
      const target = flow.nodes.find(node => node.id === toId);
      if (!source || !target) return { ok: false, message: '请选择画布中的有效节点。' };
      if (source.id === target.id) return { ok: false, message: '节点不能连接到自身。' };
      if (nodeTypes[source.type]?.output === false) return { ok: false, message: `「${source.title}」是终点，不能继续连线。` };
      if (nodeTypes[target.type]?.input === false) return { ok: false, message: `「${target.title}」只能作为流程起点。` };
      if (flow.edges.some(edge => edge.from === fromId && edge.to === toId)) return { ok: false, message: '这两个节点已经连接。' };
      const outgoing = new Map(flow.nodes.map(node => [node.id, []]));
      flow.edges.forEach(edge => outgoing.get(edge.from)?.push(edge.to));
      const pending = [toId];
      const reached = new Set();
      while (pending.length) {
        const current = pending.pop();
        if (current === fromId) return { ok: false, message: '这条连线会形成循环，请使用其他节点或删除回环。' };
        if (reached.has(current)) continue;
        reached.add(current);
        outgoing.get(current)?.forEach(id => pending.push(id));
      }
      return { ok: true };
    }

    bindOutputPort(port) {
      port.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        this.startPortConnection(port.dataset.workflowPortNode, event);
      });
      port.addEventListener('click', event => event.stopPropagation());
    }

    bindInputPort(port) {
      port.addEventListener('pointerdown', event => event.stopPropagation());
      port.addEventListener('click', event => event.stopPropagation());
    }

    startPortConnection(fromId, event) {
      const source = this.activeFlow().nodes.find(node => node.id === fromId);
      if (!source || nodeTypes[source.type]?.output === false) return;
      this.selectedNodeId = fromId;
      this.selectedEdgeId = null;
      this.connectSourceId = fromId;
      this.updateNodeSelection();
      this.renderInspector();
      const begin = this.worldPoint(event);
      this.connectionPreview = { from: fromId, x: begin.x, y: begin.y, valid: false, targetId: null };
      this.drawEdgesOnly();
      const move = moveEvent => {
        if (moveEvent.pointerId !== event.pointerId) return;
        const point = this.worldPoint(moveEvent);
        const candidate = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest?.('[data-workflow-port="in"]');
        const targetId = candidate?.dataset.workflowPortNode || null;
        const decision = targetId ? this.canCreateEdge(fromId, targetId) : { ok: false };
        this.nodesLayer.querySelectorAll('[data-workflow-port="in"]').forEach(port => port.classList.toggle('drop-target', port.dataset.workflowPortNode === targetId && decision.ok));
        this.connectionPreview = { from: fromId, x: point.x, y: point.y, valid: decision.ok, targetId };
        this.drawEdgesOnly();
      };
      const finish = finishEvent => {
        if (finishEvent.pointerId !== event.pointerId) return;
        const candidate = document.elementFromPoint(finishEvent.clientX, finishEvent.clientY)?.closest?.('[data-workflow-port="in"]');
        const targetId = candidate?.dataset.workflowPortNode || null;
        const decision = targetId ? this.canCreateEdge(fromId, targetId) : { ok: false, message: '' };
        this.nodesLayer.querySelectorAll('[data-workflow-port="in"]').forEach(port => port.classList.remove('drop-target'));
        this.connectionPreview = null;
        this.connectSourceId = null;
        if (decision.ok) {
          this.suppressNodeClickUntil = Date.now() + 250;
          this.addEdge(fromId, targetId);
        } else {
          this.notice = decision.message || '已取消创建连线。';
          this.drawEdgesOnly();
          this.updateNodeSelection();
          this.renderInspector();
        }
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    }

    bindNodeDrag(element) {
      element.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.stopPropagation();
        const id = element.dataset.workflowNode;
        const node = this.activeFlow().nodes.find(item => item.id === id);
        if (!node) return;
        this.selectedNodeId = id;
        this.selectedEdgeId = null;
        this.updateNodeSelection();
        this.renderInspector();
        const rect = this.canvas.getBoundingClientRect();
        const pointerWorldX = (event.clientX - rect.left - this.view.x) / this.view.zoom;
        const pointerWorldY = (event.clientY - rect.top - this.view.y) / this.view.zoom;
        const offsetX = pointerWorldX - node.x;
        const offsetY = pointerWorldY - node.y;
        let moved = false;
        element.setPointerCapture?.(event.pointerId);
        const move = moveEvent => {
          if (moveEvent.pointerId !== event.pointerId) return;
          const nextX = (moveEvent.clientX - rect.left - this.view.x) / this.view.zoom - offsetX;
          const nextY = (moveEvent.clientY - rect.top - this.view.y) / this.view.zoom - offsetY;
          if (!moved && (Math.abs(nextX - node.x) > 1 || Math.abs(nextY - node.y) > 1)) { this.recordHistory(); moved = true; }
          node.x = clamp(this.snap(nextX), 16, WORLD_WIDTH - NODE_WIDTH - 16);
          node.y = clamp(this.snap(nextY), 16, WORLD_HEIGHT - NODE_HEIGHT - 16);
          element.style.transform = `translate(${node.x}px, ${node.y}px)`;
          this.drawEdgesOnly();
        };
        const finish = finishEvent => {
          if (finishEvent.pointerId !== event.pointerId) return;
          if (moved) {
            this.save();
            this.renderInspector();
          }
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
      });

      element.addEventListener('click', event => {
        event.stopPropagation();
        if (Date.now() < (this.suppressNodeClickUntil || 0)) return;
        const targetId = element.dataset.workflowNode;
        if (this.connectSourceId && this.connectSourceId !== targetId) {
          this.addEdge(this.connectSourceId, targetId);
          return;
        }
        this.selectedNodeId = targetId;
        this.selectedEdgeId = null;
        this.updateNodeSelection();
        this.renderInspector();
      });
    }

    drawEdgesOnly() {
      this.renderEdges();
    }

    updateNodeSelection() {
      this.nodesLayer.querySelectorAll('[data-workflow-node]').forEach(element => {
        element.classList.toggle('selected', element.dataset.workflowNode === this.selectedNodeId);
        element.classList.toggle('connecting', element.dataset.workflowNode === this.connectSourceId);
      });
      this.updateEdgeSelection();
    }

    updateEdgeSelection() {
      this.edgesLayer?.querySelectorAll('[data-workflow-edge]').forEach(element => element.classList.toggle('selected', element.dataset.workflowEdge === this.selectedEdgeId));
    }

    onRootFocusIn(event) {
      const field = event.target.closest('[data-workflow-node-field], [data-workflow-flow-field], [data-workflow-edge-field]');
      if (!field || this.historyInput === field) return;
      this.historyInput = field;
      this.recordHistory();
    }

    onDragStart(event) {
      const button = event.target.closest('[data-workflow-add]');
      if (!button || !nodeTypes[button.dataset.workflowAdd]) return;
      event.dataTransfer?.setData('application/x-rcb-workflow-node', button.dataset.workflowAdd);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    }

    onKeyDown(event) {
      const input = event.target.closest('input, textarea, select');
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.redo(); else this.undo();
        return;
      }
      if (input) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedEdgeId) {
        event.preventDefault();
        this.deleteSelectedEdge();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedNodeId) {
        event.preventDefault();
        this.deleteSelectedNode();
      } else if (event.key === 'Escape' && (this.connectSourceId || this.connectionPreview)) {
        this.connectSourceId = null;
        this.connectionPreview = null;
        this.notice = '已取消创建连线。';
        this.drawEdgesOnly();
        this.updateNodeSelection();
        this.renderInspector();
      }
    }

    onRootInput(event) {
      const nodeSearch = event.target.closest('[data-workflow-node-search]');
      const nodeField = event.target.closest('[data-workflow-node-field]');
      const flowField = event.target.closest('[data-workflow-flow-field]');
      const edgeField = event.target.closest('[data-workflow-edge-field]');
      if (nodeSearch) {
        this.nodeQuery = nodeSearch.value;
        this.root.querySelector('.workflow-node-library')?.replaceWith(this.nodeLibraryElement());
        globalThis.lucide?.createIcons?.();
        const nextSearch = this.root.querySelector('[data-workflow-node-search]');
        nextSearch?.focus();
        nextSearch?.setSelectionRange?.(nextSearch.value.length, nextSearch.value.length);
        return;
      }
      if (edgeField) {
        const edge = this.selectedEdge();
        if (!edge) return;
        this.clearValidation();
        edge[edgeField.dataset.workflowEdgeField] = edgeField.value;
        this.save();
        this.drawEdgesOnly();
        return;
      }
      if (nodeField) {
        const node = this.selectedNode();
        if (!node) return;
        this.clearValidation();
        const field = nodeField.dataset.workflowNodeField;
        const value = nodeField.type === 'checkbox' ? nodeField.checked : nodeField.type === 'number' ? Number(nodeField.value) : nodeField.value;
        if (field.startsWith('config.')) node.config[field.slice(7)] = value;
        else node[field] = value;
        this.save();
        const element = this.nodesLayer.querySelector(`[data-workflow-node="${this.selectorValue(node.id)}"]`);
        if (element && field === 'title') element.querySelector('[data-workflow-node-title]').textContent = value || nodeTypes[node.type].title;
        if (element && field === 'description') element.querySelector('[data-workflow-node-description]').textContent = value || nodeTypes[node.type].description;
        return;
      }
      if (flowField) {
        const flow = this.activeFlow();
        const field = flowField.dataset.workflowFlowField;
        const value = flowField.type === 'checkbox' ? flowField.checked : flowField.value;
        if (field === 'enabled' && value) {
          const report = this.evaluateFlow(flow);
          this.validation = report;
          if (!report.valid) {
            flow.enabled = false;
            flowField.checked = false;
            this.notice = `流程未通过校验，不能标记为已启用配置。请先修复 ${report.errors.length} 项问题。`;
            this.save();
            this.drawGraph();
            this.renderInspector();
            const notice = this.root.querySelector('[data-workflow-notice]'); if (notice) notice.textContent = this.notice;
            return;
          }
          this.state.flows.forEach(item => { if (item.id !== flow.id) item.enabled = false; });
          this.notice = '流程校验通过，已同步为自动回复的当前执行流程。';
        } else {
          this.clearValidation();
        }
        flow[field] = value;
        this.save();
        this.root.querySelectorAll(`[data-workflow-flow="${this.selectorValue(flow.id)}"] b`).forEach(node => { node.textContent = flow.name || '未命名工作流'; });
        const title = this.root.querySelector('.workflow-flow-summary strong'); if (title) title.textContent = flow.name || '未命名工作流';
        const status = this.root.querySelector('.workflow-flow-summary .status-chip');
        if (status) { status.textContent = flow.enabled ? '执行中配置' : '未启用'; status.className = `status-chip ${flow.enabled ? 'approved' : 'archived'}`; }
        const notice = this.root.querySelector('[data-workflow-notice]'); if (notice && this.notice) notice.textContent = this.notice;
      }
    }

    selectorValue(value) {
      if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
      return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    nodeLibraryElement() {
      const holder = document.createElement('div');
      holder.innerHTML = this.nodeLibraryMarkup();
      return holder.firstElementChild;
    }

    recordHistory() {
      const snapshot = JSON.stringify(this.state);
      if (this.history.length && this.history[this.history.length - 1] === snapshot) return;
      this.history.push(snapshot);
      if (this.history.length > 60) this.history.shift();
      this.future = [];
    }

    restoreSnapshot(snapshot, message) {
      try {
        this.state = normalizeState(JSON.parse(snapshot));
      } catch { return; }
      this.selectedNodeId = null;
      this.selectedEdgeId = null;
      this.connectSourceId = null;
      this.connectionPreview = null;
      this.validation = null;
      this.notice = message;
      this.save();
      this.render();
    }

    undo() {
      const snapshot = this.history.pop();
      if (!snapshot) return;
      this.future.push(JSON.stringify(this.state));
      this.restoreSnapshot(snapshot, '已撤销上一步编辑。');
    }

    redo() {
      const snapshot = this.future.pop();
      if (!snapshot) return;
      this.history.push(JSON.stringify(this.state));
      this.restoreSnapshot(snapshot, '已恢复刚才撤销的编辑。');
    }

    clearValidation() {
      if (!this.validation) return;
      this.validation = null;
      this.nodesLayer?.querySelectorAll('[data-workflow-node]').forEach(node => node.classList.remove('invalid'));
      this.inspector?.querySelector('.workflow-validation')?.remove();
    }

    evaluateFlow(flow = this.activeFlow()) {
      const errors = [];
      const nodesById = new Map(flow.nodes.map(node => [node.id, node]));
      const outgoing = new Map(flow.nodes.map(node => [node.id, []]));
      const incoming = new Map(flow.nodes.map(node => [node.id, []]));
      const addError = (message, nodeIds = []) => errors.push({ message, nodeIds: [...new Set(nodeIds.filter(id => nodesById.has(id)))] });
      flow.edges.forEach(edge => {
        if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) return;
        outgoing.get(edge.from).push(edge.to);
        incoming.get(edge.to).push(edge.from);
      });

      if (!flow.name.trim()) addError('请填写流程名称。');
      const triggers = flow.nodes.filter(node => nodeTypes[node.type]?.role === 'trigger');
      const terminals = flow.nodes.filter(node => nodeTypes[node.type]?.terminal === true);
      if (!triggers.length) addError('缺少触发器：工作流必须从一个平台事件开始。');
      if (triggers.length > 1) addError('自动回复流程只能保留一个平台消息触发器。', triggers.map(node => node.id));
      if (!terminals.length) addError('缺少终点：至少添加回复、转人工或结束流程节点。');

      flow.nodes.forEach(node => {
        const metadata = nodeTypes[node.type];
        const inCount = incoming.get(node.id).length;
        const outCount = outgoing.get(node.id).length;
        if (!EXECUTABLE_NODE_TYPES.has(node.type)) addError(`节点「${node.title}」尚未接入安全执行器，不能启用。`, [node.id]);
        if (metadata.role === 'trigger') {
          if (outCount === 0) addError(`触发器「${node.title}」尚未连接到下一步。`, [node.id]);
          return;
        }
        if (inCount === 0) addError(`节点「${node.title}」没有上游连接。`, [node.id]);
        if (metadata.terminal) {
          if (outCount > 0) addError(`终点「${node.title}」不应继续连接到后续节点。`, [node.id]);
          return;
        }
        if (outCount === 0) addError(`节点「${node.title}」缺少下一步连接。`, [node.id]);
        if (metadata.branching) {
          const branches = flow.edges.filter(edge => edge.from === node.id);
          if (outCount < 2) addError(`分支节点「${node.title}」至少需要两条出线。`, [node.id]);
          if (branches.some(edge => !edge.label.trim())) addError(`分支节点「${node.title}」存在未命名的分支。请选择连线后填写分支名称。`, [node.id]);
          const labels = branches.map(edge => edge.label.trim()).filter(Boolean);
          if (new Set(labels).size !== labels.length) addError(`分支节点「${node.title}」的分支名称重复，无法区分路由。`, [node.id]);
        }
      });

      if (triggers.length) {
        const reachable = new Set(triggers.map(node => node.id));
        const queue = [...reachable];
        while (queue.length) {
          const id = queue.shift();
          outgoing.get(id).forEach(next => { if (!reachable.has(next)) { reachable.add(next); queue.push(next); } });
        }
        const unreachable = flow.nodes.filter(node => !reachable.has(node.id)).map(node => node.id);
        if (unreachable.length) addError('这些节点无法从任一触发器到达。', unreachable);
      }

      if (terminals.length) {
        const canFinish = new Set(terminals.map(node => node.id));
        const queue = [...canFinish];
        while (queue.length) {
          const id = queue.shift();
          incoming.get(id).forEach(previous => { if (!canFinish.has(previous)) { canFinish.add(previous); queue.push(previous); } });
        }
        const deadEnds = flow.nodes.filter(node => !canFinish.has(node.id)).map(node => node.id);
        if (deadEnds.length) addError('这些节点无法走到回复、转人工或结束流程终点。', deadEnds);
      }

      const visiting = new Set();
      const visited = new Set();
      const cycleNodes = new Set();
      const walk = id => {
        if (visiting.has(id)) { cycleNodes.add(id); return; }
        if (visited.has(id)) return;
        visiting.add(id);
        outgoing.get(id).forEach(next => { walk(next); if (cycleNodes.has(next)) cycleNodes.add(id); });
        visiting.delete(id);
        visited.add(id);
      };
      flow.nodes.forEach(node => walk(node.id));
      if (cycleNodes.size) addError('流程存在循环连线；请删除回环后再启用。', [...cycleNodes]);

      return { valid: errors.length === 0, errors, invalidNodeIds: [...new Set(errors.flatMap(error => error.nodeIds))] };
    }

    focusNode(id) {
      const node = this.activeFlow().nodes.find(item => item.id === id);
      if (!node) return;
      const rect = this.canvas.getBoundingClientRect();
      this.selectedNodeId = id;
      this.selectedEdgeId = null;
      this.view.x = rect.width / 2 - (node.x + NODE_WIDTH / 2) * this.view.zoom;
      this.view.y = rect.height / 2 - (node.y + NODE_HEIGHT / 2) * this.view.zoom;
      this.syncCanvas();
      this.updateNodeSelection();
      this.renderInspector();
    }

    onRootClick(event) {
      const minimap = event.target.closest('[data-workflow-minimap]');
      if (minimap) {
        const rect = minimap.getBoundingClientRect();
        const relativeX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        const relativeY = clamp((event.clientY - rect.top) / rect.height, 0, 1);
        const canvasRect = this.canvas.getBoundingClientRect();
        this.view.x = canvasRect.width / 2 - relativeX * WORLD_WIDTH * this.view.zoom;
        this.view.y = canvasRect.height / 2 - relativeY * WORLD_HEIGHT * this.view.zoom;
        this.syncCanvas();
        return;
      }
      const focusNode = event.target.closest('[data-workflow-focus-node]');
      if (focusNode) {
        this.focusNode(focusNode.dataset.workflowFocusNode);
        return;
      }
      const flowButton = event.target.closest('[data-workflow-flow]');
      if (flowButton) {
        this.state.activeFlowId = flowButton.dataset.workflowFlow;
        this.selectedNodeId = null;
        this.selectedEdgeId = null;
        this.connectSourceId = null;
        this.validation = null;
        this.notice = '';
        this.save();
        this.render();
        this.fitToFlow();
        return;
      }
      const addButton = event.target.closest('[data-workflow-add]');
      if (addButton) {
        this.addNode(addButton.dataset.workflowAdd);
        return;
      }
      const action = event.target.closest('[data-workflow-action]')?.dataset.workflowAction;
      if (!action) return;
      if (action === 'new-flow') this.createFlow();
      if (action === 'delete-flow') this.deleteFlow();
      if (action === 'delete-node') this.deleteSelectedNode();
      if (action === 'delete-edge') this.deleteSelectedEdge();
      if (action === 'connect') this.toggleConnect();
      if (action === 'validate') this.validate();
      if (action === 'fit') this.fitToFlow();
      if (action === 'layout') this.autoLayout();
      if (action === 'snap') { this.snapToGrid = !this.snapToGrid; this.notice = this.snapToGrid ? '已开启网格对齐。' : '已关闭网格对齐。'; this.render(); }
      if (action === 'undo') this.undo();
      if (action === 'redo') this.redo();
      if (action === 'zoom-in') this.zoomAtCenter(1.14);
      if (action === 'zoom-out') this.zoomAtCenter(.86);
    }

    createFlow() {
      this.recordHistory();
      const flowNumber = this.state.flows.length + 1;
      const trigger = makeNode('trigger', 520, 580);
      const flow = {
        id: nodeId('flow'),
        name: `新建工作流 ${flowNumber}`,
        description: '请补充此流程的业务目标与执行边界。',
        enabled: false,
        nodes: [trigger],
        edges: []
      };
      this.state.flows.push(flow);
      this.state.activeFlowId = flow.id;
      this.selectedNodeId = trigger.id;
      this.selectedEdgeId = null;
      this.connectSourceId = null;
      this.validation = null;
      this.notice = '已创建工作流草稿，请继续添加节点并设置连线。';
      this.save();
      this.render();
      this.fitToFlow();
    }

    deleteFlow() {
      if (this.state.flows.length === 1) return;
      const flow = this.activeFlow();
      if (!window.confirm(`删除「${flow.name}」吗？此操作只删除本机保存的画布流程。`)) return;
      this.recordHistory();
      this.state.flows = this.state.flows.filter(item => item.id !== flow.id);
      this.state.activeFlowId = this.state.flows[0].id;
      this.selectedNodeId = null;
      this.selectedEdgeId = null;
      this.connectSourceId = null;
      this.validation = null;
      this.notice = '已删除本机流程。';
      this.save();
      this.render();
      this.fitToFlow();
    }

    addNode(type) {
      if (!nodeTypes[type]) return;
      const rect = this.canvas.getBoundingClientRect();
      const worldX = (rect.width / 2 - this.view.x) / this.view.zoom - NODE_WIDTH / 2;
      const worldY = (rect.height / 2 - this.view.y) / this.view.zoom - NODE_HEIGHT / 2;
      this.addNodeAt(type, worldX, worldY);
    }

    addNodeAt(type, worldX, worldY) {
      if (!nodeTypes[type]) return;
      this.recordHistory();
      const node = makeNode(type, clamp(this.snap(worldX), 16, WORLD_WIDTH - NODE_WIDTH - 16), clamp(this.snap(worldY), 16, WORLD_HEIGHT - NODE_HEIGHT - 16));
      this.activeFlow().nodes.push(node);
      this.selectedNodeId = node.id;
      this.selectedEdgeId = null;
      this.connectSourceId = null;
      this.validation = null;
      this.notice = `已添加${nodeTypes[type].label}，请在右侧完成设置。`;
      this.save();
      this.render();
    }

    deleteSelectedNode() {
      const flow = this.activeFlow();
      const node = this.selectedNode();
      if (!node) return;
      this.recordHistory();
      flow.nodes = flow.nodes.filter(item => item.id !== node.id);
      flow.edges = flow.edges.filter(edge => edge.from !== node.id && edge.to !== node.id);
      this.selectedNodeId = null;
      this.selectedEdgeId = null;
      this.connectSourceId = null;
      this.validation = null;
      this.notice = `已删除「${node.title}」及其相关连线。`;
      this.save();
      this.render();
    }

    toggleConnect() {
      const node = this.selectedNode();
      if (!node) return;
      this.connectSourceId = this.connectSourceId === node.id ? null : node.id;
      this.notice = this.connectSourceId ? '请选择画布上的目标节点以创建连线。' : '已取消创建连线。';
      this.render();
    }

    addEdge(from, to) {
      const flow = this.activeFlow();
      const decision = this.canCreateEdge(from, to);
      if (!decision.ok) {
        this.notice = decision.message;
      } else {
        this.recordHistory();
        const source = flow.nodes.find(node => node.id === from);
        const target = flow.nodes.find(node => node.id === to);
        const branchCount = flow.edges.filter(edge => edge.from === from).length;
        const label = source?.type === 'condition' && target?.type === 'reply' ? '低风险' : source?.type === 'condition' && target?.type === 'handoff' ? '需核对' : nodeTypes[source?.type]?.branching ? `分支 ${branchCount + 1}` : '';
        flow.edges.push({ id: nodeId('edge'), from, to, label });
        this.validation = null;
        this.notice = '已创建节点连线。';
        this.save();
      }
      this.connectSourceId = null;
      this.selectedNodeId = to;
      this.selectedEdgeId = null;
      this.render();
    }

    deleteSelectedEdge() {
      const edge = this.selectedEdge();
      if (!edge) return;
      this.recordHistory();
      this.activeFlow().edges = this.activeFlow().edges.filter(item => item.id !== edge.id);
      this.selectedEdgeId = null;
      this.validation = null;
      this.notice = '已删除节点连线。';
      this.save();
      this.render();
    }

    autoLayout() {
      const flow = this.activeFlow();
      if (!flow.nodes.length) return;
      this.recordHistory();
      const incoming = new Map(flow.nodes.map(node => [node.id, 0]));
      flow.edges.forEach(edge => incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1));
      const depth = new Map();
      const queue = flow.nodes.filter(node => nodeTypes[node.type]?.role === 'trigger' || incoming.get(node.id) === 0);
      queue.forEach(node => depth.set(node.id, 0));
      const outgoing = new Map(flow.nodes.map(node => [node.id, []]));
      flow.edges.forEach(edge => outgoing.get(edge.from)?.push(edge.to));
      while (queue.length) {
        const node = queue.shift();
        outgoing.get(node.id).forEach(nextId => {
          const nextDepth = (depth.get(node.id) || 0) + 1;
          if (!depth.has(nextId)) { depth.set(nextId, nextDepth); queue.push(flow.nodes.find(item => item.id === nextId)); }
        });
      }
      const columns = new Map();
      flow.nodes.forEach(node => {
        const column = depth.get(node.id) ?? 0;
        if (!columns.has(column)) columns.set(column, []);
        columns.get(column).push(node);
      });
      [...columns.keys()].sort((a, b) => a - b).forEach(column => columns.get(column).forEach((node, index, nodes) => {
        node.x = 260 + column * 340;
        node.y = Math.round(450 + (index - (nodes.length - 1) / 2) * 210);
      }));
      this.validation = null;
      this.notice = '已按处理顺序自动排版。';
      this.save();
      this.render();
      this.fitToFlow();
    }

    validate() {
      const flow = this.activeFlow();
      this.validation = this.evaluateFlow(flow);
      if (!this.validation.valid && flow.enabled) {
        flow.enabled = false;
        this.save();
      }
      this.notice = this.validation.valid
        ? '流程结构校验通过：每条路径均可从触发器走到有效终点。'
        : `发现 ${this.validation.errors.length} 项问题：已标红相关节点，可在右侧逐项定位并修复。`;
      this.render();
    }

    zoomAtCenter(factor) {
      const rect = this.canvas.getBoundingClientRect();
      const cursorX = rect.width / 2;
      const cursorY = rect.height / 2;
      const worldX = (cursorX - this.view.x) / this.view.zoom;
      const worldY = (cursorY - this.view.y) / this.view.zoom;
      const nextZoom = clamp(this.view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      this.view.x = cursorX - worldX * nextZoom;
      this.view.y = cursorY - worldY * nextZoom;
      this.view.zoom = nextZoom;
      this.syncCanvas();
    }

    fitToFlow() {
      const flow = this.activeFlow();
      if (!this.canvas || !flow.nodes.length) return;
      const rect = this.canvas.getBoundingClientRect();
      const xs = flow.nodes.map(node => node.x);
      const ys = flow.nodes.map(node => node.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs) + NODE_WIDTH;
      const maxY = Math.max(...ys) + NODE_HEIGHT;
      const padding = 108;
      const width = Math.max(maxX - minX, 1);
      const height = Math.max(maxY - minY, 1);
      const zoom = clamp(Math.min((rect.width - padding * 2) / width, (rect.height - padding * 2) / height, 1), MIN_ZOOM, MAX_ZOOM);
      this.view.zoom = zoom;
      this.view.x = (rect.width - width * zoom) / 2 - minX * zoom;
      this.view.y = (rect.height - height * zoom) / 2 - minY * zoom;
      this.syncCanvas();
    }
  }

  globalThis.RcbWorkflowCanvas = {
    mount(root) {
      if (!root) return null;
      mountedEditor?.destroy();
      mountedEditor = new WorkflowCanvas(root);
      return mountedEditor;
    },
    unmount() {
      mountedEditor?.destroy();
      mountedEditor = null;
    }
  };
})();
