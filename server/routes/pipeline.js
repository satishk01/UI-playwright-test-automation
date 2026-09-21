const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { PipelineOrchestrator } = require('../pipeline/orchestrator');
const { createLLMClient, PROVIDER_DEFAULTS } = require('../utils/llm-client');
const { validateAppContext } = require('../utils/app-context');

const runs = new Map();

/**
 * Look up a run by id, falling back to run-meta.json on disk if it's not in
 * memory (e.g. after a server restart). Returns a minimal run object suitable
 * for re-execution, or null if not found.
 *
 * The persisted meta now includes auth/options/llm/appContext, so a
 * re-execution after restart uses the same browser context and LLM config as
 * the original run — not silent defaults.
 */
function loadRunFromDisk(runId) {
  const metaFile = path.join(__dirname, '..', '..', 'runs', runId, 'run-meta.json');
  if (!fs.existsSync(metaFile)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    if (!meta || meta.id !== runId) return null;
    return {
      id: runId,
      targetUrl: meta.targetUrl,
      description: meta.description || '',
      auth: meta.auth || { type: 'none' },
      options: meta.options || {},
      llm: meta.llm || {},
      appContext: meta.appContext || {},
      createdAt: meta.createdAt || new Date().toISOString(),
      status: 'completed',
      stages: [],
      results: null,
    };
  } catch {
    return null;
  }
}

function getRun(runId) {
  return runs.get(runId) || loadRunFromDisk(runId);
}

// GET /api/pipeline/providers
router.get('/providers', (req, res) => {
  res.json({
    providers: [
      {
        id: 'anthropic', name: 'Anthropic', requiresKey: true,
        defaultModel: PROVIDER_DEFAULTS.anthropic.model,
        defaultBaseUrl: PROVIDER_DEFAULTS.anthropic.baseUrl,
        models: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'],
        extraFields: [],
      },
      {
        id: 'bedrock', name: 'AWS Bedrock', requiresKey: false,
        defaultModel: PROVIDER_DEFAULTS.bedrock.model,
        defaultBaseUrl: '',
        models: [
          'anthropic.claude-sonnet-4-6-v1',
          'anthropic.claude-haiku-4-5-20251001-v1',
          'anthropic.claude-opus-4-6-v1',
          'us.amazon.nova-pro-v1:0',
          'us.amazon.nova-lite-v1:0',
          'meta.llama3-1-70b-instruct-v1:0',
          'meta.llama3-1-405b-instruct-v1:0',
          'mistral.mistral-large-2407-v1:0',
        ],
        extraFields: ['awsRegion', 'awsAccessKeyId', 'awsSecretAccessKey', 'awsSessionToken', 'awsApiKey', 'awsCredentialType', 'awsBaseUrl'],
      },
      {
        id: 'azure', name: 'Azure OpenAI', requiresKey: true,
        defaultModel: PROVIDER_DEFAULTS.azure.model,
        defaultBaseUrl: '',
        models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-35-turbo'],
        extraFields: ['azureDeployment', 'azureApiVersion'],
      },
      {
        id: 'openrouter', name: 'OpenRouter', requiresKey: true,
        defaultModel: PROVIDER_DEFAULTS.openrouter.model,
        defaultBaseUrl: PROVIDER_DEFAULTS.openrouter.baseUrl,
        models: [
          'anthropic/claude-sonnet-4-6',
          'anthropic/claude-haiku-4-5',
          'openai/gpt-4o',
          'google/gemini-2.5-flash',
          'meta-llama/llama-3.1-70b-instruct',
          'deepseek/deepseek-r1',
          'qwen/qwen3-235b-a22b',
          'mistralai/mistral-large',
        ],
        extraFields: [],
      },
      {
        id: 'grok', name: 'Grok (xAI)', requiresKey: true,
        defaultModel: PROVIDER_DEFAULTS.grok.model,
        defaultBaseUrl: PROVIDER_DEFAULTS.grok.baseUrl,
        models: ['grok-3', 'grok-3-mini', 'grok-3-fast'],
        extraFields: [],
      },
      {
        id: 'nvidia', name: 'NVIDIA NIM', requiresKey: true,
        defaultModel: PROVIDER_DEFAULTS.nvidia.model,
        defaultBaseUrl: PROVIDER_DEFAULTS.nvidia.baseUrl,
        models: [
          'meta/llama-3.1-70b-instruct',
          'meta/llama-3.1-405b-instruct',
          'mistralai/mistral-large-2-instruct',
          'google/gemma-2-27b-it',
          'nvidia/llama-3.1-nemotron-70b-instruct',
        ],
        extraFields: [],
      },
      {
        id: 'ollama', name: 'Ollama', requiresKey: false,
        defaultModel: PROVIDER_DEFAULTS.ollama.model,
        defaultBaseUrl: PROVIDER_DEFAULTS.ollama.baseUrl,
        models: ['qwen3:8b', 'qwen3:14b', 'qwen3:30b', 'llama3.1:8b', 'llama3.1:70b', 'gemma3:12b', 'gemma4:27b', 'deepseek-coder-v2:16b', 'mistral:7b', 'codellama:34b'],
        extraFields: [],
      },
      {
        id: 'vllm', name: 'vLLM', requiresKey: false,
        defaultModel: PROVIDER_DEFAULTS.vllm.model,
        defaultBaseUrl: PROVIDER_DEFAULTS.vllm.baseUrl,
        models: ['meta-llama/Llama-3.1-8B-Instruct', 'meta-llama/Llama-3.1-70B-Instruct', 'Qwen/Qwen2.5-Coder-32B-Instruct', 'mistralai/Mistral-7B-Instruct-v0.3'],
        extraFields: [],
      },
      {
        id: 'omniroute', name: 'OmniRoute', requiresKey: false,
        defaultModel: PROVIDER_DEFAULTS.omniroute.model,
        defaultBaseUrl: PROVIDER_DEFAULTS.omniroute.baseUrl,
        models: ['default'],
        extraFields: [],
      },
    ],
  });
});

