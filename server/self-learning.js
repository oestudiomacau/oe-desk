import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { modelCodes, prepareChunk, searchKnowledge } from './knowledge-retrieval.js';

export const replyModes = ['full_auto', 'human_collab', 'off', 'self_learning'];
export const automatedReplyMode = mode => mode === 'full_auto' || mode === 'human_collab';

function redact(text) {
  return String(text || '').trim().slice(0, 1200)
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[邮箱]')
    .replace(/(?<!\d)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)/g, '[手机号]')
    .replace(/((?:订单号|运单号|身份证号|微信号|手机号)\s*[:：]?\s*)[\w-]{4,}/gi, '$1[已隐藏]');
}

const privateOrConditional = /\[(?:邮箱|手机号|已隐藏)\]|https?:|订单|运单|快递|收货|地址|电话|联系|加微|微信|支付宝|付款|退款|赔偿|身份证|银行卡|发给您|截图|链接|私信|忽略|指令|提示词|角色|系统消息|密码|验证码|看情况|不确定|要确认|待确认|可能|应该|大概|大约|左右|暂时|如果|有的|选配|定制|年款|版本|批次|活动|价格|多少钱|库存|适配|通用|能装|能用|可以装|安装|刹车|制动|[?？<>]/i;
const fixedSpecification = /线径|直径|长度|宽度|高度|厚度|重量|净重|孔距|行程|容量/;
const packageFact = /材质|材料|标配|包装清单|包含|配备|带不带/;
const specificationValue = '\\d+(?:\\.\\d+)?[ \\t]*(?:mm|cm|kg|mg|ml|cc|毫米|厘米|千克|公斤|克|毫升|升)';
const bareSpecification = new RegExp(`^(?:是|为)?\\s*${specificationValue}[。！!~～\\s]*$`, 'i');
const privateChat = /\[(?:邮箱|手机号|已隐藏)\]|https?:|订单号|运单号|快递单号|收货地址|身份证|银行卡|密码|验证码|[\u4e00-\u9fff]{2,}(?:省|市|区|县|镇)[\u4e00-\u9fff]{2,}(?:路|街|巷)\d*[号弄]/i;
const conversationalReply = /^(?:您好|你好|谢谢|感谢|好的|在的|收到|辛苦了|稍等|没关系)[哈呢哦呀啊。！!~～\s]*$/;
const asksFollowUp = answer => /[？?]\s*$/.test(answer);
const followUpFields = [['车型', /车型|什么车|哪款车/], ['年款', /年款|哪一年|哪年的/],
  ['配件型号', /配件|哪款卡钳|哪款减震|具体型号/], ['规格', /规格|孔距|口径/]];

function frequentFollowUpFields(answers) {
  const followUps = answers.filter(asksFollowUp);
  return followUpFields.map(([field, pattern]) => ({ field, count: followUps.filter(answer => pattern.test(answer)).length }))
    .filter(item => item.count > 0).sort((left, right) => right.count - left.count);
}

function initialDecision({ source, answer }) {
  if (!conversationalReply.test(answer) && !asksFollowUp(answer)) return 'review';
  return source === 'history' ? 'skipped' : 'style';
}

export function learningKnowledgeCandidate({ question, answer }) {
  if (answer.length > 160 || privateOrConditional.test(question.replace(/[?？]/g, '') + '\n' + answer)) return false;
  const models = modelCodes(question);
  if (models.size !== 1) return false;
  const field = fixedSpecification.exec(question)?.[0];
  if (!field) return packageFact.test(question) && modelCodes(answer).has([...models][0]) &&
    /(?:材质|材料)(?:为|是)|采用.{1,30}(?:铝合金|不锈钢|碳钢|尼龙|橡胶)|(?:标配|包装内|随盒)(?:包含|含有|附带|配备|有)/.test(answer);
  return bareSpecification.test(answer) ||
    (new RegExp(specificationValue + '(?![a-z])', 'i').test(answer) &&
      answer.includes(field) && modelCodes(answer).has([...models][0]));
}

