const { createCipheriv, createDecipheriv, randomBytes, scryptSync } = require('node:crypto');
const { existsSync } = require('node:fs');
const { mkdir, mkdtemp, realpath, rename, rm, writeFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');

const magic = Buffer.from('OEDESK01');
const maxSize = 64 * 1024 * 1024;
const portableDataNames = new Set([
  'training-qa.json', 'self-learning.json', 'prompt-settings.json',
  'workflow-config.json', 'workbench-operations.json', 'feige-messages.json'
]);

function permittedFile(path) {
  if (typeof path !== 'string') return false;
  if (path === '.env') return true;
  const parts = path.split('/');
  if (parts[0] === 'data') return parts.length === 2 && portableDataNames.has(parts[1]);
  return parts[0] === 'knowledge-base' && parts.length > 1
    && parts.every(part => part && part !== '.' && part !== '..' && !/[\\:\x00-\x1f]/.test(part));
}

function encryptProfile(files, password) {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32), nonce);
  const data = Buffer.concat([cipher.update(JSON.stringify(files), 'utf8'), cipher.final()]);
  if (data.length > maxSize) throw new Error('私有数据包过大。');
  return Buffer.concat([magic, salt, nonce, cipher.getAuthTag(), data]);
}

async function restoreProfile(archive, target, password) {
  if (existsSync(target)) throw new Error('已有 OE DESK 数据，无法覆盖导入。');
  if (archive.length < 53 || archive.length > maxSize + 52 || !archive.subarray(0, 8).equals(magic)) {
    throw new Error('私有数据包格式有误。');
  }
  let files;
  try {
    const decipher = createDecipheriv('aes-256-gcm',
      scryptSync(password, archive.subarray(8, 24), 32), archive.subarray(24, 36));
    decipher.setAuthTag(archive.subarray(36, 52));
    files = JSON.parse(Buffer.concat([decipher.update(archive.subarray(52)), decipher.final()]).toString('utf8'));
  } catch {
    throw new Error('密码不正确，或私有数据包已损坏。');
  }
  if (!files || Array.isArray(files) || typeof files['.env'] !== 'string' ||
      Object.entries(files).some(([path, content]) => !permittedFile(path) || typeof content !== 'string')) {
    throw new Error('私有数据包的目录无效。');
  }
  await mkdir(dirname(target), { recursive: true });
  const parent = await realpath(dirname(target));
  const stage = await mkdtemp(join(parent, 'oedesk-profile-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      const output = join(stage, path);
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(output, Buffer.from(content, 'base64'), { flag: 'wx', mode: 0o600 });
    }
    if (existsSync(target)) throw new Error('已有 OE DESK 数据，无法覆盖导入。');
    await rename(stage, target);
  } finally {
    if (dirname(stage) === parent) await rm(stage, { recursive: true, force: true });
  }
}

module.exports = { encryptProfile, restoreProfile, permittedFile, portableDataNames };
