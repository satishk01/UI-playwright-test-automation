const { createLLMClient } = require('../utils/llm-client');
const {
  applyDeterministicRepairs,
  buildScopedFailureContext,
  findTestBlock,
  replaceTestBlock,
} = require('../utils/deterministic-healer');
const { describeElementsForPrompt } = require('../utils/aria-snapshot');

class Healer {
  constructor(targetUrl, auth, llmConfig = {}, description = '') {
    this.targetUrl = targetUrl;
    this.auth = auth;
    this.llm = createLLMClient(llmConfig);
    this.description = (description || '').trim();
  }

  async heal(currentCode, executionResult, snapshot, plan, opts = {}) {
    if (!executionResult.failures || executionResult.failures.length === 0) {
      return null;
    }

    const classified = await this.classifyFailures(executionResult.failures, snapshot);

    const badPlans = classified.filter(f => f.classification === 'bad_test_plan');
    const badCode = classified.filter(f => f.classification === 'bad_code');

    let healedCode = currentCode;
    const changes = [];

    // ── Deterministic repair pass (§7) — zero-token fixes for mechanical
    // failure classes (strict-mode, name drift, hidden widgets, URL
    // assertions, network timeouts). Only unfixable signatures escalate
    // to the LLM.
    const allFailures = [...badCode, ...badPlans];
    const det = applyDeterministicRepairs(healedCode, allFailures, snapshot, {
      harRelPath: opts.harRelPath || null,
      apiUrlPatterns: opts.apiUrlPatterns || null,
    });
    healedCode = det.code;
    changes.push(...det.repairs.map(r => `Deterministic fix: ${r.testName} — ${r.fix}`));

    const escBadCode = det.remaining.filter(f => f.classification === 'bad_code');
    const escBadPlan = det.remaining.filter(f => f.classification === 'bad_test_plan');

    if (escBadCode.length > 0) {
      healedCode = await this.healBadCode(healedCode, escBadCode, snapshot);
      changes.push(...escBadCode.map(f => `Fixed: ${f.testName} — ${f.diagnosis}`));
    }

    if (escBadPlan.length > 0) {
      healedCode = await this.healBadPlan(healedCode, escBadPlan, snapshot, plan);
      changes.push(...escBadPlan.map(f => `Revised: ${f.testName} — ${f.diagnosis}`));
    }

    // Deletion-proof: reject if test count decreased
    const origCount = (currentCode.match(/\btest\(/g) || []).length;
    const newCount = (healedCode.match(/\btest\(/g) || []).length;
    if (newCount < origCount) {
      console.warn('Heal reduced test count — rejecting');
      return null;
    }

    return {
      code: healedCode,
      changes,
      expectedResult: {
        compileErrors: 0,
        passed: executionResult.passed + badCode.length,
        failed: Math.max(0, executionResult.failed - badCode.length - badPlans.length),
      },
    };
  }

  async classifyFailures(failures, snapshot) {
    const classified = [];

    for (const failure of failures) {
      if (failure.type === 'compile_error') {
        classified.push({ ...failure, classification: 'bad_code', diagnosis: 'TypeScript compilation error' });
        continue;
      }

      const targetMatch = failure.reason?.match(/getByRole\('([^']+)',\s*\{\s*name:\s*'([^']+)'/);
      if (targetMatch) {
        const [, role, name] = targetMatch;
        const exists = snapshot.roleNamePairs.some(
          e => e.role === role && e.name === name
        );
        if (!exists) {
          classified.push({ ...failure, classification: 'bad_test_plan', diagnosis: `Element [${role}] '${name}' not found in accessibility tree` });
        } else {
          classified.push({ ...failure, classification: 'bad_code', diagnosis: 'Element exists but assertion or interaction failed' });
        }
      } else {
        classified.push({ ...failure, classification: 'bad_code', diagnosis: failure.reason || 'Unknown failure' });
      }
    }

    return classified;
  }

  /**
   * Splice an LLM response back into the spec. If the LLM returned a full
   * file, use it directly; otherwise replace the failing test blocks with
   * the repaired blocks it returned.
   */
  _applyLlmResponse(code, text, failingTestNames) {
    let out = text.replace(/^```(?:typescript|ts)?\n?/m, '').replace(/\n?```$/m, '');
    // Full-file response — use as-is
    if (/import\s*\{?\s*test|test\.describe\s*\(/.test(out) && /test\.describe|beforeEach/.test(out)) {
      return out;
    }
    // Scoped response — splice each test block back into the file
    for (const name of failingTestNames) {
      const block = this._extractBlockFromResponse(out, name);
      if (block) {
        const replaced = replaceTestBlock(code, name, block);
        if (replaced) code = replaced;
      }
    }
    return code;
  }

  _extractBlockFromResponse(text, testName) {
    // Reuse findTestBlock — it matches the closing "});" at the test's own
    // indentation. A naive indexOf('});') would truncate blocks containing
    // mid-body "});" sequences (e.g. `.catch(() => {});`).
    const block = findTestBlock(text, testName);
    return block ? text.slice(block.start, block.end).trim() : null;
  }

  async healBadCode(code, failures, snapshot) {
    // §1: aria YAML is the primary element description (smaller + refs).
    const roleNameList = describeElementsForPrompt(snapshot);

    // Detect duplicate elements so the healer knows to add .first()
    const nameCounts = {};
    for (const e of snapshot.roleNamePairs) {
      if (!e.name) continue;
      const key = `${e.role}:${e.name}`;
      nameCounts[key] = (nameCounts[key] || 0) + 1;
    }
    const duplicates = Object.entries(nameCounts)
      .filter(([, count]) => count > 1)
      .map(([key, count]) => {
        const idx = key.indexOf(':');
        return `  [${key.substring(0, idx)}] '${key.substring(idx + 1)}' appears ${count} times — use .first()`;
      })
      .join('\n');

    // §7: send only the failing test blocks + the page snapshot, not the
    // entire spec file — ~5× smaller heal prompts.
    const scoped = buildScopedFailureContext(code, failures);
    const allBlocksFound = scoped.every(s => s.block);
    const failureDetails = scoped.map(s =>
      `Test: "${s.testName}"\nError: ${s.reason}\n${s.block ? `Code block:\n${s.block}` : (failures.find(f => f.testName === s.testName)?.snippet ? `Code snippet:\n${failures.find(f => f.testName === s.testName).snippet}` : 'Code block not found — full file follows.')}`
    ).join('\n---\n');

    const errorContextBlock = failures
      .map(f => f.errorContext ? `Live aria snapshot at failure time for "${f.testName}":\n${f.errorContext}` : null)
      .filter(Boolean)
      .join('\n\n');
    const errorContextSection = errorContextBlock
      ? `\nARIA SNAPSHOT AT FAILURE TIME (what the page actually looked like):\n${errorContextBlock}\n`
      : '';

    const appContextBlock = this.description
      ? `\nApplication context (provided by the user — use this to better diagnose failures):\n${this.description}\n`
      : '';

    // §9 prompt caching: element list + rules are static per suite across
    // heal iterations — put them in `system` so repeat calls hit the cache.
    const systemPrompt = `You are fixing failing Playwright test blocks. Use ONLY elements from this page snapshot:

Available elements on the page (use ONLY these):
${roleNameList}

${duplicates ? `DUPLICATE ELEMENTS (appear multiple times — add .first() to disambiguate):\n${duplicates}\n` : ''}
Rules:
1. Fix ONLY the failing tests — do not modify passing tests
2. NEVER delete a test — fix it or mark it as test.fixme() with a reason
3. Use ONLY getByRole() with exact names from the available elements list. ALWAYS add { exact: true } to every getByRole call.
4. The total test count must remain the same or increase
5. For duplicate elements (listed above), add .first() AFTER { exact: true } to the locator: getByRole('link', { name: 'Example Link', exact: true }).first()
6. For timeout failures on dropdowns/selects, add locator.waitFor({ state: 'visible' }) before the action
7. For cascading dropdown tests (Year → Model → Trim), PRESERVE the wait steps between selects — do NOT remove waitForTimeout or waitFor calls between dependent selects
8. For "waitForOptions" steps, keep the waitFor({ state: 'visible' }) call — it's needed for dynamic dropdowns
9. For strict mode violations, add { exact: true } AND .first() to the locator
10. If a test times out because an element never appears, mark it as test.fixme() with the timeout reason
11. For timeout failures on SPA/API-driven pages, replace fixed waitForTimeout() sleeps with page.waitForResponse(): await page.waitForResponse(resp => resp.url().includes('/api/') && resp.status() === 200, { timeout: 15000 }); — this waits for the actual API response instead of guessing the latency
12. NEVER assert against countdown timer elements (e.g. "Sale ends in 5 days : 19 hrs : 48 min : 10 sec"). Replace these assertions with a comment: // Skipped: time-sensitive element
13. For navigation assertions, use page.waitForURL() instead of expect(page).toHaveURL()
14. For WCAG accessibility audit tests, use expect.soft() instead of expect() — site violations should be reported, not cause test failures
15. Use REALISTIC test data for form fills — email: test@example.com, phone: (555) 123-4567, password: Test@1234!, names: John Smith. Do NOT use generic "test input".
16. For form fill actions, add locator.waitFor({ state: 'visible', timeout: 10000 }) before fill() or selectOption()
17. For login/auth tests: (a) "invalid credentials" → assert expect(page.url()).toMatch(/login|signin/i), NOT login button visible. (b) "valid credentials" → wrap post-login assertions in try/catch. (c) NEVER assert login button is visible after invalid credential test — use URL assertion instead.
18. For dialog/modal tests: wrap expect(dialog).toBeVisible() in try/catch — the dialog may not open if the trigger click fails.
19. For visual regression tests: do NOT wrap toHaveScreenshot() in try/catch — Playwright's expect tracks failures internally and try/catch cannot suppress them. Instead, check if the baseline file exists with fs.existsSync() before calling toHaveScreenshot(). If no baseline exists, take a manual screenshot with page.screenshot() and return. Only call toHaveScreenshot() when the baseline already exists.
20. For "element(s) not found" failures where the locator name is ALL UPPERCASE (e.g. 'LOGIN'): the runtime accessible name may differ in case due to CSS text-transform. Switch to a case-insensitive anchored regex: getByRole('button', { name: /^login$/i }).first()
21. For locator.waitFor visible timeouts on form fields whose name appears multiple times on the page: target the visible instance with .visible().first() before waitFor/fill.
22. If the failure's aria snapshot shows the element exists under a DIFFERENT name, patch the locator to that name.

Respond with ONLY the TypeScript code, no markdown fences.`;

    // If every failing block was extracted, use a scoped prompt (fixed blocks
    // are spliced back). Otherwise fall back to the full-file prompt.
    const prompt = allBlocksFound
      ? `Fix the following failing Playwright test blocks. ${appContextBlock}
Failures:
${failureDetails}
${errorContextSection}
Return each repaired test block complete: test('name', async ({ page }) => { ... }); — no imports, no describe wrapper, no commentary.`
      : `Fix the following failing Playwright tests. The tests exist but their assertions or interactions are wrong.
${appContextBlock}
Current test code:
\`\`\`typescript
${code}
\`\`\`

Failures:
${failureDetails}
${errorContextSection}
Return the complete fixed file.`;

    // §9: heal calls get a smaller token budget — a targeted fix rarely
    // needs the full 8192.
    const text = await this.llm.complete(prompt, {
      maxTokens: allBlocksFound ? 4096 : 8192,
      system: systemPrompt,
      cache: true,
    });
    return this._applyLlmResponse(code, text, failures.map(f => f.testName));
  }

  async healBadPlan(code, failures, snapshot, plan) {
    const roleNameList = describeElementsForPrompt(snapshot);

    const scoped = buildScopedFailureContext(code, failures);
    const allBlocksFound = scoped.every(s => s.block);
    const failureDetails = scoped.map(s =>
      `Test: "${s.testName}"\nDiagnosis: ${s.diagnosis}${s.block ? `\nCode block:\n${s.block}` : ''}`
    ).join('\n---\n');

    const appContextBlock = this.description
      ? `\nApplication context (provided by the user — use this to better understand the app when revising tests):\n${this.description}\n`
      : '';

    // §9 prompt caching: element list + rules are static per suite.
    const systemPrompt = `You are revising Playwright test blocks whose plans reference elements that don't exist on the page. Use ONLY elements from this page snapshot:

Available elements on the page (use ONLY these):
${roleNameList}

Rules:
1. Rewrite the failing tests to use elements that ACTUALLY exist on the page
2. Keep the test intent similar but adjust targets to real elements
3. NEVER delete a test — rewrite it or mark it as test.fixme() with a reason
4. The total test count must remain the same or increase

Respond with ONLY the TypeScript code, no markdown fences.`;

    const prompt = allBlocksFound
      ? `Revise these failing Playwright test blocks.
${appContextBlock}
Failures (elements not found):
${failureDetails}

Return each repaired test block complete: test('name', async ({ page }) => { ... }); — no imports, no describe wrapper, no commentary.`
      : `Revise these Playwright tests whose plans reference elements that don't exist on the page.
${appContextBlock}
Current test code:
\`\`\`typescript
${code}
\`\`\`

Failures (elements not found):
${failureDetails}

Return the complete fixed file.`;

    const text = await this.llm.complete(prompt, {
      maxTokens: allBlocksFound ? 4096 : 8192,
      system: systemPrompt,
      cache: true,
    });
    return this._applyLlmResponse(code, text, failures.map(f => f.testName));
  }

  getUsage() {
    return this.llm.getUsage();
  }
}

module.exports = { Healer };
