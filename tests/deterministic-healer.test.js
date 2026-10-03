const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  applyDeterministicRepairs,
  findTestBlock,
  extractTestBlock,
  replaceTestBlock,
  fuzzyMatchElement,
  buildScopedFailureContext,
} = require('../server/utils/deterministic-healer');

const SPEC = `import { test, expect } from '@playwright/test';

test.describe('Suite', () => {
  test('click home link', async ({ page }) => {
    await page.goto('https://example.com');
    await page.getByRole('link', { name: 'Home' }).click();
  });

  test('fill email', async ({ page }) => {
    await page.goto('https://example.com');
    await page.getByRole('textbox', { name: 'Email' }).fill('test@example.com');
  });

  test('select option visible', async ({ page }) => {
    await page.goto('https://example.com');
    await expect(page.getByRole('option', { name: 'Red' }).first()).toBeVisible();
  });

  test('navigates to cart', async ({ page }) => {
    await page.goto('https://example.com');
    await page.getByRole('link', { name: 'Cart' }).click();
    await expect(page).toHaveURL(/\\/cart/);
  });

  test('loads products', async ({ page }) => {
    await page.goto('https://example.com');
    await page.waitForTimeout(3000);
    await expect(page.getByRole('list')).toBeVisible();
  });
});
`;

const SNAPSHOT = {
  url: 'https://example.com',
  roleNamePairs: [
    { role: 'link', name: 'Home' },
    { role: 'textbox', name: 'Email address' },
    { role: 'link', name: 'Cart' },
  ],
  apiCalls: [{ url: 'https://api.example.com/v1/products/123' }],
};

// ── findTestBlock / extractTestBlock / replaceTestBlock ──

test('findTestBlock: locates a test block by name', () => {
  const b = findTestBlock(SPEC, 'fill email');
  assert.ok(b);
  assert.ok(SPEC.slice(b.start, b.end).includes("getByRole('textbox'"));
  assert.ok(!SPEC.slice(b.start, b.end).includes('select option visible'));
});

test('findTestBlock: matches fixme tests and tolerates quotes', () => {
  const code = `  test.fixme('it\'s broken', async ({ page }) => {\n    await page.goto('/');\n  });`;
  const b = findTestBlock(code, "it's broken");
  assert.ok(b);
});

test('findTestBlock: returns null for unknown test', () => {
  assert.equal(findTestBlock(SPEC, 'nonexistent'), null);
});

test('replaceTestBlock: splices new source into the block', () => {
  const out = replaceTestBlock(SPEC, 'fill email', `  test('fill email', async ({ page }) => {\n    await page.goto('/x');\n  });`);
  assert.ok(out.includes("page.goto('/x')"));
  assert.ok(out.includes('click home link'));
});

// ── fuzzyMatchElement ──

test('fuzzyMatchElement: case/whitespace-insensitive match', () => {
  const hit = fuzzyMatchElement('textbox', 'email  address', SNAPSHOT);
  assert.equal(hit.name, 'Email address');
});

test('fuzzyMatchElement: substring containment', () => {
  const hit = fuzzyMatchElement('textbox', 'Email', SNAPSHOT);
  // 'email' is a substring of 'email address'
  assert.equal(hit.name, 'Email address');
});

test('fuzzyMatchElement: respects role and returns null on no match', () => {
  assert.equal(fuzzyMatchElement('button', 'Email', SNAPSHOT), null);
  assert.equal(fuzzyMatchElement('link', 'Nonexistent', SNAPSHOT), null);
});

// ── Rule 1: strict mode violation → { exact: true } + .first() ──

test('repair: strict mode violation adds exact+first to the locator', () => {
  const failures = [{
    testName: 'click home link',
    reason: "Error: strict mode violation: getByRole('link', { name: 'Home' }) resolved to 2 elements",
  }];
  const { code, repairs, remaining } = applyDeterministicRepairs(SPEC, failures, SNAPSHOT);
  assert.equal(repairs.length, 1);
  assert.equal(remaining.length, 0);
  assert.ok(code.includes("getByRole('link', { name: 'Home', exact: true }).first()"));
  // other tests untouched
  assert.ok(code.includes("getByRole('textbox', { name: 'Email' }).fill"));
});

test('repair: strict mode escalates when block not found', () => {
  const failures = [{
    testName: 'ghost test',
    reason: "strict mode violation: getByRole('link', { name: 'Home' }) resolved to 2 elements",
  }];
  const { remaining } = applyDeterministicRepairs(SPEC, failures, SNAPSHOT);
  assert.equal(remaining.length, 1);
});

// ── Rule 2: name drift → fuzzy-match and patch the locator name ──

