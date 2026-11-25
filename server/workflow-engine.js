const executableNodeTypes = new Set([
  'trigger', 'rag', 'knowledge', 'llm', 'extract', 'condition', 'classifier',
  'delay', 'merge', 'variable', 'template', 'custom', 'reply', 'handoff', 'stop'
]);

const terminalNodeTypes = new Set(['reply', 'handoff', 'stop']);
const branchingNodeTypes = new Set(['condition', 'classifier']);
const WORKFLOW_SCHEMA_VERSION = 2;

export function createDefaultWorkflowState() {
  return {
    version: WORKFLOW_SCHEMA_VERSION,
    activeFlowId: 'default-customer-reply',
    flows: [{
      id: 'default-customer-reply',
      name: 'AI 智能自动回复',
      description: '收到客户消息后识别意图，按商品、适配、售后或通用咨询检索资料并自动回复。',
      enabled: true,
      nodes: [
        { id: 'default-trigger', type: 'trigger', title: '收到客户消息', description: '在后台持续接收已接入店铺的新客户消息。', x: 220, y: 700, config: { channel: '所有已接入店铺', event: '收到新买家消息' } },
        { id: 'default-classifier', type: 'classifier', title: '识别客户意图', description: '将消息分为商品咨询、车型适配、订单售后或其他问题。', x: 540, y: 700, config: { labels: '商品咨询\n车型适配\n订单售后\n其他', fallback: '进入其他分支' } },
        { id: 'default-product-rag', type: 'rag', title: '商品咨询答复', description: '检索商品资料并直接回答规格、功能、价格等咨询。', x: 900, y: 320, config: { strategy: '本地 RAG 优先', prompt: '优先回答客户当前问题；动态价格或库存无法确认时，简洁说明以商品页面为准，不要只回复“转人工”。' } },
        { id: 'default-fitment-rag', type: 'rag', title: '车型适配答复', description: '结合车型、年份与商品资料回答适配和安装问题。', x: 900, y: 580, config: { strategy: '本地 RAG 优先', prompt: '先回答已确认部分；信息不足时主动询问车型、年份、版本或安装规格，给客户明确的下一步，不要只回复“人工核验”。' } },
        { id: 'default-after-sales-rag', type: 'rag', title: '订单售后答复', description: '识别订单和售后诉求，提供可执行的补充信息指引。', x: 900, y: 840, config: { strategy: '本地 RAG 优先', prompt: '说明可确认的售后规则；缺少订单信息时请客户提供订单号、问题照片或当前状态，不要编造处理结果。' } },
        { id: 'default-general-rag', type: 'rag', title: '通用问题答复', description: '处理未归类问题并生成自然、简洁的客户回复。', x: 900, y: 1100, config: { strategy: '本地 RAG 优先', prompt: '直接回应客户问题；资料不足时提出一个最有帮助的补充问题，避免机械重复“请人工核验”。' } },
        { id: 'default-reply', type: 'reply', title: '自动发送回复', description: '将生成结果写入对应会话的安全发送队列。', x: 1320, y: 700, config: { mode: 'AI 全托管队列', template: '' } }
      ],
      edges: [
        { id: 'default-edge-trigger-classifier', from: 'default-trigger', to: 'default-classifier', label: '' },
        { id: 'default-edge-classifier-product', from: 'default-classifier', to: 'default-product-rag', label: '商品咨询' },
        { id: 'default-edge-classifier-fitment', from: 'default-classifier', to: 'default-fitment-rag', label: '车型适配' },
        { id: 'default-edge-classifier-after-sales', from: 'default-classifier', to: 'default-after-sales-rag', label: '订单售后' },
        { id: 'default-edge-classifier-general', from: 'default-classifier', to: 'default-general-rag', label: '其他' },
        { id: 'default-edge-product-reply', from: 'default-product-rag', to: 'default-reply', label: '' },
        { id: 'default-edge-fitment-reply', from: 'default-fitment-rag', to: 'default-reply', label: '' },
        { id: 'default-edge-after-sales-reply', from: 'default-after-sales-rag', to: 'default-reply', label: '' },
        { id: 'default-edge-general-reply', from: 'default-general-rag', to: 'default-reply', label: '' }
      ]
    }]
  };
}

