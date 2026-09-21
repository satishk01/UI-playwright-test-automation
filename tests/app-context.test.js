const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAppContext } = require('../server/utils/app-context');

test('validateAppContext: null/undefined returns empty object', () => {
  assert.deepEqual(validateAppContext(null), {});
  assert.deepEqual(validateAppContext(undefined), {});
});

test('validateAppContext: non-object throws', () => {
  assert.throws(() => validateAppContext('not an object'), /must be an object/);
  assert.throws(() => validateAppContext([]), /must be an object/);
  assert.throws(() => validateAppContext(42), /must be an object/);
});

test('validateAppContext: valid baseURL is preserved', () => {
  const out = validateAppContext({ baseURL: 'https://app.example.com' });
  assert.equal(out.baseURL, 'https://app.example.com');
});

test('validateAppContext: non-http baseURL is rejected', () => {
  assert.throws(() => validateAppContext({ baseURL: 'file:///etc/passwd' }), /http\(s\) URL/);
  assert.throws(() => validateAppContext({ baseURL: 'javascript:alert(1)' }), /http\(s\) URL/);
  assert.throws(() => validateAppContext({ baseURL: 'not a url' }), /not a valid URL/);
});

test('validateAppContext: empty baseURL is ignored (not rejected)', () => {
  const out = validateAppContext({ baseURL: '' });
  assert.equal(out.baseURL, undefined);
  assert.equal(Object.keys(out).length, 0);
});

test('validateAppContext: valid viewport is normalized to integers', () => {
  const out = validateAppContext({ viewport: { width: 1920, height: 1080 } });
  assert.deepEqual(out.viewport, { width: 1920, height: 1080 });
});

test('validateAppContext: viewport coerces string numbers', () => {
  const out = validateAppContext({ viewport: { width: '1280', height: '720' } });
  assert.deepEqual(out.viewport, { width: 1280, height: 720 });
});

test('validateAppContext: viewport rejects out-of-range', () => {
  assert.throws(() => validateAppContext({ viewport: { width: 100, height: 720 } }), /width/);
  assert.throws(() => validateAppContext({ viewport: { width: 5000, height: 720 } }), /width/);
  assert.throws(() => validateAppContext({ viewport: { width: 1280, height: 100 } }), /height/);
});

test('validateAppContext: viewport rejects non-numeric', () => {
  assert.throws(() => validateAppContext({ viewport: { width: 'evil', height: 720 } }), /width/);
  assert.throws(() => validateAppContext({ viewport: { width: NaN, height: 720 } }), /width/);
});

test('validateAppContext: valid userAgent is preserved', () => {
  const out = validateAppContext({ userAgent: 'Mozilla/5.0 TestAgent' });
  assert.equal(out.userAgent, 'Mozilla/5.0 TestAgent');
});

test('validateAppContext: userAgent with newlines is rejected (header injection)', () => {
  assert.throws(() => validateAppContext({ userAgent: 'Mozilla\r\nX-Inject: evil' }), /newlines/);
  assert.throws(() => validateAppContext({ userAgent: 'Mozilla\nX-Inject: evil' }), /newlines/);
});

test('validateAppContext: extraHTTPHeaders flat string map is preserved', () => {
  const out = validateAppContext({ extraHTTPHeaders: { 'X-Custom': 'value', 'Accept-Language': 'en-US' } });
  assert.deepEqual(out.extraHTTPHeaders, { 'X-Custom': 'value', 'Accept-Language': 'en-US' });
});

test('validateAppContext: extraHTTPHeaders coerces non-string values to string', () => {
  const out = validateAppContext({ extraHTTPHeaders: { 'X-Count': 42 } });
  assert.equal(out.extraHTTPHeaders['X-Count'], '42');
});

test('validateAppContext: extraHTTPHeaders rejects newlines in values (header injection)', () => {
  assert.throws(() => validateAppContext({ extraHTTPHeaders: { 'X-Evil': 'value\r\nX-Inject: evil' } }), /newlines/);
});

test('validateAppContext: extraHTTPHeaders rejects newlines in keys', () => {
  assert.throws(() => validateAppContext({ extraHTTPHeaders: { 'X-Evil\r\nX-Inject': 'evil' } }), /newlines/);
});

test('validateAppContext: extraHTTPHeaders rejects non-object', () => {
  assert.throws(() => validateAppContext({ extraHTTPHeaders: 'not an object' }), /flat object/);
  assert.throws(() => validateAppContext({ extraHTTPHeaders: ['array'] }), /flat object/);
});

test('validateAppContext: extraHTTPHeaders rejects empty keys', () => {
  assert.throws(() => validateAppContext({ extraHTTPHeaders: { '': 'value' } }), /invalid/);
});

test('validateAppContext: unknown keys are rejected (fail closed)', () => {
  assert.throws(() => validateAppContext({ evilKey: 'payload' }), /Unknown appContext keys/);
  assert.throws(() => validateAppContext({ baseURL: 'https://x.com', extra: 1 }), /Unknown appContext keys/);
});

test('validateAppContext: full valid input passes through cleanly', () => {
  const out = validateAppContext({
    baseURL: 'https://app.example.com',
    viewport: { width: 1920, height: 1080 },
    userAgent: 'TestAgent/1.0',
    extraHTTPHeaders: { 'X-Test': '1' },
  });
  assert.deepEqual(out, {
    baseURL: 'https://app.example.com',
    viewport: { width: 1920, height: 1080 },
    userAgent: 'TestAgent/1.0',
    extraHTTPHeaders: { 'X-Test': '1' },
  });
});

test('validateAppContext: error has code INVALID_APP_CONTEXT', () => {
  try {
    validateAppContext({ baseURL: 'not a url' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'INVALID_APP_CONTEXT');
    assert.ok(Array.isArray(err.details));
  }
});

// ── apiPatterns ──

test('validateAppContext: valid apiPatterns array is preserved', () => {
  const out = validateAppContext({ apiPatterns: ['/api/', 'execute-api', '/v1/products'] });
  assert.deepEqual(out.apiPatterns, ['/api/', 'execute-api', '/v1/products']);
});

test('validateAppContext: apiPatterns with regex patterns (enclosed in /.../) are preserved', () => {
  const out = validateAppContext({ apiPatterns: ['/v\\d+/products/'] });
  assert.deepEqual(out.apiPatterns, ['/v\\d+/products/']);
});

test('validateAppContext: invalid regex in apiPatterns is rejected', () => {
  assert.throws(() => validateAppContext({ apiPatterns: ['/[invalid(/'] }), /not a valid regex/);
});

test('validateAppContext: apiPatterns must be an array', () => {
  assert.throws(() => validateAppContext({ apiPatterns: '/api/' }), /must be an array/);
  assert.throws(() => validateAppContext({ apiPatterns: { 0: '/api/' } }), /must be an array/);
});

test('validateAppContext: empty apiPatterns entries are rejected', () => {
  assert.throws(() => validateAppContext({ apiPatterns: ['/api/', ''] }), /invalid/);
});

test('validateAppContext: empty apiPatterns array is ignored (not rejected)', () => {
  const out = validateAppContext({ apiPatterns: [] });
  assert.equal(out.apiPatterns, undefined);
});

test('validateAppContext: apiPatterns with full valid context passes through', () => {
  const out = validateAppContext({
    baseURL: 'https://app.example.com',
    apiPatterns: ['/api/', 'execute-api', '/graphql'],
  });
  assert.equal(out.baseURL, 'https://app.example.com');
  assert.deepEqual(out.apiPatterns, ['/api/', 'execute-api', '/graphql']);
});
