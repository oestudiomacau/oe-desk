import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import XLSX from 'xlsx';
import { deleteProductRows, organizeProductMarkdown, productColumns, readProductRows, writeProductRows } from './product-markdown.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_BYTES = 30 * 1024 * 1024;

function safeFileName(name) {
  const clean = basename(String(name || 'upload')).replace(/[^a-zA-Z0-9._-\u4e00-\u9fff]/g, '_');
  return clean.slice(0, 120) || 'upload';
}

function compactExcelRows(rows) {
  const populated = rows.filter(row => row.some(cell => String(cell ?? '').trim()));
  if (!populated.length) return [];
  const [header, ...data] = populated;
  const used = new Set();
  for (const row of data) row.forEach((cell, index) => {
    if (String(cell ?? '').trim()) used.add(index);
  });
  header.forEach((cell, index) => {
    const label = String(cell ?? '').trim();
    if (label && !/^字段\s*\d+$/.test(label)) used.add(index);
  });
  const columns = [...used].sort((a, b) => a - b);
  return populated.map(row => columns.map(index => String(row[index] ?? '').replace(/\r?\n/g, ' ').trim()));
}

function combineExcelSheets(sheets) {
  const populated = sheets.map(sheet => ({ ...sheet, rows: compactExcelRows(sheet.rows) })).filter(sheet => sheet.rows[0]?.length);
  const columns = new Map();
  const body = [];
  const multiple = populated.length > 1;
  if (multiple) columns.set('sheet', '工作表');
  for (const { name, rows } of populated) {
    const [header, ...data] = rows;
    const counts = new Map();
    const keys = header.map((cell, index) => {
      const label = cell || `字段 ${index + 1}`;
      const count = (counts.get(label) || 0) + 1;
      counts.set(label, count);
      const key = JSON.stringify([label, count]);
      columns.set(key, label);
      return key;
    });
    for (const row of data) {
      const values = new Map(keys.map((key, index) => [key, row[index]]));
      if (multiple) values.set('sheet', name);
      body.push(values);
    }
  }
  return columns.size ? [[...columns.values()], ...body.map(row => [...columns.keys()].map(key => row.get(key) ?? ''))] : [];
}

function readExcelSheet(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const startRow = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']).s.r : 0;
  const startCol = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']).s.c : 0;
  for (const { s, e } of sheet['!merges'] || []) {
    // Vertical merges carry a category or product name across its data rows.
    if (s.c !== e.c || s.r === e.r) continue;
    const value = rows[s.r - startRow]?.[s.c - startCol];
    if (!String(value ?? '').trim()) continue;
    for (let index = s.r + 1 - startRow; index <= Math.min(e.r - startRow, rows.length - 1); index++) {
      const row = rows[index];
      if (row?.some(cell => String(cell ?? '').trim())) row[s.c - startCol] ||= value;
    }
  }
  return rows;
}

const excelExtension = /\.xlsx?$/i;
const excelRowText = row => row.map(cell => cell.replace(/[\\|]/g, character => '\\' + character)).join(' | ');
const parseExcelRow = line => line.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\([\\|])/g, '$1'));