function cleanText(value, limit = 2400) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

function cleanConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => {
    const safeKey = cleanText(key, 80).replace(/[^a-zA-Z0-9_.-]/g, '_');
    if (typeof item === 'boolean' || typeof item === 'number') return [safeKey, item];
    return [safeKey, cleanText(item, 6000)];
  }).filter(([key]) => key));
}

export function normalizeWorkflowState(input) {
  if (!input || !Array.isArray(input.flows)) return createDefaultWorkflowState();
  let flows = input.flows.slice(0, 20).map((flow, flowIndex) => {
    const nodes = Array.isArray(flow?.nodes) ? flow.nodes.slice(0, 100).map((node, nodeIndex) => ({
      id: cleanText(node?.id, 100) || `flow-${flowIndex + 1}-node-${nodeIndex + 1}`,
      type: cleanText(node?.type, 40),
      title: cleanText(node?.title, 180) || '未命名节点',
      description: cleanText(node?.description, 800),
      x: Number.isFinite(Number(node?.x)) ? Number(node.x) : 0,
      y: Number.isFinite(Number(node?.y)) ? Number(node.y) : 0,
      config: cleanConfig(node?.config)
    })).filter(node => node.type) : [];
    const nodeIds = new Set(nodes.map(node => node.id));
    const seenPairs = new Set();
    const edges = Array.isArray(flow?.edges) ? flow.edges.slice(0, 240).map((edge, edgeIndex) => ({
      id: cleanText(edge?.id, 100) || `flow-${flowIndex + 1}-edge-${edgeIndex + 1}`,
      from: cleanText(edge?.from, 100),
      to: cleanText(edge?.to, 100),
      label: cleanText(edge?.label, 120)
    })).filter(edge => {
      const pair = `${edge.from}:${edge.to}`;
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to || seenPairs.has(pair)) return false;
      seenPairs.add(pair);
      return true;
    }) : [];
    return {
      id: cleanText(flow?.id, 100) || `flow-${flowIndex + 1}`,
      name: cleanText(flow?.name, 180) || '未命名工作流',
      description: cleanText(flow?.description, 1000),
      enabled: flow?.enabled === true,
      nodes,
      edges
    };
  }).filter(flow => flow.nodes.length);
  if (!flows.length) return createDefaultWorkflowState();
  if (Number(input.version || 1) < WORKFLOW_SCHEMA_VERSION) {
    const improvedDefault = createDefaultWorkflowState().flows[0];
    flows = flows.map(flow => flow.id === improvedDefault.id ? improvedDefault : flow);
  }
  const requestedActiveId = cleanText(input.activeFlowId, 100);
  return {
    version: WORKFLOW_SCHEMA_VERSION,
    activeFlowId: flows.some(flow => flow.id === requestedActiveId) ? requestedActiveId : flows[0].id,
    flows
  };
}

