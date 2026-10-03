/**
 * Cross-run spec cache — token-reduction plan §9.
 *
 * Hash the page's aria snapshot; if a page is unchanged since the last run,
 * reuse the previously generated spec files instead of re-running
 * plan/generate. Re-runs of the same app then cost ~0 tokens.
 *
 * Storage: runs/_cache/spec-cache.json — shared across runs of the same
 * server process tree. Entries are keyed by sha256(origin+path|contentHash),
 * so different pages of the same app cache independently.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = process.env.SPEC_CACHE_DIR || path.join(__dirname, '..', '..', 'runs', '_cache');
const CACHE_FILE = path.join(CACHE_DIR, 'spec-cache.json');
const MAX_ENTRIES = 500;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Generated-code schema version — bump whenever the emitted spec logic
// changes (new tests, new hooks, bug fixes in templates). Otherwise stale
// cached specs keep running the old code forever: the content hash only
// tracks page changes, not generator changes.
const GEN_VERSION = 4;

function load() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function save(cache) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    // Prune expired + cap size (drop oldest first)
    const entries = Object.entries(cache).sort((a, b) =>
      (a[1].savedAt || '').localeCompare(b[1].savedAt || ''));
    const cutoff = Date.now() - MAX_AGE_MS;
    const fresh = entries.filter(([, v]) => {
      const t = Date.parse(v.savedAt || '');
      return Number.isFinite(t) && t > cutoff;
    });
    const kept = fresh.slice(-MAX_ENTRIES);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(kept), null, 2));
  } catch (err) {
    console.warn(`spec-cache save failed: ${err.message}`);
  }
}

/**
 * Cache key for a page: URL identity + content hash of its snapshot.
 * @param {object} snapshot — must have .url and .ariaHash
 */
function keyFor(snapshot) {
  let origin = '', p = snapshot.path || '';
  try {
    const u = new URL(snapshot.url);
    origin = u.origin;
    p = u.pathname;
  } catch { /* keep raw */ }
  return crypto.createHash('sha256')
    .update(`${origin}${p}|${snapshot.ariaHash || 'nohash'}|g${GEN_VERSION}`)
    .digest('hex');
}

/**
 * Look up cached spec code for a page.
 * @returns {{ suites: Object<string, {code:string, har:string|null}>, savedAt: string } | null}
 */
function get(snapshot) {
  if (process.env.SPEC_CACHE_DISABLE === '1') return null;
  const entry = load()[keyFor(snapshot)];
  return entry && entry.suites ? entry : null;
}

/**
 * Which suite names are cached for this page (e.g. 'Functional').
 */
function cachedSuites(snapshot) {
  const entry = get(snapshot);
  return entry ? Object.keys(entry.suites) : [];
}

/**
 * Store a generated spec for a page+suite. `harAbsPath` (optional) is the
 * recorded HAR file so cache hits can copy it into the new run.
 */
function set(snapshot, suite, code, harAbsPath = null) {
  if (process.env.SPEC_CACHE_DISABLE === '1') return;
  const cache = load();
  const key = keyFor(snapshot);
  if (!cache[key]) {
    cache[key] = { url: snapshot.url, ariaHash: snapshot.ariaHash, suites: {}, savedAt: new Date().toISOString() };
  }
  cache[key].suites[suite] = { code, har: harAbsPath };
  cache[key].savedAt = new Date().toISOString();
  save(cache);
}

module.exports = { get, set, cachedSuites, keyFor };
