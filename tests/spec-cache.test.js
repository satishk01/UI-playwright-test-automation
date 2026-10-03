const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the cache dir before requiring the module (CACHE_FILE is resolved
// at module load time).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-cache-'));
process.env.SPEC_CACHE_DIR = tmpDir;

const specCache = require('../server/utils/spec-cache');

const SNAP = { url: 'https://example.com/products', ariaHash: 'abc123' };

test('keyFor: stable for same url+hash, changes when hash changes', () => {
  assert.equal(specCache.keyFor(SNAP), specCache.keyFor({ url: 'https://example.com/products?x=1', ariaHash: 'abc123' }));
  assert.notEqual(specCache.keyFor(SNAP), specCache.keyFor({ url: 'https://example.com/products', ariaHash: 'def456' }));
});

test('set/get: round-trips generated spec code per suite', () => {
  specCache.set(SNAP, 'Functional', 'test code F', null);
  specCache.set(SNAP, 'Accessibility', 'test code A', '/run/knowledge/x.har');
  const entry = specCache.get(SNAP);
  assert.equal(entry.suites.Functional.code, 'test code F');
  assert.equal(entry.suites.Accessibility.code, 'test code A');
  assert.equal(entry.suites.Accessibility.har, '/run/knowledge/x.har');
});

test('get: misses when snapshot hash differs (page changed)', () => {
  specCache.set(SNAP, 'Navigation', 'nav code');
  assert.equal(specCache.get({ url: 'https://example.com/products', ariaHash: 'changed' }), null);
});

test('cachedSuites: lists stored suite names', () => {
  specCache.set(SNAP, 'Forms', 'forms code');
  const suites = specCache.cachedSuites(SNAP);
  assert.ok(suites.includes('Functional'));
  assert.ok(suites.includes('Forms'));
});

test('SPEC_CACHE_DISABLE=1 disables reads and writes', () => {
  process.env.SPEC_CACHE_DISABLE = '1';
  try {
    const snap2 = { url: 'https://example.com/other', ariaHash: 'h2' };
    specCache.set(snap2, 'Functional', 'code');
    assert.equal(specCache.get(snap2), null);
  } finally {
    delete process.env.SPEC_CACHE_DISABLE;
  }
});
