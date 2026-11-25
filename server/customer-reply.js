const internalLinePattern = /^(?:思考(?:过程|链路)?|分析(?:过程)?|检索(?:过程|结果|摘要)?|RAG(?:\s*摘要)?|知识库(?:检索|匹配|命中)?|内部核验|处理步骤)\s*[：:]/i;

export function sanitizeCustomerReply(value, fallback = '这个问题暂时无法确认，请告诉我具体商品、车型或订单信息。') {
  let text = String(value || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:thinking|analysis)[\s\S]*?```/gi, '')
    .split(/\r?\n/)
    .filter(line => !internalLinePattern.test(line.trim()))
    .join('\n');
  text = text
    .replace(/(?:我|系统)?(?:已经|已)?从(?:本地)?(?:知识库|资料库)(?:里|中)?(?:为您|帮您)?(?:检索|搜索|搜寻|查找|查询|匹配|关联)(?:到|出)?(?:的|了)?/g, '')
    .replace(/根据(?:知识库|检索资料|搜索结果|资料命中)(?:显示|来看|可知)?[，,:：]?/g, '')
    .replace(/当前检索到的资料不足以安全确认这个问题/g, '这个问题暂时无法确认')
    .replace(/(?:知识库|资料库)(?:里|中)?(?:暂时)?(?:没有|暂无)([^。！？!\n]*)/g, '目前暂时没有$1')
    .replace(/(?:RAG|检索)(?:结果|过程|链路|摘要)/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*[：:，,。]+\s*/g, '')
    .trim();
  return text || fallback;
}
