const fs = require('fs');
const path = require('path');
const { Executor } = require('./05_execute');
const { Healer } = require('./06_heal');

/**
 * ReExecutor — re-runs the generated tests from an existing run without
 * regenerating them. Optionally applies healing to fix failures.
 *
 * Stages: execute (→ heal loop) → summarize
 */
class ReExecutor {
  constructor(originalRunId, run, send) {
    this.originalRunId = originalRunId;
    this.runData = run;
    this.send = send;
    this.aborted = false;

    this.runDir = path.join(__dirname, '..', '..', 'runs', originalRunId);
    this.testsDir = path.join(this.runDir, 'generated-tests');
    this.resultsDir = path.join(this.runDir, 'test-results');

    this.enableHealing = run.options?.enableHealing !== false;
    this.llmConfig = run.llm || {};
    this.appContext = run.appContext || {};
    this.description = (run.description || '').trim();
    this.storageStatePath = path.join(this.runDir, 'auth-state.json');
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
    this.runData.status = 'running';
    this.send('status', { status: 'running' });

    this.emit('pipeline', 'info', {
      message: `Re-executing tests from run ${this.originalRunId}${this.enableHealing ? ' with healing' : ' (healing disabled)'}`,
    });

    // Ensure directories exist
    [this.runDir, this.testsDir, this.resultsDir].forEach(d => {
      fs.mkdirSync(d, { recursive: true });
    });

    // Load snapshots for healing (if enabled)
    let snapshots = [];
    const snapshotsFile = path.join(this.runDir, 'knowledge', 'snapshots.json');
    if (fs.existsSync(snapshotsFile)) {
      try {
        snapshots = JSON.parse(fs.readFileSync(snapshotsFile, 'utf-8'));
      } catch { /* ignore */ }
    }

    // Load plans for healing
    let plans = [];
    const plansFile = path.join(this.runDir, 'knowledge', 'plans.json');
    if (fs.existsSync(plansFile)) {
      try {
        plans = JSON.parse(fs.readFileSync(plansFile, 'utf-8'));
      } catch { /* ignore */ }
    }

    const executor = new Executor(this.testsDir, this.resultsDir, {
      storageStatePath: this.storageStatePath,
      appContext: this.appContext,
      testTimeout: this.runData.options?.testTimeout,
      retries: this.runData.options?.retries,
    });
    const healer = this.enableHealing
      ? new Healer(this.runData.targetUrl, this.runData.auth, this.llmConfig, this.description)
      : null;

    const maxHealIterations = parseInt(process.env.MAX_HEAL_ITERATIONS || '3', 10);
    let finalResults = { plans: [], totalTests: 0, passed: 0, failed: 0, skipped: 0, fixme: 0 };

    // Find all spec files
    const specFiles = fs.existsSync(this.testsDir)
      ? fs.readdirSync(this.testsDir).filter(f => f.endsWith('.spec.ts')).sort()
      : [];

    if (specFiles.length === 0) {
      this.emit('execute', 'error', { message: 'No generated test files found in the original run' });
      return { plans: [], totalTests: 0, passed: 0, failed: 0, skipped: 0, fixme: 0 };
    }

    for (const specFileName of specFiles) {
      if (this.aborted) throw new Error('Aborted');

      const planId = specFileName.replace('.spec.ts', '');
      const specFile = path.join(this.testsDir, specFileName);

      // Find matching plan and snapshot for healing context
      const plan = plans.find(p =>
        `${p.page}_${p.suite}`.replace(/[^a-zA-Z0-9]/g, '_') === planId
      ) || plans[0];
      const snapshot = plan
        ? snapshots.find(s => s.url === plan.page || s.path === plan.page) || snapshots[0]
        : snapshots[0];

      let testCode = fs.readFileSync(specFile, 'utf-8');

      // When healing is disabled, execute once and escalate failures
      if (!this.enableHealing) {
        this.emit('execute', 'running', { planId, iteration: 1, message: `Executing: ${planId}` });
        const result = await executor.execute(specFile);
        this.emit('execute', 'done', { planId, iteration: 1, ...result });

        if (result.failed > 0 || result.compileErrors > 0) {
          this.emit('heal', 'skipped', { planId, message: 'Healing disabled — marking failures as fixme' });
          testCode = this.escalateToFixme(testCode, result.failures);
          fs.writeFileSync(specFile, testCode);
        }

        const planResult = {
          planId,
          page: plan?.page || '',
          suite: plan?.suite || '',
          tests: result.total,
          passed: result.passed,
          failed: result.failed,
          skipped: result.skipped || 0,
          fixme: (testCode.match(/test\.fixme/g) || []).length,
        };
        finalResults.plans.push(planResult);
        finalResults.totalTests += planResult.tests;
        finalResults.passed += planResult.passed;
        finalResults.failed += planResult.failed;
        finalResults.skipped += planResult.skipped;
        finalResults.fixme += planResult.fixme;
        continue;
      }

      // Healing enabled — full execute → heal loop
      let iteration = 0;
      let bestResult = null;
      let lastFailures = null;
      const harRelPath = `../knowledge/${planId}.har`;

      while (iteration < maxHealIterations) {
        if (this.aborted) throw new Error('Aborted');
        iteration++;

        this.emit('execute', 'running', { planId, iteration, message: `Executing: ${planId} (attempt ${iteration})` });
        // §8: on heal iterations, re-run only the tests that failed last time.
        const result = await executor.execute(specFile, { onlyFailures: iteration > 1 ? lastFailures : null });
        // Merge a partial --test-list re-run into the last full result.
        if (iteration > 1 && lastFailures && bestResult && result.total > 0 && result.total < bestResult.total) {
          result.passed = bestResult.passed + result.passed;
          result.skipped = (bestResult.skipped || 0) + (result.skipped || 0);
          result.total = bestResult.total;
        }
        this.emit('execute', 'done', { planId, iteration, ...result });
        lastFailures = result.failures;

        if (!bestResult || this.isImprovement(result, bestResult)) {
          bestResult = result;
          // Track which spec source produced the best result so a
          // non-improving heal below can restore it.
          bestResult.code = testCode;
        }

        if (result.passed === result.total && result.total > 0 && result.compileErrors === 0) break;

        if (iteration >= maxHealIterations) {
          this.emit('heal', 'escalate', { planId, message: 'Max iterations reached, marking failures as fixme' });
          testCode = this.escalateToFixme(testCode, result.failures);
          fs.writeFileSync(specFile, testCode);
          break;
        }

        this.emit('heal', 'running', { planId, iteration, message: `Healing: ${planId}` });
        const healed = await healer.heal(testCode, result, snapshot, plan, {
          harRelPath: fs.existsSync(path.join(this.runDir, 'knowledge', `${planId}.har`)) ? harRelPath : null,
        });

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
        page: plan?.page || '',
        suite: plan?.suite || '',
        tests: bestResult ? bestResult.total : 0,
        passed: bestResult ? bestResult.passed : 0,
        failed: bestResult ? bestResult.failed : 0,
        skipped: bestResult ? (bestResult.skipped || 0) : 0,
        fixme: (testCode.match(/test\.fixme/g) || []).length,
      };
      finalResults.plans.push(planResult);
      finalResults.totalTests += planResult.tests;
      finalResults.passed += planResult.passed;
      finalResults.failed += planResult.failed;
      finalResults.skipped += planResult.skipped;
      finalResults.fixme += planResult.fixme;
    }

    // Aggregate token usage from healing (if enabled)
    if (healer) {
      const healUsage = healer.getUsage();
      this.runData.tokenUsage = this.runData.tokenUsage || { inputTokens: 0, outputTokens: 0, calls: 0, stages: {} };
      this.runData.tokenUsage.stages = this.runData.tokenUsage.stages || {};
      this.runData.tokenUsage.stages.heal = healUsage;
      this.runData.tokenUsage.inputTokens = (this.runData.tokenUsage.inputTokens || 0) + healUsage.inputTokens;
      this.runData.tokenUsage.outputTokens = (this.runData.tokenUsage.outputTokens || 0) + healUsage.outputTokens;
      this.runData.tokenUsage.calls = (this.runData.tokenUsage.calls || 0) + healUsage.calls;
      this.emit('pipeline', 'info', {
        message: `Token usage (re-execute): ${healUsage.inputTokens} input, ${healUsage.outputTokens} output, ${healUsage.calls} LLM calls`,
      });
    }

    // Generate final report
    this.emit('pipeline', 'info', { message: 'Updating final report' });
    try {
      const { generateReport } = require('../utils/report-generator');
      this.runData.results = finalResults;
      this.runData.status = 'completed';
      const html = generateReport(this.originalRunId, this.runData, this.runDir);
      fs.writeFileSync(path.join(this.runDir, 'report.html'), html);
    } catch (err) {
      console.error(`Failed to generate report: ${err.message}`);
    }

    return finalResults;
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

module.exports = { ReExecutor };
