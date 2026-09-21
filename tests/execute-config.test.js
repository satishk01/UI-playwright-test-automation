const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPlaywrightConfig, clampInt } = require('../server/pipeline/05_execute');

test('clampInt clamps to range and floors non-integers', () => {
  assert.equal(clampInt(100, 320, 3840, 1280), 320);
  assert.equal(clampInt(5000, 320, 3840, 1280), 3840);
  assert.equal(clampInt(1920.7, 320, 3840, 1280), 1920);
  assert.equal(clampInt('not a number', 320, 3840, 1280), 1280);
  assert.equal(clampInt(NaN, 320, 3840, 1280), 1280);
  assert.equal(clampInt(undefined, 320, 3840, 1280), 1280);
});

test('buildPlaywrightConfig: empty appContext produces valid default config', () => {
  const config = buildPlaywrightConfig({});
  // Should contain the default headless/screenshot/trace options
  assert.match(config, /headless: true/);
  assert.match(config, /screenshot: 'only-on-failure'/);
  // Should NOT contain baseURL/viewport/userAgent when not provided
  assert.doesNotMatch(config, /baseURL/);
  assert.doesNotMatch(config, /viewport/);
  assert.doesNotMatch(config, /userAgent/);
  assert.doesNotMatch(config, /extraHTTPHeaders/);
});

test('buildPlaywrightConfig: baseURL is JSON-stringified (safe)', () => {
  const config = buildPlaywrightConfig({ appContext: { baseURL: 'https://example.com' } });
  // JSON.stringify produces a double-quoted string literal
  assert.match(config, /baseURL: "https:\/\/example\.com"/);
});

