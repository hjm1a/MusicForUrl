const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureEnvFile, parseEnvKeys } = require('../lib/env-check');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-env-check-'));
}

test('parseEnvKeys reads non-comment keys', () => {
  const keys = parseEnvKeys(`
PORT=3000
# IGNORE_ME=1
  TOKEN_TTL_HOURS = 168
`);
  assert.deepEqual(keys, new Set(['PORT', 'TOKEN_TTL_HOURS']));
});

test('ensureEnvFile appends missing keys from example', () => {
  const dir = makeTempDir();
  const envPath = path.join(dir, '.env');
  const examplePath = path.join(dir, 'env.example');

  fs.writeFileSync(envPath, 'PORT=3000\n', 'utf8');
  fs.writeFileSync(examplePath, 'PORT=3000\nCACHE_TTL=86400\nTOKEN_TTL_HOURS=168\n', 'utf8');

  const result = ensureEnvFile({ envPath, examplePath });
  const content = fs.readFileSync(envPath, 'utf8');

  assert.equal(result.created, false);
  assert.deepEqual(result.addedKeys, ['CACHE_TTL', 'TOKEN_TTL_HOURS']);
  assert.match(content, /CACHE_TTL=86400/);
  assert.match(content, /TOKEN_TTL_HOURS=168/);
});

test('ensureEnvFile creates .env when missing', () => {
  const dir = makeTempDir();
  const envPath = path.join(dir, '.env');
  const examplePath = path.join(dir, 'env.example');

  fs.writeFileSync(examplePath, 'PORT=3000\nCACHE_TTL=86400\n', 'utf8');
  const result = ensureEnvFile({ envPath, examplePath });

  assert.equal(result.created, true);
  assert.deepEqual(result.addedKeys, ['PORT', 'CACHE_TTL']);
  assert.equal(fs.existsSync(envPath), true);
});

test('ensureEnvFile is idempotent for existing keys', () => {
  const dir = makeTempDir();
  const envPath = path.join(dir, '.env');
  const examplePath = path.join(dir, 'env.example');

  fs.writeFileSync(envPath, 'PORT=3000\nCACHE_TTL=86400\n', 'utf8');
  fs.writeFileSync(examplePath, 'PORT=3000\nCACHE_TTL=86400\n', 'utf8');

  const first = ensureEnvFile({ envPath, examplePath });
  const second = ensureEnvFile({ envPath, examplePath });

  assert.deepEqual(first.addedKeys, []);
  assert.deepEqual(second.addedKeys, []);
});