// POST /api/pipeline/health-check
router.post('/health-check', async (req, res) => {
  try {
    const client = createLLMClient(req.body);
    const result = await client.healthCheck();
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/pipeline/start
router.post('/start', async (req, res) => {
  const { targetUrl, auth, options, llm, description, appContext } = req.body;

  if (!targetUrl) {
    return res.status(400).json({ error: 'targetUrl is required' });
  }

  // Validate appContext server-side — it is untrusted input that flows into
  // generated Playwright config files, so we fail closed on anything invalid.
  let cleanAppContext;
  try {
    cleanAppContext = validateAppContext(appContext);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code });
  }

  const runId = uuidv4();
  const run = {
    id: runId,
    targetUrl,
    description: (description || '').trim(),
    auth: auth || { type: 'none' },
    options: options || {},
    llm: llm || {},
    appContext: cleanAppContext,
    status: 'queued',
    stages: [],
    createdAt: new Date().toISOString(),
    results: null,
  };

  // Persist the full run config to disk so re-execution works after a server
  // restart. Previously only id/targetUrl/description/createdAt were saved,
  // which meant appContext (and auth/llm/options) were lost on restart and
  // re-execution silently fell back to defaults.
  const runDir = path.join(__dirname, '..', '..', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run-meta.json'), JSON.stringify({
    id: runId,
    targetUrl,
    description: run.description,
    createdAt: run.createdAt,
    // Persist the full config needed to re-execute faithfully. API keys /
    // tokens are intentionally included so re-execution can call the LLM for
    // healing — the runs/ directory must therefore be protected at the OS
    // level (not served statically, not committed to git).
    auth: run.auth,
    options: run.options,
    llm: run.llm,
    appContext: run.appContext,
  }, null, 2));

  runs.set(runId, run);
  res.json({ runId, status: 'queued' });
});

// GET /api/pipeline/stream/:runId — SSE
router.get('/stream/:runId', (req, res) => {
  const { runId } = req.params;
  const run = runs.get(runId);

  if (!run) return res.status(404).json({ error: 'Run not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('connected', { runId });

  const orchestrator = new PipelineOrchestrator(run, send);
  orchestrator.run().then((results) => {
    run.status = 'completed';
    run.results = results;
    // Persist token usage to run-meta.json so it survives server restarts
    try {
      const metaFile = path.join(__dirname, '..', '..', 'runs', run.id, 'run-meta.json');
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
        meta.tokenUsage = run.tokenUsage || null;
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
      }
    } catch (e) { console.error('Failed to persist tokenUsage:', e.message); }
    send('complete', results);
    res.end();
  }).catch((err) => {
    run.status = 'failed';
    send('error', { message: err.message, stack: err.stack });
    res.end();
  });

  req.on('close', () => { orchestrator.abort(); });
});

// GET /api/pipeline/status/:runId
router.get('/status/:runId', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

// POST /api/pipeline/re-execute/:runId — re-run existing generated tests via SSE
router.post('/re-execute/:runId', (req, res) => {
  const { runId } = req.params;
  // Use getRun so re-execution works even after a server restart, when the
  // original run is no longer in the in-memory Map but is on disk.
  const originalRun = getRun(runId);

  if (!originalRun) return res.status(404).json({ error: 'Run not found' });

  // Create a new run entry that reuses the original run's directory
  const newRunId = uuidv4();
  const enableHealing = req.body?.enableHealing !== false;
  const run = {
    id: newRunId,
    targetUrl: originalRun.targetUrl,
    auth: originalRun.auth,
    options: { ...originalRun.options, enableHealing, reExecuteFrom: runId },
    llm: originalRun.llm || {},
    appContext: originalRun.appContext || {},
    description: originalRun.description || '',
    status: 'queued',
    stages: [],
    createdAt: new Date().toISOString(),
    results: null,
  };
  runs.set(newRunId, run);

  res.json({ runId: newRunId, status: 'queued', reExecuteFrom: runId });
});

// GET /api/pipeline/re-execute-stream/:runId — SSE for re-execution
router.get('/re-execute-stream/:runId', (req, res) => {
  const { runId } = req.params;
  const run = runs.get(runId);

  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!run.options?.reExecuteFrom) return res.status(400).json({ error: 'Not a re-execution run' });

  const originalRunId = run.options.reExecuteFrom;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('connected', { runId, reExecuteFrom: originalRunId });

  const { ReExecutor } = require('../pipeline/re-executor');
  const executor = new ReExecutor(originalRunId, run, send);

  executor.run().then((results) => {
    run.status = 'completed';
    run.results = results;
    // Persist token usage to run-meta.json for re-executed runs
    try {
      const metaFile = path.join(__dirname, '..', '..', 'runs', originalRunId, 'run-meta.json');
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
        meta.tokenUsage = run.tokenUsage || meta.tokenUsage || null;
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
      }
    } catch (e) { console.error('Failed to persist tokenUsage:', e.message); }
    send('complete', results);
    res.end();
  }).catch((err) => {
    run.status = 'failed';
    send('error', { message: err.message, stack: err.stack });
    res.end();
  });

  req.on('close', () => { executor.abort(); });
});

module.exports = router;
module.exports.runs = runs;
