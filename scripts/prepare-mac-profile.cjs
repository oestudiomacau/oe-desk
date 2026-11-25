const { randomBytes } = require('node:crypto');
const { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { encryptProfile, permittedFile, portableDataNames } = require('../electron/private-profile.cjs');

const [source, archive, passwordFile] = process.argv.slice(2);
if (!source || !archive || !passwordFile) throw new Error('Provide a workbench profile, encrypted output and password file.');

const settings = readFileSync(join(source, '.env'), 'utf8').split(/\r?\n/).filter(line =>
  /^\s*(RAG_PROVIDER|OPENAI_BASE_URL|OPENAI_API_KEY|OPENAI_CHAT_MODEL|OPENAI_EMBED_MODEL|OLLAMA_BASE_URL|OLLAMA_CHAT_MODEL|OLLAMA_EMBED_MODEL|RAG_EMBEDDING_ENABLED)\s*=/.test(line));
if (!settings.some(line => /^\s*OPENAI_API_KEY\s*=\s*\S/.test(line))) throw new Error('The current model profile has no API key.');
const files = { '.env': Buffer.from(settings.join('\n') + '\n', 'utf8').toString('base64') };

function collectKnowledge(directory) {
  for (const entry of readdirSync(join(source, directory), { withFileTypes: true })) {
    const relative = directory + '/' + entry.name;
    if (entry.isDirectory()) collectKnowledge(relative);
    else if (entry.isFile() && permittedFile(relative)) files[relative] = readFileSync(join(source, relative)).toString('base64');
  }
}
collectKnowledge('knowledge-base');
for (const name of portableDataNames) {
  if (name === 'feige-messages.json') continue;
  const relative = 'data/' + name;
  const path = join(source, relative);
  if (statSync(path, { throwIfNoEntry: false })?.isFile()) files[relative] = readFileSync(path).toString('base64');
}
files['data/feige-messages.json'] = Buffer.from(JSON.stringify({ listening: false, replyMode: 'off' })).toString('base64');
const password = randomBytes(12).toString('hex');
mkdirSync(dirname(passwordFile), { recursive: true });
writeFileSync(archive, encryptProfile(files, password), { mode: 0o600 });
writeFileSync(passwordFile, password + '\n', { mode: 0o600 });
