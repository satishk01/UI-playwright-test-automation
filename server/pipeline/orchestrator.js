const path = require('path');
const fs = require('fs');
const { Explorer } = require('./01_explore');
const { Analyzer } = require('./02_analyze');
const { Planner } = require('./03_plan');
const { Generator } = require('./04_generate');
const { Executor } = require('./05_execute');
const { Healer } = require('./06_heal');
const { createLLMClient } = require('../utils/llm-client');

class PipelineOrchestrator {
  constructor(run, send) {
    this.runData = run;
    this.send = send;
    this.aborted = false;
    this.runDir = path.join(__dirname, '..', '..', 'runs', run.id);
    this.knowledgeDir = path.join(this.runDir, 'knowledge');
    this.testsDir = path.join(this.runDir, 'generated-tests');
    this.resultsDir = path.join(this.runDir, 'test-results');

    // Build LLM config from run payload or env
    this.llmConfig = run.llm || {};

    // Application context — user-provided settings that influence Playwright config
    this.appContext = run.appContext || {};

    // User-provided description of the application — passed to LLM prompts
    this.description = (run.description || '').trim();

    // Storage state path — where the Explorer will save the authenticated browser state
    this.storageStatePath = path.join(this.runDir, 'auth-state.json');

    // Healing can be disabled via options.enableHealing (default: true)
    this.enableHealing = run.options?.enableHealing !== false;

    // Crawl limits — UI-provided values take precedence over env vars
    this.maxDepth = run.options?.maxDepth || parseInt(process.env.MAX_CRAWL_DEPTH || '3', 10);
    this.maxPages = run.options?.maxPages || parseInt(process.env.MAX_PAGES || '20', 10);

    // Targeted crawl — when the user specifies targetScreens (from a screen
    // registry), the Explorer captures only those screens (plus an optional
    // light crawl of `targetDepth` link levels) instead of BFS-crawling the
    // whole app. This focuses testing on the screens that changed and saves
    // LLM tokens across analyze/plan/generate.
    this.targetScreens = Array.isArray(run.options?.targetScreens) ? run.options.targetScreens : null;
    this.targetDepth = run.options?.targetDepth != null ? parseInt(run.options.targetDepth, 10) : 0;
  }

  abort() {
    this.aborted = true;
  }

  emit(stage, status, data = {}) {
    const entry = { stage, status, timestamp: new Date().toISOString(), ...data };
    this.runData.stages.push(entry);
    this.send('stage', entry);
  }

