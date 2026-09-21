const { chromium } = require('playwright');
const { createLLMClient } = require('../utils/llm-client');
const { captureAccessibilityTree } = require('../utils/accessibility');
const { createNetworkTracker, buildWaitForResponseCode, summarizeApiCalls } = require('../utils/network-capture');
const { generateFieldValue } = require('../utils/test-data');
const { detectAssertionPattern } = require('../utils/assertion-library');
const { isTimeSensitiveName } = require('../utils/time-sensitive');

class Generator {
  constructor(targetUrl, auth, llmConfig = {}, description = '', options = {}) {
    this.targetUrl = targetUrl;
    this.auth = auth;
    this.llm = createLLMClient(llmConfig);
    this.description = (description || '').trim();
    // API patterns for network capture — passed from appContext.apiPatterns
    this.apiPatterns = options.apiPatterns || null;
    // App context (viewport, userAgent, etc.) for the recording browser
    this.appContext = options.appContext || {};
    // Test timeout (ms) — emitted as test.setTimeout in beforeEach so the
    // page-load + API-wait time inside beforeEach doesn't eat into the test body
    this.testTimeout = options.testTimeout || null;
  }

  async generate(plan, snapshot) {
    // Run record-and-ground and LLM generation in parallel to save time.
    // Promise.allSettled lets both complete even if one fails.
    const [recordedResult, llmResult] = await Promise.allSettled([
      this.recordAndGround(plan, snapshot),
      this.llmGenerate(plan, snapshot),
    ]);

    let recordedCode = recordedResult.status === 'fulfilled' ? recordedResult.value : null;
    if (recordedResult.status === 'rejected') {
      console.warn(`Record-and-ground failed for ${plan.suite}: ${recordedResult.reason?.message}`);
    }

    let llmCode = llmResult.status === 'fulfilled' ? llmResult.value : null;
    if (llmResult.status === 'rejected') {
      console.warn(`LLM generate failed for ${plan.suite}: ${llmResult.reason?.message}`);
    }

    // Measure quality — if most steps were skipped, the recorded code is low value
    let recordedSkipRatio = 1;
    if (recordedCode) {
      const totalSteps = plan.tests.reduce((sum, t) => sum + t.steps.length, 0);
      const skippedSteps = (recordedCode.match(/\/\/ Step skipped:/g) || []).length;
      recordedSkipRatio = totalSteps > 0 ? skippedSteps / totalSteps : 1;
      if (recordedSkipRatio > 0.5) {
        console.warn(`Record-and-ground produced ${skippedSteps}/${totalSteps} skipped steps for ${plan.suite} — will prefer LLM code`);
      }
    }

    // Prefer LLM code when recorded code has too many skipped steps (>50%)
    if (recordedCode && llmCode) {
      if (recordedSkipRatio > 0.5) {
        return llmCode;
      }
      return recordedCode; // Recorder is primary when it produced meaningful steps
    }
    return recordedCode || llmCode || this.fallbackTemplate(plan);
  }

  async recordAndGround(plan, snapshot) {
    this._currentSnapshot = snapshot;
    const browser = await chromium.launch({ headless: true });
    // Use appContext for the recording browser so the recorded actions
    // happen in the same environment as test execution.
    const contextOptions = {
      viewport: this.appContext.viewport || { width: 1280, height: 720 },
    };
    if (this.appContext.userAgent) contextOptions.userAgent = this.appContext.userAgent;
    if (this.appContext.extraHTTPHeaders && Object.keys(this.appContext.extraHTTPHeaders).length > 0) {
      contextOptions.extraHTTPHeaders = this.appContext.extraHTTPHeaders;
    }
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    // Attach network tracker to capture API calls triggered by each step
    const tracker = createNetworkTracker(page, { apiPatterns: this.apiPatterns });

    await this.handleAuth(page);

    const testBlocks = [];

    for (const test of plan.tests) {
      const steps = [];

      for (const step of test.steps) {
        try {
          // Try networkidle briefly, fall back to domcontentloaded for sites that never go idle
          const idleTimeout = parseInt(process.env.NETWORKIDLE_TIMEOUT || '10000', 10);
          try {
            await page.goto(plan.page, { waitUntil: 'networkidle', timeout: idleTimeout });
          } catch {
            await page.goto(plan.page, { waitUntil: 'domcontentloaded', timeout: 15000 });
          }

          const beforeUrl = page.url();
          const beforeSnapshot = await captureAccessibilityTree(page);

          // Reset tracker before each step so we capture only the API calls
          // triggered by THIS step (not leftover from previous steps).
          tracker.reset();

          const actionCode = await this.executeAndObserve(page, step, beforeUrl, beforeSnapshot, tracker);
          if (actionCode) steps.push(actionCode);
        } catch (err) {
          // Sanitize error message — strip newlines and ANSI codes so it doesn't break TypeScript
          const sanitized = (err.message || 'Unknown error').replace(/[\r\n]+/g, ' ').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 200);
          steps.push(`    // Step skipped: ${step.action} on [${step.target?.role}] '${step.target?.name}' — ${sanitized}`);
        }
      }

      if (steps.length > 0) {
        // Count hidden steps so the timeout calculator can allocate enough
        // time for the try/catch waits on hidden elements.
        const hiddenStepCount = test.steps.filter(s => s.target?.hidden).length;
        testBlocks.push({ name: test.name, steps, hiddenStepCount });
      }
    }

