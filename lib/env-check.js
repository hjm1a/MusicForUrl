const fs = require('node:fs');
const path = require('node:path');

const ENV_KEY_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function parseEnvKeys(content) {
  const keys = new Set();
  const text = String(content || '');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = line.match(ENV_KEY_RE);
    if (m && m[1]) keys.add(m[1]);
  }
  return keys;
}

function parseEnvEntries(content) {
  const entries = [];
  const text = String(content || '');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = line.match(ENV_KEY_RE);
    if (!m || !m[1]) continue;
    entries.push({ key: m[1], line: line.trimEnd() });
  }
  return entries;
}

function ensureEnvFile(opts = {}) {
  const root = opts.rootDir || process.cwd();
  const envPath = opts.envPath || path.join(root, '.env');
  const examplePath = opts.examplePath || path.join(root, 'env.example');
  const logger = opts.logger || console;

  if (!fs.existsSync(examplePath)) {
    return { created: false, addedKeys: [] };
  }

  const exampleContent = fs.readFileSync(examplePath, 'utf8');
  const exampleEntries = parseEnvEntries(exampleContent);
  const expectedKeys = new Set(exampleEntries.map((e) => e.key));

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, exampleContent, 'utf8');
    const addedKeys = Array.from(expectedKeys);
    if (addedKeys.length > 0) {
      logger.info?.(`[ENV] Created .env from env.example (${addedKeys.length} keys)`);
    }
    return { created: true, addedKeys };
  }

  const envContent = fs.readFileSync(envPath, 'utf8');
  const currentKeys = parseEnvKeys(envContent);

  const missingLines = [];
  const addedKeys = [];
  for (const entry of exampleEntries) {
    if (!currentKeys.has(entry.key)) {
      missingLines.push(entry.line);
      addedKeys.push(entry.key);
      currentKeys.add(entry.key);
    }
  }

  if (missingLines.length === 0) {
    return { created: false, addedKeys: [] };
  }

  let next = envContent;
  if (next && !next.endsWith('\n')) next += '\n';
  if (next) next += '\n';
  next += '# Auto-added missing keys from env.example\n';
  next += missingLines.join('\n');
  next += '\n';

  fs.writeFileSync(envPath, next, 'utf8');
  logger.info?.(`[ENV] Added missing keys to .env: ${addedKeys.join(', ')}`);
  return { created: false, addedKeys };
}

module.exports = {
  ensureEnvFile,
  parseEnvKeys
};
