const { readFileSync } = require('node:fs');

function loadRuntimeEnv(path, env) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return env;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, name, value] = match;
    if (env.RCB_ALLOW_ENV_OVERRIDES === 'true' && env[name] !== undefined) continue;
    env[name] = value.replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function runtimePort(value) {
  const port = Number(value || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 之间的整数。');
  return port;
}

module.exports = { loadRuntimeEnv, runtimePort };
