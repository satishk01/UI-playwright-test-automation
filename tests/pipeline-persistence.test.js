const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');

// We test the /start route's persistence + validation behavior in isolation.
// To avoid the global runs Map and runs/ directory from the real app, we
// build a fresh Express app that mounts the route logic with a temp runs dir.

let tmpRoot;
let app;
let server;
let port;

function buildApp(runsDir) {
  // Re-implement the minimal route logic against a temp runs dir, mirroring
  // routes/pipeline.js exactly for the /start handler. This keeps the test
  // hermetic (no global state, no real runs/ dir).
  const { v4: uuidv4 } = require('uuid');
  const { validateAppContext } = require('../server/utils/app-context');
  const router = express.Router();
  const runs = new Map();

  router.post('/start', async (req, res) => {
    const { targetUrl, auth, options, llm, description, appContext } = req.body;
    if (!targetUrl) return res.status(400).json({ error: 'targetUrl is required' });

    let cleanAppContext;
    try {
      cleanAppContext = validateAppContext(appContext);
    } catch (err) {
      return res.status(400).json({ error: err.message, code: err.code });
    }

    const runId = uuidv4();
    const run = {
      id: runId, targetUrl,
      description: (description || '').trim(),
      auth: auth || { type: 'none' },
      options: options || {},
      llm: llm || {},
      appContext: cleanAppContext,
      status: 'queued', stages: [],
      createdAt: new Date().toISOString(), results: null,
    };

    const runDir = path.join(runsDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run-meta.json'), JSON.stringify({
      id: runId, targetUrl, description: run.description, createdAt: run.createdAt,
      auth: run.auth, options: run.options, llm: run.llm, appContext: run.appContext,
    }, null, 2));

    runs.set(runId, run);
    res.json({ runId, status: 'queued' });
  });

  const e = express();
  e.use(express.json({ limit: '10mb' }));
  e.use('/api/pipeline', router);
  return { app: e, runs };
}

function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      port,
      method,
      path: urlPath,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: json, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-test-'));
  const runsDir = path.join(tmpRoot, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const built = buildApp(runsDir);
  app = built.app;
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  port = server.address().port;
});

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('POST /start persists appContext to run-meta.json', async () => {
  const res = await request(server, 'POST', '/api/pipeline/start', {
    targetUrl: 'https://app.example.com',
    appContext: {
      baseURL: 'https://app.example.com',
      viewport: { width: 1920, height: 1080 },
      userAgent: 'TestAgent/1.0',
      extraHTTPHeaders: { 'X-Test': '1' },
    },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.runId);

  // Read the persisted meta from disk
  const metaFile = path.join(tmpRoot, 'runs', res.body.runId, 'run-meta.json');
  assert.ok(fs.existsSync(metaFile), 'run-meta.json should be written');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
  assert.equal(meta.targetUrl, 'https://app.example.com');
  assert.deepEqual(meta.appContext, {
    baseURL: 'https://app.example.com',
    viewport: { width: 1920, height: 1080 },
    userAgent: 'TestAgent/1.0',
    extraHTTPHeaders: { 'X-Test': '1' },
  });
});

test('POST /start persists auth/llm/options (full config, not just id+url)', async () => {
  const res = await request(server, 'POST', '/api/pipeline/start', {
    targetUrl: 'https://app.example.com',
    auth: { type: 'basic', username: 'admin', password: 'secret' },
    options: { maxDepth: 5, maxPages: 50, enableHealing: false },
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-test' },
    description: 'my run',
  });
  assert.equal(res.status, 200);
  const meta = JSON.parse(fs.readFileSync(
    path.join(tmpRoot, 'runs', res.body.runId, 'run-meta.json'), 'utf-8'
  ));
  assert.deepEqual(meta.auth, { type: 'basic', username: 'admin', password: 'secret' });
  assert.deepEqual(meta.options, { maxDepth: 5, maxPages: 50, enableHealing: false });
  assert.deepEqual(meta.llm, { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-test' });
  assert.equal(meta.description, 'my run');
});

test('POST /start rejects invalid appContext with 400', async () => {
  const res = await request(server, 'POST', '/api/pipeline/start', {
    targetUrl: 'https://app.example.com',
    appContext: { baseURL: 'not a url' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_APP_CONTEXT');
  assert.match(res.body.error, /not a valid URL/);
});

test('POST /start rejects appContext with unknown keys', async () => {
  const res = await request(server, 'POST', '/api/pipeline/start', {
    targetUrl: 'https://app.example.com',
    appContext: { evilKey: 'payload' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unknown appContext keys/);
});

test('POST /start rejects appContext with header injection attempt', async () => {
  const res = await request(server, 'POST', '/api/pipeline/start', {
    targetUrl: 'https://app.example.com',
    appContext: { userAgent: 'Mozilla\r\nX-Inject: evil' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /newlines/);
});

test('POST /start accepts empty appContext (backwards compatible)', async () => {
  const res = await request(server, 'POST', '/api/pipeline/start', {
    targetUrl: 'https://app.example.com',
  });
  assert.equal(res.status, 200);
  const meta = JSON.parse(fs.readFileSync(
    path.join(tmpRoot, 'runs', res.body.runId, 'run-meta.json'), 'utf-8'
  ));
  assert.deepEqual(meta.appContext, {});
});

test('POST /start requires targetUrl', async () => {
  const res = await request(server, 'POST', '/api/pipeline/start', {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /targetUrl is required/);
});
