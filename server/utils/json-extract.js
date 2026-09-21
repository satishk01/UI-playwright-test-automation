/**
 * Robustly extract and parse JSON from an LLM text response.
 *
 * LLMs frequently wrap JSON in markdown fences, add prose before/after,
 * or emit trailing characters. This module finds the first balanced
 * JSON object or array and parses it.
 */

/**
 * Strip markdown code fences if present.
 * @param {string} text
 * @returns {string}
 */
function stripFences(text) {
  // Remove a leading ```json or ``` fence and its closing ```
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?\s*```/i);
  if (fenced) return fenced[1];

  // Fallback: strip a single leading/trailing fence
  return text
    .replace(/^\s*```(?:json)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/i, '')
    .trim();
}

/**
 * Find the first balanced JSON value (object or array) in the text.
 * Returns the parsed value, or throws SyntaxError if no valid JSON found.
 *
 * @param {string} text  Raw LLM output
 * @returns {*} Parsed JSON value
 */
function extractJSON(text) {
  if (!text || typeof text !== 'string') {
    throw new SyntaxError('Empty response from LLM');
  }

  const cleaned = stripFences(text);

  // Fast path: try parsing as-is first
  try {
    return JSON.parse(cleaned);
  } catch { /* fall through to balanced extraction */ }

  // Find the first { or [ and balance it, respecting strings and escapes
  const startIdx = cleaned.search(/[\[{]/);
  if (startIdx === -1) {
    throw new SyntaxError(`No JSON found in response: ${cleaned.slice(0, 120)}`);
  }

  const open = cleaned[startIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        const jsonStr = cleaned.slice(startIdx, i + 1);
        return JSON.parse(jsonStr);
      }
    }
  }

  throw new SyntaxError(`Unbalanced JSON in response: ${cleaned.slice(0, 120)}`);
}

module.exports = { extractJSON, stripFences };
