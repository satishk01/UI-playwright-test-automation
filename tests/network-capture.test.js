const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesApiPatterns,
  deriveUrlPattern,
  buildWaitForResponseCode,
  summarizeApiCalls,
  DEFAULT_API_PATTERNS,
} = require('../server/utils/network-capture');

// ── matchesApiPatterns ──

test('matchesApiPatterns: substring matching works', () => {
  assert.ok(matchesApiPatterns('https://api.example.com/products', ['/api/']));
  assert.ok(matchesApiPatterns('https://xyz.execute-api.us-east-1.amazonaws.com/prod', ['execute-api']));
  assert.ok(matchesApiPatterns('https://app.com/graphql', ['/graphql']));
});

test('matchesApiPatterns: regex matching works (enclosed in /.../)', () => {
  assert.ok(matchesApiPatterns('https://api.example.com/v1/products/123', ['/v\\d+/products/']));
  assert.ok(matchesApiPatterns('https://api.example.com/v2/users/456', ['/v\\d+/users/']));
});

test('matchesApiPatterns: non-matching URL returns false', () => {
  assert.equal(matchesApiPatterns('https://example.com/page.html', ['/api/']), false);
  assert.equal(matchesApiPatterns('https://example.com/image.png', ['execute-api']), false);
});

test('matchesApiPatterns: empty patterns returns false', () => {
  assert.equal(matchesApiPatterns('https://api.example.com/products', []), false);
  assert.equal(matchesApiPatterns('https://api.example.com/products', null), false);
  assert.equal(matchesApiPatterns('https://api.example.com/products', undefined), false);
});

test('matchesApiPatterns: invalid regex is skipped (not thrown)', () => {
  // Invalid regex should not throw — it's skipped
  assert.equal(matchesApiPatterns('https://example.com/test', ['/[invalid(/']), false);
});

test('matchesApiPatterns: default patterns match common API URLs', () => {
  assert.ok(matchesApiPatterns('https://api.example.com/api/products', DEFAULT_API_PATTERNS));
  assert.ok(matchesApiPatterns('https://xyz.execute-api.us-east-1.amazonaws.com/prod/items', DEFAULT_API_PATTERNS));
  assert.ok(matchesApiPatterns('https://app.com/graphql', DEFAULT_API_PATTERNS));
  // Static assets should NOT match
  assert.equal(matchesApiPatterns('https://example.com/style.css', DEFAULT_API_PATTERNS), false);
  assert.equal(matchesApiPatterns('https://example.com/logo.png', DEFAULT_API_PATTERNS), false);
});

// ── deriveUrlPattern ──

test('deriveUrlPattern: strips query params', () => {
  const pattern = deriveUrlPattern('https://api.example.com/products?lang=en&page=1');
  assert.equal(pattern, '/products');
});

test('deriveUrlPattern: replaces numeric IDs', () => {
  const pattern = deriveUrlPattern('https://api.example.com/products/123/details');
  assert.equal(pattern, '/products/.*/details');
});

test('deriveUrlPattern: replaces UUIDs', () => {
  const pattern = deriveUrlPattern('https://api.example.com/items/550e8400-e29b-41d4-a716-446655440000');
  assert.match(pattern, /\/items\/\.\*/);
});

test('deriveUrlPattern: replaces long alphanumeric IDs', () => {
  const pattern = deriveUrlPattern('https://api.example.com/items/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0');
  assert.match(pattern, /\/items\/\.\*/);
});

test('deriveUrlPattern: preserves path structure for clean URLs', () => {
  const pattern = deriveUrlPattern('https://api.example.com/api/v1/products');
  assert.equal(pattern, '/api/v1/products');
});

test('deriveUrlPattern: handles invalid URLs gracefully', () => {
  const pattern = deriveUrlPattern('not a url at all');
  // Should return something without throwing
  assert.ok(typeof pattern === 'string');
});

// ── buildWaitForResponseCode ──

test('buildWaitForResponseCode: produces valid waitForResponse call', () => {
  const code = buildWaitForResponseCode('https://api.example.com/products/123');
  assert.match(code, /page\.waitForResponse/);
  assert.match(code, /resp\.url\(\)\.includes\(/);
  assert.match(code, /resp\.status\(\) === 200/);
  assert.match(code, /timeout: 15000/);
});

test('buildWaitForResponseCode: uses URL pattern substring for matching', () => {
  const code = buildWaitForResponseCode('https://api.example.com/api/v1/products/123');
  // Should use the path prefix before the wildcard for includes() matching
  assert.match(code, /includes\("\/api\/v1\/products"\)/);
});

test('buildWaitForResponseCode: escapes quotes in URL safely', () => {
  const code = buildWaitForResponseCode("https://api.example.com/products?name=test'quote");
  // JSON.stringify escapes the single quote inside the double-quoted string
  assert.match(code, /page\.waitForResponse/);
  // Should not contain an unescaped break-out
  assert.doesNotMatch(code, /includes\('.*'.*\)/);
});

// ── summarizeApiCalls ──

test('summarizeApiCalls: groups by URL pattern', () => {
  const calls = [
    { url: 'https://api.example.com/products/123', method: 'GET', status: 200 },
    { url: 'https://api.example.com/products/456', method: 'GET', status: 200 },
    { url: 'https://api.example.com/users/789', method: 'GET', status: 200 },
  ];
  const summary = summarizeApiCalls(calls);
  assert.equal(summary.length, 2);
  // Products should be first (2 calls vs 1)
  assert.match(summary[0].pattern, /\/products\/\.\*/);
  assert.equal(summary[0].count, 2);
  assert.deepEqual(summary[0].methods, ['GET']);
});

test('summarizeApiCalls: respects maxPatterns limit', () => {
  const calls = [];
  for (let i = 0; i < 20; i++) {
    calls.push({ url: `https://api.example.com/endpoint${i}`, method: 'GET', status: 200 });
  }
  const summary = summarizeApiCalls(calls, 5);
  assert.equal(summary.length, 5);
});

test('summarizeApiCalls: empty input returns empty array', () => {
  assert.deepEqual(summarizeApiCalls([]), []);
});

test('summarizeApiCalls: captures multiple methods for same pattern', () => {
  const calls = [
    { url: 'https://api.example.com/products/123', method: 'GET', status: 200 },
    { url: 'https://api.example.com/products/456', method: 'POST', status: 201 },
  ];
  const summary = summarizeApiCalls(calls);
  assert.equal(summary.length, 1);
  assert.ok(summary[0].methods.includes('GET'));
  assert.ok(summary[0].methods.includes('POST'));
});