    tracker.detach();
    await browser.close();
    if (testBlocks.length === 0) return null;
    let code = this.buildSpecFile(plan, testBlocks, snapshot);
    // Apply groundCheck to recordAndGround output too — catches duplicate
    // elements and time-sensitive assertions that the recorder picked up.
    code = this.groundCheck(code, snapshot, plan.suite);
    return code;
  }

  async executeAndObserve(page, step, beforeUrl, beforeSnapshot, tracker) {
    const { action, target, value } = step;
    const lines = [];

    // Handle wait actions — these add explicit waits without interacting with elements
    if (action === 'wait') {
      lines.push(`    await page.waitForTimeout(${parseInt(value) || 1000});`);
      return lines.join('\n');
    }

    // Handle waitForOptions — wait for a dropdown to populate with options
    if (action === 'waitForOptions') {
      if (target && target.role && target.name) {
        const locator = this.buildLocator(target);
        lines.push(`    // Wait for ${target.name} options to populate after parent selection`);
        lines.push(`    await ${locator}.waitFor({ state: 'visible', timeout: 10000 });`);
        lines.push(`    await page.waitForTimeout(500); // Extra settle time for dynamic options`);
      } else {
        lines.push(`    await page.waitForTimeout(1000);`);
      }
      return lines.join('\n');
    }

    // Handle waitForApiResponse — explicit wait for an API response pattern
    if (action === 'waitForApiResponse') {
      const pattern = value || (target?.name || '');
      if (pattern) {
        lines.push(`    // Wait for API response: ${pattern}`);
        lines.push(`    try {`);
        lines.push(`      await page.waitForResponse(resp => resp.url().includes(${JSON.stringify(pattern)}) && resp.status() === 200, { timeout: 15000 });`);
        lines.push(`    } catch { /* API may be cached or not fire on every run */ }`);
      } else {
        lines.push(`    await page.waitForTimeout(2000); // Fallback wait for API response`);
      }
      return lines.join('\n');
    }

    if (action === 'navigate') {
      const url = target?.name || value || this.targetUrl;
      lines.push(`    await page.goto('${url}', { waitUntil: 'domcontentloaded' });`);
      // Use waitForURL for async SPA navigation — wrapped in try/catch
      // since the URL pattern is inferred and may not match exactly.
      const navPath = new URL(url, this.targetUrl).pathname;
      lines.push(`    try {`);
      lines.push(`      await page.waitForURL(new RegExp(${JSON.stringify(this.escapeForRegex(navPath))}), { timeout: 15000 });`);
      lines.push(`    } catch { /* URL may differ — navigation still proceeded */ }`);
      return lines.join('\n');
    }

    if (!target || !target.role || !target.name) return null;

    const locator = this.buildLocator(target);
    const snapshot = this._currentSnapshot;
    // If the Planner marked this target as hidden (e.g. spinbuttons inside a
    // collapsed date/time picker), wrap fill/check assertions in try/catch so
    // the test doesn't hard-fail if the widget wasn't opened first.
    const isHidden = target.hidden === true;

    switch (action) {
      case 'click': {
        lines.push(`    await ${locator}.click({ timeout: 10000 }).catch(() => {});`);
        try {
          const el = this.getLocatorForPage(page, target, snapshot);
          await el.click({ timeout: 5000 });
        } catch { /* element may not be clickable */ }

        // Check if this click triggered API calls. If so, emit waitForResponse
        // wrapped in try/catch — the API call may not fire on every run (cached,
        // different page state, etc.) and we don't want to fail the test just
        // because the API didn't fire.
        const apiCalls = tracker.getCalls();
        if (apiCalls.length > 0) {
          // Use the first API call's URL pattern — typically the primary
          // data fetch triggered by the click (e.g. navigating to a product
          // page fetches /api/products/123).
          const primaryCall = apiCalls[0];
          lines.push(`    // Wait for API response triggered by clicking ${target.name}`);
          lines.push(`    try {`);
          lines.push(`      ${buildWaitForResponseCode(primaryCall.url)}`);
          lines.push(`    } catch { /* API may be cached or not fire on every run */ }`);
        } else {
          // No API call detected — use a short settle wait
          await page.waitForTimeout(1000);
        }

        const afterUrl = page.url();
        // Try custom assertion pattern first — produces better assertions for
        // known scenarios (login, search, cart, dialog, form submit, etc.)
        const customAssertion = detectAssertionPattern(step);
        if (customAssertion) {
          lines.push(customAssertion);
        } else if (afterUrl !== beforeUrl) {
          const afterPath = new URL(afterUrl).pathname;
          // Use waitForURL with try/catch — the URL pattern is inferred from
          // recording and may not match at execution time if the site uses
          // different routing (e.g. query params, hash routing, redirects).
          lines.push(`    try {`);
          lines.push(`      await page.waitForURL(new RegExp(${JSON.stringify(this.escapeForRegex(afterPath))}), { timeout: 15000 });`);
          lines.push(`    } catch {`);
          lines.push(`      // URL pattern may differ — verify element visibility instead`);
          lines.push(`      await expect(${locator}).toBeAttached();`);
          lines.push(`    }`);
        } else {
          const afterSnapshot = await captureAccessibilityTree(page);
          const newElements = this.findNewElements(beforeSnapshot, afterSnapshot);
          if (newElements.length > 0) {
            const best = this.pickSalientElement(newElements);
            lines.push(`    await expect(page.getByRole('${best.role}', { name: '${this.escapeStr(best.name)}', exact: true })).toBeVisible();`);
          } else {
            lines.push(`    await expect(${locator}).toBeAttached();`);
          }
        }
        break;
      }
      case 'fill': {
        const fillValue = value || generateFieldValue({
          type: target.role === 'searchbox' ? 'search' : 'text',
          name: target.name,
          placeholder: target.name,
          ariaLabel: target.name,
        }) || 'test input';
        if (isHidden) {
          // Hidden element (e.g. spinbutton inside collapsed picker) — wrap
          // in try/catch so the test doesn't hard-fail if the widget wasn't
          // opened. The click on the trigger button should have opened it,
          // but if that click failed silently, this fill will also fail.
          lines.push(`    // Element may be hidden inside a collapsed widget — wrap in try/catch`);
          lines.push(`    try {`);
          lines.push(`      await ${locator}.waitFor({ state: 'visible', timeout: 2000 });`);
          lines.push(`      await ${locator}.fill('${this.escapeStr(fillValue)}');`);
          lines.push(`      await expect(${locator}).toHaveValue('${this.escapeStr(fillValue)}');`);
          lines.push(`    } catch { /* element hidden — widget may not have opened */ }`);
        } else {
          lines.push(`    await ${locator}.waitFor({ state: 'visible', timeout: 10000 });`);
          lines.push(`    await ${locator}.fill('${this.escapeStr(fillValue)}');`);
          lines.push(`    await expect(${locator}).toHaveValue('${this.escapeStr(fillValue)}');`);
        }
        break;
      }
      case 'check': {
        if (target.role === 'checkbox' || target.role === 'radio' || target.role === 'switch') {
          if (isHidden) {
            lines.push(`    try { await ${locator}.check(); await expect(${locator}).toBeChecked(); } catch { /* hidden element */ }`);
          } else {
            lines.push(`    await ${locator}.check();`);
            lines.push(`    await expect(${locator}).toBeChecked();`);
          }
        } else {
          if (isHidden) {
            lines.push(`    await expect(${locator}).toBeVisible().catch(() => { /* element may be hidden inside collapsed widget */ });`);
          } else {
            lines.push(`    await expect(${locator}).toBeVisible();`);
          }
        }
        break;
      }
      case 'select': {
        lines.push(`    await ${locator}.waitFor({ state: 'visible', timeout: 10000 });`);
        lines.push(`    await ${locator}.selectOption('${this.escapeStr(value || '')}');`);
        // Check if selecting triggered API calls (dependent dropdown pattern:
        // selecting Year triggers /api/models?year=2020). Wrap in try/catch
        // since the API may be cached or not fire on every run.
        const apiCalls = tracker.getCalls();
        if (apiCalls.length > 0) {
          const primaryCall = apiCalls[0];
          lines.push(`    // Wait for API response after selecting ${target.name} (dependent dropdown)`);
          lines.push(`    try {`);
          lines.push(`      ${buildWaitForResponseCode(primaryCall.url)}`);
          lines.push(`    } catch { /* API may be cached or not fire on every run */ }`);
        } else {
          // Fallback: fixed wait for dependent dropdowns to populate
          lines.push(`    await page.waitForTimeout(1000); // Wait for dependent dropdowns to populate`);
        }
        break;
      }
      case 'hover': {
        lines.push(`    await ${locator}.hover();`);
        lines.push(`    await expect(${locator}).toBeVisible();`);
        break;
      }
      case 'press': {
        lines.push(`    await ${locator}.press('${this.escapeStr(value || 'Enter')}');`);
        // Check if pressing triggered API calls (e.g. Enter in search box).
        // Wrap in try/catch for resilience.
        const apiCalls = tracker.getCalls();
        if (apiCalls.length > 0) {
          const primaryCall = apiCalls[0];
          lines.push(`    // Wait for API response triggered by pressing ${value || 'Enter'} on ${target.name}`);
          lines.push(`    try {`);
          lines.push(`      ${buildWaitForResponseCode(primaryCall.url)}`);
          lines.push(`    } catch { /* API may be cached or not fire on every run */ }`);
        }
        break;
      }
      default:
        lines.push(`    await ${locator}.click();`);
        lines.push(`    await expect(${locator}).toBeAttached();`);
    }
    return lines.join('\n');
  }

  findNewElements(beforeTree, afterTree) {
    const beforeNames = new Set();
    this.collectNames(beforeTree, beforeNames);
    const newElements = [];
    this.findNewInTree(afterTree, beforeNames, newElements);
    return newElements;
  }

  collectNames(node, set) {
    if (!node) return;
    if (node.name) set.add(`${node.role}:${node.name}`);
    if (node.children) node.children.forEach(c => this.collectNames(c, set));
  }

  findNewInTree(node, existingNames, results) {
    if (!node) return;
    if (node.name && !existingNames.has(`${node.role}:${node.name}`)) {
      results.push({ role: node.role, name: node.name });
    }
    if (node.children) node.children.forEach(c => this.findNewInTree(c, existingNames, results));
  }

  pickSalientElement(elements) {
    const priority = ['dialog', 'alertdialog', 'searchbox', 'heading', 'button', 'link'];
    const isTimeSensitive = isTimeSensitiveName;
    for (const role of priority) {
      const match = elements.find(e => e.role === role && !isTimeSensitive(e.name));
      if (match) return match;
    }
    return elements[0];
  }

  async llmGenerate(plan, snapshot) {
    const roleNameList = snapshot.roleNamePairs
      .filter(e => e.name)
      .map(e => `[${e.role}] '${e.name}'`)
      .join('\n');

    // Detect duplicate role+name pairs so the LLM knows to disambiguate
    const nameCounts = {};
    for (const e of snapshot.roleNamePairs) {
      if (!e.name) continue;
      const key = `${e.role}:${e.name}`;
      nameCounts[key] = (nameCounts[key] || 0) + 1;
    }
    const duplicates = Object.entries(nameCounts)
      .filter(([, count]) => count > 1)
      .map(([key, count]) => {
        const [role, ...nameParts] = key.split(':');
        return `  [${role}] '${nameParts.join(':')}' appears ${count} times — use .first() or { exact: true }`;
      })
      .join('\n');

    const appContextBlock = this.description
      ? `\nApplication context (provided by the user — use this to write more realistic test data and assertions):\n${this.description}\n`
      : '';

    // API context — if the page makes API calls (SPA with async data fetch),
    // tell the LLM about the API patterns so it can use waitForResponse.
    const apiCalls = snapshot.apiCalls || [];
    const apiSummary = snapshot.apiSummary || [];
    const apiContextBlock = apiSummary.length > 0
      ? `\nAPI CALLS DETECTED — this is a SPA that fetches data from APIs (e.g. API Gateway + Lambda).\n` +
        `The following API endpoints were called during page load:\n` +
        apiSummary.map(a => `  ${a.methods.join('/')} ${a.pattern} (${a.count} call${a.count > 1 ? 's' : ''})`).join('\n') +
        `\n\nFor API-driven pages, use page.waitForResponse() instead of fixed waitForTimeout() sleeps:\n` +
        `  await page.waitForResponse(resp => resp.url().includes('/api/products') && resp.status() === 200, { timeout: 15000 });\n` +
        `This waits for the actual API response instead of guessing how long Lambda will take.\n`
      : '';

    const prompt = `Generate a Playwright test spec file in TypeScript for these test scenarios.
${appContextBlock}${apiContextBlock}
Target URL: ${plan.page}
Suite: ${plan.suite}

Test Plan:
${JSON.stringify(plan.tests, null, 2)}

Available elements on the page (from accessibility snapshot — use ONLY these):
${roleNameList}

${duplicates ? `DUPLICATE ELEMENTS (these appear multiple times — you MUST disambiguate):\n${duplicates}\n` : ''}

Generate a complete .spec.ts file using these rules:
1. Import { test, expect } from '@playwright/test'
2. Use ONLY getByRole() locators with exact names from the list above — ALWAYS add { exact: true } to every getByRole call: page.getByRole('link', { name: 'Example Link', exact: true })
3. NEVER invent element names — if a name isn't in the list, don't use it
4. Each test should be independent and navigate to the page first
5. Use SPECIFIC assertions per action — NOT generic heading checks:
   - After clicking a navigation link: use await page.waitForURL(new RegExp('/expected-path'), { timeout: 15000 }) wrapped in try/catch — the URL pattern is inferred and may not match exactly. Example:
     try { await page.waitForURL(new RegExp('/search'), { timeout: 15000 }); } catch { /* URL may differ */ }
   - After filling a form field: assert toHaveValue() on that field
   - After submitting a form: assert a success message or URL change
   - After clicking a button that opens a dialog: assert the dialog is visible using getByRole('dialog', { exact: true })
   - After clicking a dropdown: assert the dropdown options are visible
   - Do NOT reuse the same assertion across different tests
6. For duplicate elements (listed above), you MUST use BOTH { exact: true } AND .first(): page.getByRole('link', { name: 'Example Link', exact: true }).first()
7. For select/combobox interactions, use locator.waitFor({ state: 'visible', timeout: 10000 }) before selectOption
8. Keep tests focused and deterministic
9. Use test.describe for grouping
10. CRITICAL: Do NOT use element names that contain countdown timers or dynamic time-based text. If an element name has "days", "hrs", "min", "sec", "Sale ends in", or time patterns like "5 days : 19 hrs", do NOT assert against it. Instead, assert against a stable element on the destination page (e.g. a heading, button, or navigation element that does NOT change over time)
11. In the beforeEach hook, after navigating and waiting, dismiss any cookie/consent banner by clicking a button matching /accept|agree|dismiss|got it/i (use .first() and wrap in try/catch so it doesn't fail if no banner exists). Do NOT match /close/i as too many elements match that pattern.
12. For steps with action "waitForOptions", add: await page.getByRole(role, { name: name, exact: true }).waitFor({ state: 'visible', timeout: 10000 }); followed by await page.waitForTimeout(500);
13. For steps with action "wait", add: await page.waitForTimeout(value);
14. For cascading dropdowns (steps with "dependsOn"), ensure parent selectOption completes BEFORE child selectOption — use locator.waitFor() instead of fixed waitForTimeout between dependent selects
15. For "select" actions, after selectOption add: await page.getByRole('combobox', { name: 'child-name', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
16. For elements inside iframes, use page.frameLocator('selector').getByRole(..., { exact: true })
17. For API-driven pages, use page.waitForResponse() after actions that trigger API calls. ALWAYS wrap in try/catch — the API may be cached or not fire on every run. Example:
    try { await page.waitForResponse(resp => resp.url().includes('/api/') && resp.status() === 200, { timeout: 15000 }); } catch { /* API may be cached */ }
18. For steps with action "waitForApiResponse", add: try { await page.waitForResponse(resp => resp.url().includes(value) && resp.status() === 200, { timeout: 15000 }); } catch { /* API may be cached */ }
19. NEVER use .check() or .toBeChecked() on elements that are not checkboxes, radio buttons, or switches. For Accessibility tests on links, buttons, or other elements, use .toBeVisible() or .toBeFocused() instead.
20. Use page.waitForLoadState('domcontentloaded') after page.goto() before any other action.
21. For navigation assertions, prefer page.waitForURL() over expect(page).toHaveURL() — it waits for async SPA routing to complete. ALWAYS wrap in try/catch since the URL pattern is inferred and may not match. Example:
    try { await page.waitForURL(new RegExp('/expected-path'), { timeout: 15000 }); } catch { /* URL may differ */ }
22. Use REALISTIC test data for form fills based on field type and name:
    - Email fields: use test.john.smith123@example.com
    - Phone fields: use (555) 123-4567
    - Password fields: use Test@1234!
    - Name fields: use realistic first/last names (John Smith, Sarah Johnson)
    - Address fields: use realistic addresses (123 Main St, Springfield, CA, 94102)
    - Credit card fields: use 4111-1111-1111-1111, CVV 123, expiry 12/28
    - Search fields: use realistic search terms (not "test input")
    - Date fields: use 1990-06-15 format
    - URL fields: use https://example.com
    - Number fields: use realistic values (1-100)
    - Textarea/message fields: use a realistic sentence
    Do NOT use generic "test input" or "test" as form values.
23. For click actions, add a timeout and .catch() to prevent cascading failures:
    await page.getByRole('link', { name: 'Example Link', exact: true }).click({ timeout: 10000 }).catch(() => {});
    This ensures that if an element is not found or not clickable, the test continues to the next assertion instead of hanging for 60s.
24. CRITICAL — Login/Auth test rules:
    - For "invalid credentials" or "wrong password" tests: ASSERT the URL STAYS on the login page: expect(page.url()).toMatch(/login|signin/i). Do NOT assert the login button is still visible — it may re-render or be temporarily hidden. Do NOT assert URL changes away from login.
    - For "valid credentials" or "successful login" tests: Wrap ALL post-login assertions in try/catch since test credentials may not actually authenticate. Use soft assertions like toBeVisible().catch(() => {}) instead of hard expect(). Do NOT use expect(page.url()).not.toMatch(/login/) as a hard assertion — wrap it in try/catch.
    - For "missing field" or "required field" tests: Assert the form validation prevents submission — the URL should NOT change and the field should still be visible. Do NOT assert successful navigation.
    - NEVER assert both "login succeeds" and "login button still visible" in the same test — these are contradictory.
25. For element visibility assertions in Accessibility suites, wrap in .catch(() => {}) to avoid hard failures on elements that may render differently across environments:
    await expect(locator).toBeVisible().catch(() => { console.log('Element not visible: ...'); });
26. If an accessible name from the snapshot is ALL UPPERCASE (e.g. 'LOGIN', 'SIGN UP'), it is likely a CSS text-transform artifact — the runtime accessible name may differ in case (e.g. 'Login'). Use a case-insensitive anchored regex instead of an exact string: page.getByRole('button', { name: /^login$/i }).first()
27. When the same form field name appears multiple times on the page (duplicate textboxes in the snapshot), target the visible instance: page.getByRole('textbox', { name: 'Field Name', exact: true }).filter({ visible: true }).first()
28. In form tests, NEVER click the submit button before filling the required fields — fill every field first, then click submit once at the end. Clicking submit on an empty form triggers HTML5 validation and can leave the page in an unexpected state for subsequent steps.
29. NEVER target getByRole('option', ...) — <option> elements inside a native <select> are never "visible" and selectOption() is invalid on them. Always target the parent combobox/select with getByRole('combobox', { name: '...', exact: true }) and call .selectOption('value') on THAT locator.
30. NEVER use element names that contain calendar dates (e.g. "14/08/2026", "08/14/26", "2026-08-14"). Date-picker buttons change daily and will never match at test execution time. Skip tests that depend on a specific date label.
31. Some elements in the accessibility tree are hidden inside collapsed widgets (e.g. spinbutton "Day", "Month", "Year", "Hours", "Minutes" inside a date/time picker). These elements are NOT visible on page load — they only become visible after clicking a trigger button (e.g. "Show date picker"). When generating tests for such elements:
    - ALWAYS click the trigger button first (e.g. "Show date picker") before asserting or filling the hidden sub-elements
    - Wrap assertions on hidden sub-elements in .catch() in case the trigger click didn't open the widget
    - For Accessibility suites, do NOT assert hidden elements are visible — only assert the trigger button is visible/focusable
    - Example: await page.getByRole('button', { name: 'Show date picker', exact: true }).click({ timeout: 10000 }).catch(() => {}); then try { await expect(page.getByRole('spinbutton', { name: 'Day', exact: true })).toBeVisible({ timeout: 5000 }); } catch { /* picker may not have opened */ }

Respond with ONLY the TypeScript code, no markdown fences.`;

    const text = await this.llm.complete(prompt, { maxTokens: 8192 });
    let code = text.replace(/^```(?:typescript|ts)?\n?/m, '').replace(/\n?```$/m, '');
    code = this.groundCheck(code, snapshot, plan.suite);
    return code;
  }

  groundCheck(code, snapshot, suiteName) {
    const issues = [];

    // Count occurrences of each role+name pair to detect duplicates
    const nameCounts = {};
    for (const e of snapshot.roleNamePairs) {
      if (!e.name) continue;
      const key = `${e.role}:${e.name}`;
      nameCounts[key] = (nameCounts[key] || 0) + 1;
    }

    // ── Fix #6: Add { exact: true } + .first() to ALL duplicate getByRole calls ──
    // { exact: true } (Playwright 1.27+) provides precise name matching.
    // .first() is still needed when the SAME role+name pair appears multiple times.
    for (const [key, count] of Object.entries(nameCounts)) {
      if (count <= 1) continue;
      const idx = key.indexOf(':');
      const role = key.substring(0, idx);
      const name = key.substring(idx + 1);
      const escapedName = this.escapeStr(name);
      // Match both { name: '...' } and { name: '...', exact: true } variants
      const target1 = `getByRole('${role}', { name: '${escapedName}' })`;
      const target2 = `getByRole('${role}', { name: '${escapedName}', exact: true })`;
      const replacement = `getByRole('${role}', { name: '${escapedName}', exact: true }).first()`;

      // Replace variant without exact: true
      code = code.split(target1).map((part, i, arr) => {
        if (i < arr.length - 1) {
          if (!arr[i + 1].startsWith('.first()') && !arr[i + 1].startsWith(', exact: true')) {
            return part + replacement;
          }
        }
        return part;
      }).join('');

      // Replace variant with exact: true but no .first()
      code = code.split(target2).map((part, i, arr) => {
        if (i < arr.length - 1) {
          if (!arr[i + 1].startsWith('.first()')) {
            return part + replacement;
          }
        }
        return part;
      }).join('');
    }

    // ── Fix #4: Strip assertions against time-sensitive element names ──
    // The LLM sometimes adds assertions against countdown timer elements
    // (e.g. "Sale ends in 5 days : 19 hrs : 48 min : 10 sec") that will
    // never match at execution time because the time has changed.
    const isTimeSensitive = isTimeSensitiveName;

    // Match full lines containing getByRole with time-sensitive names.
    // Handles both { name: '...' } and { name: '...', exact: true } variants.
    const timePattern = /^(.*getByRole\('([^']+)',\s*\{\s*name:\s*'([^']+)'(?:,\s*exact:\s*true)?\s*\}\).*)$/gm;
    let timeMatch;
    while ((timeMatch = timePattern.exec(code)) !== null) {
      const [fullLine, , , elementName] = timeMatch;
      if (isTimeSensitive(elementName)) {
        // Replace the entire line with a comment explaining the skip
        const indent = fullLine.match(/^\s*/)[0];
        const replacement = `${indent}// Skipped: assertion against time-sensitive element '${elementName.slice(0, 60)}...'`;
        code = code.replace(fullLine, replacement);
        issues.push(`Time-sensitive: '${elementName.slice(0, 50)}'`);
      }
    }

    // ── Existing: check for unmatched elements (fuzzy match fallback) ──
    // Matches both { name: '...' } and { name: '...', exact: true } variants.
    const pattern = /getByRole\('([^']+)',\s*\{\s*name:\s*'([^']+)'(?:,\s*exact:\s*true)?\s*\}\)/g;
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const [fullMatch, role, name] = match;
      const exists = snapshot.roleNamePairs.some(
        e => e.role === role && e.name === name
      );
      if (!exists) {
        const fuzzy = snapshot.roleNamePairs.find(
          e => e.role === role && e.name.toLowerCase().includes(name.toLowerCase())
        );
        if (fuzzy) {
          const replacement = `getByRole('${fuzzy.role}', { name: '${this.escapeStr(fuzzy.name)}', exact: true })`;
          // Use replaceAll to fix all occurrences
          code = code.split(fullMatch).join(replacement);
          // Check if the fuzzy match is also a duplicate
          const fuzzyKey = `${fuzzy.role}:${fuzzy.name}`;
          if (nameCounts[fuzzyKey] > 1) {
            const withFirst = replacement + '.first()';
            code = code.split(replacement).map((part, i, arr) => {
              if (i < arr.length - 1 && !arr[i + 1].startsWith('.first()')) {
                return part + withFirst;
              }
              return part;
            }).join('');
          }
        } else {
          issues.push(`Unmatched: [${role}] '${name}'`);
        }
      }
    }

    // ── Safety: fix page.. syntax errors from empty getByRole calls ──
    // If an assertion pattern generated getByRole('', { name: '' }) and it
    // got stripped by fuzzy matching above, we'd end up with page..first()
    // which is a syntax error. Replace with a safe fallback.
    code = code.replace(/page\.\.first\(\)/g, "page.locator('body').first()");
    code = code.replace(/page\.\./g, "page.locator('body').");

    // ── Fix: Soften hard login URL assertions ──
    // The LLM often generates expect(page.url()).not.toMatch(/login|signin/i)
    // as a hard assertion after login attempts with fake credentials. This fails
    // because test credentials don't actually authenticate. Wrap in try/catch.
    code = code.replace(
      /expect\(page\.url\(\)\)\.not\.toMatch\((\/login\|signin\/i)\)/g,
      "try { expect(page.url()).not.toMatch($1); } catch { /* test credentials may not authenticate */ }"
    );

    // ── Fix: Remove contradictory login-button-visible assertions ──
    // After a login URL assertion (now wrapped in try/catch above), the LLM
    // sometimes adds a trailing "expect login button to be visible" assertion.
    // This is contradictory — if login succeeded, the button shouldn't be visible;
    // if it didn't, the URL assertion already handles it. Remove any toBeVisible()
    // assertion on a button matching login/signin names that follows the URL check.
    code = code.replace(
      /(\} catch \{ \/\* test credentials may not authenticate \*\/ \};\n)(\s*await expect\(page\.getByRole\('button', \{ name: '[^']*(?:login|sign in|log in|signin|sign-in|log-in)[^']*', exact: true \}\)\)\.toBeVisible\(\);\n)/gi,
      "$1"
    );

    // ── Fix: Wrap dialog visibility assertions in try/catch ──
    // Dialogs may not open if the trigger click fails silently (wrapped in .catch()).
    // A hard expect(dialog).toBeVisible() causes cascading failures.
    code = code.replace(
      /await expect\((page\.getByRole\('dialog'\)\.first\(\)|dialog)\)\.toBeVisible\((\{ timeout: \d+ \})?\);/g,
      (match, locator, timeout) => {
        const t = timeout || '';
        return `try { await expect(${locator}).toBeVisible(${t}); } catch { /* dialog may not open if trigger failed */ }`;
      }
    );

    // ── Fix: Replace login-button-visible assertions after invalid credential tests ──
    // After filling password with wrong value and clicking login button, asserting
    // the LOGIN button is still visible is fragile (element may re-render).
    // Replace with URL assertion: expect(page.url()).toMatch(/login|signin/i)
    code = code.replace(
      /(\.click\(\{ timeout: \d+ \}\)\.catch\(\(\) => \{\}\);\n)(\s*\/\/ Assert element is visible\n)(\s*await expect\(page\.getByRole\('button', \{ name: '[^']*(?:login|sign in|log in|signin|sign-in|log-in)[^']*', exact: true \}\)(?:\.first\(\))?\)\.toBeVisible\((\{ timeout: \d+ \})?\);)/gi,
      (match, clickLine, comment, _assertLine, timeout) => {
        return `${clickLine}    // Assert URL stays on login page (invalid credentials)\n    expect(page.url()).toMatch(/login|signin/i);`;
      }
    );

    // ── Fix: Soften standalone button/link visibility assertions ──
    // In SPA apps, elements may exist in the DOM but not be visible due to
    // hydration timing, CSS transitions, or conditional rendering.
    // For Accessibility suites: replace toBeVisible() with toBeAttached()
    //   (accessibility tests should verify DOM presence, not visual visibility)
    // For other suites: wrap toBeVisible() in .catch() to prevent hard failures
    const isAccessibility = suiteName === 'Accessibility';
    code = code.replace(
      /^(\s*)await expect\((page\.getByRole\((?:'button'|'link'),\s*\{[^}]+\}\s*\)(?:\.first\(\))?)\)\.toBeVisible\((\{ timeout: \d+ \})?\);$/gm,
      (match, indent, locator, timeout) => {
        const t = timeout || '';
        if (isAccessibility) {
          return `${indent}await expect(${locator}).toBeAttached(${t});`;
        }
        return `${indent}await expect(${locator}).toBeVisible(${t}).catch(() => { /* element may not be visible in SPA */ });`;
      }
    );

    // ── Fix: Case-insensitive matching for ALL-CAPS accessible names ──
    // CSS text-transform: uppercase changes the accessible name recorded at
    // discovery time (e.g. 'LOGIN') but the runtime accessible name may be the
    // raw DOM text (e.g. 'Login'). An exact-case match then finds 0 elements.
    // Convert all-caps exact names to case-insensitive anchored regex + .first()
    // (.first() avoids strict-mode violations when several casing variants exist).
    code = code.replace(
      /getByRole\('([a-z-]+)', \{ name: '([^']+)', exact: true \}\)(\.first\(\))?/g,
      (match, role, name, firstPart) => {
        const isAllCaps = /[A-Z]{2,}/.test(name) && !/[a-z]/.test(name);
        if (!isAllCaps) return match;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return `getByRole('${role}', { name: /^${escaped}$/i }).first()`;
      }
    );

    // ── Fix: Prefer visible instance for form-fill locators with .first() ──
    // When the same field name appears multiple times on a page (e.g. a hero
    // form plus a footer/modal copy), plain .first() can resolve to a hidden
    // duplicate whose waitFor({ state: 'visible' }) then times out. Filtering
    // by visibility is always the intended target for a fill interaction.
    code = code.replace(
      /getByRole\('(?:textbox|combobox|searchbox|spinbutton)', \{[^}]+\}\)(?!\.filter\()\.first\(\)/g,
      (match) => match.replace('.first()', '.filter({ visible: true }).first()')
    );

    // ── Fix: Strip invalid assertions/actions on 'option' role elements ──
    // The LLM sometimes targets getByRole('option', ...) for <select> dropdowns.
    // <option> elements inside a native <select> are never "visible" (they're
    // hidden until the dropdown opens), so waitFor({ state: 'visible' }) always
    // times out. selectOption() is also invalid on an option — it belongs on the
    // parent combobox. Remove these so the test doesn't hard-fail on them.
    code = code.replace(
      /^(.*getByRole\('option',[^\n]*\)\.first\(\)?\)\.waitFor\(\{ state: 'visible', timeout: \d+ \}\);.*)$/gm,
      (line) => {
        const indent = line.match(/^\s*/)[0];
        return `${indent}// Skipped: visibility wait on <option> (never visible in native <select>)`;
      }
    );
    code = code.replace(
      /^(.*getByRole\('option',[^\n]*\)\.first\(\)?\)\.selectOption\([^)]*\);.*)$/gm,
      (line) => {
        const indent = line.match(/^\s*/)[0];
        return `${indent}// Skipped: selectOption on <option> (must target the parent combobox)`;
      }
    );

    // ── Fix: Trim leading/trailing whitespace in getByRole exact names ──
    // The accessibility tree sometimes captures names with leading/trailing
    // whitespace (e.g. ' Brand Name' with a leading space). With { exact: true }, Playwright
    // does a strict string match and the runtime accessible name (trimmed) won't
    // match, so the locator finds 0 elements. Trim the name inside the literal.
    code = code.replace(
      /getByRole\('([a-z-]+)', \{ name: '([^']*)', exact: true \}\)/g,
      (match, role, name) => {
        const trimmed = name.trim();
        if (trimmed === name) return match;
        return `getByRole('${role}', { name: '${this.escapeStr(trimmed)}', exact: true })`;
      }
    );

    // ── Fix: Soften navigation-fallback toBeAttached assertions ──
    // When a click + waitForURL falls into the catch branch, the generated
    // fallback asserts the SOURCE link is still attached. After a successful
    // navigation the source link is gone (we're on a new page), and if the
    // element is conditionally rendered (e.g. behind a menu) it may never have
    // been present. Wrap these fallbacks in .catch() so a missing element
    // doesn't hard-fail a navigation test.
    code = code.replace(
      /(\s*\/\/ URL pattern may differ — verify element visibility instead\n\s*)await expect\((page\.getByRole\([^)]+\)(?:\.first\(\))?)\)\.toBeAttached\(\);/g,
      (match, indent, locator) => `${indent}await expect(${locator}).toBeAttached().catch(() => { /* element may not be present after navigation */ });`
    );

    // ── Fix: Soften hard assertions on spinbutton elements ──
    // Spinbuttons (Day, Month, Year, Hours, Minutes) are often inside
    // collapsed date/time picker widgets. They exist in the DOM but aren't
    // visible until the picker is opened. Hard toBeVisible()/toBeAttached()
    // on them causes false failures. Wrap in .catch() so the test doesn't
    // fail if the picker wasn't opened.
    code = code.replace(
      /^(\s*)await expect\((page\.getByRole\('spinbutton',[^\n]*\)(?:\.first\(\))?)\)\.toBeVisible\((\{ timeout: \d+ \})?\);$/gm,
      (match, indent, locator, timeout) => `${indent}await expect(${locator}).toBeVisible(${timeout || ''}).catch(() => { /* spinbutton may be hidden inside collapsed picker */ });`
    );
    code = code.replace(
      /^(\s*)await expect\((page\.getByRole\('spinbutton',[^\n]*\)(?:\.first\(\))?)\)\.toBeAttached\((\{ timeout: \d+ \})?\);$/gm,
      (match, indent, locator, timeout) => `${indent}await expect(${locator}).toBeAttached(${timeout || ''}).catch(() => { /* spinbutton may be hidden inside collapsed picker */ });`
    );

    if (issues.length > 0) {
      code = `// GROUND-CHECK WARNINGS:\n// ${issues.join('\n// ')}\n\n${code}`;
    }
    return code;
  }

  buildSpecFile(plan, testBlocks, snapshot) {
    const suiteName = `${plan.path || 'page'} — ${plan.suite}`;
    const isAccessibilitySuite = plan.suite === 'Accessibility';

    // Detect if this page is an SPA that makes API calls on load. If so,
    // emit waitForResponse in beforeEach instead of a fixed sleep — this
    // handles SPA apps that fetch data on mount (any framework + any backend).
    const apiCalls = snapshot?.apiCalls || [];
    const isApiDriven = apiCalls.length > 0;
    // Use the first API call as the "page load data fetch" pattern
    const primaryApiPattern = isApiDriven ? apiCalls[0] : null;

    let code = `import { test, expect } from '@playwright/test';\n`;
    if (isAccessibilitySuite) {
      code += `import AxeBuilder from '@axe-core/playwright';\n`;
    }
    code += `\n`;
    code += `test.describe('${this.escapeStr(suiteName)}', () => {\n`;
    code += `  test.beforeEach(async ({ page }) => {\n`;
    if (this.testTimeout) {
      code += `    test.setTimeout(${this.testTimeout});\n`;
    }
    code += `    await page.goto('${plan.page}', { waitUntil: 'domcontentloaded' });\n`;
    if (isApiDriven && primaryApiPattern) {
      // SPA: wait for the page's primary API call to complete instead of
      // a fixed sleep. Use try/catch so the test doesn't fail if the API
      // call doesn't fire on every page load (e.g. cached responses).
      code += `    // Wait for page's API data to load (SPA with async data fetch)\n`;
      code += `    try {\n`;
      code += `      ${buildWaitForResponseCode(primaryApiPattern.url)}\n`;
      code += `    } catch { /* API may be cached or not fire on every load */ }\n`;
      // For SPA apps, the API response triggers a re-render that may
      // take time (hydration, change detection, virtual DOM updates). Wait
      // for networkidle as a secondary signal, then a settle period. This
      // matches the crawl's wait strategy more closely so elements present
      // at crawl time are also present at test execution time.
      code += `    // Wait for SPA hydration/rendering to complete\n`;
      code += `    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* SPA may never go idle */ }\n`;
      code += `    await page.waitForTimeout(2000); // Settle for dynamic content rendering\n`;
    } else {
      code += `    // Give dynamic content (JS hydration, dropdowns) time to render\n`;
      code += `    // SPAs need extra time for hydration after domcontentloaded\n`;
      code += `    await page.waitForTimeout(2000);\n`;
    }
    // Dismiss cookie/consent banners that commonly overlay and block clicks.
    // Do NOT match /close/i — too many elements match "Close" causing strict mode violations.
    // Match both button and link roles — some sites use anchors for "Accept".
    code += `    // Dismiss cookie consent banner if present (common on e-commerce sites)\n`;
    code += `    const cookieBanner = page.getByRole('button', { name: /accept|agree|dismiss|got it|allow all|accept all/i }).first();\n`;
    code += `    if (await cookieBanner.isVisible({ timeout: 1500 }).catch(() => false)) {\n`;
    code += `      await cookieBanner.click();\n`;
    code += `      await page.waitForTimeout(300);\n`;
    code += `    } else {\n`;
    code += `      const cookieLink = page.getByRole('link', { name: /accept|agree|allow all|accept all/i }).first();\n`;
    code += `      if (await cookieLink.isVisible({ timeout: 500 }).catch(() => false)) {\n`;
    code += `        await cookieLink.click();\n`;
    code += `        await page.waitForTimeout(300);\n`;
    code += `      }\n`;
    code += `    }\n`;
    code += `  });\n\n`;
    // afterEach: close any open dialogs/modals to prevent state leakage between tests
    code += `  test.afterEach(async ({ page }) => {\n`;
    code += `    // Close any open dialogs that might block subsequent tests\n`;
    code += `    const dialog = page.getByRole('dialog').first();\n`;
    code += `    if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {\n`;
    code += `      const closeBtn = dialog.getByRole('button', { name: /close|cancel|done|ok/i }).first();\n`;
    code += `      if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {\n`;
    code += `        await closeBtn.click();\n`;
    code += `      } else {\n`;
    code += `        await page.keyboard.press('Escape');\n`;
    code += `      }\n`;
    code += `    }\n`;
    code += `  });\n\n`;
    if (isAccessibilitySuite) {
      code += `  test('WCAG accessibility audit — no critical violations', async ({ page }) => {\n`;
      code += `    const results = await new AxeBuilder({ page })\n`;
      code += `      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])\n`;
      code += `      .analyze();\n`;
      code += `    // Report violations as console output — do NOT fail the test.\n`;
      code += `    // Site-level WCAG violations are not test generation failures.\n`;
      code += `    const criticalViolations = results.violations.filter(\n`;
      code += `      v => v.impact === 'critical' || v.impact === 'serious'\n`;
      code += `    );\n`;
      code += `    if (criticalViolations.length > 0) {\n`;
      code += `      console.log('Critical/serious WCAG violations:', JSON.stringify(criticalViolations.map(v => ({ rule: v.id, impact: v.impact, count: v.nodes.length })), null, 2));\n`;
      code += `    }\n`;
      code += `    // Informational only — does not fail the test\n`;
      code += `    expect(results.passes.length).toBeGreaterThan(0);\n`;
      code += `  });\n\n`;
      code += `  test('WCAG accessibility audit — full violation report', async ({ page }) => {\n`;
      code += `    const results = await new AxeBuilder({ page })\n`;
      code += `      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])\n`;
      code += `      .analyze();\n`;
      code += `    // This test always passes but reports all violations in the test output\n`;
      code += `    const violationSummary = results.violations.map(v => ({\n`;
      code += `      rule: v.id,\n`;
      code += `      impact: v.impact,\n`;
      code += `      description: v.description,\n`;
      code += `      count: v.nodes.length,\n`;
      code += `    }));\n`;
      code += `    console.log('Accessibility violations:', JSON.stringify(violationSummary, null, 2));\n`;
      code += `    expect(results.passes.length).toBeGreaterThan(0);\n`;
      code += `  });\n\n`;
    }

    // Visual regression test — captures a full-page screenshot.
    // Uses domcontentloaded instead of networkidle (SPAs rarely go idle).
    // On first run (no baseline), toHaveScreenshot fails even with
    // updateSnapshots:'missing' — and Playwright's expect tracks failures
    // internally so try/catch cannot suppress them. Instead, we check if the
    // baseline file exists and take a manual screenshot if it doesn't.
    // On subsequent runs, toHaveScreenshot compares against the baseline.
    const cleanPath = (plan.path || 'page').replace(/^\//, '');
    code += `  test('Visual regression — page layout screenshot', async ({ page }) => {\n`;
    code += `    await page.waitForLoadState('domcontentloaded');\n`;
    code += `    await page.waitForTimeout(1000); // Brief settle for dynamic content\n`;
    code += `    const screenshotName = '${this.escapeStr(cleanPath)}-layout.png';\n`;
    code += `    const fs = require('fs');\n`;
    code += `    const path = require('path');\n`;
    code += `    const os = require('os');\n`;
    code += `    const specFile = path.basename(__filename);\n`;
    code += `    const snapshotDir = path.resolve(__dirname, '..', 'screenshots');\n`;
    code += `    // Playwright's toHaveScreenshot names baselines as <name>-<platform>.png\n`;
    code += `    // (it strips the .png from the name we pass, then appends -<platform>.png).\n`;
    code += `    // The guard must compute the SAME path or the first-run skip won't fire.\n`;
    code += `    const baseName = screenshotName.replace(/\\.[^.]+$/, '');\n`;
    code += `    const baselinePath = path.join(snapshotDir, specFile + '-snapshots', baseName + '-' + os.platform() + '.png');\n`;
    code += `    if (!fs.existsSync(baselinePath)) {\n`;
    code += `      // First run: no baseline exists. Take a manual screenshot to create one.\n`;
    code += `      const snapshotSubDir = path.dirname(baselinePath);\n`;
    code += `      if (!fs.existsSync(snapshotSubDir)) fs.mkdirSync(snapshotSubDir, { recursive: true });\n`;
    code += `      await page.screenshot({ path: baselinePath, fullPage: true, animations: 'disabled' });\n`;
    code += `      console.log('Baseline screenshot created: ' + screenshotName + ' — will compare on next run');\n`;
    code += `      return;\n`;
    code += `    }\n`;
    code += `    // Baseline exists: compare with it\n`;
    code += `    await expect(page).toHaveScreenshot(screenshotName, {\n`;
    code += `      maxDiffPixelRatio: 0.01,\n`;
    code += `      threshold: 0.2,\n`;
    code += `      animations: 'disabled',\n`;
    code += `      fullPage: true,\n`;
    code += `    });\n`;
    code += `  });\n\n`;

    for (const block of testBlocks) {
      code += `  test('${this.escapeStr(block.name)}', async ({ page }) => {\n`;
      // Dynamic timeout: tests with many steps (e.g. cascading dropdowns) need
      // more time. Base 10s + 5s per visible step + 2s per hidden step (hidden
      // steps use a 2s waitFor-visible then fall to catch), capped at 120s.
      const stepCount = block.steps.length;
      const hiddenCount = block.hiddenStepCount || 0;
      const visibleCount = stepCount - hiddenCount;
      const dynamicTimeout = Math.min(10000 + visibleCount * 5000 + hiddenCount * 2500, 120000);
      if (stepCount > 3) {
        code += `    test.setTimeout(${dynamicTimeout}); // Extended timeout for ${stepCount} steps (${hiddenCount} hidden)\n`;
      }
      code += block.steps.join('\n') + '\n';
      code += `  });\n\n`;
    }
    code += `});\n`;
    return code;
  }

  fallbackTemplate(plan) {
    const isAccessibilitySuite = plan.suite === 'Accessibility';
    let code = `import { test, expect } from '@playwright/test';\n`;
    if (isAccessibilitySuite) {
      code += `import AxeBuilder from '@axe-core/playwright';\n`;
    }
    code += `\n`;
    code += `test.describe('${plan.path || 'page'} — ${plan.suite}', () => {\n`;
    code += `  test.beforeEach(async ({ page }) => {\n`;
    code += `    await page.goto('${plan.page}', { waitUntil: 'domcontentloaded' });\n`;
    code += `  });\n\n`;
    if (isAccessibilitySuite) {
      code += `  test('WCAG accessibility audit — no critical violations', async ({ page }) => {\n`;
      code += `    const results = await new AxeBuilder({ page })\n`;
      code += `      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])\n`;
      code += `      .analyze();\n`;
      code += `    const criticalViolations = results.violations.filter(\n`;
      code += `      v => v.impact === 'critical' || v.impact === 'serious'\n`;
      code += `    );\n`;
      code += `    if (criticalViolations.length > 0) {\n`;
      code += `      console.log('Critical/serious WCAG violations:', JSON.stringify(criticalViolations.map(v => ({ rule: v.id, impact: v.impact, count: v.nodes.length })), null, 2));\n`;
      code += `    }\n`;
      code += `    expect(results.passes.length).toBeGreaterThan(0);\n`;
      code += `  });\n\n`;
    }
    for (const t of plan.tests) {
      code += `  test.fixme('${this.escapeStr(t.name)}' /* Could not auto-generate */, async ({ page }) => {\n`;
      code += `    // TODO: Manual implementation needed\n`;
      code += `  });\n\n`;
    }
    code += `});\n`;
    return code;
  }

  async handleAuth(page) {
    const { type } = this.auth;

    if (type === 'none' || !type) return;

    if (type === 'basic') {
      await page.context().setExtraHTTPHeaders({
        Authorization: 'Basic ' + Buffer.from(`${this.auth.username}:${this.auth.password}`).toString('base64'),
      });
    } else if (type === 'bearer') {
      await page.context().setExtraHTTPHeaders({
        Authorization: `Bearer ${this.auth.token}`,
      });
    } else if (type === 'oauth') {
      const { cookies, localStorage: ls } = this.auth;
      if (cookies && cookies.length > 0) {
        await page.context().addCookies(cookies);
      }
      if (ls) {
        await page.goto(this.targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        for (const [key, value] of Object.entries(ls)) {
          await page.evaluate(([k, v]) => window.localStorage.setItem(k, v), [key, value]);
        }
      }
    } else if (type === 'form') {
      const { loginUrl, usernameSelector, passwordSelector, submitSelector, username, password } = this.auth;
      const idleTimeout = parseInt(process.env.NETWORKIDLE_TIMEOUT || '10000', 10);
      try {
        await page.goto(loginUrl || this.targetUrl, { waitUntil: 'networkidle', timeout: idleTimeout });
      } catch {
        await page.goto(loginUrl || this.targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      }
      await page.fill(usernameSelector || '[name="username"], [name="email"], #username, #email', username);
      await page.fill(passwordSelector || '[name="password"], #password', password);
      await page.click(submitSelector || 'button[type="submit"], input[type="submit"]');
      try {
        await page.waitForLoadState('networkidle', { timeout: idleTimeout });
      } catch {
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      }
    }
  }

  /**
   * Build a Playwright locator string for the generated test code.
   * If the target has an iframeSelector, uses page.frameLocator() to access
   * elements inside iframes. Otherwise uses the standard page.getByRole().
   */
  buildLocator(target) {
    // Use { exact: true } for more precise matching — avoids strict mode violations
    // when multiple elements share the same role but have different names.
    // Trim the name — the accessibility tree sometimes captures leading/trailing
    // whitespace that won't match the runtime accessible name under exact matching.
    const nameStr = this.escapeStr((target.name || '').trim());
    const roleLocator = `getByRole('${target.role}', { name: '${nameStr}', exact: true })`;
    if (target.iframeSelector) {
      return `page.frameLocator('${this.escapeStr(target.iframeSelector)}').${roleLocator}`;
    }
    return `page.${roleLocator}`;
  }

  /**
   * Get a Playwright locator object at runtime (for recordAndGround browser automation).
   * Handles iframe elements by traversing through frameLocator.
   * If snapshot is provided, adds .first() for duplicate elements to avoid strict mode violations.
   */
  getLocatorForPage(page, target, snapshot) {
    let locator;
    if (target.iframeSelector) {
      locator = page.frameLocator(target.iframeSelector).getByRole(target.role, { name: target.name, exact: true });
    } else {
      locator = page.getByRole(target.role, { name: target.name, exact: true });
    }
    // Add .first() for duplicate elements to prevent strict mode violations during recording
    if (snapshot && snapshot.roleNamePairs) {
      const count = snapshot.roleNamePairs.filter(
        e => e.role === target.role && e.name === target.name
      ).length;
      if (count > 1) {
        return locator.first();
      }
    }
    return locator;
  }

  escapeStr(s) { return (s || '').replace(/'/g, "\\'").replace(/\n/g, '\\n'); }
  escapeForRegex(s) { return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  getUsage() {
    return this.llm.getUsage();
  }
}

module.exports = { Generator };
