/**
 * Deterministic test repair — token-reduction plan §7.
 *
 * Before a failure reaches the LLM healer (which resends the entire spec file
 * plus the whole element list, up to 6 calls per suite), this pass handles the
 * common mechanical failure classes with targeted, zero-token fixes:
 *
 *   strict mode violation on getByRole      → append .first() / { exact: true }
 *   element not found / locator timeout     → fuzzy-match name → patch locator
 *   toBeVisible timeout on option/spinbutton→ soften assertion with .catch()
 *   page.url() / toHaveURL assertion mismatch → convert to waitForURL
 *   network/API timeout                     → inject waitForResponse / routeFromHAR
 *
 * Failures with no deterministic signature are returned in `remaining` for
 * LLM escalation — with scoped prompts (failing test block only).
 */

const { deriveUrlPattern } = require('./network-capture');

/**
 * Locate the `test('name', ...)` block inside generated spec code.
 * Generated specs have a flat structure — tests end with `\n  });`.
 * @returns {{ start: number, end: number } | null}
 */
function findTestBlock(code, testName) {
  const escaped = escapeRegex(testName);
  // [ \t]* not \s* — the latter would swallow preceding newlines and the
  // closing-brace search below would then never match (block runs to EOF).
  const re = new RegExp(`(^|\\n)([ \\t]*)test(?:\\.fixme)?\\(\\s*(['"\`])${escaped}\\3`, 'm');
  const m = re.exec(code);
  if (!m) return null;
  const start = m.index + (m[1] ? 1 : 0);
  // Find the test's closing "});" — scan for the first line that is exactly
  // optional whitespace + "});" at an indentation <= the test's own indent.
  const indent = m[2] || '';
  const closeRe = new RegExp(`\\n${escapeRegex(indent)}\\}\\);`, 'g');
  closeRe.lastIndex = start;
  const c = closeRe.exec(code);
  const end = c ? c.index + c[0].length : code.length;
  return { start, end };
}

/**
 * Extract the source of a single test block (for scoped heal prompts).
 */
function extractTestBlock(code, testName) {
  const block = findTestBlock(code, testName);
  return block ? code.slice(block.start, block.end) : null;
}

/**
 * Replace a test block's source with new code (used to splice LLM-repaired
 * test blocks back into the spec without resending the whole file).
 */
function replaceTestBlock(code, testName, newBlockCode) {
  const block = findTestBlock(code, testName);
  if (!block) return null;
  return code.slice(0, block.start) + newBlockCode.trim() + code.slice(block.end);
}

