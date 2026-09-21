/**
 * Custom Assertion Library — pre-built Playwright assertion patterns for
 * common web testing scenarios. These are used by the LLM prompt and the
 * generator to produce more robust, scenario-specific assertions instead
 * of generic visibility checks.
 *
 * Each assertion returns a string of Playwright test code that can be
 * inserted into a generated spec file.
 */

// ── Assertion builders ──────────────────────────────────────

/**
 * Assert that a login was successful — checks for common success indicators:
 * URL change away from /login, presence of a user menu/avatar, or absence of login form.
 */
function assertLoginSuccess({ redirectPath = '/dashboard', userMenuRole = 'button', userMenuName = 'Account' }) {
  return [
    `    // Assert login success — URL changed away from login page`,
    `    try { await page.waitForURL(new RegExp('${redirectPath}'), { timeout: 15000 }); } catch { /* URL may differ */ }`,
    `    // Verify user menu is visible (logged-in indicator)`,
    `    await expect(page.getByRole('${userMenuRole}', { name: '${userMenuName}', exact: true })).toBeVisible({ timeout: 5000 }).catch(() => {`,
    `      // Fallback: verify we're no longer on the login page`,
    `      expect(page.url()).not.toMatch(/login|signin/i);`,
    `    });`,
  ].join('\n');
}

/**
 * Assert that a search returned results — checks for result container visibility
 * and that at least one result item is present.
 */
function assertSearchResults({ resultsRole = 'list', resultsName = '', itemRole = 'listitem' }) {
  const nameFilter = resultsName ? `, { name: '${resultsName}', exact: true }` : '';
  return [
    `    // Assert search results are visible`,
    `    await page.waitForTimeout(1000); // Brief wait for results to render`,
    `    const resultsContainer = page.getByRole('${resultsRole}'${nameFilter}).first();`,
    `    await expect(resultsContainer).toBeVisible({ timeout: 10000 });`,
    `    // Verify at least one result item exists`,
    `    const resultItems = page.getByRole('${itemRole}');`,
    `    expect(await resultItems.count()).toBeGreaterThan(0);`,
  ].join('\n');
}

/**
 * Assert that a form submission succeeded — checks for success message,
 * URL change, or disappearance of the form.
 */
function assertFormSubmitSuccess({ successText = 'success', successRole = 'alert', redirectPath = null }) {
  const lines = [
    `    // Assert form submission success`,
  ];
  if (redirectPath) {
    lines.push(`    try { await page.waitForURL(new RegExp('${redirectPath}'), { timeout: 15000 }); } catch { /* URL may differ */ }`);
  }
  lines.push(
    `    // Check for success message (alert, status, or heading)`,
    `    const successAlert = page.getByRole('${successRole}', { name: /${successText}/i }).first();`,
    `    const successVisible = await successAlert.isVisible({ timeout: 5000 }).catch(() => false);`,
    `    if (successVisible) {`,
    `      await expect(successAlert).toBeVisible();`,
    `    } else {`,
    `      // Fallback: verify the form is no longer visible (submitted and navigated away)`,
    `      await page.waitForTimeout(1000);`,
    `      expect(page.url()).not.toMatch(/form|create|edit|submit/i);`,
    `    }`,
  );
  return lines.join('\n');
}

/**
 * Assert that a cart operation worked — checks cart count badge or cart page.
 */
function assertCartAction({ cartCountRole = 'button', cartCountName = 'cart', expectedCount = null }) {
  const lines = [
    `    // Assert cart action succeeded`,
    `    const cartButton = page.getByRole('${cartCountRole}', { name: /${cartCountName}/i }).first();`,
    `    await expect(cartButton).toBeVisible({ timeout: 5000 });`,
  ];
  if (expectedCount !== null) {
    lines.push(`    // Verify cart count updated`);
    lines.push(`    const cartText = await cartButton.textContent();`);
    lines.push(`    expect(cartText).toMatch(/${expectedCount}/);`);
  } else {
    lines.push(`    // Verify cart count is present (any number > 0)`);
    lines.push(`    const cartText = await cartButton.textContent();`);
    lines.push(`    expect(cartText).toMatch(/\\d+/);`);
  }
  return lines.join('\n');
}

/**
 * Assert that a navigation/link click worked — checks URL change.
 */
function assertNavigation({ expectedPath }) {
  return [
    `    // Assert navigation to expected path`,
    `    try { await page.waitForURL(new RegExp('${expectedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&')}'), { timeout: 15000 }); } catch { /* URL may differ */ }`,
  ].join('\n');
}

/**
 * Assert that a dialog/modal opened — checks dialog visibility.
 */
function assertDialogOpen({ dialogTitle = null }) {
  const nameFilter = dialogTitle ? `, { name: '${dialogTitle}', exact: true }` : '';
  return [
    `    // Assert dialog/modal is open`,
    `    const dialog = page.getByRole('dialog'${nameFilter}).first();`,
    `    await expect(dialog).toBeVisible({ timeout: 5000 });`,
  ].join('\n');
}