export function createSelfLearning(path) {
  let records = [];
  let index = [];
  let tail = Promise.resolve();

  function setRecords(next) {
    records = next;
    index = next.map(record => prepareChunk({ id: record.id, title: record.question, text: record.question, type: 'learning-example', record }));
  }

  function update(action) {
    const pending = tail.then(async () => {
      const next = await action(records);
      if (next === records) return;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path + '.tmp', JSON.stringify(next, null, 2), 'utf8');
      await rename(path + '.tmp', path);
      setRecords(next);
    });
    tail = pending.catch(() => {});
    return pending;
  }

  return {
    async load() {
      try { setRecords(JSON.parse(await readFile(path, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    list() {
      return {
        samples: [...index].reverse().map(chunk => ({ ...chunk.record, models: [...chunk.modelCodes],
          replyLength: [...chunk.record.answer].length, asksFollowUp: /[？?]\s*$/.test(chunk.record.answer) })),
        indexed: index.length,
        published: records.filter(record => record.knowledgeId).length
      };
    },
    capture(sample, screen) {
      return this.captureBatch([sample], screen);
    },
    captureBatch(samples, screen) {
      let addedCount = 0;
      let publishedCount = 0;
      return update(async current => {
        const seen = new Set(current.map(item => item.id));
        const added = [];
        for (const { platform, conversationId, replyId, question, answer, source } of samples) {
          const id = createHash('sha256').update(JSON.stringify([platform, conversationId, replyId])).digest('hex').slice(0, 20);
          if (seen.has(id)) continue;
          const record = { id, platform, question: redact(question), answer: redact(answer), learnedAt: new Date().toISOString(), source: source || 'live' };
          if (!record.question || !record.answer) continue;
          if (privateChat.test(record.question + '\n' + record.answer)) continue;
          seen.add(id);
          added.push(record);
        }
        if (!added.length) return current;
        if (screen) {
          const decisions = await screen(added.filter(learningKnowledgeCandidate));
          for (const record of added) {
            const { knowledgeId, decision } = decisions.get(record.id) || {};
            record.decision = decision || initialDecision(record);
            if (knowledgeId) Object.assign(record, { knowledgeId, publishedAt: new Date().toISOString() });
          }
        }
        addedCount = added.length;
        publishedCount = added.filter(record => record.decision === 'published').length;
        return [...current, ...added];
      }).then(() => ({ added: addedCount, published: publishedCount }));
    },
    recheck(screen) {
      return update(async current => {
        const unchecked = current.filter(record => record.platform === 'douyin' && !record.knowledgeId && !record.decision);
        if (!unchecked.length) return current;
        const decisions = await screen(unchecked.filter(record => !privateChat.test(record.question + '\n' + record.answer))
          .filter(learningKnowledgeCandidate));
        const ids = new Set(unchecked.map(record => record.id));
        return current.map(record => {
          if (!ids.has(record.id)) return record;
          const result = decisions.get(record.id);
          if (result?.knowledgeId) return { ...record, ...result, publishedAt: new Date().toISOString() };
          return { ...record, decision: result?.decision || initialDecision(record) };
        });
      });
    },
    summarize(activeKnowledge) {
      const isLinked = item => item.knowledgeId && activeKnowledge.has(item.knowledgeId);
      const sources = ['live', 'history'].map(source => {
        const items = records.filter(record => record.platform === 'douyin' && (record.source || 'live') === source && record.decision !== 'skipped');
        const published = items.filter(record => isLinked(record) && record.decision !== 'known');
        const lengths = items.map(item => [...item.answer].length).sort((left, right) => left - right);
        return { source, learned: items.length, published: published.length,
          known: items.filter(item => item.decision === 'known' && (!item.knowledgeId || isLinked(item))).length,
          review: items.filter(item => item.knowledgeId
            ? !isLinked(item) : !['style', 'known'].includes(item.decision)).length,
          style: items.filter(item => item.decision === 'style').length,
          followUps: items.filter(item => asksFollowUp(item.answer)).length,
          followUpFields: source === 'live' ? frequentFollowUpFields(items.map(item => item.answer)) : [],
          medianReplyLength: lengths[Math.floor(lengths.length / 2)] || 0,
          examples: [...published].reverse().filter((item, index, rows) =>
            rows.findIndex(other => other.knowledgeId === item.knowledgeId) === index).slice(0, 5)
            .map(({ question, answer }) => ({ question, answer })) };
      });
      return { generatedAt: new Date().toISOString(), sources };
    },
    guidance(question, platform) {
      const candidates = index.filter(chunk => chunk.record.platform === platform && chunk.record.source !== 'history');
      const matches = searchKnowledge(question, candidates, [], 3).map(item => item.chunk.record.answer);
      if (!matches.length) return '';
      const lengths = matches.map(text => [...text].length).sort((a, b) => a - b);
      const length = lengths[Math.floor(lengths.length / 2)];
      const questionCount = matches.filter(asksFollowUp).length;
      const fields = frequentFollowUpFields(matches).slice(0, 2).map(item => item.field);
      const clarification = fields.length ? `如果当前问题确实缺少对应信息，可优先核对${fields.join('或')}。` : '';
      return `相近人工答复的常用长度约 ${length} 字。${questionCount > matches.length / 2 ? '信息不足时，人工通常以一个具体问题收尾。' + clarification : '人工通常直接回答当前问题。'}仅作表达参考，服从已配置的回复规则。`;
    },
    publish(id, save) {
      return update(async current => {
        const record = current.find(item => item.id === id);
        if (!record) throw new Error('找不到学习样本。');
        if (record.knowledgeId) return current;
        const knowledge = await save(record);
        return current.map(item => item.id === id ? { ...item, knowledgeId: knowledge.id, decision: 'confirmed', publishedAt: new Date().toISOString() } : item);
      });
    }
  };
}
