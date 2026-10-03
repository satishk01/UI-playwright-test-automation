/**
 * Aria snapshot utilities — token-reduction plan §1.
 *
 * `page.ariaSnapshot({ mode: 'ai' })` returns a YAML snapshot optimized for AI
 * consumption with deterministic `[ref=eN]` element references. Feeding this
 * YAML to the LLM instead of flattened role+name JSON lists is typically
 * 40–70% fewer input tokens because hierarchy carries context.
 *
 * `boxes: true` appends `[box=x,y,w,h]` to each node, giving deterministic
 * visibility tagging (zero-size = hidden) without a per-element locator pass.
 */

const crypto = require('crypto');

/**
 * Fixed clock time used for `page.clock` emulation (token-reduction plan §2).
 * The same instant is installed in the explore/record browsers and emitted in
 * generated specs, so time-dependent labels (countdowns, clocks, "today"
 * pickers) render identically at capture and execution time.
 */
const FIXED_CLOCK_TIME = '2030-01-15T12:00:00.000Z';

/**
 * Capture the AI-mode aria snapshot for a page.
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {number} [opts.depth] — cap snapshot depth for very large pages
 * @returns {Promise<string|null>} YAML string, or null if capture failed.
 */
async function captureAriaSnapshot(page, opts = {}) {
  try {
    return await page.ariaSnapshot({
      mode: 'ai',
      boxes: true,
      ...(opts.depth ? { depth: opts.depth } : {}),
      timeout: 15000,
    });
  } catch (err) {
    console.warn(`ariaSnapshot capture failed: ${err.message}`);
    return null;
  }
}

/**
 * Capture the default-mode aria snapshot for use as a toMatchAriaSnapshot()
 * baseline. The default mode has no [ref=]/[box=] annotations, so it diff-
 * compares cleanly at test execution time.
 * @param {import('playwright').Page} page
 * @returns {Promise<string|null>}
 */
async function captureAriaBaseline(page) {
  try {
    return await page.ariaSnapshot({ timeout: 15000 });
  } catch {
    return null;
  }
}

/**
 * Capture the structured element list via `page.ariaSnapshotJSON()` (PW 1.63+).
 * Returns the same tree as the YAML snapshot as free-form JSON — each node has
 * role/name/ref/box plus extras (link `url`, `cursor: 'pointer'`) that YAML
 * regex parsing cannot extract. Falls back to `parseAriaRefs(yaml)` when the
 * JSON API is unavailable (older Playwright) or fails.
 * @param {import('playwright').Page} page
 * @param {string} [yaml] — already-captured YAML to parse as fallback
 * @returns {Promise<{ ref: string|null, role: string, name: string,
 *   box: {x:number,y:number,w:number,h:number}|null, url?: string,
 *   cursor?: string }[]>}
 */
async function captureAriaElements(page, yaml) {
  if (typeof page.ariaSnapshotJSON === 'function') {
    try {
      const tree = await page.ariaSnapshotJSON({ mode: 'ai', boxes: true, timeout: 15000 });
      const out = [];
      const walk = (nodes) => {
        for (const node of nodes || []) {
          if (!node || typeof node !== 'object') continue;
          out.push({
            role: node.role || '',
            name: node.name || node.text || '',
            ref: node.ref || null,
            box: node.box ? { x: node.box.x, y: node.box.y, w: node.box.width, h: node.box.height } : null,
            ...(node.url ? { url: node.url } : {}),
            ...(node.cursor ? { cursor: node.cursor } : {}),
          });
          walk(node.children);
        }
      };
      walk(Array.isArray(tree) ? tree : [tree]);
      if (out.length) return out;
    } catch (err) {
      console.warn(`ariaSnapshotJSON capture failed, falling back to YAML parse: ${err.message}`);
    }
  }
  return parseAriaRefs(yaml);
}

/**
 * Parse an AI-mode aria snapshot YAML into a flat element list.
 * Handles lines like:
 *   - link "Home" [ref=e2]
 *   - textbox "Email" [ref=e7] [disabled] [box=10,20,200,30]
 *   - navigation:              (container — no ref)
 *   - iframe:                  (embedded iframe subtree in ai mode)
 * @param {string} yaml
 * @returns {{ ref: string|null, role: string, name: string, box: {x:number,y:number,w:number,h:number}|null }[]}
 */
