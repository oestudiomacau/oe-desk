const assert = require('node:assert/strict');

(async () => {
  const {
    createDefaultWorkflowState,
    nextWorkflowNode,
    normalizeWorkflowState,
    selectXianyuWorkflow,
    validateExecutableWorkflow
  } = await import('../server/workflow-engine.js');

  const state = createDefaultWorkflowState();
  const flow = selectXianyuWorkflow(state);
  assert.ok(flow, 'The built-in customer reply workflow must be executable on first run.');
  assert.equal(validateExecutableWorkflow(flow).valid, true);
  assert.equal(state.version, 2, 'The improved automatic workflow must use the migration-safe v2 schema.');

  const trigger = flow.nodes.find(node => node.type === 'trigger');
  const classifier = nextWorkflowNode(flow, trigger, {});
  const rag = nextWorkflowNode(flow, classifier, { intent: '商品咨询' });
  const reply = nextWorkflowNode(flow, rag, {});
  assert.equal(classifier.type, 'classifier');
  assert.equal(rag.type, 'rag');
  assert.equal(reply.type, 'reply');
  assert.equal(reply.config.mode, 'AI 全托管队列', 'The canvas reply node must control automatic delivery without relying on a separate global mode.');

  const condition = { id: 'condition', type: 'condition', config: { condition: '低风险且命中资料' } };
  const conditionFlow = { nodes: [condition, { id: 'reply', type: 'reply' }, { id: 'handoff', type: 'handoff' }], edges: [{ from: 'condition', to: 'reply', label: '低风险' }, { from: 'condition', to: 'handoff', label: '需核对' }] };
  const knowledgeResult = { sources: [{ type: 'knowledge' }] };
  assert.equal(nextWorkflowNode(conditionFlow, condition, { result: knowledgeResult, risk: { level: 'low' } }).type, 'reply', 'Low-risk knowledge-backed messages must follow the reply branch.');
  assert.equal(nextWorkflowNode(conditionFlow, condition, { result: knowledgeResult, risk: { level: 'high' } }).type, 'handoff', 'High-risk messages must follow the human handoff branch.');
  assert.equal(nextWorkflowNode(conditionFlow, condition, { result: { sources: [] }, risk: { level: 'high' }, replyMode: 'full_auto' }).type, 'reply', 'Full-auto mode must retain its all-message reply behavior inside a conditional workflow.');

  const legacyState = normalizeWorkflowState({
    version: 1,
    activeFlowId: 'default-customer-reply',
    flows: [{
      id: 'default-customer-reply', name: '客户消息自动处理', enabled: true,
      nodes: [
        { id: 'old-trigger', type: 'trigger', config: { channel: '天猫' } },
        { id: 'old-rag', type: 'rag', config: {} },
        { id: 'old-reply', type: 'reply', config: { mode: '人工确认后发送' } }
      ],
      edges: [{ id: 'old-a', from: 'old-trigger', to: 'old-rag' }, { id: 'old-b', from: 'old-rag', to: 'old-reply' }]
    }]
  });
  const migrated = selectXianyuWorkflow(legacyState);
  assert.ok(migrated, 'The broken v1 default flow must migrate to an executable Xianyu workflow.');
  assert.equal(migrated.nodes.find(node => node.type === 'trigger').config.channel, '所有已接入店铺');
  assert.equal(migrated.nodes.find(node => node.type === 'reply').config.mode, 'AI 全托管队列');

  const disabled = normalizeWorkflowState({ ...state, flows: state.flows.map(item => ({ ...item, enabled: false })) });
  assert.equal(selectXianyuWorkflow(disabled), null, 'Disabling the flow must have a real effect on automatic processing.');

  const unsafe = normalizeWorkflowState({
    version: 1,
    activeFlowId: 'unsafe',
    flows: [{
      id: 'unsafe', name: 'unsafe', enabled: true,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { channel: '闲鱼' } },
        { id: 'code', type: 'code', config: { code: 'return input' } },
        { id: 'reply', type: 'reply', config: {} }
      ],
      edges: [{ id: 'a', from: 'trigger', to: 'code' }, { id: 'b', from: 'code', to: 'reply' }]
    }]
  });
  assert.equal(validateExecutableWorkflow(unsafe.flows[0]).valid, false, 'Arbitrary code nodes must not be presented as executable without a sandbox.');

  console.log('workflow engine tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