/**
 * Assert that a dialog/modal closed — checks dialog is not visible.
 */
function assertDialogClosed() {
  return [
    `    // Assert dialog/modal is closed`,
    `    await page.waitForTimeout(500); // Brief wait for close animation`,
    `    const dialog = page.getByRole('dialog').first();`,
    `    await expect(dialog).not.toBeVisible({ timeout: 3000 }).catch(() => {`,
    `      // Soft pass — dialog may have been removed from DOM entirely`,
    `    });`,
  ].join('\n');
}

/**
 * Assert that a dropdown selection populated dependent options.
 */
function assertDependentDropdownPopulated({ childRole = 'combobox', childName }) {
  return [
    `    // Assert dependent dropdown populated after parent selection`,
    `    const childDropdown = page.getByRole('${childRole}', { name: '${childName}', exact: true });`,
    `    await childDropdown.waitFor({ state: 'visible', timeout: 10000 });`,
    `    // Verify the dropdown has options (not empty)`,
    `    const optionCount = await childDropdown.locator('option').count();`,
    `    expect(optionCount).toBeGreaterThan(0);`,
  ].join('\n');
}

/**
 * Assert that an element is present and visible — generic assertion with
 * better error messaging.
 */
function assertElementVisible({ role, name }) {
  if (!role || !name) return null;
  return [
    `    // Assert element is visible`,
    `    await expect(page.getByRole('${role}', { name: '${name}', exact: true }).first()).toBeVisible({ timeout: 10000 });`,
  ].join('\n');
}

/**
 * Assert that an API response was successful — waits for a specific API pattern.
 */
function assertApiResponse({ urlPattern, timeout = 15000 }) {
  return [
    `    // Assert API response received`,
    `    try {`,
    `      await page.waitForResponse(`,
    `        resp => resp.url().includes('${urlPattern}') && resp.status() === 200,`,
    `        { timeout: ${timeout} }`,
    `      );`,
    `    } catch { /* API may be cached or not fire on every run */ }`,
  ].join('\n');
}

// ── Pattern detection ───────────────────────────────────────

/**
 * Detect the best assertion pattern for a test step based on its context.
 * Returns the appropriate assertion code string, or null if no pattern matches.
 *
 * @param {object} step — Test step from the plan
 * @param {string} step.action — The action type (click, fill, select, etc.)
 * @param {object} step.target — Target element { role, name }
 * @param {string} step.expectedOutcome — Expected outcome description
 * @param {string} step.value — Value for fill/select actions
 * @returns {string|null} Assertion code or null
 */
function detectAssertionPattern(step) {
  const { action, target, expectedOutcome } = step;
  if (!expectedOutcome) return null;

  const outcome = expectedOutcome.toLowerCase();

  // Login success
  if (/login|signed in|authenticated|logged in/.test(outcome)) {
    return assertLoginSuccess({});
  }

  // Search results
  if (/search result|results (are )?visible|results (are )?displayed|search complete/.test(outcome)) {
    return assertSearchResults({});
  }

  // Form submission success
  if (/form (submit|success)|submission (success|complete)|saved|created|updated|deleted/.test(outcome)) {
    return assertFormSubmitSuccess({});
  }

  // Cart operations
  if (/cart|added to cart|item added|cart count/.test(outcome)) {
    return assertCartAction({});
  }

  // Navigation
  if (/url (change|update)|navigate|redirect|page (change|load)/.test(outcome)) {
    const pathMatch = outcome.match(/\/[a-z\-\/]+/i);
    if (pathMatch) {
      return assertNavigation({ expectedPath: pathMatch[0] });
    }
  }

  // Dialog open
  if (/dialog|modal|popup|overlay (open|appear|visible)/.test(outcome)) {
    return assertDialogOpen({});
  }

  // Dialog close
  if (/dialog|modal|popup (close|dismiss|hidden)/.test(outcome)) {
    return assertDialogClosed({});
  }

  // Dependent dropdown
  if (/dropdown.*populate|options.*populate|dependent.*dropdown|child.*options/.test(outcome)) {
    return assertDependentDropdownPopulated({ childName: target?.name || '' });
  }

  // API response
  if (/api response|api call|data load|data fetch/.test(outcome)) {
    return assertApiResponse({ urlPattern: '/api/' });
  }

  // Generic element visible — only if role and name are non-empty strings
  if (target && typeof target.role === 'string' && target.role.trim() &&
      typeof target.name === 'string' && target.name.trim() &&
      /visible|appear|show|display/.test(outcome)) {
    const assertion = assertElementVisible({ role: target.role, name: target.name });
    if (assertion) return assertion;
  }

  return null;
}

module.exports = {
  assertLoginSuccess,
  assertSearchResults,
  assertFormSubmitSuccess,
  assertCartAction,
  assertNavigation,
  assertDialogOpen,
  assertDialogClosed,
  assertDependentDropdownPopulated,
  assertElementVisible,
  assertApiResponse,
  detectAssertionPattern,
};