test('repair: element-not-found patches locator to fuzzy-matched name', () => {
  const failures = [{
    testName: 'fill email',
    reason: "locator.fill: Timeout 30000ms exceeded. waiting for getByRole('textbox', { name: 'Email' }) — element not found",
  }];
  const { code, repairs, remaining } = applyDeterministicRepairs(SPEC, failures, SNAPSHOT);
  assert.equal(repairs.length, 1);
  assert.equal(remaining.length, 0);
  assert.ok(code.includes("name: 'Email address'"));
});

test('repair: element-not-found escalates when no fuzzy match exists', () => {
  const spec = SPEC.replace("name: 'Email'", "name: 'Phone Number'");
  const failures = [{
    testName: 'fill email',
    reason: "waiting for getByRole('textbox', { name: 'Phone Number' }) — element not found",
  }];
  const { remaining } = applyDeterministicRepairs(spec, failures, SNAPSHOT);
  assert.equal(remaining.length, 1);
});

// ── Rule 3: hidden option/spinbutton widget → soften assertion ──

test('repair: toBeVisible timeout on option softens with .catch', () => {
  const failures = [{
    testName: 'select option visible',
    reason: "expect(page.getByRole('option', { name: 'Red' }).first()).toBeVisible() timed out",
  }];
  const { code, repairs, remaining } = applyDeterministicRepairs(SPEC, failures, SNAPSHOT);
  assert.equal(repairs.length, 1);
  assert.equal(remaining.length, 0);
  assert.ok(code.includes('.catch(() => { /* hidden widget'));
});

// ── Rule 4: URL assertion → waitForURL ──

test('repair: toHaveURL failure converts to waitForURL', () => {
  const failures = [{
    testName: 'navigates to cart',
    reason: 'expect(page).toHaveURL(/\\/cart/) failed — url assertion mismatch after navigation',
  }];
  const { code, repairs, remaining } = applyDeterministicRepairs(SPEC, failures, SNAPSHOT);
  assert.equal(repairs.length, 1);
  assert.equal(remaining.length, 0);
  assert.ok(code.includes('page.waitForURL(/\\/cart/, { timeout: 15000 })'));
});

// ── Rule 5: network/API timeout → waitForResponse or routeFromHAR ──

test('repair: network timeout injects waitForResponse from recorded API', () => {
  const failures = [{
    testName: 'loads products',
    reason: 'page.waitForResponse: Timeout exceeded waiting for response',
  }];
  const { code, repairs, remaining } = applyDeterministicRepairs(SPEC, failures, SNAPSHOT);
  assert.equal(repairs.length, 1);
  assert.equal(remaining.length, 0);
  assert.ok(code.includes('waitForResponse(resp => resp.url().includes('));
});

test('repair: network timeout prefers routeFromHAR when harRelPath given', () => {
  const failures = [{
    testName: 'loads products',
    reason: 'requestfailed net::ERR_CONNECTION_REFUSED',
  }];
  const { code, repairs } = applyDeterministicRepairs(SPEC, failures, SNAPSHOT, {
    harRelPath: '../knowledge/page_Functional.har',
  });
  assert.equal(repairs.length, 1);
  assert.ok(code.includes('routeFromHAR'));
  assert.ok(code.includes('page_Functional.har'));
});

test('repair: network timeout escalates with no HAR and no apiCalls', () => {
  const failures = [{
    testName: 'loads products',
    reason: 'requestfailed net::ERR_ABORTED',
  }];
  const { remaining } = applyDeterministicRepairs(SPEC, failures, { url: 'x', roleNamePairs: [] });
  assert.equal(remaining.length, 1);
});

// ── General: compile errors + unknown failures always escalate ──

test('repair: compile_error type always escalates to LLM', () => {
  const failures = [{ testName: 'x', type: 'compile_error', reason: 'strict mode violation: getByRole' }];
  const { remaining } = applyDeterministicRepairs(SPEC, failures, SNAPSHOT);
  assert.equal(remaining.length, 1);
});

test('repair: unknown failure signature escalates', () => {
  const failures = [{ testName: 'click home link', reason: 'visual diff threshold exceeded' }];
  const { remaining } = applyDeterministicRepairs(SPEC, failures, SNAPSHOT);
  assert.equal(remaining.length, 1);
});

// ── buildScopedFailureContext ──

test('buildScopedFailureContext: extracts only the failing test blocks', () => {
  const scoped = buildScopedFailureContext(SPEC, [
    { testName: 'click home link', reason: 'r1' },
    { testName: 'navigates to cart', reason: 'r2' },
  ]);
  assert.equal(scoped.length, 2);
  assert.ok(scoped[0].block.includes('click home link'));
  assert.ok(scoped[1].block.includes('navigates to cart'));
  assert.ok(!scoped[0].block.includes('fill email'));
});
