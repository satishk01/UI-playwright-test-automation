const express = require('express');
const router = express.Router();
const { runs } = require('./pipeline');
const fs = require('fs');
const path = require('path');
const { generateReport } = require('../utils/report-generator');

// GET /api/runs — list all runs (memory + disk)
router.get('/', (req, res) => {
  const list = [];
  const seen = new Set();

  // First, add runs from memory (active runs)
  for (const r of runs.values()) {
    seen.add(r.id);
    list.push({
      id: r.id,
      targetUrl: r.targetUrl,
      description: r.description || '',
      status: r.status,
      createdAt: r.createdAt,
      stageCount: r.stages.length,
      totalTests: r.results?.totalTests || 0,
      passed: r.results?.passed || 0,
      failed: r.results?.failed || 0,
      fixme: r.results?.fixme || 0,
      tokenUsage: r.tokenUsage || null,
      inMemory: true,
    });
  }

  // Then, scan disk for runs not in memory (past runs from before restart)
  const runsRoot = path.join(__dirname, '..', '..', 'runs');
  if (fs.existsSync(runsRoot)) {
    for (const dir of fs.readdirSync(runsRoot)) {
      if (seen.has(dir)) continue;
      const runDir = path.join(runsRoot, dir);
      if (!fs.statSync(runDir).isDirectory()) continue;

      // Read run-meta.json if it exists
      let meta = {};
      const metaFile = path.join(runDir, 'run-meta.json');
      if (fs.existsSync(metaFile)) {
        try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch {}
      }

      // Try to determine status from test-results directory
      const resultsDir = path.join(runDir, 'test-results');
      let totalTests = 0, passed = 0, failed = 0, fixme = 0;
      let hasResults = false;
      if (fs.existsSync(resultsDir)) {
        for (const f of fs.readdirSync(resultsDir)) {
          if (!f.endsWith('-results.json')) continue;
          try {
            const report = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf-8'));
            const stats = report.stats || {};
            if (stats.expected !== undefined || stats.unexpected !== undefined) {
              hasResults = true;
              passed += (stats.expected || 0) + (stats.flaky || 0);
              failed += stats.unexpected || 0;
              fixme += stats.skipped || 0;
            }
          } catch {}
        }
      }
      totalTests = passed + failed + fixme;

      // Check if generated tests exist
      const testsDir = path.join(runDir, 'generated-tests');
      const hasTests = fs.existsSync(testsDir) && fs.readdirSync(testsDir).some(f => f.endsWith('.spec.ts'));

      let status = 'unknown';
      if (hasResults) status = 'completed';
      else if (hasTests) status = 'tests-generated';
      else if (fs.existsSync(path.join(runDir, 'knowledge'))) status = 'analyzed';

      list.push({
        id: dir,
        targetUrl: meta.targetUrl || 'N/A',
        description: meta.description || '',
        status,
        createdAt: meta.createdAt || fs.statSync(runDir).birthtime.toISOString(),
        stageCount: 0,
        totalTests,
        passed,
        failed,
        fixme,
        tokenUsage: meta.tokenUsage || null,
        inMemory: false,
      });
    }
  }

  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

// PATCH /api/runs/:id/description — update run description
router.patch('/:id/description', (req, res) => {
  const runId = req.params.id;
  const { description } = req.body;
  const runDir = path.join(__dirname, '..', '..', 'runs', runId);

  if (!fs.existsSync(runDir)) {
    return res.status(404).json({ error: 'Run not found' });
  }

  // Update memory if present
  const run = runs.get(runId);
  if (run) {
    run.description = (description || '').trim();
  }

  // Persist to disk
  const metaFile = path.join(runDir, 'run-meta.json');
  let meta = {};
  if (fs.existsSync(metaFile)) {
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch {}
  }
  meta.description = (description || '').trim();
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));

  res.json({ ok: true, description: meta.description });
});

// GET /api/runs/:id/tests — return generated test files
router.get('/:id/tests', (req, res) => {
  const runDir = path.join(__dirname, '..', '..', 'runs', req.params.id, 'generated-tests');
  if (!fs.existsSync(runDir)) {
    return res.json({ tests: [] });
  }
  const files = fs.readdirSync(runDir).filter(f => f.endsWith('.spec.ts'));
  const tests = files.map(f => ({
    filename: f,
    content: fs.readFileSync(path.join(runDir, f), 'utf-8'),
  }));
  res.json({ tests });
});