export function validateExecutableWorkflow(flow) {
  const errors = [];
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const edges = Array.isArray(flow?.edges) ? flow.edges : [];
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const incoming = new Map(nodes.map(node => [node.id, []]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) {
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge);
    incoming.get(edge.to).push(edge);
  }
  const triggers = nodes.filter(node => node.type === 'trigger');
  if (triggers.length !== 1) errors.push('自动回复流程必须且只能有一个平台消息触发器。');
  if (!nodes.some(node => terminalNodeTypes.has(node.type))) errors.push('流程必须包含回复、转人工或结束节点。');
  for (const node of nodes) {
    if (!executableNodeTypes.has(node.type)) errors.push(`节点「${node.title}」尚未接入安全执行器，不能启用。`);
    if (node.type !== 'trigger' && !incoming.get(node.id)?.length) errors.push(`节点「${node.title}」没有上游连接。`);
    if (!terminalNodeTypes.has(node.type) && !outgoing.get(node.id)?.length) errors.push(`节点「${node.title}」缺少下一步连接。`);
    if (terminalNodeTypes.has(node.type) && outgoing.get(node.id)?.length) errors.push(`终点「${node.title}」不能继续连接后续节点。`);
    if (branchingNodeTypes.has(node.type)) {
      const branches = outgoing.get(node.id) || [];
      const labels = branches.map(edge => edge.label.trim());
      if (branches.length < 2) errors.push(`分支节点「${node.title}」至少需要两条出线。`);
      if (labels.some(label => !label)) errors.push(`分支节点「${node.title}」存在未命名分支。`);
      if (new Set(labels).size !== labels.length) errors.push(`分支节点「${node.title}」存在重复分支名称。`);
    }
  }
  if (triggers.length === 1) {
    const reachable = new Set([triggers[0].id]);
    const queue = [triggers[0].id];
    while (queue.length) {
      const id = queue.shift();
      for (const edge of outgoing.get(id) || []) {
        if (!reachable.has(edge.to)) { reachable.add(edge.to); queue.push(edge.to); }
      }
    }
    if (nodes.some(node => !reachable.has(node.id))) errors.push('流程存在无法从触发器到达的节点。');
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function selectPlatformWorkflow(state, platform = 'xianyu') {
  const normalized = normalizeWorkflowState(state);
  const labels = platform === 'douyin' ? ['抖音', '抖店', '飞鸽'] : ['闲鱼'];
  return normalized.flows.find(flow => {
    if (!flow.enabled || !validateExecutableWorkflow(flow).valid) return false;
    const trigger = flow.nodes.find(node => node.type === 'trigger');
    return ['所有已接入店铺', '', ...labels].includes(cleanText(trigger?.config?.channel));
  }) || null;
}

export function selectXianyuWorkflow(state) {
  return selectPlatformWorkflow(state, 'xianyu');
}

function edgeMatches(edge, candidates) {
  const label = cleanText(edge?.label).toLowerCase();
  return candidates.some(candidate => label.includes(candidate));
}

export function nextWorkflowNode(flow, node, context = {}) {
  const outgoing = flow.edges.filter(edge => edge.from === node.id);
  if (!outgoing.length) return null;
  let edge = outgoing[0];
  if (node.type === 'condition') {
    const hasKnowledge = Array.isArray(context.result?.sources) && context.result.sources.some(source => source.type === 'knowledge');
    const condition = cleanText(node.config?.condition);
    const passed = context.replyMode === 'full_auto'
      ? true
      : condition === '命中资料即可'
        ? hasKnowledge
        : condition === '人工协同模式'
          ? context.replyMode === 'human_collab'
          : context.risk?.level === 'low' && hasKnowledge;
    const positive = ['低风险', '通过', '是', '自动回复', '已命中', 'true'];
    const negative = ['需核对', '转人工', '未通过', '否', '否则', 'else', 'false'];
    edge = outgoing.find(item => edgeMatches(item, passed ? positive : negative)) || outgoing[passed ? 0 : Math.min(1, outgoing.length - 1)];
  } else if (node.type === 'classifier' && context.intent) {
    edge = outgoing.find(item => cleanText(item.label).includes(context.intent))
      || outgoing.find(item => /其他|默认|else/i.test(item.label))
      || outgoing[0];
  }
  return flow.nodes.find(item => item.id === edge?.to) || null;
}

export function renderWorkflowTemplate(template, context = {}) {
  const values = {
    'customer.message': context.message?.text || '',
    'previous.output': context.output || '',
    'knowledge.output': context.result?.answer || '',
    ...Object.fromEntries(Object.entries(context.variables || {}).map(([key, value]) => [`variables.${key}`, value]))
  };
  return String(template || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key) => String(values[key] ?? ''));
}

export const workflowExecutableNodeTypes = executableNodeTypes;
