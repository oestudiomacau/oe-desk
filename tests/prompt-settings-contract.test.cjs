const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const serverSource = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');
const htmlSource = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

assert.match(serverSource, /promptSettingsPath/, 'Prompt settings must have server-side storage.');
assert.match(serverSource, /loadPromptSettings/, 'Prompt settings must be loaded when the service starts.');
assert.match(serverSource, /\/api\/prompt-settings/, 'The service must expose prompt settings to the local workbench.');
assert.match(serverSource, /configuredPromptAddendum\(/, 'Every RAG request must include persisted prompt and enabled skills.');
assert.match(serverSource, /promptSettingsRevision/, 'Saved prompt settings must expose a stable revision for runtime verification.');
assert.match(serverSource, /promptSettingsRevision: promptSettingsRevision\(\)/, 'Every generated reply trace must identify the prompt revision it used.');
assert.match(htmlSource, /fetch\('\/api\/prompt-settings'/, 'The workbench must load the authoritative prompt settings.');
assert.match(htmlSource, /savePromptSettings\(/, 'Saving a prompt or skill must persist it to the service.');
assert.match(htmlSource, /promptSettingsRevision/, 'The workbench must surface which prompt revision produced a reply.');
assert.match(htmlSource, /id="skill-test-question"/, 'A skill card must provide a real question input for a safe local trial.');
assert.match(htmlSource, /id="run-skill"/, 'A skill card must provide an explicit run action.');
assert.match(htmlSource, /data-skill-run-result/, 'A skill card must render the observable result of its trial.');

console.log('prompt settings contract passed');
