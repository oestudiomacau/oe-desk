const executableNodeTypes = new Set([
  'trigger', 'rag', 'knowledge', 'llm', 'extract', 'condition', 'classifier',
  'delay', 'merge', 'variable', 'template', 'custom', 'reply', 'handoff', 'stop'
]);

const terminalNodeTypes = new Set(['reply', 'handoff', 'stop']);
const branchingNodeTypes = new Set(['condition', 'classifier']);

export function createDefaultWorkflowState() {
  return {
    version: 1,
    activeFlowId: 'default-customer-reply',
    flows: [{
      id: 'default-customer-reply',
      name: '客户消息自动处理',
      description: '对收到的客户消息进行检索、风险判断，并路由至回复或人工队列。',
      enabled: true,
      nodes: [
        { id: 'default-trigger', type: 'trigger', title: '收到平台消息', description: '从已接入的店铺接收买家消息。', x: 320, y: 620, config: { channel: '所有已接入店铺', event: '收到新买家消息' } },
        { id: 'default-rag', type: 'rag', title: 'RAG 检索与答复', description: '结合本地资料、提示词和启用的技能生成答复草稿。', x: 650, y: 620, config: { strategy: '本地 RAG 优先', prompt: '' } },
        { id: 'default-condition', type: 'condition', title: '风险与证据判断', description: '按风险等级和检索证据决定回复或转人工。', x: 980, y: 620, config: { condition: '低风险且命中资料', otherwise: '转人工' } },
        { id: 'default-reply', type: 'reply', title: '提交回复草稿', description: '把生成结果交给人工确认或写入发送队列。', x: 1320, y: 470, config: { mode: '人工确认后发送', template: '' } },
        { id: 'default-handoff', type: 'handoff', title: '转入人工队列', description: '整理问题和证据边界后交给相应人工队列。', x: 1320, y: 780, config: { queue: '人工确认', note: '' } }
      ],
      edges: [
        { id: 'default-edge-trigger-rag', from: 'default-trigger', to: 'default-rag', label: '' },
        { id: 'default-edge-rag-condition', from: 'default-rag', to: 'default-condition', label: '' },
        { id: 'default-edge-condition-reply', from: 'default-condition', to: 'default-reply', label: '低风险' },
        { id: 'default-edge-condition-handoff', from: 'default-condition', to: 'default-handoff', label: '需核对' }
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
  const flows = input.flows.slice(0, 20).map((flow, flowIndex) => {
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
  const requestedActiveId = cleanText(input.activeFlowId, 100);
  return {
    version: 1,
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
  if (triggers.length !== 1) errors.push('闲鱼自动回复流程必须且只能有一个平台消息触发器。');
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

export function selectXianyuWorkflow(state) {
  const normalized = normalizeWorkflowState(state);
  return normalized.flows.find(flow => {
    if (!flow.enabled || !validateExecutableWorkflow(flow).valid) return false;
    const trigger = flow.nodes.find(node => node.type === 'trigger');
    return ['所有已接入店铺', '闲鱼', ''].includes(cleanText(trigger?.config?.channel));
  }) || null;
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