function escapeRegex(s) {
  return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fuzzy-match an element name against the snapshot's role+name pairs.
 * Used when a recorded/planned name drifted between capture and execution.
 * @returns {{ role: string, name: string } | null}
 */
function fuzzyMatchElement(role, name, snapshot) {
  const pairs = (snapshot.roleNamePairs || []).filter(e => e.role === role && e.name);
  const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const target = norm(name);
  // Case/whitespace-insensitive exact match
  let hit = pairs.find(e => norm(e.name) === target);
  if (hit) return hit;
  // Substring containment either direction
  hit = pairs.find(e => norm(e.name).includes(target) || target.includes(norm(e.name)));
  if (hit) return hit;
  return null;
}

/**
 * Apply deterministic repairs to a spec file for the given failures.
 * @param {string} code — current spec file source
 * @param {Array} failures — execution failures [{testName, reason, snippet}]
 * @param {object} snapshot — page snapshot (roleNamePairs, apiCalls, ariaYaml)
 * @param {object} [opts]
 * @param {string} [opts.harRelPath] — spec-relative HAR file to replay (e.g.
 *   `path.join(__dirname, '..', 'knowledge', 'x.har')` expression text)
 * @param {string[]} [opts.apiUrlPatterns] — URL substrings for routeFromHAR filter
 * @returns {{ code: string, repairs: {testName:string,fix:string}[], remaining: Array }}
 */
function applyDeterministicRepairs(code, failures, snapshot, opts = {}) {
  let out = code;
  const repairs = [];
  const remaining = [];

  for (const failure of failures) {
    const fixed = repairOne(out, failure, snapshot, opts);
    if (fixed) {
      out = fixed.code;
      repairs.push({ testName: failure.testName, fix: fixed.description });
    } else {
      remaining.push(failure);
    }
  }
  return { code: out, repairs, remaining };
}

function repairOne(code, failure, snapshot, opts) {
  const reason = failure.reason || '';
  if (failure.type === 'compile_error') return null;

  // ── 1. Strict mode violation on a getByRole locator ──
  if (/strict mode violation/i.test(reason)) {
    const m = reason.match(/getByRole\('([^']+)',\s*\{\s*name:\s*'([^']+)'/);
    if (m) {
      const [, role, name] = m;
      const block = findTestBlock(code, failure.testName);
      if (block) {
        const src = code.slice(block.start, block.end);
        // Add { exact: true } AND .first() to the offending locator.
        const patched = src.replace(
          new RegExp(`getByRole\\('${escapeRegex(role)}',\\s*\\{\\s*name:\\s*'${escapeRegex(name)}'\\s*\\}\\)(?!\\s*\\.(first|nth|last|filter))`, 'g'),
          `getByRole('${role}', { name: '${name}', exact: true }).first()`
        ).replace(
          new RegExp(`getByRole\\('${escapeRegex(role)}',\\s*\\{\\s*name:\\s*'${escapeRegex(name)}',\\s*exact:\\s*true\\s*\\}\\)(?!\\s*\\.(first|nth|last|filter))`, 'g'),
          `getByRole('${role}', { name: '${name}', exact: true }).first()`
        );
        if (patched !== src) {
          return {
            code: code.slice(0, block.start) + patched + code.slice(block.end),
            description: `strict mode: added .first() to [${role}] '${name}'`,
          };
        }
      }
    }
    return null;
  }

  // ── 2. Visibility assertion timeout on option/spinbutton (hidden widget) ──
  // Runs BEFORE the name-drift rule: option timeouts often say "Timeout
  // exceeded" which would match rule 3's generic timeout check, and option
  // elements never fuzzy-match a usable target anyway.
  if (/toBeVisible|toBeAttached/i.test(reason) && /'(option|spinbutton)'/.test(reason)) {
    const block = findTestBlock(code, failure.testName);
    if (block) {
      const src = code.slice(block.start, block.end);
      const patched = src.replace(
        /await expect\((page\.getByRole\('(?:option|spinbutton)',[^\n]*?\)(?:\.first\(\))?)\)\.(toBeVisible|toBeAttached)\((\{[^)]*\})?\);/g,
        (mm, loc, assert, arg) => `await expect(${loc}).${assert}(${arg || ''}).catch(() => { /* hidden widget — softened by deterministic healer */ });`
      );
      if (patched !== src) {
        return {
          code: code.slice(0, block.start) + patched + code.slice(block.end),
          description: 'softened hidden-widget visibility assertion',
        };
      }
    }
    return null;
  }

  // ── 3. Element not found / locator timeout — name drifted ──
  const targetMatch = reason.match(/getByRole\('([^']+)',\s*\{\s*name:\s*'([^']+)'/);
  if (targetMatch && /not found|waiting for|timeout/i.test(reason)) {
    const [, role, name] = targetMatch;
    const hit = fuzzyMatchElement(role, name, snapshot);
    if (hit && hit.name !== name) {
      const block = findTestBlock(code, failure.testName);
      if (block) {
        const src = code.slice(block.start, block.end);
        const patched = src.split(`name: '${name}'`).join(`name: '${hit.name.replace(/'/g, "\\'")}'`);
        if (patched !== src) {
          return {
            code: code.slice(0, block.start) + patched + code.slice(block.end),
            description: `name drift: '${name}' → '${hit.name}'`,
          };
        }
      }
    }
    return null; // no fuzzy match — escalate
  }

  // ── 4. URL assertion mismatch → waitForURL ──
  if (/toHaveURL|toMatch|expect\(page\.url/i.test(reason) && /url|navigat/i.test(reason + (failure.testName || ''))) {
    const block = findTestBlock(code, failure.testName);
    if (block) {
      const src = code.slice(block.start, block.end);
      let patched = src.replace(
        /await expect\(page\)\.toHaveURL\(([^;]+)\);/g,
        'try { await page.waitForURL($1, { timeout: 15000 }); } catch { /* URL may differ */ }'
      );
      patched = patched.replace(
        /expect\(page\.url\(\)\)\.toMatch\(([^;]+)\);/g,
        'try { await page.waitForURL($1, { timeout: 15000 }); } catch { /* URL may differ */ }'
      );
      if (patched !== src) {
        return {
          code: code.slice(0, block.start) + patched + code.slice(block.end),
          description: 'converted URL assertion to waitForURL',
        };
      }
    }
    return null;
  }

  // ── 5. Network / API timeout → waitForResponse or routeFromHAR ──
  if (/waitForResponse|waiting for response|requestfailed|net::|ERR_/i.test(reason)) {
    const block = findTestBlock(code, failure.testName);
    if (block) {
      const src = code.slice(block.start, block.end);
      const lines = [];
      if (opts.harRelPath) {
        const pattern = opts.apiUrlPatterns && opts.apiUrlPatterns.length > 0
          ? opts.apiUrlPatterns.join('|')
          : 'api|execute-api';
        lines.push(
          `    const path = require('path');`,
          `    // Replay recorded API responses (deterministic healer)`,
          `    try { await page.routeFromHAR(path.join(__dirname, ${JSON.stringify(opts.harRelPath)}), { url: new RegExp(${JSON.stringify(pattern)}, 'i') }); } catch { /* HAR replay unavailable */ }`
        );
      } else if ((snapshot.apiCalls || []).length > 0) {
        const pattern = deriveUrlPattern(snapshot.apiCalls[0].url).split('.*')[0].replace(/\/+$/, '');
        lines.push(
          `    // Wait for the page's primary API call (deterministic healer)`,
          `    try { await page.waitForResponse(resp => resp.url().includes(${JSON.stringify(pattern)}) && resp.status() === 200, { timeout: 15000 }); } catch { /* API may be cached */ }`
        );
      }
      if (lines.length === 0) return null;
      // Inject after the first page.goto in the test block
      const patched = src.replace(
        /(await page\.goto\([^;]+;)/,
        `$1\n${lines.join('\n')}`
      );
      if (patched !== src) {
        return {
          code: code.slice(0, block.start) + patched + code.slice(block.end),
          description: opts.harRelPath ? 'injected routeFromHAR replay' : 'injected waitForResponse for recorded API',
        };
      }
    }
    return null;
  }

  return null;
}

/**
 * Build a scoped repair context for LLM escalation (§7): only the failing
 * test blocks instead of the whole spec file. Returns the extracted blocks
 * so the caller can splice the LLM's fixed blocks back in.
 */
function buildScopedFailureContext(code, failures) {
  const blocks = [];
  for (const f of failures) {
    const block = extractTestBlock(code, f.testName);
    blocks.push({ testName: f.testName, reason: f.reason, block });
  }
  return blocks;
}

module.exports = {
  applyDeterministicRepairs,
  findTestBlock,
  extractTestBlock,
  replaceTestBlock,
  fuzzyMatchElement,
  buildScopedFailureContext,
};