export function importedFaqRows(body, metadata) {
  const rows = body.split(/\r?\n/).filter(line => line.trim() && !/^##\s/.test(line));
  const questionLabel = /^(问题|客户问题|客户问法|问法|提问|问|question)$/i;
  const answerLabel = /^(回复|回答|答案|客服回复|参考回复|客服回答|答|answer)$/i;
  let columns;
  let product = '';
  const result = [];
  for (const line of rows) {
    const row = metadata.table_format === 'excel-rows' ? parseExcelRow(line)
      : line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
    const question = row.findIndex(value => questionLabel.test(value));
    const answer = row.findIndex(value => answerLabel.test(value));
    if (question >= 0 && answer >= 0) {
      columns = { question, answer, product: row.findIndex(value => /^(产品|商品|型号|商品名称|产品名称|适用商品)$/.test(value)),
        note: row.findIndex(value => /^(备注|说明)$/.test(value)) };
      product = '';
      continue;
    }
    if (!columns || !row[columns.question] || !row[columns.answer] || row.every(value => /^:?-{2,}:?$/.test(value))) continue;
    product = row[columns.product] || product;
    result.push({ product, question: row[columns.question], answer: row[columns.answer], note: row[columns.note] || '' });
  }
  return result;
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
    const rows = combineExcelSheets(workbook.SheetNames.map(name => ({ name, rows: readExcelSheet(workbook.Sheets[name]) })));
    table = rows.slice(0, 5000);
    body = rows.map(excelRowText).join('\n');
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
  const excelFormat = excelExtension.test(name) ? 'table_format: excel-rows\n' : '';
  return { name, markdown: `---\nsource: imported\nscope: ${scope}\noriginal_file: ${name}\n${excelFormat}---\n# ${title}\n\n${normalizedBody}\n`, preview: normalizedBody.slice(0, 180).replace(/\s+/g, ' '), characters: normalizedBody.length, table };
}

export async function importKnowledgeFiles({ root, input, parseCsv, onImported, complete }) {
  const scope = input.scope === 'products' ? 'products' : 'knowledge';
  const files = Array.isArray(input.files) ? input.files : [];
  if (!files.length) throw new Error('请选择至少一个资料文件。');
  if (files.length > 20) throw new Error('单次最多导入 20 个文件。');
  if (files.reduce((total, file) => total + Buffer.byteLength(String(file.data || ''), 'base64'), 0) > MAX_BATCH_BYTES) throw new Error('单次导入总大小不能超过 30 MB。');

  const targetDir = join(root, 'knowledge-base', 'imported', scope);
  await mkdir(targetDir, { recursive: true });
  const imported = [];
  for (const upload of files) {
    const result = toMarkdown(upload, scope, parseCsv);
    const output = join(targetDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${result.name.replace(/\.[^.]+$/, '')}.md`);
    await writeFile(output, result.markdown, 'utf8');
    const file = output.replace(root + '\\', '').replace(root + '/', '');
    const entry = { name: result.name, file, scope, preview: result.preview, characters: result.characters, table: result.table };
    if (scope === 'products' && extname(result.name).toLowerCase() === '.md') {
      entry.productMarkdown = true;
      try {
        const rows = await organizeImportedProductFile({ root, file, complete });
        entry.table = [productColumns, ...rows];
        entry.organizedProducts = rows.length;
      } catch (error) {
        entry.organizeError = error.message;
      }
    }
    imported.push(entry);
  }
  await onImported();
  return { status: 'imported', imported };
}

export async function organizeImportedProductFile({ root, file, complete }) {
  const relative = String(file || '').replaceAll('\\', '/');
  if (!/^knowledge-base\/imported\/products\/[^/]+\.md$/i.test(relative)) throw new Error('请选择商品事实库中的 Markdown 文件。');
  const target = join(root, ...relative.split('/'));
  const raw = await readFile(target, 'utf8');
  if (!/^original_file:[^\n]+\.md\s*$/im.test(raw)) throw new Error('仅支持整理原始 Markdown 商品资料。');
  const existing = await readProductRows(target);
  if (existing) return existing;
  const body = raw.replace(/^---[\s\S]*?---\s*/, '').replace(/^#\s+[^\n]+\n*/, '');
  const rows = await organizeProductMarkdown(body, complete);
  if (!rows.length) throw new Error('未找到可核对的商品记录，请检查原文后再整理。');
  if ((await readFile(target, 'utf8')) !== raw) throw new Error('资料已变更，请刷新后重新整理。');
  return (await readProductRows(target)) ?? writeProductRows(target, rows);
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
      let table = lines.map(line => line.split('|').map(cell => cell.trim()));
      if (/^table_format: excel-rows$/m.test(raw) && excelExtension.test(original)) {
        table = compactExcelRows(lines.map(parseExcelRow));
      } else if (excelExtension.test(original)) {
        const sheets = [];
        for (const line of lines) {
          if (line.startsWith('## ')) {
            sheets.push({ name: line.slice(3), rows: [] });
          } else {
            if (!sheets.length) sheets.push({ name: '', rows: [] });
            sheets.at(-1).rows.push(line.split('|').map(cell => cell.trim()));
          }
        }
        table = combineExcelSheets(sheets);
      }
      const productMarkdown = scope === 'products' && extname(original).toLowerCase() === '.md';
      const products = productMarkdown ? await readProductRows(join(dir, name)) : null;
      if (products) table = [productColumns, ...products];
      result.push({ name: original, file: relative, scope, format: extname(original).slice(1).toUpperCase() || 'TEXT', preview: body.slice(0, 180).replace(/\s+/g, ' '), characters: body.length, chunks: chunkCount(relative), importedAt: (await stat(join(dir, name)).catch(() => null))?.mtime?.toLocaleString('zh-CN') || '已导入', table, productMarkdown, organizedProducts: products?.length });
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
  if (relative.startsWith('knowledge-base/imported/products/') && await readProductRows(target)) {
    const records = await writeProductRows(target, rows.slice(1));
    await onImported();
    return { status: 'updated', file: relative, rows: records.length };
  }
  const safeRows = rows.map(row => Array.isArray(row) ? row.map(cell => String(cell ?? '').replace(/[\r\n]/g, ' ').trim()) : [String(row ?? '').trim()]).filter(row => row.some(Boolean));
  let header = raw.match(/^(---[\s\S]*?---\s*#\s+[^\n]+\n\n)/)?.[1] || '';
  if (!header) throw new Error('导入资料格式无法识别。');
  const original = raw.match(/^original_file:\s*(.+)$/m)?.[1]?.trim() || '';
  const excel = excelExtension.test(original);
  if (excel && !/^table_format: excel-rows$/m.test(header)) {
    header = header.replace(/\n---/, '\ntable_format: excel-rows\n---');
  }
  const body = excel
    ? compactExcelRows(safeRows).map(excelRowText).join('\n')
    : safeRows.map(row => row.join(' | ')).join('\n');
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
  if (relative.startsWith('knowledge-base/imported/products/')) await deleteProductRows(target);
  await onImported();
  return { status: 'deleted', file: relative };
}
