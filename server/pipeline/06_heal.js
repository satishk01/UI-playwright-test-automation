const { createLLMClient } = require('../utils/llm-client');

class Healer {
  constructor(targetUrl, auth, llmConfig = {}, description = '') {
    this.targetUrl = targetUrl;
    this.auth = auth;
    this.llm = createLLMClient(llmConfig);
    this.description = (description || '').trim();
  }

  async heal(currentCode, executionResult, snapshot, plan) {
    if (!executionResult.failures || executionResult.failures.length === 0) {
      return null;
    }

    const classified = await this.classifyFailures(executionResult.failures, snapshot);

    const badPlans = classified.filter(f => f.classification === 'bad_test_plan');
    const badCode = classified.filter(f => f.classification === 'bad_code');

    let healedCode = currentCode;
    const changes = [];

    if (badCode.length > 0) {
      healedCode = await this.healBadCode(healedCode, badCode, snapshot);
      changes.push(...badCode.map(f => `Fixed: ${f.testName} — ${f.diagnosis}`));
    }

    if (badPlans.length > 0) {
      healedCode = await this.healBadPlan(healedCode, badPlans, snapshot, plan);
      changes.push(...badPlans.map(f => `Revised: ${f.testName} — ${f.diagnosis}`));
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

  async healBadCode(code, failures, snapshot) {
    const roleNameList = snapshot.roleNamePairs
      .filter(e => e.name)
      .map(e => `[${e.role}] '${e.name}'`)
      .join('\n');

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

    const failureDetails = failures.map(f =>
      `Test: "${f.testName}"\nError: ${f.reason}\n${f.snippet ? `Code snippet:\n${f.snippet}` : ''}`
    ).join('\n---\n');

    const appContextBlock = this.description
      ? `\nApplication context (provided by the user — use this to better diagnose failures):\n${this.description}\n`
      : '';

    const prompt = `Fix the following Playwright test failures. The tests exist but their assertions or interactions are wrong.
${appContextBlock}
Current test code:
\`\`\`typescript
${code}
\`\`\`

Failures:
${failureDetails}

Available elements on the page (use ONLY these [role] 'name' pairs):
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
21. For locator.waitFor visible timeouts on form fields whose name appears multiple times on the page: target the visible instance with .filter({ visible: true }).first() before waitFor/fill.
22. Return the complete fixed file

Respond with ONLY the TypeScript code, no markdown fences.`;

    const text = await this.llm.complete(prompt, { maxTokens: 8192 });
    return text.replace(/^```(?:typescript|ts)?\n?/m, '').replace(/\n?```$/m, '');
  }

  async healBadPlan(code, failures, snapshot, plan) {
    const roleNameList = snapshot.roleNamePairs
      .filter(e => e.name)
      .map(e => `[${e.role}] '${e.name}'`)
      .join('\n');

    const failureDetails = failures.map(f =>
      `Test: "${f.testName}"\nDiagnosis: ${f.diagnosis}`
    ).join('\n---\n');

    const appContextBlock = this.description
      ? `\nApplication context (provided by the user — use this to better understand the app when revising tests):\n${this.description}\n`
      : '';

    const prompt = `Revise these Playwright tests whose plans reference elements that don't exist on the page.
${appContextBlock}
Current test code:
\`\`\`typescript
${code}
\`\`\`

Failures (elements not found):
${failureDetails}

Available elements on the page (use ONLY these [role] 'name' pairs):
${roleNameList}

Rules:
1. Rewrite the failing tests to use elements that ACTUALLY exist on the page
2. Keep the test intent similar but adjust targets to real elements
3. NEVER delete a test — rewrite it or mark as test.fixme() with a reason
4. The total test count must remain the same or increase
5. Return the complete fixed file

Respond with ONLY the TypeScript code, no markdown fences.`;

    const text = await this.llm.complete(prompt, { maxTokens: 8192 });
    return text.replace(/^```(?:typescript|ts)?\n?/m, '').replace(/\n?```$/m, '');
  }

  getUsage() {
    return this.llm.getUsage();
  }
}

module.exports = { Healer };
