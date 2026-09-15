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

  const trigger = flow.nodes.find(node => node.type === 'trigger');
  const rag = nextWorkflowNode(flow, trigger, {});
  const condition = nextWorkflowNode(flow, rag, {});
  assert.equal(rag.type, 'rag');
  assert.equal(condition.type, 'condition');

  const knowledgeResult = { sources: [{ type: 'knowledge' }] };
  assert.equal(nextWorkflowNode(flow, condition, { result: knowledgeResult, risk: { level: 'low' } }).type, 'reply', 'Low-risk knowledge-backed messages must follow the reply branch.');
  assert.equal(nextWorkflowNode(flow, condition, { result: knowledgeResult, risk: { level: 'high' } }).type, 'handoff', 'High-risk messages must follow the human handoff branch.');
  assert.equal(nextWorkflowNode(flow, condition, { result: { sources: [] }, risk: { level: 'high' }, replyMode: 'full_auto' }).type, 'reply', 'Full-auto mode must retain its all-message reply behavior inside the visual workflow.');

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
