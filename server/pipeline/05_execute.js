const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Clamp an integer to a safe range. Returns null if the input is not a
 * finite integer-like value.
 */
function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Build the contents of a playwright.config.ts file from appContext + storage
 * state path. Pure function — no filesystem access — so it can be unit tested
 * in isolation.
 *
 * Security: every user-controlled string is emitted via JSON.stringify, which
 * produces a valid TS/JS string literal that cannot break out of the string
 * context (single quotes, backticks, ${...}, and newlines are all escaped).
 * Viewport dimensions are coerced to clamped integers, so they can never
 * inject code.
 *
 * @param {object} opts
 * @param {object} [opts.appContext] — { baseURL, viewport, userAgent, extraHTTPHeaders }
 * @param {string|null} [opts.storageStateRelPath] — relative path to auth-state.json, or null
 * @returns {string} — full playwright.config.ts source
 */
function buildPlaywrightConfig(opts = {}) {
  const appContext = opts.appContext || {};
  const storageStateRelPath = opts.storageStateRelPath || null;
  const testTimeout = clampInt(opts.testTimeout, 5000, 300000, 60000);
  const retries = clampInt(opts.retries, 0, 5, 1);

  const useOptions = [
    "    headless: true,",
    "    screenshot: 'only-on-failure',",
    "    trace: 'retain-on-failure',",
    // Flake-class killers (§8): service workers cache stale assets and CSS
    // animations race assertions — disable both deterministically.
    "    serviceWorkers: 'block',",
    "    reducedMotion: 'reduce',",
  ];

  // Storage state — JSON.stringify escapes any path separators / quotes.
  // The path is relative and derived from a UUID runId, but we escape
  // defensively anyway in case of unusual filesystem characters.
  if (storageStateRelPath) {
    useOptions.push(`    storageState: ${JSON.stringify(storageStateRelPath)},`);
  }

  // Base URL — JSON.stringify produces a safe string literal.
  if (typeof appContext.baseURL === 'string' && appContext.baseURL.trim()) {
    useOptions.push(`    baseURL: ${JSON.stringify(appContext.baseURL)},`);
  }

  // Extra HTTP headers — JSON.stringify the whole object directly. No
  // regex post-processing needed; the indented JSON is valid TS.
  if (appContext.extraHTTPHeaders && typeof appContext.extraHTTPHeaders === 'object'
      && !Array.isArray(appContext.extraHTTPHeaders)
      && Object.keys(appContext.extraHTTPHeaders).length > 0) {
    useOptions.push(`    extraHTTPHeaders: ${JSON.stringify(appContext.extraHTTPHeaders, null, 6)},`);
  }

  // Viewport — coerce to clamped integers so non-numeric input can't inject.
  if (appContext.viewport && typeof appContext.viewport === 'object') {
    const width = clampInt(appContext.viewport.width, 320, 3840, 1280);
    const height = clampInt(appContext.viewport.height, 240, 2160, 720);
    useOptions.push(`    viewport: { width: ${width}, height: ${height} },`);
  }

  // User agent — JSON.stringify produces a safe string literal.
  if (typeof appContext.userAgent === 'string' && appContext.userAgent.trim()) {
    useOptions.push(`    userAgent: ${JSON.stringify(appContext.userAgent)},`);
  }

  // Locale — must match the explorer/recorder contexts or locale-sensitive
  // rendering (toLocaleDateString etc.) produces false baseline diffs.
  const locale = (typeof appContext.locale === 'string' && appContext.locale.trim())
    ? appContext.locale.trim() : 'en-US';
  useOptions.push(`    locale: ${JSON.stringify(locale)},`);

  return `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './generated-tests',
  timeout: ${testTimeout},
  retries: ${retries},
  // §8: retries run in a clean worker — separates real failures from
  // cross-test interference flakes.
  ${retries > 0 ? "retryStrategy: 'isolated'," : ''}
  fullyParallel: true,
  workers: 4,
  // snapshotDir resolves relative to THIS config file's dir (runDir), not
  // testDir — so './screenshots' lands at runDir/screenshots where
  // writeA11yBaseline and the visual-test guards place baselines.
  snapshotDir: './screenshots',
  updateSnapshots: 'missing',
  use: {
${useOptions.join('\n')}
  },
  reporter: [['list'], ['json', { outputFile: 'test-results/all-results.json' }]],
});
`;
}

