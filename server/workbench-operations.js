import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { splitXianyuReplyForDelivery } from './xianyu-message-queue.js';
import { catalogAliasKey, defaultCatalogAliases } from './product-recommendation.js';

export function createWorkbenchOperations(directory) {
  const path = join(directory, 'workbench-operations.json');
  let state = { rules: [], assets: [] };
  let writes = Promise.resolve();
  function activeAliases(current) {
    const saved = current.catalogAliases || [];
    const excluded = new Set([...(current.deletedCatalogAliases || []), ...saved.map(item => catalogAliasKey(item.alias))]);
    return [...defaultCatalogAliases.filter(item => !excluded.has(catalogAliasKey(item.alias))), ...saved];
  }

  function update(change) {
    const pending = writes.then(async () => {
      const next = change(state);
      await mkdir(directory, { recursive: true });
      await writeFile(path + '.tmp', JSON.stringify(next), { mode: 0o600 });
      await rename(path + '.tmp', path);
      state = next;
    });
    writes = pending.catch(() => {});
    return pending;
  }

  return {
    async load() {
      try { state = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    rules: () => state.rules,
    catalogAliases: () => activeAliases(state),
    saveCatalogAlias(alias, target) {
      return update(current => {
        const aliases = current.catalogAliases || [];
        const key = catalogAliasKey(alias);
        const remaining = aliases.filter(item => catalogAliasKey(item.alias) !== key);
        if (remaining.length >= 200) throw new Error('最多保存 200 条商品关联。');
        return { ...current, catalogAliases: [...remaining, { alias, target }] };
      });
    },
    deleteCatalogAlias(alias) {
      const key = catalogAliasKey(alias);
      return update(current => ({ ...current,
        deletedCatalogAliases: [...new Set([...(current.deletedCatalogAliases || []), key])],
        catalogAliases: (current.catalogAliases || []).filter(item => catalogAliasKey(item.alias) !== key) }));
    },
    assets: () => state.assets.map(({ data, ...metadata }) => metadata),
    asset: id => state.assets.find(item => item.id === id),
    match(platform, message) {
      const normalized = message.normalize('NFKC').toLowerCase();
      const matches = state.rules.filter(rule => rule.enabled && (rule.platform === 'all' || rule.platform === platform)
        && rule.words.some(word => normalized.includes(word.normalize('NFKC').toLowerCase())));
      return matches.find(rule => rule.action === 'handoff') || matches[0];
    },
    saveRules(input) {
      if (!Array.isArray(input) || input.length > 50) throw new Error('最多保存 50 条规则。');
      const rules = input.map(rule => {
        const name = String(rule.name || '').trim();
        const answer = String(rule.answer || '').trim();
        const words = [...new Set(String(rule.keywords || '').split(/[、，,\n]/).map(word => word.trim()).filter(Boolean))];
        if (!name || name.length > 60 || !words.length || words.length > 30 || words.some(word => word.length > 60)
          || !['all', 'douyin', 'xianyu'].includes(rule.platform) || !['handoff', 'reply'].includes(rule.action)
          || answer.length > 200 || (rule.action === 'reply' && !splitXianyuReplyForDelivery(answer).some(Boolean))) throw new Error('请检查规则名称、关键词、渠道和回复内容。');
        return { name, words, platform: rule.platform, action: rule.action, answer: rule.action === 'reply' ? answer : '', enabled: rule.enabled === true };
      });
      return update(current => ({ ...current, rules }));
    },
    addAsset(input) {
      const name = String(input.name || '').trim().slice(0, 150);
      const data = String(input.data || '');
      if (!name || data.length > 2_800_000 || !/^[\w+/]+={0,2}$/.test(data)) throw new Error('请选择不超过 2 MB 的图片。');
      const bytes = Buffer.from(data, 'base64');
      const hex = bytes.subarray(0, 12).toString('hex');
      const type = hex.startsWith('89504e470d0a1a0a') ? 'png' : hex.startsWith('ffd8ff') ? 'jpeg'
        : hex.startsWith('52494646') && hex.endsWith('57454250') ? 'webp' : null;
      if (!type || bytes.length > 2 * 1024 * 1024) throw new Error('只支持 2 MB 以内的 PNG、JPEG、WebP 图片。');
      return update(current => {
        if (current.assets.length >= 30) throw new Error('图库已满，请删除不需要的图片。');
        return { ...current, assets: [{ id: randomUUID(), name, type, size: bytes.length, data, createdAtMs: Date.now() }, ...current.assets] };
      });
    },
    deleteAsset(id) {
      return update(current => ({ ...current, assets: current.assets.filter(item => item.id !== id) }));
    }
  };
}

export function summarizePlatformHistory(platform, state) {
  const replies = new Map();
  for (const reply of state.sent) {
    if (!reply.sourceMessageId || reply.delivery === 'superseded') continue;
    const group = replies.get(reply.sourceMessageId) || [];
    group.push(reply);
    replies.set(reply.sourceMessageId, group);
  }
  const inbound = state.messages.filter(item => item.direction === 'in');
  const latest = new Map(inbound.map(item => [item.conversationId, item.id]));
  return inbound.map(item => {
    const group = replies.get(item.id) || [];
    const delivered = group.length > 0 && group.every(reply => reply.delivery === 'sent');
    const status = delivered ? 'sent' : group.some(reply => reply.delivery === 'verifying') ? 'verifying' : item.status;
    return {
      id: item.id, platform, conversationId: item.conversationId,
      question: item.text, answer: delivered ? group.map(reply => reply.text).join('\n') : item.draft || '',
      status, rule: item.matchedRule || '', at: item.updatedAtMs || item.createdAtMs,
      actionable: latest.get(item.conversationId) === item.id && ['needs_human', 'error', 'verifying'].includes(status)
    };
  });
}
