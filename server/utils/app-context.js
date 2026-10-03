/**
 * Validation and normalization for the user-provided "application context" —
 * Playwright browser context options (baseURL, viewport, userAgent,
 * extraHTTPHeaders) that flow from the API/UI through to the Explorer and
 * Executor.
 *
 * The server treats appContext as untrusted input (any API caller can supply
 * it, not just our own UI). This module returns a clean, typed object or
 * throws with a user-facing message. It never mutates the input.
 */

const URL = require('url').URL || globalThis.URL;

const VIEWPORT_MIN_W = 320;
const VIEWPORT_MAX_W = 3840;
const VIEWPORT_MIN_H = 240;
const VIEWPORT_MAX_H = 2160;
const MAX_HEADER_COUNT = 50;
const MAX_HEADER_NAME_LEN = 256;
const MAX_HEADER_VALUE_LEN = 8192;
const MAX_UA_LEN = 4096;
const MAX_BASEURL_LEN = 2048;
const MAX_API_PATTERNS = 20;
const MAX_API_PATTERN_LEN = 200;

/**
 * Validate and normalize an appContext object.
 * @param {unknown} input
 * @returns {{baseURL?: string, viewport?: {width:number,height:number}, userAgent?: string, extraHTTPHeaders?: Record<string,string>}}
 * @throws {Error} with a human-readable message on validation failure.
 */