class Executor {
  constructor(testsDir, resultsDir, options = {}) {
    this.testsDir = testsDir;
    this.resultsDir = resultsDir;
    this.runDir = path.join(testsDir, '..');
    this.storageStatePath = options.storageStatePath || null;
    this.appContext = options.appContext || {};
    this.testTimeout = options.testTimeout || null;
    this.retries = options.retries != null ? options.retries : null;
    this.ensureConfig();
  }

  ensureConfig() {
    // Always (re)write playwright.config.ts in the run directory so Playwright
    // uses the correct testDir and the latest reporter format. This is important
    // for re-execution, where an old config with an outdated reporter may exist.
    const configPath = path.join(this.runDir, 'playwright.config.ts');
    let storageStateRelPath = null;
    if (this.storageStatePath && fs.existsSync(this.storageStatePath)) {
      storageStateRelPath = path.relative(this.runDir, this.storageStatePath).replace(/\\/g, '/');
    }
    const config = buildPlaywrightConfig({
      appContext: this.appContext,
      storageStateRelPath,
      testTimeout: this.testTimeout,
      retries: this.retries,
    });
    fs.writeFileSync(configPath, config);
  }

  /**
   * Execute ALL spec files, running each one individually with spawn.
   * This gives real-time per-file and per-test progress events via onProgress.
   *
   * @param {string[]} specFiles
   * @param {function} [onProgress] — callback(event) for each test/file event
   */
  async executeAll(specFiles, onProgress) {
    const results = {};

    // Compile check all files first
    for (const specFile of specFiles) {
      const planId = path.basename(specFile, '.spec.ts');
      const compileResult = this.compileCheck(specFile);
      if (!compileResult.success) {
        results[planId] = {
          specFile,
          total: 0, passed: 0, failed: 0, skipped: 0,
          compileErrors: compileResult.errors.length,
          failures: compileResult.errors.map(e => ({
            testName: 'compile', reason: e, type: 'compile_error',
          })),
          duration: 0,
        };
        if (onProgress) onProgress({ type: 'compile_error', planId, message: `Compile error in ${planId}` });
      }
    }

    // Filter out files that failed compilation
    const validFiles = specFiles.filter(f => {
      const planId = path.basename(f, '.spec.ts');
      return !results[planId] || results[planId].compileErrors === 0;
    });

    if (validFiles.length === 0) return results;

    if (onProgress) onProgress({ type: 'start', message: `Starting execution of ${validFiles.length} spec file(s)` });

    // Run each spec file individually so we get clear per-file progress.
    // Within each file, tests still run in parallel (workers from config).
    for (let fi = 0; fi < validFiles.length; fi++) {
      const specFile = validFiles[fi];
      const planId = path.basename(specFile, '.spec.ts');
      const specBasename = path.basename(specFile);
      const fileResultsFile = path.join(this.resultsDir, `${planId}-results.json`);

      if (onProgress) onProgress({
        type: 'file_start',
        planId,
        message: `Starting ${planId} (${fi + 1}/${validFiles.length}) — ${specBasename}`,
      });

      const startTime = Date.now();

      // Run using the config's reporters (list for stdout progress + json for results file).
      // The config has outputFile: 'test-results/all-results.json' built in.
      // We do NOT pass --reporter on CLI because that overrides the config's reporters,
      // and the PLAYWRIGHT_JSON_OUTPUT_NAME env var does not work in this Playwright version.
      const allResultsFile = path.join(this.resultsDir, 'all-results.json');
      // Clear stale results — if this playwright run produces nothing we must
      // see that as "no results", not inherit the previous spec's file.
      try { fs.unlinkSync(allResultsFile); } catch {}

      await new Promise((resolve) => {
        const child = spawn('npx', [
          'playwright', 'test',
          '--config', 'playwright.config.ts',
          specBasename,
        ], {
          cwd: this.runDir,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
        });

        const lineBuf = { stdout: '', stderr: '' };

        const processLine = (line) => {
          if (!line || !onProgress) return;
          const parsed = this._parseListReporterLine(line);
          if (parsed) {
            onProgress(parsed);
          }
        };

        child.stdout.on('data', (data) => {
          lineBuf.stdout += data.toString();
          let idx;
          while ((idx = lineBuf.stdout.indexOf('\n')) >= 0) {
            const line = lineBuf.stdout.substring(0, idx).trim();
            lineBuf.stdout = lineBuf.stdout.substring(idx + 1);
            processLine(line);
          }
        });

        child.stderr.on('data', (data) => {
          lineBuf.stderr += data.toString();
          let idx;
          while ((idx = lineBuf.stderr.indexOf('\n')) >= 0) {
            const line = lineBuf.stderr.substring(0, idx).trim();
            lineBuf.stderr = lineBuf.stderr.substring(idx + 1);
            processLine(line);
          }
        });

        child.on('close', () => {
          if (lineBuf.stdout.trim()) processLine(lineBuf.stdout.trim());
          if (lineBuf.stderr.trim()) processLine(lineBuf.stderr.trim());
          resolve();
        });

        child.on('error', () => resolve());
      });

      const duration = Date.now() - startTime;

      // Parse the JSON results from the config's outputFile (all-results.json).
      // Then copy it to <planId>-results.json for backward compatibility with
      // the report generator and run history.
      if (fs.existsSync(allResultsFile)) {
        try {
          const report = JSON.parse(fs.readFileSync(allResultsFile, 'utf-8'));
          const result = {
            specFile,
            total: 0, passed: 0, failed: 0, skipped: 0,
            compileErrors: 0, flaky: 0,
            failures: [],
            duration,
          };
          this._parseReportInto(report, result, planId);
          results[planId] = result;

          // Copy to per-plan results file for report generator compatibility
          try { fs.copyFileSync(allResultsFile, fileResultsFile); } catch {}

          if (onProgress) onProgress({
            type: 'file_done',
            planId,
            message: `${planId} complete: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped (${Math.round(duration / 1000)}s)`,
            passed: result.passed,
            failed: result.failed,
            skipped: result.skipped,
            total: result.total,
          });
        } catch {
          results[planId] = await this.execute(specFile);
          if (onProgress) onProgress({ type: 'file_done', planId, message: `${planId} complete (results parsed via fallback)` });
        }
      } else {
        results[planId] = await this.execute(specFile);
        if (onProgress) onProgress({ type: 'file_done', planId, message: `${planId} complete (no results file — fallback)` });
      }
    }

    if (onProgress) onProgress({ type: 'complete', message: 'All spec files finished execution' });

    return results;
  }