  async run() {
    [this.runDir, this.knowledgeDir, this.testsDir, this.resultsDir].forEach(d => {
      fs.mkdirSync(d, { recursive: true });
    });

    this.runData.status = 'running';
    this.send('status', { status: 'running' });

    // Log which LLM provider we're using
    const llm = createLLMClient(this.llmConfig);
    this.emit('pipeline', 'info', { message: `LLM provider: ${llm.describe()}` });

    const maxHealIterations = parseInt(process.env.MAX_HEAL_ITERATIONS || '3', 10);
    let finalResults = { plans: [], totalTests: 0, passed: 0, failed: 0, fixme: 0 };
    // Token usage accumulator — populated from each stage's LLM client
    let tokenUsage = { inputTokens: 0, outputTokens: 0, calls: 0, stages: {} };

    try {
      // ── Stage 1: Explore ──
      this.emit('explore', 'running', { message: 'Crawling target site...' });
      const explorer = new Explorer(this.runData.targetUrl, this.runData.auth, {
        maxDepth: this.maxDepth,
        maxPages: this.maxPages,
        timeout: parseInt(process.env.PLAYWRIGHT_TIMEOUT || '30000', 10),
        storageStatePath: this.storageStatePath,
        appContext: this.appContext,
        apiPatterns: this.appContext.apiPatterns || null,
        targetScreens: this.targetScreens,
        targetDepth: this.targetDepth,
      });
      const snapshots = await explorer.explore();
      if (this.aborted) throw new Error('Aborted');
      fs.writeFileSync(
        path.join(this.knowledgeDir, 'snapshots.json'),
        JSON.stringify(snapshots, null, 2)
      );
      this.emit('explore', 'done', { pages: snapshots.length, targeted: !!(this.targetScreens && this.targetScreens.length) });

      // Fail fast with a clear message if exploration captured nothing — otherwise
      // downstream stages silently iterate over empty arrays and produce no tests.
      if (snapshots.length === 0) {
        const msg = `Explorer captured 0 pages for ${this.runData.targetUrl}. ` +
          `This usually means the site never reached networkidle within the Playwright timeout. ` +
          `Check server logs for "networkidle timed out" warnings and consider raising PLAYWRIGHT_TIMEOUT.`;
        this.emit('pipeline', 'error', { message: msg });
        throw new Error(msg);
      }

      // ── Stage 2: Analyze ──
      this.emit('analyze', 'running', { message: 'Building page models via LLM...' });
      const analyzer = new Analyzer(this.llmConfig, this.description);
      const pageModels = await analyzer.analyze(snapshots);
      if (this.aborted) throw new Error('Aborted');
      tokenUsage.stages.analyze = analyzer.getUsage();
      fs.writeFileSync(
        path.join(this.knowledgeDir, 'page_models.json'),
        JSON.stringify(pageModels, null, 2)
      );
      this.emit('analyze', 'done', { models: pageModels.length });

      // ── Stage 3: Plan ──
      this.emit('plan', 'running', { message: 'Generating test scenarios...' });
      const planner = new Planner(this.llmConfig, this.description);
      const plans = await planner.plan(pageModels, snapshots);
      if (this.aborted) throw new Error('Aborted');
      tokenUsage.stages.plan = planner.getUsage();
      fs.writeFileSync(
        path.join(this.knowledgeDir, 'plans.json'),
        JSON.stringify(plans, null, 2)
      );
      this.emit('plan', 'done', { plans: plans.length });

      // If planning produced no tests, surface it clearly rather than silently finishing.
      if (plans.length === 0) {
        const msg = `Planner generated 0 test plans from ${pageModels.length} page model(s). ` +
          `The LLM may have filtered out all tests because no interactive elements matched, ` +
          `or the model returned unparseable output. Check server logs for "Failed to plan" errors.`;
        this.emit('pipeline', 'error', { message: msg });
        throw new Error(msg);
      }

      // ── Stage 4+5+6: Generate → Execute → Heal loop ──
      const generator = new Generator(this.runData.targetUrl, this.runData.auth, this.llmConfig, this.description, {
        apiPatterns: this.appContext.apiPatterns || null,
        appContext: this.appContext,
        testTimeout: this.runData.options?.testTimeout || null,
      });
      const executor = new Executor(this.testsDir, this.resultsDir, {
        storageStatePath: this.storageStatePath,
        appContext: this.appContext,
        testTimeout: this.runData.options?.testTimeout,
        retries: this.runData.options?.retries,
      });
      const healer = this.enableHealing
        ? new Healer(this.runData.targetUrl, this.runData.auth, this.llmConfig, this.description)
        : null;

      // ── Generate all test files first ──
      const specFiles = [];
      const planSpecMap = new Map(); // plan -> specFile

      for (const plan of plans) {
        if (this.aborted) throw new Error('Aborted');

        const planId = `${plan.page}_${plan.suite}`.replace(/[^a-zA-Z0-9]/g, '_');
        this.emit('generate', 'running', { planId, message: `Generating: ${planId}` });

        const snapshot = snapshots.find(s => s.url === plan.page || s.path === plan.page) || snapshots[0];

        let testCode = await generator.generate(plan, snapshot);
        const specFile = path.join(this.testsDir, `${planId}.spec.ts`);
        fs.writeFileSync(specFile, testCode);
        this.emit('generate', 'done', { planId });

        specFiles.push(specFile);
        planSpecMap.set(plan, { specFile, planId, testCode });
      }

      // ── When healing is disabled: batch-execute ALL suites in one Playwright run ──
      // This is dramatically faster — one browser launch, parallel workers, no per-suite overhead.
      if (!this.enableHealing) {
        this.emit('execute', 'running', { planId: 'all', iteration: 1, message: 'Executing all suites (batch mode)' });
        const batchResults = await executor.executeAll(specFiles, (event) => {
          if (event.type === 'test') {
            const icon = event.status === 'passed' ? '✓' : event.status === 'failed' ? '✗' : '-';
            this.emit('execute', 'progress', {
              planId: event.planId,
              message: `${icon} ${event.testName} (${event.status}${event.duration ? `, ${event.duration}ms` : ''})`,
              testName: event.testName,
              testStatus: event.status,
              duration: event.duration,
            });
          } else if (event.type === 'file_start') {
            this.emit('execute', 'progress', { planId: event.planId, message: event.message });
          } else if (event.type === 'file_done') {
            this.emit('execute', 'progress', {
              planId: event.planId,
              message: event.message,
              testStatus: 'file_done',
              passed: event.passed,
              failed: event.failed,
              skipped: event.skipped,
              total: event.total,
            });
          } else if (event.type === 'compile_error') {
            this.emit('execute', 'progress', { planId: event.planId, message: event.message });
          } else if (event.type === 'start') {
            this.emit('execute', 'progress', { planId: 'all', message: event.message });
          } else if (event.type === 'complete') {
            this.emit('execute', 'progress', { planId: 'all', message: event.message });
          }
        });
        this.emit('execute', 'done', { planId: 'all', iteration: 1 });

        for (const [plan, { specFile, planId, testCode: tc }] of planSpecMap) {
          if (this.aborted) throw new Error('Aborted');

          let testCode = tc;
          const result = batchResults[planId] || {
            total: 0, passed: 0, failed: 0, skipped: 0, compileErrors: 0,
            failures: [], duration: 0,
          };

          this.emit('execute', 'done', { planId, iteration: 1, ...result });

          if (result.failed > 0 || result.compileErrors > 0) {
            this.emit('heal', 'skipped', { planId, message: 'Healing disabled — marking failures as fixme' });
            testCode = this.escalateToFixme(testCode, result.failures);
            fs.writeFileSync(specFile, testCode);
          }

          const planResult = {
            planId,
            page: plan.page,
            suite: plan.suite,
            tests: result.total,
            passed: result.passed,
            failed: result.failed,
            fixme: (testCode.match(/test\.fixme/g) || []).length,
          };
          finalResults.plans.push(planResult);
          finalResults.totalTests += planResult.tests;
          finalResults.passed += planResult.passed;
          finalResults.failed += planResult.failed;
          finalResults.fixme += planResult.fixme;
        }
      } else {
        // ── Healing enabled: execute per-suite with heal loop ──
        for (const [plan, { specFile, planId, testCode: initialCode }] of planSpecMap) {
          if (this.aborted) throw new Error('Aborted');

          let testCode = initialCode;
          let iteration = 0;
          let bestResult = null;

          const snapshot = snapshots.find(s => s.url === plan.page || s.path === plan.page) || snapshots[0];

          while (iteration < maxHealIterations) {
            if (this.aborted) throw new Error('Aborted');
            iteration++;

            this.emit('execute', 'running', { planId, iteration, message: `Executing: ${planId} (attempt ${iteration})` });
            const result = await executor.execute(specFile);
            this.emit('execute', 'done', { planId, iteration, ...result });

            if (!bestResult || this.isImprovement(result, bestResult)) {
              bestResult = result;
            }

            if (result.passed === result.total && result.compileErrors === 0) break;

            if (iteration >= maxHealIterations) {
              this.emit('heal', 'escalate', { planId, message: 'Max iterations reached, marking failures as fixme' });
              testCode = this.escalateToFixme(testCode, result.failures);
              fs.writeFileSync(specFile, testCode);
              break;
            }

            this.emit('heal', 'running', { planId, iteration, message: `Healing: ${planId}` });
            const healed = await healer.heal(testCode, result, snapshot, plan);

            if (healed && this.isImprovement(healed.expectedResult, bestResult)) {
              testCode = healed.code;
              fs.writeFileSync(specFile, testCode);
              this.emit('heal', 'done', { planId, iteration, changes: healed.changes });
            } else {
              this.emit('heal', 'skipped', { planId, iteration, message: 'Heal did not improve results' });
              if (bestResult && bestResult.code) {
                testCode = bestResult.code;
                fs.writeFileSync(specFile, testCode);
              }
            }
          }

          const planResult = {
            planId,
            page: plan.page,
            suite: plan.suite,
            tests: bestResult ? bestResult.total : 0,
            passed: bestResult ? bestResult.passed : 0,
            failed: bestResult ? bestResult.failed : 0,
            fixme: (testCode.match(/test\.fixme/g) || []).length,
          };
          finalResults.plans.push(planResult);
          finalResults.totalTests += planResult.tests;
          finalResults.passed += planResult.passed;
          finalResults.failed += planResult.failed;
          finalResults.fixme += planResult.fixme;
        }
      }

      // ── Stage 7: Report ──
      // Aggregate token usage from all stages
      tokenUsage.stages.generate = generator.getUsage();
      if (healer) {
        tokenUsage.stages.heal = healer.getUsage();
      }
      for (const stage of ['analyze', 'plan', 'generate', 'heal']) {
        const u = tokenUsage.stages[stage];
        if (u) {
          tokenUsage.inputTokens += u.inputTokens || 0;
          tokenUsage.outputTokens += u.outputTokens || 0;
          tokenUsage.calls += u.calls || 0;
        }
      }
      this.runData.tokenUsage = tokenUsage;
      this.emit('pipeline', 'info', {
        message: `Token usage: ${tokenUsage.inputTokens} input, ${tokenUsage.outputTokens} output, ${tokenUsage.calls} LLM calls`,
        tokenUsage,
      });

      // Include token usage in final results so it flows through SSE to the client
      finalResults.tokenUsage = tokenUsage;

      this.emit('pipeline', 'info', { message: 'Generating final report' });
      try {
        const { generateReport } = require('../utils/report-generator');
        // Update runData results so the report has the latest data
        this.runData.results = finalResults;
        this.runData.status = 'completed';
        const html = generateReport(this.runId, this.runData, this.runDir);
        fs.writeFileSync(path.join(this.runDir, 'report.html'), html);
        this.emit('pipeline', 'info', { message: 'Report generated successfully' });
      } catch (err) {
        console.error(`Failed to generate report: ${err.message}`);
      }

      return finalResults;

    } catch (err) {
      if (err.message === 'Aborted') {
        this.emit('pipeline', 'aborted');
        return { aborted: true };
      }
      throw err;
    }
  }

