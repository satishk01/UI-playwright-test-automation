/**
 * Deterministic PageModel builder — token-reduction plan §6.
 *
 * The Analyze stage used to burn one LLM call per page to produce a
 * PageModel whose fields are mostly derivable from the snapshot. This module
 * builds the same shape deterministically; the one remaining LLM call (the
 * Functional-suite planner) emits `purpose` as a side output when it runs.
 */

/**
 * Guess the site's type from URL/title heuristics. Used by the Planner prompt
 * to contextualize Functional test generation.
 */
function inferSiteType(snapshot) {
  const hay = `${snapshot.url || ''} ${snapshot.title || ''}`.toLowerCase();
  const has = (...kws) => kws.some(k => hay.includes(k));
  if (has('login', 'signin', 'sign-in', 'register', 'signup', 'auth')) return 'auth';
  if (has('checkout', 'cart', 'shop', 'store', 'product', 'order', 'buy')) return 'e-commerce';
  if (has('search', 'results', 'find', 'parts', 'catalog')) return 'search/catalog';
  if (has('dashboard', 'admin', 'account', 'profile', 'settings')) return 'dashboard';
  if (has('blog', 'article', 'news', 'post')) return 'blog';
  if (has('docs', 'documentation', 'guide', 'reference', 'api')) return 'documentation';
  if ((snapshot.forms || []).length > 0) return 'form-based';
  return 'web-app';
}

/**
 * Detect cascading dropdown patterns by analyzing field names.
 * Common patterns: year→model→trim, country→state→city, category→subcategory.
 * (Moved from 03_plan.js so both the analyzer and planner share it.)
 */
function detectCascadingDropdowns(combos) {
  const cascadePatterns = [
    { keywords: ['year', 'model', 'trim', 'make', 'submodel', 'engine', 'driveline', 'transmission'], label: 'vehicle selector' },
    { keywords: ['country', 'state', 'city', 'province', 'region', 'zip', 'postal'], label: 'address selector' },
    { keywords: ['category', 'subcategory', 'type', 'subtype'], label: 'category selector' },
    { keywords: ['brand', 'product', 'variant', 'size', 'color'], label: 'product selector' },
  ];

  const lines = [];

  for (const pattern of cascadePatterns) {
    const matches = combos.filter(c =>
      pattern.keywords.some(kw => (c.name || '').toLowerCase().includes(kw))
    );

    if (matches.length >= 2) {
      const ordered = matches.sort((a, b) => {
        const aIdx = Math.min(...pattern.keywords.map((kw, idx) =>
          (a.name || '').toLowerCase().includes(kw) ? idx : 999));
        const bIdx = Math.min(...pattern.keywords.map((kw, idx) =>
          (b.name || '').toLowerCase().includes(kw) ? idx : 999));
        return aIdx - bIdx;
      });

      lines.push(`    This appears to be a ${pattern.label} cascade.`);
      lines.push(`    Fill order: ${ordered.map(c => `'${c.name}'`).join(' → ')}`);
      lines.push(`    After selecting each parent dropdown, wait for child options to populate before selecting the next.`);
    }
  }

  if (lines.length === 0 && combos.length >= 2) {
    lines.push(`    Multiple dropdowns detected. Fill in order: ${combos.map(c => `'${c.name}'`).join(' → ')}`);
    lines.push(`    If selecting one dropdown changes the options of another, wait for options to update between selections.`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Map a raw snapshot form into the PageModel form shape.
 */
function mapForm(f) {
  const fields = (f.fields || []).map(fld => ({
    role: fld.type === 'select-one' || fld.tagName === 'select' ? 'combobox'
      : fld.type === 'checkbox' ? 'checkbox'
      : fld.type === 'radio' ? 'radio'
      : 'textbox',
    name: fld.name || fld.placeholder || fld.ariaLabel || '',
    required: fld.required || false,
    sampleValue: null,
    dependsOn: null,
    fillOrder: 1,
  }));

  const combos = fields.filter(fld => fld.role === 'combobox');
  const cascadeHint = combos.length >= 2 ? detectCascadingDropdowns(combos) : null;

  return {
    purpose: `Form with ${fields.length} fields`,
    fields,
    submitElement: null,
    isCascading: !!cascadeHint && !cascadeHint.startsWith('    Multiple'),
    cascadingDescription: cascadeHint,
  };
}

/**
 * Build a PageModel from a page snapshot — no LLM required.
 * @param {object} snapshot — output of Explorer.capturePage()
 * @returns {object} PageModel
 */
function buildPageModel(snapshot) {
  const interactive = snapshot.interactiveElements || [];

  const navigation = interactive
    .filter(e => (e.role === 'link' || e.role === 'button') && e.name)
    // dedupe by role+name
    .filter((e, i, arr) => arr.findIndex(x => x.role === e.role && x.name === e.name) === i)
    .slice(0, 20)
    .map(e => ({ role: e.role, name: e.name, destination: 'unknown' }));

  const forms = (snapshot.forms || []).map(mapForm);

  const keyElements = interactive
    .filter(e => e.name)
    .slice(0, 20)
    .map(e => ({ role: e.role, name: e.name, significance: 'interactive element' }));

  return {
    url: snapshot.url,
    path: snapshot.path,
    title: snapshot.title,
    siteType: inferSiteType(snapshot),
    purpose: `Page: ${snapshot.title || snapshot.path || snapshot.url}`,
    navigation,
    forms,
    keyElements,
    behaviors: [],
    interactiveElements: interactive,
  };
}

module.exports = { buildPageModel, inferSiteType, detectCascadingDropdowns, mapForm };