function parseAriaRefs(yaml) {
  if (!yaml) return [];
  const elements = [];
  const lineRe = /^\s*-\s+([a-zA-Z][a-zA-Z0-9-]*)\s*(?:"((?:[^"\\]|\\.)*)")?([^\n]*)$/gm;
  let m;
  while ((m = lineRe.exec(yaml)) !== null) {
    const [, role, rawName, rest] = m;
    const refMatch = rest.match(/\[ref=(e\d+)\]/);
    const boxMatch = rest.match(/\[box=([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\]/);
    elements.push({
      role,
      name: rawName ? rawName.replace(/\\(.)/g, '$1') : '',
      ref: refMatch ? refMatch[1] : null,
      box: boxMatch
        ? { x: +boxMatch[1], y: +boxMatch[2], w: +boxMatch[3], h: +boxMatch[4] }
        : null,
    });
  }
  return elements;
}

/**
 * Tag roleNamePairs with deterministic visibility using aria-snapshot boxes.
 * A zero-size box means the element is not rendered (hidden inside a
 * collapsed widget, display:none at this depth, etc.).
 *
 * Elements below the fold are intentionally NOT marked hidden — Playwright
 * auto-scrolls to them at test time, so only a zero-size box is a reliable
 * "cannot interact" signal.
 *
 * @param {ReturnType<typeof parseAriaRefs>} refs
 * @param {Array} roleNamePairs — mutated in place; pairs unmatched in the
 *   snapshot are left untouched (caller may fall back to locator checks).
 * @returns {Set<object>} pairs that were matched (so the caller knows which
 *   ones still need the locator-based visibility check).
 */
function tagVisibilityFromSnapshot(refs, roleNamePairs) {
  const matchedPairs = new Set();
  if (!refs || refs.length === 0) return matchedPairs;

  // Build lookup: "role|name" -> queue of refs (same pair may appear twice)
  const byKey = new Map();
  for (const r of refs) {
    if (!r.name) continue;
    const key = `${r.role}|${r.name}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }

  for (const pair of roleNamePairs) {
    if (!pair.name) continue;
    const key = `${pair.role}|${pair.name}`;
    const queue = byKey.get(key);
    if (!queue || queue.length === 0) continue;
    const ref = queue.shift();
    matchedPairs.add(pair);
    if (ref.ref) pair.ref = ref.ref;
    if (ref.box && (ref.box.w <= 0 || ref.box.h <= 0)) {
      pair.visible = false;
    }
  }
  return matchedPairs;
}

/**
 * Stable content hash of a page snapshot for cross-run caching (§9).
 * Strips [ref=] and [box=] annotations — they vary between renders even when
 * the page is unchanged — then hashes the remaining YAML.
 * @param {object} snapshot
 * @returns {string} sha256 hex
 */
function snapshotContentHash(snapshot) {
  let basis;
  if (snapshot.ariaYaml) {
    basis = snapshot.ariaYaml
      .replace(/\s*\[ref=e\d+\]/g, '')
      .replace(/\s*\[box=[^\]]+\]/g, '');
  } else {
    basis = JSON.stringify({
      pairs: (snapshot.roleNamePairs || []).map(e => [e.role, e.name]),
      forms: snapshot.forms || [],
    });
  }
  return crypto.createHash('sha256').update(basis).digest('hex');
}

/**
 * Build the element-description block for LLM prompts (§1).
 * Prefers the aria YAML snapshot (smaller, hierarchical, ref-annotated).
 * Falls back to the flattened [role] 'name' list when no snapshot exists.
 * @param {object} snapshot
 * @param {object} [opts]
 * @param {boolean} [opts.includeHidden] — annotate hidden elements
 * @returns {string}
 */
function describeElementsForPrompt(snapshot, opts = {}) {
  if (snapshot.ariaYaml) {
    return (
      `Page accessibility snapshot (YAML; [ref=eN] are stable element refs — ` +
      `use them for element identification; [box=x,y,w,h] is the bounding box, ` +
      `zero-size means the element is NOT rendered):\n${snapshot.ariaYaml}`
    );
  }
  return (snapshot.roleNamePairs || [])
    .filter(e => e.name)
    .map(e => {
      let s = `[${e.role}] '${e.name}'`;
      if (e.iframeSelector) s += ` (inside iframe: ${e.iframeSelector})`;
      if (opts.includeHidden && e.visible === false) s += ' (hidden)';
      return s;
    })
    .join('\n');
}

module.exports = {
  FIXED_CLOCK_TIME,
  captureAriaSnapshot,
  captureAriaBaseline,
  captureAriaElements,
  parseAriaRefs,
  tagVisibilityFromSnapshot,
  snapshotContentHash,
  describeElementsForPrompt,
};