  /**
   * Parse a Playwright JSON report into a result object, filtering by planId.
   */
  _parseReportInto(report, result, planId) {
    const tests = [];
    // titlePath accumulates describe-suite titles so a test can be targeted
    // via `npx playwright test --test-list` (§8 — re-run only failed tests
    // in the heal loop instead of the whole spec).
    const walk = (suite, titlePath) => {
      const childTitles = suite.title && !suite.file ? [...titlePath, suite.title] : titlePath;
      if (suite.specs) {
        for (const spec of suite.specs) {
          const specFile = spec.file || suite.file;
          const filePlanId = specFile ? path.basename(specFile, '.spec.ts') : planId;
          if (filePlanId !== planId) continue;

          for (const test of spec.tests || []) {
            const testResults = test.results || [];
            const flaky = test.status === 'flaky' || (test.status === 'expected' && testResults.length > 1 &&
              testResults.some(r => r.status === 'unexpected'));
            const lastResult = testResults[testResults.length - 1] || {};
            const failResult = testResults.find(r => r.status === 'unexpected') || lastResult;
            const screenshot = failResult.attachments?.find(a => a.name === 'screenshot')?.path || null;
            tests.push({
              name: spec.title,
              titlePath: [...childTitles, spec.title],
              status: test.status,
              duration: testResults.reduce((sum, r) => sum + (r.duration || 0), 0),
              error: failResult.error?.message || null,
              snippet: failResult.error?.snippet || null,
              errorContext: failResult.error?.errorContext || null,
              flaky,
              screenshot,
            });
          }
        }
      }
      if (suite.suites) {
        for (const child of suite.suites) walk(child, childTitles);
      }
    };

    if (report.suites) {
      for (const suite of report.suites) walk(suite, []);
    }

    result.total = tests.length;
    result.passed = tests.filter(t => t.status === 'expected' || t.status === 'flaky').length;
    result.failed = tests.filter(t => t.status === 'unexpected').length;
    result.skipped = tests.filter(t => t.status === 'skipped').length;
    result.flaky = tests.filter(t => t.flaky).length;
    result.failures = tests
      .filter(t => t.status === 'unexpected')
      .map(t => ({
        testName: t.name,
        titlePath: t.titlePath,
        reason: t.error || 'Test failed',
        snippet: t.snippet,
        errorContext: t.errorContext,
        type: 'test_failure',
        screenshot: t.screenshot,
      }));
  }