  isImprovement(candidate, baseline) {
    if (!baseline) return true;
    if ((candidate.compileErrors || 0) > (baseline.compileErrors || 0)) return false;
    if ((candidate.passed || 0) < (baseline.passed || 0)) return false;
    if ((candidate.failed || 0) >= (baseline.failed || 0)) return false;
    return true;
  }

  escalateToFixme(code, failures) {
    if (!failures || failures.length === 0) return code;
    let result = code;
    for (const failure of failures) {
      // Match test('name' or test("name" or test(`name` at the start of a line
      // but NOT test.fixme( — which already has the fixme marker
      const testPattern = new RegExp(
        `(test\\()(['"\`]${this.escapeRegex(failure.testName)}['"\`])`,
        'g'
      );
      // Skip if this test is already marked as fixme
      const fixmeCheck = new RegExp(
        `test\\.fixme\\(['"\`]${this.escapeRegex(failure.testName)}['"\`]`,
        'g'
      );
      if (fixmeCheck.test(result)) continue;
      // Sanitize the reason — strip newlines and ANSI codes so it doesn't break TypeScript
      const sanitized = (failure.reason || 'Could not auto-fix')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\x1b\[[0-9;]*m/g, '')
        .slice(0, 200);
      result = result.replace(testPattern, `test.fixme($2 /* ${sanitized} */`);
    }
    return result;
  }

  escapeRegex(str) {
    return (str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

module.exports = { PipelineOrchestrator };
