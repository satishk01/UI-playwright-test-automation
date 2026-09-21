const fs = require('fs');
const path = require('path');

/**
 * Production-quality HTML test report generator.
 * Produces a self-contained, client-shareable report with:
 *  - SVG donut chart for pass/fail distribution
 *  - Filterable test results table (pass/fail/skip filters)
 *  - Per-suite breakdown with visual bars
 *  - Failure analysis with error categorization
 *  - Coverage matrix (pages × suites)
 *  - Print-friendly layout
 *  - Professional branding
 */

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(iso) {
  if (!iso) return 'N/A';
  try {
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function formatDuration(ms) {
  if (!ms || ms === 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
}

function loadRunData(runDir) {
  const data = {
    snapshots: [],
    pageModels: [],
    plans: [],
    testResults: {},
    testFiles: {},
    runMeta: null,
  };

  const snapFile = path.join(runDir, 'knowledge', 'snapshots.json');
  if (fs.existsSync(snapFile)) {
    try { data.snapshots = JSON.parse(fs.readFileSync(snapFile, 'utf-8')); } catch {}
  }

  const pmFile = path.join(runDir, 'knowledge', 'page_models.json');
  if (fs.existsSync(pmFile)) {
    try { data.pageModels = JSON.parse(fs.readFileSync(pmFile, 'utf-8')); } catch {}
  }

  const plansFile = path.join(runDir, 'knowledge', 'plans.json');
  if (fs.existsSync(plansFile)) {
    try { data.plans = JSON.parse(fs.readFileSync(plansFile, 'utf-8')); } catch {}
  }

  const resultsDir = path.join(runDir, 'test-results');
  if (fs.existsSync(resultsDir)) {
    // Check for all-results.json first (combined report from batch execution)
    const allResultsFile = path.join(resultsDir, 'all-results.json');
    if (fs.existsSync(allResultsFile)) {
      try {
        const allReport = JSON.parse(fs.readFileSync(allResultsFile, 'utf-8'));
        // Split combined report into individual plan results by file
        if (allReport.suites) {
          for (const suite of allReport.suites) {
            // Top-level suites in Playwright JSON report are files
            const planId = suite.file ? path.basename(suite.file, '.spec.ts') : null;
            if (planId) {
              // Create a mini-report for this plan so flattenTests can process it
              data.testResults[planId] = { ...allReport, suites: [suite] };
            }
          }
        }
      } catch (err) {
        console.warn(`Failed to parse all-results.json in ${runDir}: ${err.message}`);
      }
    }

    // Then load any individual results files (backwards compatibility or single-suite execution)
    for (const f of fs.readdirSync(resultsDir)) {
      if (f.endsWith('-results.json') && f !== 'all-results.json') {
        try {
          const planId = f.replace('-results.json', '');
          // Don't overwrite if we already loaded it from all-results.json
          if (!data.testResults[planId]) {
            data.testResults[planId] = JSON.parse(
              fs.readFileSync(path.join(resultsDir, f), 'utf-8')
            );
          }
        } catch {}
      }
    }
  }

  const testsDir = path.join(runDir, 'generated-tests');
  if (fs.existsSync(testsDir)) {
    for (const f of fs.readdirSync(testsDir)) {
      if (f.endsWith('.spec.ts')) {
        try {
          data.testFiles[f] = fs.readFileSync(path.join(testsDir, f), 'utf-8');
        } catch {}
      }
    }
  }

  const metaFile = path.join(runDir, 'run-meta.json');
  if (fs.existsSync(metaFile)) {
    try { data.runMeta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch {}
  }

  return data;
}

function flattenTests(report) {
  const tests = [];

  const walk = (suite) => {
    if (suite.specs) {
      for (const spec of suite.specs) {
        for (const test of spec.tests || []) {
          const results = test.results || [];
          // Playwright marks tests that failed on an earlier retry but ultimately
          // passed with status "flaky". Older reports may only have "expected"
          // with multiple results, so detect both forms.
          const flaky = test.status === 'flaky' ||
            (test.status === 'expected' && results.length > 1 &&
              results.some(r => r.status === 'unexpected'));
          const lastResult = results[results.length - 1] || {};
          const failResult = results.find(r => r.status === 'unexpected') || lastResult;
          const screenshot = failResult.attachments?.find(a => a.name === 'screenshot')?.path || null;
          tests.push({
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
  return tests;
}

/**
 * Load a screenshot file as a base64 data URI for embedding in HTML.
 */
function loadScreenshotAsDataURI(filePath) {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const buffer = fs.readFileSync(filePath);
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Categorize a test failure based on its error message.
 */
function categorizeFailure(error) {
  if (!error) return { category: 'Unknown', icon: '?' };
  const lower = error.toLowerCase();

  if (lower.includes('strict mode violation') || lower.includes('resolved to 2 elements') || lower.includes('resolved to 3 elements'))
    return { category: 'Ambiguous Locator', icon: '◉', description: 'Multiple elements matched the same role+name. Use .first() or { exact: true }.' };
  if (lower.includes('timeout') || lower.includes('timed out'))
    return { category: 'Timeout', icon: '⏱', description: 'Element or action did not complete within the timeout period.' };
  if (lower.includes('tobevisible') || lower.includes('to be visible'))
    return { category: 'Element Not Visible', icon: '👁', description: 'Expected element was not visible on the page after the action.' };
  if (lower.includes('tohaveurl'))
    return { category: 'URL Mismatch', icon: '🔗', description: 'Page did not navigate to the expected URL.' };
  if (lower.includes('tohavevalue'))
    return { category: 'Value Mismatch', icon: '📝', description: 'Form field did not have the expected value after fill/select.' };
  if (lower.includes('element not found') || lower.includes('not found'))
    return { category: 'Element Not Found', icon: '🔍', description: 'The target element does not exist on the page.' };
  if (lower.includes('syntaxerror') || lower.includes('missing semicolon'))
    return { category: 'Code Generation Error', icon: '⚙', description: 'Generated test code has a syntax error.' };
  if (lower.includes('navigation') || lower.includes('goto'))
    return { category: 'Navigation Error', icon: '🧭', description: 'Failed to navigate to the target page.' };

  return { category: 'Other', icon: '⚠', description: 'Unclassified failure.' };
}

/**
 * Generate an SVG donut chart for pass/fail/skip distribution.
 */
function generateDonutChart(passed, failed, skipped, total) {
  if (total === 0) return '';
  const r = 60;
  const cx = 80;
  const cy = 80;
  const circumference = 2 * Math.PI * r;

  const passPct = passed / total;
  const failPct = failed / total;
  const skipPct = skipped / total;

  const passDash = passPct * circumference;
  const failDash = failPct * circumference;
  const skipDash = skipPct * circumference;

  const passOffset = 0;
  const failOffset = -passDash;
  const skipOffset = -(passDash + failDash);

  return `
  <svg width="160" height="160" viewBox="0 0 160 160" style="margin: 0 auto; display: block;">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e0e0e0" stroke-width="20"/>
    ${passed > 0 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#4caf50" stroke-width="20"
      stroke-dasharray="${passDash} ${circumference - passDash}" stroke-dashoffset="${passOffset}"
      transform="rotate(-90 ${cx} ${cy})" style="transition: stroke-dasharray 0.5s;"/>` : ''}
    ${failed > 0 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#f44336" stroke-width="20"
      stroke-dasharray="${failDash} ${circumference - failDash}" stroke-dashoffset="${failOffset}"
      transform="rotate(-90 ${cx} ${cy})" style="transition: stroke-dasharray 0.5s;"/>` : ''}
    ${skipped > 0 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ff9800" stroke-width="20"
      stroke-dasharray="${skipDash} ${circumference - skipDash}" stroke-dashoffset="${skipOffset}"
      transform="rotate(-90 ${cx} ${cy})" style="transition: stroke-dasharray 0.5s;"/>` : ''}
    <text x="${cx}" y="${cy - 5}" text-anchor="middle" font-size="28" font-weight="800" fill="#333">${total}</text>
    <text x="${cx}" y="${cy + 15}" text-anchor="middle" font-size="11" fill="#888" text-transform="uppercase">Tests</text>
  </svg>`;
}

/**
 * Generate a horizontal bar for a suite's pass/fail ratio.
 */
function generateSuiteBar(passed, failed, skipped, total) {
  if (total === 0) return '<div style="color:#888;font-size:12px;">No tests</div>';
  const passPct = (passed / total) * 100;
  const failPct = (failed / total) * 100;
  const skipPct = (skipped / total) * 100;
  return `
    <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:#e0e0e0;margin-top:6px;">
      ${passed > 0 ? `<div style="width:${passPct}%;background:#4caf50;"></div>` : ''}
      ${failed > 0 ? `<div style="width:${failPct}%;background:#f44336;"></div>` : ''}
      ${skipped > 0 ? `<div style="width:${skipPct}%;background:#ff9800;"></div>` : ''}
    </div>`;
}

function generateReport(runId, run, runDir) {
  const data = loadRunData(runDir);
  const results = run?.results || {};

  const totalTests = results.totalTests || 0;
  const passed = results.passed || 0;
  const failed = results.failed || 0;
  const fixme = results.fixme || 0;
  const passRate = totalTests > 0 ? Math.round((passed / totalTests) * 100) : 0;

  // Build per-plan detail with all data joined
  const planDetails = (results.plans || []).map(plan => {
    const planId = plan.planId;
    const report = data.testResults[planId];
    const tests = report ? flattenTests(report) : [];
    const specCode = data.testFiles[`${planId}.spec.ts`] || '';
    const matchingPlan = data.plans.find(p =>
      `${p.page}_${p.suite}`.replace(/[^a-zA-Z0-9]/g, '_') === planId
    );
    const snapshot = data.snapshots.find(s =>
      s.url === matchingPlan?.page || s.path === matchingPlan?.page
    ) || data.snapshots[0];
    const pageModel = data.pageModels.find(m =>
      m.url === matchingPlan?.page || m.path === matchingPlan?.page
    ) || data.pageModels[0];

    return { plan, tests, specCode, matchingPlan, snapshot, pageModel, report };
  });

  // Collect all failures for the failure analysis section
  const allFailures = [];
  let flakyCount = 0;
  for (const pd of planDetails) {
    for (const t of pd.tests) {
      if (t.flaky) flakyCount++;
      if (t.status === 'unexpected') {
        const cat = categorizeFailure(t.error);
        allFailures.push({
          testName: t.name,
          suite: pd.plan.suite,
          page: pd.plan.page,
          error: t.error,
          category: cat.category,
          icon: cat.icon,
          description: cat.description,
          duration: t.duration,
        });
      }
    }
  }

  // Group failures by category
  const failureCategories = {};
  for (const f of allFailures) {
    if (!failureCategories[f.category]) {
      failureCategories[f.category] = { count: 0, icon: f.icon, description: f.description, failures: [] };
    }
    failureCategories[f.category].count++;
    failureCategories[f.category].failures.push(f);
  }

  // Pages tested
  const pages = data.snapshots.map(s => ({
    url: s.url,
    title: s.title || 'Untitled',
    path: s.path || '/',
    interactiveCount: (s.interactiveElements || []).length,
    linkCount: (s.links || []).length,
    formCount: (s.forms || []).length,
  }));

  const generatedDate = new Date().toISOString();
  const targetUrl = run?.targetUrl || (pages[0]?.url || 'N/A');
  const createdAt = run?.createdAt || generatedDate;
  const description = run?.description || '';
  const enableHealing = run?.options?.enableHealing !== false;

  // Build coverage matrix: pages × suites
  const suiteTypes = ['Navigation', 'Functional', 'Forms', 'Accessibility'];
  const coverageMatrix = pages.map(page => {
    const row = { page, suites: {} };
    for (const suite of suiteTypes) {
      const matchingPlans = planDetails.filter(pd =>
        pd.plan.page === page.url && pd.plan.suite === suite
      );
      if (matchingPlans.length > 0) {
        const pd = matchingPlans[0];
        const suitePassed = pd.tests.filter(t => t.status === 'expected' || t.status === 'flaky').length;
        const suiteFailed = pd.tests.filter(t => t.status === 'unexpected').length;
        // Use executed tests count, or fall back to planned tests count from plans.json
        const suiteTotal = pd.tests.length || (pd.matchingPlan?.tests?.length || 0);
        row.suites[suite] = { passed: suitePassed, failed: suiteFailed, total: suiteTotal, hasData: true };
      } else {
        row.suites[suite] = { hasData: false };
      }
    }
    return row;
  });

  // ── Build HTML ──
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Test Report — ${escapeHtml(targetUrl)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    color: #1a1a2e; background: #f0f2f5; line-height: 1.6; font-size: 15px;
  }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }

  /* ── Header ── */
  .report-header {
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
    color: white; padding: 48px 40px; border-radius: 16px; margin-bottom: 24px;
    position: relative; overflow: hidden;
  }
  .report-header::after {
    content: ''; position: absolute; top: 0; right: 0; width: 300px; height: 100%;
    background: linear-gradient(135deg, transparent, rgba(79, 172, 254, 0.1));
  }
  .report-header .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .report-header .brand-icon {
    width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #4facfe, #00f2fe);
    display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 800; color: #1a1a2e;
  }
  .report-header .brand-text { font-size: 18px; font-weight: 700; letter-spacing: 0.5px; }
  .report-header h1 { font-size: 32px; font-weight: 800; margin-bottom: 8px; }
  .report-header .subtitle { font-size: 16px; opacity: 0.7; margin-bottom: 28px; }
  .report-header .meta-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px;
  }
  .report-header .meta-item { background: rgba(255,255,255,0.08); padding: 16px 20px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1); }
  .report-header .meta-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; opacity: 0.6; }
  .report-header .meta-value { font-size: 15px; font-weight: 600; margin-top: 4px; }

  /* ── Cards ── */
  .card {
    background: white; border-radius: 16px; padding: 32px; margin-bottom: 24px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
  }
  .card-title {
    font-size: 22px; font-weight: 800; margin-bottom: 24px; color: #1a1a2e;
    display: flex; align-items: center; gap: 10px;
  }
  .card-title::before {
    content: ''; width: 4px; height: 24px; background: linear-gradient(180deg, #4facfe, #00f2fe);
    border-radius: 2px;
  }

  /* ── Summary Section with Donut ── */
  .summary-grid { display: grid; grid-template-columns: 200px 1fr; gap: 40px; align-items: center; }
  @media (max-width: 768px) { .summary-grid { grid-template-columns: 1fr; } }

  .stats-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px;
  }
  .stat-box {
    text-align: center; padding: 20px 12px; border-radius: 12px; border: 2px solid;
  }
  .stat-box .stat-num { font-size: 32px; font-weight: 800; line-height: 1; }
  .stat-box .stat-label { font-size: 12px; font-weight: 600; margin-top: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-total { border-color: #e0e0e0; background: #fafafa; }
  .stat-total .stat-num { color: #333; }
  .stat-pass { border-color: #c8e6c9; background: #f1f8f4; }
  .stat-pass .stat-num { color: #2e7d32; }
  .stat-fail { border-color: #ffcdd2; background: #fdf2f4; }
  .stat-fail .stat-num { color: #c62828; }
  .stat-fixme { border-color: #fff9c4; background: #fffef5; }
  .stat-fixme .stat-num { color: #f57f17; }
  .stat-rate { border-color: #bbdefb; background: #f0f7ff; }
  .stat-rate .stat-num { color: #1565c0; }

  /* ── Pass Rate Bar ── */
  .pass-bar-container {
    background: #e0e0e0; border-radius: 8px; height: 32px; overflow: hidden; margin-top: 20px;
    display: flex;
  }
  .pass-bar-pass { background: linear-gradient(90deg, #4caf50, #66bb6a); height: 100%; transition: width 0.5s; }
  .pass-bar-fail { background: linear-gradient(90deg, #f44336, #ef5350); height: 100%; transition: width 0.5s; }
  .pass-bar-fixme { background: linear-gradient(90deg, #ff9800, #ffa726); height: 100%; transition: width 0.5s; }
  .pass-bar-label {
    font-size: 12px; font-weight: 700; color: white; display: flex; align-items: center;
    justify-content: center; height: 100%; white-space: nowrap; padding: 0 8px;
  }

  /* ── Interpretation Banner ── */
  .interpretation {
    margin-top: 24px; padding: 20px; border-radius: 12px; font-size: 15px; line-height: 1.7;
  }
  .interpretation.good { background: #f1f8f4; border-left: 4px solid #4caf50; color: #2e7d32; }
  .interpretation.moderate { background: #fff8e1; border-left: 4px solid #ff9800; color: #e65100; }
  .interpretation.poor { background: #fdf2f4; border-left: 4px solid #f44336; color: #c62828; }
  .interpretation.none { background: #f5f5f5; border-left: 4px solid #999; color: #666; }

  /* ── Pages Section ── */
  .page-item {
    border: 1px solid #e8e8e8; border-radius: 12px; padding: 24px; margin-bottom: 16px;
    transition: box-shadow 0.2s;
  }
  .page-item:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  .page-item h3 { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
  .page-url { font-size: 13px; color: #666; font-family: 'Courier New', monospace; margin-bottom: 16px; word-break: break-all; }
  .page-meta-chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  .chip {
    font-size: 12px; padding: 5px 14px; border-radius: 20px; font-weight: 600;
  }
  .chip-blue { background: #e3f2fd; color: #1565c0; }
  .chip-green { background: #e8f5e9; color: #2e7d32; }
  .chip-purple { background: #f3e5f5; color: #7b1fa2; }
  .chip-gray { background: #f5f5f5; color: #666; }

  .page-purpose { font-size: 14px; color: #555; margin-top: 12px; font-style: italic; }
  .page-behaviors { margin-top: 12px; }
  .page-behaviors li { font-size: 14px; color: #444; margin-left: 20px; margin-bottom: 4px; }

  .key-elements-table { width: 100%; margin-top: 16px; border-collapse: collapse; font-size: 13px; }
  .key-elements-table th { text-align: left; padding: 10px 14px; background: #f8f8f8; border-bottom: 2px solid #e0e0e0; font-weight: 700; color: #555; }
  .key-elements-table td { padding: 10px 14px; border-bottom: 1px solid #f0f0f0; }
  .key-elements-table tr:last-child td { border-bottom: none; }
  .key-elements-table tr:hover { background: #fafafa; }

  /* ── Coverage Matrix ── */
  .coverage-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .coverage-table th { text-align: center; padding: 12px 16px; background: #f8f8f8; border-bottom: 2px solid #e0e0e0; font-weight: 700; color: #555; }
  .coverage-table th:first-child { text-align: left; }
  .coverage-table td { padding: 12px 16px; border-bottom: 1px solid #f0f0f0; text-align: center; }
  .coverage-table td:first-child { text-align: left; }
  .coverage-cell { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 6px; font-weight: 600; font-size: 13px; }
  .coverage-cell.pass { background: #e8f5e9; color: #2e7d32; }
  .coverage-cell.fail { background: #fdf2f4; color: #c62828; }
  .coverage-cell.mixed { background: #fff8e1; color: #e65100; }
  .coverage-cell.none { background: #f5f5f5; color: #aaa; }

  /* ── Failure Analysis ── */
  .failure-category {
    border: 1px solid #e8e8e8; border-radius: 12px; padding: 20px; margin-bottom: 16px;
  }
  .failure-category-header {
    display: flex; align-items: center; gap: 12px; margin-bottom: 12px;
  }
  .failure-category-icon {
    width: 36px; height: 36px; border-radius: 8px; background: #fdf2f4; display: flex;
    align-items: center; justify-content: center; font-size: 18px;
  }
  .failure-category-title { font-size: 16px; font-weight: 700; }
  .failure-category-count {
    margin-left: auto; background: #f44336; color: white; padding: 4px 12px;
    border-radius: 20px; font-size: 13px; font-weight: 700;
  }
  .failure-category-desc { font-size: 13px; color: #888; margin-bottom: 12px; }
  .failure-list-item {
    padding: 12px 16px; background: #fafafa; border-radius: 8px; margin-bottom: 8px;
    font-size: 13px;
  }
  .failure-list-item .test-name { font-weight: 600; color: #333; }
  .failure-list-item .test-suite { font-size: 12px; color: #888; }
  .failure-list-item .test-error {
    margin-top: 8px; padding: 10px; background: #fff; border-radius: 6px;
    font-family: 'Courier New', monospace; font-size: 12px; color: #c62828;
    white-space: pre-wrap; word-break: break-word; border: 1px solid #ffcdd2;
  }

  /* ── Test Suite Sections ── */
  .suite-section {
    border: 1px solid #e8e8e8; border-radius: 12px; overflow: hidden; margin-bottom: 16px;
  }
  .suite-header {
    padding: 18px 24px; display: flex; justify-content: space-between; align-items: center;
    cursor: pointer; user-select: none; transition: background 0.2s;
  }
  .suite-header:hover { background: #f8f8f8; }
  .suite-header.passed { background: #f1f8f4; border-left: 4px solid #4caf50; }
  .suite-header.failed { background: #fdf2f4; border-left: 4px solid #f44336; }
  .suite-header.mixed { background: #fff8e1; border-left: 4px solid #ff9800; }
  .suite-header h3 { font-size: 17px; font-weight: 700; }
  .suite-header .suite-stats { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 12px; }
  .suite-body { padding: 0; }
  .suite-body.collapsed { display: none; }

  .test-row {
    padding: 16px 24px; border-bottom: 1px solid #f0f0f0; display: flex; align-items: flex-start; gap: 14px;
  }
  .test-row:last-child { border-bottom: none; }
  .test-row:hover { background: #fafafa; }
  .test-icon {
    width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; font-size: 15px; font-weight: 700; flex-shrink: 0; margin-top: 2px;
  }
  .test-icon.pass { background: #4caf50; color: white; }
  .test-icon.fail { background: #f44336; color: white; }
  .test-icon.skip { background: #ff9800; color: white; }
  .test-info { flex: 1; }
  .test-name { font-weight: 600; font-size: 15px; }
  .test-meta { font-size: 12px; color: #888; margin-top: 2px; }
  .test-error {
    margin-top: 10px; padding: 14px; background: #fdf2f4; border-radius: 8px;
    font-family: 'Courier New', monospace; font-size: 12px; color: #c62828;
    white-space: pre-wrap; word-break: break-word; border: 1px solid #ffcdd2;
  }
  .test-screenshot { margin-top: 12px; }
  .test-screenshot img { max-width: 100%; border-radius: 8px; border: 1px solid #e0e0e0; transition: max-height 0.3s; }
  .test-screenshot img.expanded { max-height: none !important; cursor: zoom-out; }
  .test-steps { margin-top: 10px; }
  .test-step {
    font-size: 13px; color: #555; padding: 6px 0; padding-left: 20px;
    border-left: 2px solid #e0e0e0; margin-left: 4px;
  }
  .test-step strong { color: #333; }
  .test-step .step-dep { font-size: 11px; color: #999; font-style: italic; }

  /* ── Test Code ── */
  .code-block {
    background: #1e1e2e; color: #cdd6f4; padding: 20px; border-radius: 10px;
    font-family: 'Fira Code', 'Courier New', monospace; font-size: 12px; overflow-x: auto;
    white-space: pre; margin-top: 12px; max-height: 500px; overflow-y: auto;
    line-height: 1.5;
  }

  /* ── Filter Buttons ── */
  .filter-bar { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
  .filter-btn {
    padding: 8px 18px; border-radius: 8px; border: 2px solid #e0e0e0; background: white;
    font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s;
  }
  .filter-btn:hover { border-color: #4facfe; }
  .filter-btn.active { background: #1a1a2e; color: white; border-color: #1a1a2e; }

  /* ── Footer ── */
  .report-footer {
    text-align: center; padding: 32px; color: #888; font-size: 13px; margin-top: 24px;
  }
  .report-footer .footer-brand { font-size: 16px; font-weight: 700; color: #555; margin-bottom: 8px; }

  /* ── Print ── */
  @media print {
    body { background: white; }
    .container { max-width: none; padding: 0; }
    .card { box-shadow: none; border: 1px solid #ddd; page-break-inside: avoid; }
    .suite-body.collapsed { display: block !important; }
    .report-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .filter-bar { display: none; }
    .test-row:hover { background: none; }
  }

  /* ── Toggle ── */
  .toggle-icon { font-size: 18px; transition: transform 0.2s; color: #888; }
  .toggle-icon.collapsed { transform: rotate(-90deg); }

  /* ── Responsive ── */
  @media (max-width: 768px) {
    .container { padding: 12px; }
    .card { padding: 20px; }
    .report-header { padding: 32px 24px; }
    .report-header h1 { font-size: 24px; }
    .summary-grid { grid-template-columns: 1fr; text-align: center; }
  }
</style>
</head>
<body>
<div class="container">

  <!-- ════════════════ HEADER ════════════════ -->
  <div class="report-header">
    <div class="brand">
      <div class="brand-icon">A</div>
      <div class="brand-text">AutoTest Agent</div>
    </div>
    <h1>Automated Test Report</h1>
    <div class="subtitle">Autonomous E2E Test Generation & Execution</div>
    <div class="meta-grid">
      <div class="meta-item">
        <div class="meta-label">Target Application</div>
        <div class="meta-value">${escapeHtml(targetUrl)}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Report Generated</div>
        <div class="meta-value">${formatDate(generatedDate)}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Run Started</div>
        <div class="meta-value">${formatDate(createdAt)}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Run ID</div>
        <div class="meta-value" style="font-size: 12px; font-family: monospace;">${escapeHtml(runId)}</div>
      </div>
    </div>
    ${description ? `<div style="margin-top: 20px; background: rgba(255,255,255,0.08); padding: 16px 20px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1);"><div class="meta-label">Run Description</div><div class="meta-value" style="font-size: 15px; margin-top: 4px;">${escapeHtml(description)}</div></div>` : ''}
  </div>

  <!-- ════════════════ EXECUTIVE SUMMARY ════════════════ -->
  <div class="card">
    <div class="card-title">Executive Summary</div>

    <div class="summary-grid">
      <div>
        ${generateDonutChart(passed, failed, fixme, totalTests)}
        <div style="text-align:center; margin-top: 12px;">
          <div style="font-size: 36px; font-weight: 800; color: ${passRate >= 80 ? '#2e7d32' : passRate >= 50 ? '#e65100' : '#c62828'};">${passRate}%</div>
          <div style="font-size: 13px; color: #888; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Pass Rate</div>
        </div>
      </div>

      <div>
        <div class="stats-grid">
          <div class="stat-box stat-total">
            <div class="stat-num">${totalTests}</div>
            <div class="stat-label">Total Tests</div>
          </div>
          <div class="stat-box stat-pass">
            <div class="stat-num">${passed}</div>
            <div class="stat-label">Passed</div>
            ${flakyCount > 0 ? `<div style="font-size: 11px; color: #e65100; font-weight: 600; margin-top: 4px;">${flakyCount} flaky (passed on retry)</div>` : ''}
          </div>
          <div class="stat-box stat-fail">
            <div class="stat-num">${failed}</div>
            <div class="stat-label">Failed</div>
          </div>
          <div class="stat-box stat-fixme">
            <div class="stat-num">${fixme}</div>
            <div class="stat-label">For Review</div>
          </div>
          ${flakyCount > 0 ? `
          <div class="stat-box" style="border-color: #ffe0b2; background: #fff8e1;">
            <div class="stat-num" style="color: #e65100;">${flakyCount}</div>
            <div class="stat-label">Flaky (of ${passed} passed)</div>
          </div>` : ''}
        </div>

        ${totalTests > 0 ? `
        <div style="margin-top: 20px;">
          <div style="font-size: 13px; font-weight: 600; color: #666; margin-bottom: 8px;">Result Distribution</div>
          <div class="pass-bar-container">
            ${passed > 0 ? `<div class="pass-bar-pass" style="width: ${(passed/totalTests)*100}%;"><div class="pass-bar-label">${Math.round((passed/totalTests)*100)}% Passed</div></div>` : ''}
            ${failed > 0 ? `<div class="pass-bar-fail" style="width: ${(failed/totalTests)*100}%;"><div class="pass-bar-label">${Math.round((failed/totalTests)*100)}% Failed</div></div>` : ''}
            ${fixme > 0 ? `<div class="pass-bar-fixme" style="width: ${(fixme/totalTests)*100}%;"><div class="pass-bar-label">${Math.round((fixme/totalTests)*100)}% Review</div></div>` : ''}
          </div>
        </div>` : ''}
      </div>
    </div>

    <div class="interpretation ${totalTests === 0 ? 'none' : passRate >= 80 ? 'good' : passRate >= 50 ? 'moderate' : 'poor'}">
      ${totalTests === 0
        ? '<strong>No tests were executed.</strong> This may indicate an issue with test generation or execution setup. Please check the server logs for errors.'
        : passRate >= 80
          ? `<strong>Application is in good health.</strong> ${passed} out of ${totalTests} tests passed, indicating that the core user flows are functioning as expected. The application is ready for release consideration.`
          : passRate >= 50
            ? `<strong>Application has moderate issues.</strong> ${failed} out of ${totalTests} tests failed, suggesting some user flows may need attention before release. Review the failure analysis section for details.`
            : `<strong>Application has significant issues.</strong> ${failed} out of ${totalTests} tests failed, indicating that critical user flows are not working as expected. Immediate attention is required.`
      }
      ${fixme > 0 ? ` ${fixme} test(s) were marked for manual review — these could not be automatically verified and require human judgment.` : ''}
      ${flakyCount > 0 ? ` ${flakyCount} of ${passed} passed test(s) were flaky — they failed on an initial attempt but passed on retry. These indicate test or application instability and should be investigated.` : ''}
    </div>
  </div>

  <!-- ════════════════ COVERAGE MATRIX ════════════════ -->
  ${pages.length > 0 ? `
  <div class="card">
    <div class="card-title">Test Coverage Matrix</div>
    <p style="font-size: 14px; color: #666; margin-bottom: 20px;">
      Coverage of test suites across discovered pages. Green = all passed, Red = all failed, Orange = mixed results, Gray = not tested.
    </p>
    <table class="coverage-table">
      <thead>
        <tr>
          <th>Page</th>
          ${suiteTypes.map(s => `<th>${s}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${coverageMatrix.map(row => `
          <tr>
            <td>
              <div style="font-weight: 600;">${escapeHtml(row.page.title)}</div>
              <div style="font-size: 12px; color: #888; font-family: monospace;">${escapeHtml(row.page.path)}</div>
            </td>
            ${suiteTypes.map(suite => {
              const cell = row.suites[suite];
              if (!cell.hasData) return '<td><span class="coverage-cell none">—</span></td>';
              const cls = cell.failed === 0 ? 'pass' : cell.passed === 0 ? 'fail' : 'mixed';
              const label = cell.passed > 0 || cell.failed > 0 ? `${cell.passed}/${cell.total}` : `${cell.total} planned`;
              return `<td><span class="coverage-cell ${cls}">${label}</span></td>`;
            }).join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>` : ''}

  <!-- ════════════════ FAILURE ANALYSIS ════════════════ -->
  ${allFailures.length > 0 ? `
  <div class="card">
    <div class="card-title">Failure Analysis</div>
    <p style="font-size: 14px; color: #666; margin-bottom: 20px;">
      ${allFailures.length} test failure(s) categorized by root cause. This analysis helps prioritize fixes.
    </p>

    ${Object.entries(failureCategories).map(([category, info]) => `
      <div class="failure-category">
        <div class="failure-category-header">
          <div class="failure-category-icon">${info.icon}</div>
          <div class="failure-category-title">${escapeHtml(category)}</div>
          <div class="failure-category-count">${info.count}</div>
        </div>
        <div class="failure-category-desc">${escapeHtml(info.description)}</div>
        ${info.failures.map(f => `
          <div class="failure-list-item">
            <div class="test-name">${escapeHtml(f.testName)}</div>
            <div class="test-suite">${escapeHtml(f.suite)} · ${escapeHtml(f.page)} · ${formatDuration(f.duration)}</div>
            ${f.error ? `<div class="test-error">${escapeHtml(f.error)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `).join('')}
  </div>` : ''}

  <!-- ════════════════ PAGES TESTED ════════════════ -->
  <div class="card">
    <div class="card-title">Screens & Pages Tested</div>
    <p style="font-size: 14px; color: #666; margin-bottom: 20px;">
      The following ${pages.length} screen(s) were automatically discovered and analyzed by the test agent.
    </p>

    ${pages.map((page, i) => {
      const pm = data.pageModels[i] || {};
      const snap = data.snapshots[i] || {};
      const keyElements = pm.keyElements || snap.interactiveElements || [];
      const behaviors = pm.behaviors || [];

      return `
      <div class="page-item">
        <h3>${escapeHtml(page.title)}</h3>
        <div class="page-url">${escapeHtml(page.url)}</div>
        <div class="page-meta-chips">
          <span class="chip chip-blue">${page.interactiveCount} Interactive Elements</span>
          <span class="chip chip-green">${page.linkCount} Links</span>
          <span class="chip chip-purple">${page.formCount} Forms</span>
          ${pm.siteType ? `<span class="chip chip-gray">${escapeHtml(pm.siteType)}</span>` : ''}
        </div>
        ${pm.purpose ? `<div class="page-purpose">${escapeHtml(pm.purpose)}</div>` : ''}

        ${keyElements.length > 0 ? `
        <table class="key-elements-table">
          <thead>
            <tr><th>Element Type</th><th>Name</th><th>Significance</th></tr>
          </thead>
          <tbody>
            ${keyElements.slice(0, 15).map(e => `
              <tr>
                <td><span class="chip chip-blue">${escapeHtml(e.role || 'N/A')}</span></td>
                <td>${escapeHtml(e.name || '')}</td>
                <td style="color: #666;">${escapeHtml(e.significance || e.description || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>` : ''}

        ${behaviors.length > 0 ? `
        <div class="page-behaviors">
          <div style="font-size: 13px; font-weight: 600; color: #555; margin-bottom: 6px;">Observed Behaviors:</div>
          <ul>
            ${behaviors.map(b => `<li>${escapeHtml(typeof b === 'string' ? b : (b.result || b.action || JSON.stringify(b)))}</li>`).join('')}
          </ul>
        </div>` : ''}

        ${pm.forms && pm.forms.length > 0 ? `
        <div style="margin-top: 16px;">
          <div style="font-size: 13px; font-weight: 600; color: #555; margin-bottom: 8px;">Forms Detected:</div>
          ${pm.forms.map((form, fi) => `
            <div style="padding: 12px; background: #f8f9fa; border-radius: 8px; margin-bottom: 8px;">
              <div style="font-weight: 600; font-size: 14px;">Form ${fi + 1}: ${escapeHtml(form.purpose || 'Unknown')}</div>
              ${form.isCascading ? '<div style="font-size: 12px; color: #e65100; margin-top: 4px;">⚠ Cascading dropdowns detected</div>' : ''}
              ${form.cascadingDescription ? `<div style="font-size: 12px; color: #888; margin-top: 4px;">${escapeHtml(form.cascadingDescription)}</div>` : ''}
              ${form.fields && form.fields.length > 0 ? `
                <div style="margin-top: 8px; font-size: 12px; color: #555;">
                  ${form.fields.map(fld => `• [${escapeHtml(fld.role || 'field')}] '${escapeHtml(fld.name || '')}'${fld.required ? ' (required)' : ''}${fld.dependsOn ? ` → depends on '${escapeHtml(fld.dependsOn)}'` : ''}`).join('<br>')}
                </div>` : ''}
            </div>
          `).join('')}
        </div>` : ''}
      </div>`;
    }).join('')}
  </div>

  <!-- ════════════════ TEST SUITES ════════════════ -->
  <div class="card">
    <div class="card-title">Test Suite Details</div>

    <div class="filter-bar">
      <button class="filter-btn active" onclick="filterTests('all', this)">All Tests</button>
      <button class="filter-btn" onclick="filterTests('pass', this)">Passed Only</button>
      <button class="filter-btn" onclick="filterTests('fail', this)">Failed Only</button>
      <button class="filter-btn" onclick="filterTests('skip', this)">For Review</button>
      <button class="filter-btn" onclick="expandAll()">Expand All</button>
      <button class="filter-btn" onclick="collapseAll()">Collapse All</button>
    </div>

    ${planDetails.map(({ plan, tests, specCode, matchingPlan, snapshot, pageModel, report }) => {
      const suitePassed = tests.filter(t => t.status === 'expected' || t.status === 'flaky').length;
      const suiteFailed = tests.filter(t => t.status === 'unexpected').length;
      const suiteSkipped = tests.filter(t => t.status === 'skipped').length;
      const suiteFlaky = tests.filter(t => t.flaky).length;
      const suiteTotal = tests.length || plan.tests || 0;
      const hasResults = tests.length > 0;
      const headerClass = suiteFailed > 0 ? 'failed' : suitePassed > 0 ? 'passed' : 'mixed';
      const stats = report?.stats || {};
      const duration = stats.duration || 0;

      return `
      <div class="suite-section">
        <div class="suite-header ${headerClass}" onclick="this.nextElementSibling.classList.toggle('collapsed'); this.querySelector('.toggle-icon').classList.toggle('collapsed')">
          <div>
            <h3>${escapeHtml(plan.suite || 'Unknown Suite')}</h3>
            <div style="font-size: 12px; color: #888; margin-top: 2px;">${escapeHtml(plan.page || '')}</div>
          </div>
          <div class="suite-stats">
            ${hasResults
              ? `<span style="color: #2e7d32;">${suitePassed} passed</span>${suiteFlaky > 0 ? ` <span style="color: #e65100;">(${suiteFlaky} flaky)</span>` : ''} · <span style="color: #c62828;">${suiteFailed} failed</span>${suiteSkipped > 0 ? ` · <span style="color: #f57f17;">${suiteSkipped} review</span>` : ''} · ${formatDuration(duration)}`
              : `<span style="color: #888;">${plan.tests || 0} tests planned</span>`
            }
            ${generateSuiteBar(suitePassed, suiteFailed, suiteSkipped, suiteTotal).replace('margin-top:6px;', '')}
            <span class="toggle-icon">▼</span>
          </div>
        </div>
        <div class="suite-body collapsed">

          ${hasResults ? tests.map(t => {
            const isPass = t.status === 'expected' || t.status === 'flaky';
            const iconClass = isPass ? 'pass' : t.status === 'unexpected' ? 'fail' : 'skip';
            const iconText = isPass ? '✓' : t.status === 'unexpected' ? '✗' : '⚠';
            const statusLabel =
              t.status === 'flaky' ? 'Passed (Flaky)'
              : t.status === 'expected' ? 'Passed'
              : t.status === 'unexpected' ? 'Failed'
              : 'Skipped';
            const cat = t.status === 'unexpected' ? categorizeFailure(t.error) : null;

            const planTest = matchingPlan?.tests?.find(pt => pt.name === t.name);

            // Load screenshot as base64 data URI for embedding
            const screenshotURI = t.screenshot ? loadScreenshotAsDataURI(t.screenshot) : null;

            return `
            <div class="test-row" data-status="${iconClass}">
              <div class="test-icon ${iconClass}">${iconText}</div>
              <div class="test-info">
                <div class="test-name">${escapeHtml(t.name)}</div>
                <div class="test-meta">
                  ${statusLabel} · ${formatDuration(t.duration)}
                  ${t.retry > 0 ? ` · retry #${t.retry}` : ''}
                  ${t.flaky ? ' · <span style="color: #ff9800; font-weight: 700;">⚠ FLAKY</span>' : ''}
                  ${cat ? ` · ${cat.icon} ${cat.category}` : ''}
                </div>

                ${planTest?.steps ? `
                <div class="test-steps">
                  ${planTest.steps.map((step, sidx) => `
                    <div class="test-step">
                      <strong>${escapeHtml(step.action)}</strong>
                      ${step.target ? `on <strong>${escapeHtml(step.target.role)}</strong> "${escapeHtml(step.target.name)}"` : ''}
                      ${step.value ? `with value "${escapeHtml(step.value)}"` : ''}
                      ${step.expectedOutcome ? `<br><span style="color: #888;">Expected: ${escapeHtml(step.expectedOutcome)}</span>` : ''}
                      ${step.dependsOn != null ? `<div class="step-dep">depends on step ${step.dependsOn}</div>` : ''}
                    </div>
                  `).join('')}
                </div>` : ''}

                ${t.error ? `<div class="test-error">${escapeHtml(t.error)}</div>` : ''}

                ${screenshotURI ? `
                <div class="test-screenshot">
                  <div style="font-size: 13px; font-weight: 600; color: #555; margin-bottom: 8px;">Failure Screenshot:</div>
                  <img src="${screenshotURI}" alt="Failure screenshot for ${escapeHtml(t.name)}"
                    style="max-width: 100%; border-radius: 8px; border: 1px solid #e0e0e0; cursor: pointer;"
                    onclick="this.classList.toggle('expanded')"
                    onload="if(this.naturalWidth > 800) this.style.maxHeight='300px'" />
                </div>` : ''}
              </div>
            </div>`;
          }).join('') : `
            <div style="padding: 20px 24px; color: #888; font-size: 14px;">
              Tests were planned but execution results are not available.
              ${matchingPlan ? `<div style="margin-top: 12px;"><strong>Planned tests:</strong></div>
              <ul style="margin-left: 20px; margin-top: 8px;">
                ${(matchingPlan.tests || []).map(t => `<li style="margin-bottom: 4px;">${escapeHtml(t.name)}</li>`).join('')}
              </ul>` : ''}
            </div>
          `}

          ${specCode ? `
          <div style="padding: 20px 24px; border-top: 1px solid #f0f0f0;">
            <div style="font-size: 13px; font-weight: 600; color: #555; margin-bottom: 8px;">Generated Test Code:</div>
            <div class="code-block">${escapeHtml(specCode)}</div>
          </div>` : ''}

        </div>
      </div>`;
    }).join('')}
  </div>

  <!-- ════════════════ COVERAGE SUMMARY TABLE ════════════════ -->
  <div class="card">
    <div class="card-title">Test Results Summary</div>
    <table class="key-elements-table" style="font-size: 14px;">
      <thead>
        <tr>
          <th>Suite Category</th>
          <th>Page</th>
          <th>Tests Run</th>
          <th>Passed</th>
          <th>Flaky</th>
          <th>Failed</th>
          <th>For Review</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        ${(results.plans || []).map(p => {
          const report = data.testResults[p.planId];
          const stats = report?.stats || {};
          const tests = report ? flattenTests(report) : [];
          const tPassed = tests.filter(t => t.status === 'expected' || t.status === 'flaky').length;
          const tFlaky = tests.filter(t => t.flaky).length;
          const tFailed = tests.filter(t => t.status === 'unexpected').length;
          const tSkipped = tests.filter(t => t.status === 'skipped').length;
          return `
          <tr>
            <td><strong>${escapeHtml(p.suite)}</strong></td>
            <td style="font-size: 12px; color: #666;">${escapeHtml(p.page)}</td>
            <td>${tests.length || p.tests || 0}</td>
            <td style="color: #2e7d32; font-weight: 600;">${tests.length > 0 ? tPassed : p.passed || 0}</td>
            <td style="color: #e65100; font-weight: 600;">${tFlaky > 0 ? tFlaky : ''}</td>
            <td style="color: #c62828; font-weight: 600;">${tests.length > 0 ? tFailed : p.failed || 0}</td>
            <td style="color: #f57f17;">${p.fixme || 0}</td>
            <td style="font-size: 12px; color: #888;">${formatDuration(stats.duration)}</td>
          </tr>`;
        }).join('')}
        <tr style="border-top: 2px solid #e0e0e0; font-weight: 700; background: #f8f8f8;">
          <td colspan="2">TOTAL</td>
          <td>${totalTests}</td>
          <td style="color: #2e7d32;">${passed}</td>
          <td style="color: #e65100;">${flakyCount}</td>
          <td style="color: #c62828;">${failed}</td>
          <td style="color: #f57f17;">${fixme}</td>
          <td></td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- ════════════════ METHODOLOGY ════════════════ -->
  <div class="card">
    <div class="card-title">Testing Methodology</div>
    <div style="font-size: 14px; color: #444; line-height: 1.8;">
      <p style="margin-bottom: 14px;">
        <strong>1. Site Exploration:</strong> The AutoTest Agent crawled the target application using a
        headless browser, discovering pages, navigation links, forms, and interactive elements.
        An accessibility snapshot was captured for each page to identify all user-facing components.
      </p>
      <p style="margin-bottom: 14px;">
        <strong>2. Page Analysis:</strong> Each page was analyzed using AI to determine its purpose,
        type (e.g., e-commerce, dashboard, landing page), key elements, form field relationships,
        and observable user behaviors. This semantic understanding drives the quality and relevance
        of generated tests.
      </p>
      <p style="margin-bottom: 14px;">
        <strong>3. Test Planning:</strong> Test scenarios were designed across four categories:
        <em>Navigation</em> (link and routing tests), <em>Functional</em> (core feature tests),
        <em>Forms</em> (input validation, cascading dropdowns, and submission), and
        <em>Accessibility</em> (WCAG compliance checks). Form field dependencies were modeled
        to ensure correct interaction ordering in cascading forms.
      </p>
      <p style="margin-bottom: 14px;">
        <strong>4. Test Generation:</strong> Playwright test scripts were generated in TypeScript,
        using both record-and-ground (browser observation) and LLM generation in parallel.
        Generated code includes duplicate element disambiguation, cookie banner dismissal,
        and dynamic content wait strategies.
      </p>
      <p style="margin-bottom: 14px;">
        <strong>5. Test Execution:</strong> Generated tests were executed against the live application
        using the Playwright test runner. Results were captured including pass/fail status, error
        messages, failure categorization, and execution duration.
      </p>
      <p>
        <strong>6. Self-Healing:</strong> ${enableHealing
          ? 'Failing tests were sent back to the AI for repair — the agent analyzed failures, classified them as bad test plans or bad code, and attempted to fix them. Tests that could not be fixed after multiple attempts were marked for manual review.'
          : 'Healing was disabled for this run. All failing tests were marked for manual review without AI repair attempts.'}
      </p>
    </div>
  </div>

  <!-- ════════════════ FOOTER ════════════════ -->
  <div class="report-footer">
    <div class="footer-brand">AutoTest Agent</div>
    <p>Generated on ${formatDate(generatedDate)}</p>
    <p style="margin-top: 4px; font-size: 11px; color: #aaa;">Run ID: ${escapeHtml(runId)} · Autonomous E2E Test Generation & Execution</p>
  </div>

</div>

<script>
  // Filter tests by status
  function filterTests(status, btn) {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    document.querySelectorAll('.test-row').forEach(row => {
      if (status === 'all') {
        row.style.display = '';
      } else {
        row.style.display = row.dataset.status === status ? '' : 'none';
      }
    });

    // Show all suite bodies when filtering
    if (status !== 'all') {
      document.querySelectorAll('.suite-body').forEach(el => el.classList.remove('collapsed'));
      document.querySelectorAll('.toggle-icon').forEach(el => el.classList.remove('collapsed'));
    }
  }

  function expandAll() {
    document.querySelectorAll('.suite-body').forEach(el => el.classList.remove('collapsed'));
    document.querySelectorAll('.toggle-icon').forEach(el => el.classList.remove('collapsed'));
  }

  function collapseAll() {
    document.querySelectorAll('.suite-body').forEach(el => el.classList.add('collapsed'));
    document.querySelectorAll('.toggle-icon').forEach(el => el.classList.add('collapsed'));
  }

  // Auto-expand for print
  window.addEventListener('beforeprint', expandAll);
</script>
</body>
</html>`;

  return html;
}

module.exports = { generateReport, loadRunData, flattenTests };
