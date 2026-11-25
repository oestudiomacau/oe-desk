const intents = ['车型适配', '订单或售后', '商品推荐', '商品咨询', '商品询价', '库存咨询'];
const sourceTypes = ['网页参考', '训练问答', '客服知识资料', '商品资料', '对应的客服问答', '对应的商品目录'];
const decisions = [
  '缺少要核对的具体配件，先确认商品再查适配。',
  '已识别车型和配件，现有资料未确认这组适配关系。',
  '按客户的车型和配件需求筛选目录商品，请按实际规格核对适配。',
  '采用与当前问题和商品对应的客服问答。',
  '依据命中的资料回答当前问题。',
  '可用资料不足，需补充信息后核对。'
];
const label = value => typeof value === 'string' && /^[\p{L}\p{N} +、\-]{1,40}$/u.test(value) ? value : '';
const routes = ['clarify-product', 'fitment-unverified', 'imported-faq', 'catalog-linked', 'training-guided',
  'lexical', 'hybrid', 'web-fallback', 'no-match'];

export function publicAnswerBasis(input) {
  if (!input || !intents.includes(input.intent) || !decisions.includes(input.decision)) return undefined;
  return {
    intent: input.intent,
    vehicle: label(input.vehicle),
    product: label(input.product),
    inherited: input.inherited === true,
    vehicleInherited: input.vehicleInherited === true,
    route: routes.includes(input.route) ? input.route : '',
    references: Array.isArray(input.references) ? input.references.filter(item => sourceTypes.includes(item?.type)).slice(0, 6)
      .map(item => ({ type: item.type, fields: Array.isArray(item.fields) ? item.fields.slice(0, 3).map(label).filter(Boolean) : [] })) : [],
    sources: Array.isArray(input.sources) ? input.sources.filter(item => sourceTypes.includes(item)).slice(0, 6) : [],
    skills: Array.isArray(input.skills) ? [...new Set(input.skills.filter(name => typeof name === 'string')
      .map(name => name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160)).filter(Boolean))].slice(0, 40) : [],
    matchedProducts: Number.isInteger(input.matchedProducts) ? Math.max(0, Math.min(4, input.matchedProducts)) : 0,
    decision: input.decision
  };
}