// GET /api/runs/:id/knowledge — return knowledge base
router.get('/:id/knowledge', (req, res) => {
  const kbDir = path.join(__dirname, '..', '..', 'runs', req.params.id, 'knowledge');
  if (!fs.existsSync(kbDir)) {
    return res.json({ knowledge: {} });
  }
  const knowledge = {};
  const files = fs.readdirSync(kbDir).filter(f => f.endsWith('.json'));
  files.forEach(f => {
    try {
      knowledge[f] = JSON.parse(fs.readFileSync(path.join(kbDir, f), 'utf-8'));
    } catch { knowledge[f] = null; }
  });
  res.json({ knowledge });
});

// GET /api/runs/:id/report — generate and download HTML report
router.get('/:id/report', (req, res) => {
  const runId = req.params.id;
  let run = runs.get(runId);
  const runDir = path.join(__dirname, '..', '..', 'runs', runId);

  if (!fs.existsSync(runDir)) {
    return res.status(404).json({ error: 'Run directory not found' });
  }

  // If run not in memory, reconstruct from disk
  if (!run) {
    let meta = {};
    const metaFile = path.join(runDir, 'run-meta.json');
    if (fs.existsSync(metaFile)) {
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch {}
    }
    // Reconstruct results from test-results dir
    const resultsDir = path.join(runDir, 'test-results');
    let passed = 0, failed = 0, fixme = 0;
    const plans = [];
    if (fs.existsSync(resultsDir)) {
      // First check all-results.json (batch mode)
      const allFile = path.join(resultsDir, 'all-results.json');
      if (fs.existsSync(allFile)) {
        try {
          const report = JSON.parse(fs.readFileSync(allFile, 'utf-8'));
          if (report.suites) {
            for (const suite of report.suites) {
              const planId = suite.file ? path.basename(suite.file, '.spec.ts') : null;
              if (planId) {
                // Count results for this specific suite
                let p = 0, fl = 0, fx = 0;
                const walk = (s) => {
                  if (s.specs) {
                    for (const spec of s.specs) {
                      for (const test of spec.tests || []) {
                        if (test.status === 'expected' || test.status === 'flaky') p++;
                        else if (test.status === 'unexpected') fl++;
                        else if (test.status === 'skipped') fx++;
                      }
                    }
                  }
                  if (s.suites) s.suites.forEach(walk);
                };
                walk(suite);
                passed += p; failed += fl; fixme += fx;
                plans.push({ planId, suite: planId.split('__').pop() || planId, page: meta.targetUrl || '', tests: p + fl + fx, passed: p, failed: fl, fixme: fx });
              }
            }
          }
        } catch {}
      }

      // Then check individual files for any suites not already loaded from
      // all-results.json (all-results.json may be partial in batch mode).
      const loadedPlanIds = new Set(plans.map(p => p.planId));
      for (const f of fs.readdirSync(resultsDir)) {
        if (!f.endsWith('-results.json') || f === 'all-results.json') continue;
        const planId = f.replace('-results.json', '');
        if (loadedPlanIds.has(planId)) continue;
        try {
          const report = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf-8'));
          const stats = report.stats || {};
          const p = (stats.expected || 0) + (stats.flaky || 0);
          const fl = stats.unexpected || 0;
          const fx = stats.skipped || 0;
          passed += p; failed += fl; fixme += fx;
          plans.push({ planId, suite: planId.split('__').pop() || planId, page: meta.targetUrl || '', tests: p + fl + fx, passed: p, failed: fl, fixme: fx });
        } catch {}
      }
    }
    run = {
      id: runId,
      targetUrl: meta.targetUrl || 'N/A',
      description: meta.description || '',
      createdAt: meta.createdAt || new Date().toISOString(),
      options: {},
      results: plans.length > 0 ? { plans, totalTests: passed + failed + fixme, passed, failed, fixme } : null,
    };
  }

  try {
    const html = generateReport(runId, run, runDir);
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="test-report-${runId.substring(0, 8)}.html"`);
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report: ' + err.message });
  }
});

module.exports = router;
