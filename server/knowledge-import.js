import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import XLSX from 'xlsx';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_BYTES = 30 * 1024 * 1024;

function safeFileName(name) {
  const clean = basename(String(name || 'upload')).replace(/[^a-zA-Z0-9._-\u4e00-\u9fff]/g, '_');
  return clean.slice(0, 120) || 'upload';
}

function toMarkdown(file, scope, parseCsv) {
  const name = safeFileName(file.name);
  const extension = extname(name).toLowerCase();
  const buffer = Buffer.from(String(file.data || ''), 'base64');
  if (!buffer.length) throw new Error(`${name} is empty.`);
  if (buffer.length > MAX_FILE_BYTES) throw new Error(`${name} exceeds the 8 MB limit.`);

  let body;
  let table = [];
  if (['.xlsx', '.xls'].includes(extension)) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    body = workbook.SheetNames.map(sheetName => {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
      table.push(...rows.slice(0, 5000).map(row => row.map(cell => String(cell ?? '').trim())));
      return `## ${sheetName}\n${rows.map(row => row.map(cell => String(cell ?? '').trim()).join(' | ')).filter(Boolean).join('\n')}`;
    }).filter(Boolean).join('\n\n');
  } else if (extension === '.csv') {
    const rows = parseCsv(buffer.toString('utf8')).map(row => row.map(cell => String(cell ?? '').trim()));
    table = rows.slice(0, 5000);
    body = rows.map(row => row.join(' | ')).join('\n');
  } else if (extension === '.json') {
    body = JSON.stringify(JSON.parse(buffer.toString('utf8')), null, 2);
  } else {
    body = buffer.toString('utf8');
    table = body.split(/\r?\n/).filter(line => line.trim()).map(line => [line]);
  }
  if (!body.trim()) throw new Error(`${name} has no readable content.`);
  const title = name.replace(/\.[^.]+$/, '');
  const normalizedBody = body.trim();
  return { name, markdown: `---\nsource: imported\nscope: ${scope}\noriginal_file: ${name}\n---\n# ${title}\n\n${normalizedBody}\n`, preview: normalizedBody.slice(0, 180).replace(/\s+/g, ' '), characters: normalizedBody.length, table };
}

export async function importKnowledgeFiles({ root, input, parseCsv, onImported }) {
  const scope = input.scope === 'products' ? 'products' : 'knowledge';
  const files = Array.isArray(input.files) ? input.files : [];
  if (!files.length) throw new Error('请选择至少一个资料文件。');
  if (files.length > 20) throw new Error('单次最多导入 20 个文件。');
  if (files.reduce((total, file) => total + Buffer.byteLength(String(file.data || ''), 'base64'), 0) > MAX_BATCH_BYTES) throw new Error('单次导入总大小不能超过 30 MB。');

  const targetDir = join(root, 'knowledge-base', 'imported', scope);
  await mkdir(targetDir, { recursive: true });
  const imported = [];
  for (const file of files) {
    const result = toMarkdown(file, scope, parseCsv);
    const output = join(targetDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${result.name.replace(/\.[^.]+$/, '')}.md`);
    await writeFile(output, result.markdown, 'utf8');
    imported.push({ name: result.name, file: output.replace(root + '\\', '').replace(root + '/', ''), scope, preview: result.preview, characters: result.characters, table: result.table });
  }
  await onImported();
  return { status: 'imported', imported };
}

export async function listImportedKnowledgeFiles({ root, chunkCount }) {
  const result = [];
  for (const scope of ['products', 'knowledge']) {
    const dir = join(root, 'knowledge-base', 'imported', scope);
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names.filter(item => item.endsWith('.md'))) {
      const relative = join('knowledge-base', 'imported', scope, name);
      const raw = await readFile(join(dir, name), 'utf8');
      const original = raw.match(/^original_file:\s*(.+)$/m)?.[1]?.trim() || name;
      const body = raw.replace(/^---[\s\S]*?---\s*/, '').replace(/^#\s+[^\n]+\n*/, '').trim();
      const lines = body.split(/\r?\n/).filter(line => line.trim());
      const table = lines.map(line => line.includes('|') ? line.split('|').map(cell => cell.trim()) : [line]);
      result.push({ name: original, file: relative, scope, format: extname(original).slice(1).toUpperCase() || 'TEXT', preview: body.slice(0, 180).replace(/\s+/g, ' '), characters: body.length, chunks: chunkCount(relative), importedAt: (await stat(join(dir, name)).catch(() => null))?.mtime?.toLocaleString('zh-CN') || '已导入', table });
    }
  }
  return result.sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
}

export async function updateImportedKnowledgeFile({ root, input, onImported }) {
  const relative = String(input.file || '').replaceAll('\\', '/');
  if (!/^knowledge-base\/imported\/(products|knowledge)\/[^/]+\.md$/i.test(relative)) throw new Error('无效的导入资料路径。');
  const target = join(root, ...relative.split('/'));
  const raw = await readFile(target, 'utf8');
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const safeRows = rows.map(row => Array.isArray(row) ? row.map(cell => String(cell ?? '').replace(/[\r\n]/g, ' ').trim()) : [String(row ?? '').trim()]).filter(row => row.some(Boolean));
  const header = raw.match(/^(---[\s\S]*?---\s*#\s+[^\n]+\n\n)/)?.[1] || '';
  if (!header) throw new Error('导入资料格式无法识别。');
  const body = safeRows.map(row => row.join(' | ')).join('\n');
  await writeFile(target, `${header}${body}\n`, 'utf8');
  await onImported();
  return { status: 'updated', file: relative, rows: safeRows.length };
}

export async function deleteImportedKnowledgeFile({ root, input, onImported }) {
  const relative = String(input.file || '').replaceAll('\\', '/');
  if (!/^knowledge-base\/imported\/(products|knowledge)\/[^/]+\.md$/i.test(relative)) throw new Error('无效的导入资料路径。');
  const target = join(root, ...relative.split('/'));
  const { unlink } = await import('node:fs/promises');
  await unlink(target);
  await onImported();
  return { status: 'deleted', file: relative };
}