function validateAppContext(input) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('appContext must be an object');
  }

  const out = {};
  const errors = [];

  // ── baseURL ──
  if ('baseURL' in input && input.baseURL != null && String(input.baseURL).trim() !== '') {
    const raw = String(input.baseURL);
    if (raw.length > MAX_BASEURL_LEN) {
      errors.push(`baseURL is too long (max ${MAX_BASEURL_LEN} chars)`);
    } else {
      try {
        const u = new URL(raw);
        if (!['http:', 'https:'].includes(u.protocol)) {
          errors.push(`baseURL must be an http(s) URL (got protocol "${u.protocol}")`);
        } else {
          out.baseURL = raw.trim();
        }
      } catch {
        errors.push(`baseURL is not a valid URL: "${raw}"`);
      }
    }
  }

  // ── viewport ──
  if ('viewport' in input && input.viewport != null) {
    if (typeof input.viewport !== 'object' || Array.isArray(input.viewport)) {
      errors.push('viewport must be an object with width and height');
    } else {
      const width = Math.floor(Number(input.viewport.width));
      const height = Math.floor(Number(input.viewport.height));
      if (!Number.isFinite(width) || width < VIEWPORT_MIN_W || width > VIEWPORT_MAX_W) {
        errors.push(`viewport.width must be an integer between ${VIEWPORT_MIN_W} and ${VIEWPORT_MAX_W}`);
      }
      if (!Number.isFinite(height) || height < VIEWPORT_MIN_H || height > VIEWPORT_MAX_H) {
        errors.push(`viewport.height must be an integer between ${VIEWPORT_MIN_H} and ${VIEWPORT_MAX_H}`);
      }
      if (errors.length === 0) {
        out.viewport = { width, height };
      }
    }
  }

  // ── userAgent ──
  if ('userAgent' in input && input.userAgent != null && String(input.userAgent).trim() !== '') {
    const ua = String(input.userAgent);
    if (ua.length > MAX_UA_LEN) {
      errors.push(`userAgent is too long (max ${MAX_UA_LEN} chars)`);
    } else if (/[\r\n]/.test(ua)) {
      errors.push('userAgent must not contain newlines');
    } else {
      out.userAgent = ua;
    }
  }

  // ── extraHTTPHeaders ──
  if ('extraHTTPHeaders' in input && input.extraHTTPHeaders != null) {
    const h = input.extraHTTPHeaders;
    if (typeof h !== 'object' || Array.isArray(h)) {
      errors.push('extraHTTPHeaders must be a flat object of string -> string');
    } else {
      const entries = Object.entries(h);
      if (entries.length > MAX_HEADER_COUNT) {
        errors.push(`extraHTTPHeaders has too many entries (max ${MAX_HEADER_COUNT})`);
      } else {
        const cleaned = {};
        for (const [name, value] of entries) {
          if (typeof name !== 'string' || name.length === 0 || name.length > MAX_HEADER_NAME_LEN) {
            errors.push(`extraHTTPHeaders key "${String(name).slice(0, 40)}" is invalid (must be non-empty string, max ${MAX_HEADER_NAME_LEN} chars)`);
            break;
          }
          if (/[\r\n]/.test(name)) {
            errors.push(`extraHTTPHeaders key "${name}" must not contain newlines (header injection)`);
            break;
          }
          const v = String(value);
          if (v.length > MAX_HEADER_VALUE_LEN) {
            errors.push(`extraHTTPHeaders value for "${name}" is too long (max ${MAX_HEADER_VALUE_LEN} chars)`);
            break;
          }
          if (/[\r\n]/.test(v)) {
            errors.push(`extraHTTPHeaders value for "${name}" must not contain newlines (header injection)`);
            break;
          }
          cleaned[name] = v;
        }
        if (errors.length === 0 && Object.keys(cleaned).length > 0) {
          out.extraHTTPHeaders = cleaned;
        }
      }
    }
  }

  // ── apiPatterns ──
  // URL substrings or /regex/ patterns that identify the app's API calls
  // (e.g. '/api/', 'execute-api', '/v1/products'). Used by the network tracker
  // to capture API calls and emit waitForResponse() in generated tests.
  if ('apiPatterns' in input && input.apiPatterns != null) {
    const p = input.apiPatterns;
    if (!Array.isArray(p)) {
      errors.push('apiPatterns must be an array of strings');
    } else {
      if (p.length > MAX_API_PATTERNS) {
        errors.push(`apiPatterns has too many entries (max ${MAX_API_PATTERNS})`);
      } else {
        const cleaned = [];
        for (const item of p) {
          const s = String(item);
          if (s.length === 0 || s.length > MAX_API_PATTERN_LEN) {
            errors.push(`apiPatterns entry "${s.slice(0, 40)}" is invalid (must be non-empty string, max ${MAX_API_PATTERN_LEN} chars)`);
            break;
          }
          // Validate regex patterns (enclosed in /.../)
          if (s.startsWith('/') && s.endsWith('/') && s.length > 2) {
            try {
              new RegExp(s.slice(1, -1));
            } catch (err) {
              errors.push(`apiPatterns entry "${s}" is not a valid regex: ${err.message}`);
              break;
            }
          }
          cleaned.push(s);
        }
        if (errors.length === 0 && cleaned.length > 0) {
          out.apiPatterns = cleaned;
        }
      }
    }
  }

  // ── locale ──
  // BCP-47 tag ('en-US', 'de-DE'). Pinned identically in the capture and
  // test contexts so locale-sensitive page output (toLocaleDateString etc.)
  // renders the same way in the baseline and at test execution time.
  if ('locale' in input && input.locale != null && String(input.locale).trim() !== '') {
    const loc = String(input.locale).trim();
    if (loc.length > 35 || !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(loc)) {
      errors.push(`locale "${loc}" is not a valid BCP-47 tag (e.g. en-US, de-DE)`);
    } else {
      out.locale = loc;
    }
  }

  // Reject unknown top-level keys — fail closed so typos don't silently pass
  // through and get ignored downstream.
  const allowed = new Set(['baseURL', 'viewport', 'userAgent', 'extraHTTPHeaders', 'apiPatterns', 'locale']);
  const unknown = Object.keys(input).filter(k => !allowed.has(k));
  if (unknown.length > 0) {
    errors.push(`Unknown appContext keys: ${unknown.join(', ')}. Allowed: ${[...allowed].join(', ')}`);
  }

  if (errors.length > 0) {
    const err = new Error(`Invalid appContext: ${errors.join('; ')}`);
    err.code = 'INVALID_APP_CONTEXT';
    err.details = errors;
    throw err;
  }

  return out;
}

module.exports = {
  validateAppContext,
  // Exported for testing / reuse
  VIEWPORT_MIN_W, VIEWPORT_MAX_W, VIEWPORT_MIN_H, VIEWPORT_MAX_H,
  MAX_HEADER_COUNT, MAX_HEADER_NAME_LEN, MAX_HEADER_VALUE_LEN,
  MAX_UA_LEN, MAX_BASEURL_LEN, MAX_API_PATTERNS, MAX_API_PATTERN_LEN,
};