  /**
   * Parse a line from Playwright's list reporter to extract test status.
   * Handles multiple Playwright versions and output formats:
   *   ✓  1 [chromium] › Navigation.spec.ts:3:7 › Suite › Test name (1.2s)
   *   ✘  2 [chromium] › Forms.spec.ts:10:7 › Suite › Test name (2.3s)
   *   -  3 [chromium] › Accessibility.spec.ts:5:7 › Suite › Skipped test
   *   ✓ Navigation.spec.ts:3:7 › Suite › Test name (1.2s)
   * Also handles Windows encoding where ✓/✘ may appear differently.
   */
  _parseListReporterLine(line) {
    // Strip ANSI color codes
    const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '');

    // Match: symbol + optional number + [browser] + › + file:line:col + › + test path + optional duration
    // The symbol can be ✓ (pass), ✘/✗/× (fail), - (skip)
    // Be flexible with spacing and browser label
    const match = cleanLine.match(/^([✓✘✗×\-])\s*(?:\d+)?\s*(?:\[.+?\])?\s*›?\s*(.+?\.spec\.ts):\d+:\d+\s*›\s*(.+?)(?:\s+\(([\d.]+s|ms)\))?$/);
    if (!match) return null;

    const [, symbol, specFile, testPath, durationStr] = match;
    const planId = path.basename(specFile, '.spec.ts');
    // The test path may contain "Suite › Test name" — take the last segment
    const testName = testPath.split('›').pop().trim();
    let status = 'unknown';
    if (symbol === '✓') status = 'passed';
    else if (symbol === '✘' || symbol === '✗' || symbol === '×') status = 'failed';
    else if (symbol === '-') status = 'skipped';

    let duration = 0;
    if (durationStr) {
      if (durationStr.endsWith('ms')) {
        duration = parseInt(durationStr, 10);
      } else if (durationStr.endsWith('s')) {
        duration = Math.round(parseFloat(durationStr) * 1000);
      }
    }

