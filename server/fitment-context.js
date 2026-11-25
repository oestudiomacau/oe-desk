const fitment = /适配|能装|可以装|能不能装|装不装得上|装得上|装吗|装上吗|能用|可以用|合适吗/;
const shopping = /(?:能|可以|适合|推荐)?(?:装|安装|用|选|配|换)(?:什么|哪(?:个|款|些|种))|推荐(?:什么|哪(?:个|款|些|种))|有哪(?:个|款|些|种)/;
const reset = /换个话题|另外问|不问这个|说的是另一款|退款|退货|订单|事故|故障|售后/;
const part = /(?:前|后)?(?:减震(?:器)?|避震(?:器)?|卡钳|刹车盘|制动盘|轮毂|轮圈|刹车油管|刹车油壶|油壶|油杯|刹车泵|上泵|后泵|转接码|后视镜|后摇臂|脚踏|边撑|护弓|把套)/;
const vehicle = /\b(?:(?:X[ -]?MAX|NMAX|NVX|AEROX|PCX|FORZA|NSS|ADV|TMAX)[ -]?\d{0,3}|AE[ -]?\d{1,3})(?![a-z0-9])|佛[沙莎]\s*\d{2,3}|维斯帕|\bVESPA\b/i;
const words = value => String(value || '').normalize('NFKC').toUpperCase().match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*\+?(?![A-Z0-9])/g) || [];
const vehicleName = value => String(value || '').normalize('NFKC').match(vehicle)?.[0]?.trim().toUpperCase() || '';
const detailRequest = /多少钱|价格|售价|报价|库存|有货|颜色|区别|规格|尺寸|线径|磅数|多粗|多长|垫片|包装|配什么/;

export function customerSubjects(question, history, products, faqChunks, catalogContext = {}) {
  const known = new Set([...products.map(item => item.title), ...faqChunks.map(item => item.faq.product)]
    .flatMap(words).filter(word => word.length > 1 && !vehicle.test(word) && !/^(?:RCB|ABS|DLC|SERIES|CNC|V\d+)$/.test(word)));
  const models = text => [...new Set(words(text).filter(word => known.has(word)))];
  const current = models(catalogContext.exactTitle || question);
  const kind = question.match(part)?.[0];
  const model = current.length === 1 ? current[0] : null;
  const bareModel = model && words(question).length === 1 &&
    !String(question).normalize('NFKC').replace(part, '').replace(/^(?:我说的是|是)\s*/, '')
      .replace(/[a-zA-Z0-9+\s?？。！!\-]/g, '');
  let priorQuestion = '';
  let fitmentQuestion = '';
  if (bareModel) {
    const prior = history.slice(-6).findLast(entry => entry.role === 'user');
    const text = String(prior?.content || '');
    if (!reset.test(text)) {
      if (fitment.test(text) || (shopping.test(text) && vehicleName(text))) fitmentQuestion = text;
      if (fitmentQuestion || detailRequest.test(text)) priorQuestion = text;
    }
  }
  const isFitment = Boolean(fitmentQuestion) || (fitment.test(question) && !shopping.test(question) && !reset.test(question));
  let previous = null;
  let previousVehicle = '';
  const followUp = /这款|这套|这个|那款|上面那款|多少钱|价格|售价|有货|库存|什么颜色|年款/.test(question);
  if ((isFitment || followUp) && !reset.test(question) && !/另一款|另外一款|其他配件|换个/.test(question)) {
    for (const entry of history.slice(-6).reverse()) {
      const text = String(entry.content || '');
      if (reset.test(text)) break;
      const found = models(text);
      if (found.length > 1) break;
      if (entry.role !== 'user' && !/这款|这套|这个|上面那款/.test(question)) continue;
      if (entry.role === 'user') previousVehicle ||= vehicleName(text);
      if (found.length === 1) {
        if (!current.length && (!kind || text.includes(kind))) previous = found[0];
        break;
      }
      if (text.match(part) && !/这款|这套|这个/.test(text)) break;
    }
  }
  const explicitVehicle = vehicleName(question) || (!catalogContext.inherited ? catalogContext.vehicle : '') || '';
  const identifiedVehicle = explicitVehicle || catalogContext.vehicle || vehicleName(fitmentQuestion) || previousVehicle || '';
  const candidates = [...new Set(words(fitmentQuestion || question))]
    .filter(word => word !== (model || previous) && !vehicle.test(word) && !/^(?:RCB|ABS|DLC|CNC|V\d+)$/.test(word));
  return { isFitment, isSelection: !isFitment && shopping.test(question) && Boolean(kind),
    model: model || previous, models: current, inherited: Boolean(previous), kind: kind || priorQuestion.match(part)?.[0] || '',
    vehicle: identifiedVehicle,
    vehicleInherited: !explicitVehicle && Boolean(previousVehicle || catalogContext.inherited),
    counterpart: isFitment && !identifiedVehicle && candidates.length === 1 ? candidates[0] : '',
    ambiguous: current.length > 1, fitmentQuestion, priorQuestion };
}

export function answerBasis({ subjects, question = '', purpose, sources = [], retrieval, decision, productMatches = [], skills = [] }) {
  const intent = subjects?.isFitment ? '车型适配' : /售后|订单|事故/.test(purpose) ? '订单或售后'
    : /多少钱|价格|售价|报价|价钱/.test(question) ? '商品询价'
      : /库存|有货/.test(question) ? '库存咨询' : subjects?.isSelection || /推荐/.test(purpose) ? '商品推荐' : '商品咨询';
  const types = sources.map(source => {
    if (source.type === 'web') return '网页参考';
    if (source.file?.includes('training')) return '训练问答';
    if (source.file?.includes('imported') && source.file?.includes('knowledge')) return '客服知识资料';
    return '商品资料';
  });
  if (retrieval === 'imported-faq' && types.length) types[0] = '对应的客服问答';
  if (retrieval === 'catalog-linked' && types.length) types[0] = '对应的商品目录';
  const key = value => String(value || '').normalize('NFKC').toUpperCase().replace(/[\s-]+/g, '');
  const fields = [subjects?.vehicle || subjects?.counterpart, subjects?.model, subjects?.kind].filter(Boolean);
  const references = sources.map((source, index) => {
    const text = key(source.title + ' ' + source.excerpt);
    return { type: types[index], fields: fields.filter(field => text.includes(key(field))) };
  });
  return { intent, vehicle: subjects?.vehicle || '', product: subjects?.model || subjects?.models?.join('、') || subjects?.kind || '',
    inherited: subjects?.inherited === true, vehicleInherited: subjects?.vehicleInherited === true,
    route: retrieval || 'no-match', references, sources: types, matchedProducts: productMatches.length, skills,
    decision: decision || (types.length ? '依据命中的资料回答当前问题。' : '可用资料不足，需补充信息后核对。') };
}