test('buildPlaywrightConfig: baseURL with single quote cannot break out of string', () => {
  const malicious = `x', foo: require('child_process').execSync('id')//`;
  const config = buildPlaywrightConfig({ appContext: { baseURL: malicious } });
  // JSON.stringify escapes the single quotes inside the double-quoted literal,
  // so the injected code stays inside the string and is not executable.
  assert.match(config, /baseURL: "x', foo: require\(/);
  // The config must NOT contain an unescaped executable require call outside
  // a string. Verify the whole line is a single string literal.
  const line = config.split('\n').find(l => l.includes('baseURL'));
  assert.ok(line, 'baseURL line should exist');
  // The value after baseURL: should be a JSON string literal (starts with ")
  assert.match(line.trim(), /^baseURL: ".*",$/);
});

test('buildPlaywrightConfig: baseURL with backtick and ${} cannot inject', () => {
  const malicious = '`${process.env.SECRET}`';
  const config = buildPlaywrightConfig({ appContext: { baseURL: malicious } });
  const line = config.split('\n').find(l => l.includes('baseURL'));
  // JSON.stringify escapes backticks? No — but inside a double-quoted JS
  // string literal, backticks and ${} are literal characters, not template
  // syntax. So this is safe. Verify it's a double-quoted literal.
  assert.match(line.trim(), /^baseURL: ".*",$/);
  assert.ok(line.includes('`'), 'backtick is preserved as literal char inside double-quoted string');
});

test('buildPlaywrightConfig: userAgent is JSON-stringified (safe)', () => {
  const malicious = `Mozilla/5.0', evil: require('fs').readFileSync('/etc/passwd')//`;
  const config = buildPlaywrightConfig({ appContext: { userAgent: malicious } });
  const line = config.split('\n').find(l => l.includes('userAgent'));
  assert.match(line.trim(), /^userAgent: ".*",$/);
});

test('buildPlaywrightConfig: viewport coerces non-numeric input to safe integers', () => {
  // If an attacker bypasses the client and sends a string, the executor
  // should not emit it verbatim into the config.
  const config = buildPlaywrightConfig({
    appContext: { viewport: { width: '1280; require("child_process").execSync("id")', height: 720 } },
  });
  const line = config.split('\n').find(l => l.includes('viewport'));
  // clampInt floors and clamps; Number('1280; ...') is NaN -> fallback 1280
  assert.match(line.trim(), /^viewport: \{ width: 1280, height: 720 \},$/);
});

test('buildPlaywrightConfig: viewport clamps out-of-range values', () => {
  const config = buildPlaywrightConfig({
    appContext: { viewport: { width: 99999, height: 1 } },
  });
  const line = config.split('\n').find(l => l.includes('viewport'));
  assert.match(line.trim(), /width: 3840/);
  assert.match(line.trim(), /height: 240/);
});

test('buildPlaywrightConfig: extraHTTPHeaders is emitted as JSON object', () => {
  const config = buildPlaywrightConfig({
    appContext: { extraHTTPHeaders: { 'X-Custom': 'value', 'Accept-Language': 'en-US' } },
  });
  assert.match(config, /extraHTTPHeaders: \{/);
  assert.match(config, /"X-Custom": "value"/);
  assert.match(config, /"Accept-Language": "en-US"/);
});

test('buildPlaywrightConfig: extraHTTPHeaders with quote in value is safe', () => {
  const config = buildPlaywrightConfig({
    appContext: { extraHTTPHeaders: { 'X-Evil': "'; require('fs')//" } },
  });
  const line = config.split('\n').find(l => l.includes('X-Evil'));
  // JSON.stringify escapes the single quote? No, but it's inside a
  // double-quoted string literal, so it's a literal character.
  assert.match(line.trim(), /"X-Evil": ".*"/);
});

test('buildPlaywrightConfig: storageState path is JSON-stringified', () => {
  const config = buildPlaywrightConfig({ storageStateRelPath: 'auth-state.json' });
  assert.match(config, /storageState: "auth-state\.json"/);
});

test('buildPlaywrightConfig: storageState path with quote is safe', () => {
  const malicious = `x'; require('child_process').execSync('id')//`;
  const config = buildPlaywrightConfig({ storageStateRelPath: malicious });
  const line = config.split('\n').find(l => l.includes('storageState'));
  assert.match(line.trim(), /^storageState: ".*",$/);
});

test('buildPlaywrightConfig: generated config is valid TS (sanity check structure)', () => {
  const config = buildPlaywrightConfig({
    appContext: {
      baseURL: 'https://app.example.com',
      viewport: { width: 1920, height: 1080 },
      userAgent: 'TestAgent/1.0',
      extraHTTPHeaders: { 'X-Test': '1' },
    },
    storageStateRelPath: 'auth-state.json',
  });
  // Verify the overall structure is intact
  assert.match(config, /import \{ defineConfig \} from '@playwright\/test';/);
  assert.match(config, /export default defineConfig\(/);
  assert.match(config, /testDir: '\.\/generated-tests'/);
  assert.match(config, /reporter: \[\['list'\], \['json', \{ outputFile: 'test-results\/all-results\.json' \}\]\]/);
});

test('buildPlaywrightConfig: default timeout is 60000 and retries is 1', () => {
  const config = buildPlaywrightConfig({});
  assert.match(config, /timeout: 60000/);
  assert.match(config, /retries: 1/);
});

test('buildPlaywrightConfig: custom testTimeout and retries are used', () => {
  const config = buildPlaywrightConfig({ testTimeout: 60000, retries: 3 });
  assert.match(config, /timeout: 60000/);
  assert.match(config, /retries: 3/);
});

test('buildPlaywrightConfig: testTimeout clamps to valid range', () => {
  const tooLow = buildPlaywrightConfig({ testTimeout: 1000 });
  assert.match(tooLow, /timeout: 5000/);
  const tooHigh = buildPlaywrightConfig({ testTimeout: 400000 });
  assert.match(tooHigh, /timeout: 300000/);
  const invalid = buildPlaywrightConfig({ testTimeout: 'not a number' });
  assert.match(invalid, /timeout: 60000/);
});

test('buildPlaywrightConfig: retries clamps to valid range', () => {
  const tooLow = buildPlaywrightConfig({ retries: -1 });
  assert.match(tooLow, /retries: 0/);
  const tooHigh = buildPlaywrightConfig({ retries: 10 });
  assert.match(tooHigh, /retries: 5/);
  const invalid = buildPlaywrightConfig({ retries: 'abc' });
  assert.match(invalid, /retries: 1/);
});