    return { type: 'test', planId, testName, status, duration, specFile };
  }

  /**
   * Flatten tests from a Playwright report, grouped by spec file.
   */
  flattenTestsByFile(report) {
    const byFile = {};

    const walk = (suite) => {
      // Check if this suite has a file association
      let fileKey = null;
      if (suite.file) {
        fileKey = path.basename(suite.file, '.spec.ts');
      }

      if (suite.specs) {
        for (const spec of suite.specs) {
          // Determine the spec file from the spec's file or suite's file
          const specFile = spec.file || suite.file;
          const planId = specFile ? path.basename(specFile, '.spec.ts') : fileKey;
          if (!planId) continue;

          if (!byFile[planId]) byFile[planId] = [];

          for (const test of spec.tests || []) {
            const results = test.results || [];
            const flaky = test.status === 'flaky' || (test.status === 'expected' && results.length > 1 &&
              results.some(r => r.status === 'unexpected'));
            const lastResult = results[results.length - 1] || {};
            const failResult = results.find(r => r.status === 'unexpected') || lastResult;
            const screenshot = failResult.attachments?.find(a => a.name === 'screenshot')?.path || null;
            byFile[planId].push({
              name: spec.title,
              status: test.status,
              duration: results.reduce((sum, r) => sum + (r.duration || 0), 0),
              error: failResult.error?.message || null,
              snippet: failResult.error?.snippet || null,
              retry: results.length - 1,
              flaky,
              screenshot,
            });
          }
        }
      }
      if (suite.suites) {
        for (const child of suite.suites) walk(child);
      }
    };

    if (report.suites) {
      for (const suite of report.suites) walk(suite);
    }
    return byFile;
  }

  /**
   * Build a --test-list file (§8) so the heal loop re-runs only the failing
   * tests instead of the whole spec per iteration.
   * Format per line: `<specFile> › <describe title> › <test title>`.
   * @param {string} specBasename — e.g. 'Home_Navigation.spec.ts'
   * @param {Array} failures — failures with optional titlePath
   * @returns {string|null} absolute path to the test-list file, or null if
   *   no usable entries were produced.
   */
  _writeTestListFile(specBasename, failures) {
    const lines = [];
    for (const f of failures) {
      if (f.type === 'compile_error') continue;
      const titles = Array.isArray(f.titlePath) && f.titlePath.length > 0
        ? f.titlePath
        : [f.testName];
      if (!titles.every(t => typeof t === 'string' && t.trim())) continue;
      lines.push(`${specBasename} › ${titles.join(' › ')}`);
    }
    if (lines.length === 0) return null;
    const listPath = path.join(
      this.resultsDir,
      `testlist-${path.basename(specBasename, '.spec.ts')}.txt`
    );
    fs.writeFileSync(listPath, lines.join('\n') + '\n');
    return listPath;
  }

  async execute(specFile, opts = {}) {
    const result = {
      specFile,
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      compileErrors: 0,
      failures: [],
      duration: 0,
    };

    // Step 1: Compile check
    const compileResult = this.compileCheck(specFile);
    if (!compileResult.success) {
      result.compileErrors = compileResult.errors.length;
      result.failures = compileResult.errors.map(e => ({
        testName: 'compile',
        reason: e,
        type: 'compile_error',
      }));
      return result;
    }

    // Step 2: Run with Playwright
    const resultsFile = path.join(this.resultsDir, `${path.basename(specFile, '.spec.ts')}-results.json`);
    // Clear stale results from the previous run/spec BEFORE executing — if
    // this playwright invocation produces nothing, parsing a leftover file
    // would silently attribute another suite's results to this spec.
    const allResultsFile0 = path.join(this.resultsDir, 'all-results.json');
    try { fs.unlinkSync(allResultsFile0); } catch {}
    try { fs.unlinkSync(resultsFile); } catch {}
    // The config sets testDir to './generated-tests', so rootDir becomes that
    // subdirectory. The filter argument must be relative to rootDir (just the filename).
    const specFilter = path.basename(specFile);

    // §8: when caller supplies failures from the previous iteration, re-run
    // only those tests via --test-list instead of the whole spec file.
    let testListArg = '';
    if (Array.isArray(opts.onlyFailures) && opts.onlyFailures.length > 0) {
      const listPath = this._writeTestListFile(specFilter, opts.onlyFailures);
      if (listPath) {
        testListArg = ` --test-list="${listPath}"`;
      }
    }

    try {
      const startTime = Date.now();
      // Use the config's reporters (list + json with outputFile). Don't pass --reporter
      // on CLI because it overrides the config, and PLAYWRIGHT_JSON_OUTPUT_NAME env var
      // does not work in this Playwright version.
      const allResultsFile = path.join(this.resultsDir, 'all-results.json');
      // Generous wall-clock cap: a11y suites run two WCAG audits with
      // per-test setTimeout overrides up to 5 min each; with one retry the
      // whole spec can legitimately exceed 20 min. An outer cap that is
      // shorter silently kills the suite and produces no results file.
      const execTimeout = Math.max(1500000, (this.testTimeout || 60000) * 25);
      execSync(
        `npx playwright test --config="playwright.config.ts" "${specFilter}"${testListArg} 2>&1 || true`,
        {
          cwd: this.runDir,
          env: { ...process.env },
          timeout: execTimeout,
          stdio: 'pipe',
        }
      );
      result.duration = Date.now() - startTime;
      // Copy all-results.json to per-plan results file for compatibility
      if (fs.existsSync(allResultsFile)) {
        try { fs.copyFileSync(allResultsFile, resultsFile); } catch {}
      }
    } catch (err) {
      // Playwright may exit non-zero on test failures, that's expected
      result.duration = 0;
    }

    // Step 3: Parse results
    if (fs.existsSync(resultsFile)) {
      try {
        const report = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'));
        const parsed = this.parseReport(report, result);
        // If a --test-list run matched zero tests (e.g. the healer renamed a
        // test), fall back to running the whole file once so we never report
        // a false "0 tests = success".
        if (testListArg && parsed.total === 0) {
          console.warn(`--test-list matched no tests in ${specFilter} — running full file`);
          return this.execute(specFile);
        }
        return parsed;
      } catch {
        // JSON parse failed — treat as all failed
        result.failed = 1;
        result.total = 1;
        result.failures.push({ testName: 'unknown', reason: 'Could not parse test results', type: 'parse_error' });
      }
    } else {
      // No results file — try to extract from stdout
      result.failed = 1;
      result.total = 1;
      result.failures.push({ testName: 'unknown', reason: 'No results file produced', type: 'execution_error' });
    }

    return result;
  }

  compileCheck(specFile) {
    try {
      execSync(`npx tsc --noEmit --esModuleInterop --moduleResolution node "${specFile}" 2>&1`, {
        cwd: path.join(this.testsDir, '..'),
        timeout: 30000,
        stdio: 'pipe',
      });
      return { success: true, errors: [] };
    } catch (err) {
      const output = err.stdout?.toString() || err.stderr?.toString() || err.message;
      const errors = output
        .split('\n')
        .filter(l => l.includes('error TS'))
        .map(l => l.trim());
      return { success: errors.length === 0, errors };
    }
  }

  parseReport(report, result) {
    if (!report.suites) return result;

    const flattenTests = (suites, titlePath = []) => {
      const tests = [];
      for (const suite of suites) {
        const childTitles = suite.title && !suite.file ? [...titlePath, suite.title] : titlePath;
        if (suite.specs) {
          for (const spec of suite.specs) {
            for (const test of spec.tests || []) {
              const results = test.results || [];
              // A test is "flaky" if it ultimately passed (expected/flaky) but had
              // at least one failed retry before passing.
              const flaky = test.status === 'flaky' || (test.status === 'expected' && results.length > 1 &&
                results.some(r => r.status === 'unexpected'));
              // Use the last result's error for failed tests (most informative)
              const lastResult = results[results.length - 1] || {};
              const failResult = results.find(r => r.status === 'unexpected') || lastResult;
              tests.push({
                name: spec.title,
                titlePath: [...childTitles, spec.title],
                status: test.status,
                duration: results.reduce((sum, r) => sum + (r.duration || 0), 0),
                error: failResult.error?.message || null,
                snippet: failResult.error?.snippet || null,
                errorContext: failResult.error?.errorContext || null,
                retry: results.length - 1,
                flaky,
                // Screenshot path from the failing result (if any)
                screenshot: failResult.attachments?.find(a => a.name === 'screenshot')?.path || null,
              });
            }
          }
        }
        if (suite.suites) {
          tests.push(...flattenTests(suite.suites, childTitles));
        }
      }
      return tests;
    };

    const tests = flattenTests(report.suites);
    result.total = tests.length;
    result.passed = tests.filter(t => t.status === 'expected' || t.status === 'flaky').length;
    result.failed = tests.filter(t => t.status === 'unexpected').length;
    result.skipped = tests.filter(t => t.status === 'skipped').length;
    result.flaky = tests.filter(t => t.flaky).length;

    result.failures = tests
      .filter(t => t.status === 'unexpected')
      .map(t => ({
        testName: t.name,
        titlePath: t.titlePath,
        reason: t.error || 'Test failed',
        snippet: t.snippet,
        errorContext: t.errorContext,
        type: 'test_failure',
        screenshot: t.screenshot,
      }));

    return result;
  }
}

module.exports = { Executor, buildPlaywrightConfig, clampInt };
