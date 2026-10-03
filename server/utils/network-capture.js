/**
 * Network capture utility — tracks XHR/fetch API calls made by the page
 * during exploration and test recording.
 *
 * This is the core enabler for API-driven SPA testing. Instead of relying on
 * fixed `waitForTimeout()` sleeps that race backend cold starts, we capture
 * which API endpoints the page actually calls and emit
 * `page.waitForResponse(...)` in the generated tests.
 *
 * Usage:
 *   const tracker = createNetworkTracker(page, { apiPatterns: ['/api/', 'execute-api'] });
 *   await page.goto(url);
 *   const calls = tracker.getCalls(); // [{ url, method, status, timing }]
 *   tracker.detach();
 */

const DEFAULT_API_PATTERNS = [
  '/api/',
  'execute-api',
  'amazonaws.com',
  'graphql',
  '/graphql',
  '/rest/',
  '/v1/',
  '/v2/',
];

/**
 * Check if a URL matches any of the API patterns.
 * @param {string} url
 * @param {string[]} patterns — substrings or regex strings to match against the URL
 * @returns {boolean}
 */
function matchesApiPatterns(url, patterns) {
  if (!patterns || patterns.length === 0) return false;
  for (const p of patterns) {
    if (p.startsWith('/') && p.endsWith('/') && p.length > 2) {
      // Treat as regex: /pattern/
      try {
        const regex = new RegExp(p.slice(1, -1));
        if (regex.test(url)) return true;
      } catch { /* invalid regex — skip */ }
    } else {
      if (url.includes(p)) return true;
    }
  }
  return false;
}

/**
 * Attach a network tracker to a Playwright page. Listens to 'request' and
 * 'response' events and records API calls that match the given patterns.
 *
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {string[]} [opts.apiPatterns] — URL substrings/regexes to match (defaults to common API patterns)
 * @param {number} [opts.maxCalls=100] — cap to avoid memory blowup on polling apps
 * @returns {{ getCalls: () => ApiCall[], detach: () => void, reset: () => void }}
 */
function createNetworkTracker(page, opts = {}) {
  const patterns = opts.apiPatterns && opts.apiPatterns.length > 0
    ? opts.apiPatterns
    : DEFAULT_API_PATTERNS;
  const maxCalls = opts.maxCalls || 100;

  /** @type {ApiCall[]} */
  const calls = [];
  const pending = new Map(); // requestId -> { url, method, startTime }

  const onRequest = (request) => {
    if (calls.length >= maxCalls) return;
    const url = request.url();
    const method = request.method();
    const resourceType = request.resourceType();

    // Only track XHR/fetch requests (not images, stylesheets, fonts, etc.)
    if (resourceType !== 'xhr' && resourceType !== 'fetch') return;

    // Filter to API-matching URLs
    if (!matchesApiPatterns(url, patterns)) return;

    pending.set(request, {
      url,
      method,
      startTime: Date.now(),
    });
  };

  const onResponse = (response) => {
    const request = response.request();
    const entry = pending.get(request);
    if (!entry) return;
    pending.delete(request);

    calls.push({
      url: entry.url,
      method: entry.method,
      status: response.status(),
      duration: Date.now() - entry.startTime,
      timestamp: new Date().toISOString(),
    });
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  return {
    getCalls() { return [...calls]; },
    getPendingCount() { return pending.size; },
    reset() { calls.length = 0; pending.clear(); },
    detach() {
      page.off('request', onRequest);
      page.off('response', onResponse);
    },
  };
}

/**
 * Derive a stable URL pattern from a concrete API URL for use in
 * waitForResponse. Strips query params and replaces UUIDs/numeric IDs
 * with wildcards so the same pattern matches across runs.
 *
 * Example:
 *   https://api.example.com/products/123/details?lang=en
 *   becomes: /products/{wildcard}/details
 *
 * @param {string} url
 * @returns {string} — a regex pattern string (without slashes) suitable for
 *   `resp => resp.url().includes(...)` or `new RegExp(...)`
 */
function deriveUrlPattern(url) {
  try {
    const u = new URL(url);
    let path = u.pathname;
    // Replace UUIDs: /items/550e8400-e29b-41d4-a716-446655440000 → /items/.*
    path = path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '.*');
    // Replace numeric IDs: /products/123 → /products/.*
    path = path.replace(/\/\d+(?=\/|$)/g, '/.*');
    // Replace long alphanumeric IDs: /items/a1b2c3d4e5f6 → /items/.*
    path = path.replace(/\/[a-zA-Z0-9]{20,}(?=\/|$)/g, '/.*');
    return path;
  } catch {
    // If URL parsing fails, return a simple substring match
    return url.split('?')[0];
  }
}

/**
 * Build a Playwright waitForResponse code snippet for a given API URL.
 * Uses a predicate function that matches the URL pattern.
 *
 * @param {string} url — the concrete API URL observed during recording
 * @param {string} [varName] — variable name for the response (default: 'response')
 * @returns {string} — TypeScript code line(s)
 */
function buildWaitForResponseCode(url, varName = 'response') {
  const pattern = deriveUrlPattern(url);
  // Use the path prefix before any wildcard for includes() matching.
  // Strip trailing slash so "/api/products" matches both "/api/products"
  // and "/api/products/123".
  const matchStr = pattern.split('.*')[0].replace(/\/+$/, '');
  return `await page.waitForResponse(resp => resp.url().includes(${JSON.stringify(matchStr)}) && resp.status() === 200, { timeout: 15000 });`;
}

/**
 * Group API calls by their URL pattern (path with IDs stripped).
 * Returns the most common patterns — useful for passing to the LLM prompt.
 *
 * @param {ApiCall[]} calls
 * @param {number} [maxPatterns=10]
 * @returns {{ pattern: string, count: number, methods: string[] }[]}
 */
function summarizeApiCalls(calls, maxPatterns = 10) {
  const groups = {};
  for (const call of calls) {
    const pattern = deriveUrlPattern(call.url);
    if (!groups[pattern]) {
      groups[pattern] = { pattern, count: 0, methods: new Set() };
    }
    groups[pattern].count++;
    groups[pattern].methods.add(call.method);
  }
  return Object.values(groups)
    .sort((a, b) => b.count - a.count)
    .slice(0, maxPatterns)
    .map(g => ({ pattern: g.pattern, count: g.count, methods: [...g.methods] }));
}

module.exports = {
  createNetworkTracker,
  matchesApiPatterns,
  deriveUrlPattern,
  buildWaitForResponseCode,
  summarizeApiCalls,
  DEFAULT_API_PATTERNS,
};
