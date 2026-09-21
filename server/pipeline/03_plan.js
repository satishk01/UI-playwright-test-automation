const { createLLMClient } = require('../utils/llm-client');
const { extractJSON } = require('../utils/json-extract');
const { isTimeSensitiveName } = require('../utils/time-sensitive');

class Planner {
  constructor(llmConfig = {}, description = '') {
    this.llm = createLLMClient(llmConfig);
    this.maxTestsPerPlan = parseInt(process.env.MAX_TESTS_PER_PLAN || '4', 10);
    this.description = (description || '').trim();
  }

  async plan(pageModels, snapshots) {
    const allPlans = [];

    for (const model of pageModels) {
      const snapshot = snapshots.find(s => s.url === model.url) || snapshots[0];
      const pagePlans = await this.planOnePage(model, snapshot);
      allPlans.push(...pagePlans);
    }

    return allPlans;
  }

  async planOnePage(pageModel, snapshot) {
    const roleNameList = snapshot.roleNamePairs
      .filter(e => e.name)
      .map(e => {
        if (e.iframeSelector) {
          return `[${e.role}] '${e.name}' (inside iframe: ${e.iframeSelector})`;
        }
        return `[${e.role}] '${e.name}'`;
      })
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
        const idx = key.indexOf(':');
        return `  [${key.substring(0, idx)}] '${key.substring(idx + 1)}' appears ${count} times`;
      })
      .join('\n');

    // Build a detailed form summary that includes field relationships
    const formsDetail = this.buildFormsDetail(pageModel, snapshot);

    const appContextBlock = this.description
      ? `\nApplication context (provided by the user — use this to generate more relevant test scenarios):\n${this.description}\n`
      : '';

    // Functionality hints — when the user targeted specific screens (e.g. the
    // screens that changed in this release), they can optionally list the
    // functionality that was created or updated on each screen. We surface
    // this to the LLM so it prioritises tests around the changed areas while
    // still covering the rest of the page (the system does detailed testing
    // regardless; these hints only focus priority, they do not restrict scope).
    const functionality = snapshot.functionality;
    const functionalityBlock = (Array.isArray(functionality) && functionality.length > 0)
      ? `\nRECENTLY CHANGED FUNCTIONALITY on this screen (prioritise tests around these, but still test the rest of the page):\n` +
        functionality.map(f => `  - ${f}`).join('\n') + `\n`
      : '';

    // Screen description — the user can paste a Jira task, user story, or any
    // free-form context for this screen.  This gives the LLM richer intent so
    // it generates more targeted tests that match the acceptance criteria and
    // business requirements, supplementing the automatic element-based testing.
    const screenDescription = snapshot.screenDescription;
    const descriptionBlock = (typeof screenDescription === 'string' && screenDescription.trim().length > 0)
      ? `\nSCREEN CONTEXT / REQUIREMENTS (user-provided — e.g. Jira task, user story, acceptance criteria):\n${screenDescription.trim()}\n` +
        `Use this context to generate tests that verify the described requirements and acceptance criteria.\n` +
        `Still test the rest of the page — this context focuses intent, it does not restrict scope.\n`
      : '';

    // API context — if the snapshot captured API calls, tell the Planner so it
    // can generate waitForApiResponse steps for API-driven interactions.
    const apiSummary = snapshot.apiSummary || [];
    const apiBlock = apiSummary.length > 0
      ? `\nAPI CALLS DETECTED — this page fetches data from APIs (SPA with async data fetch).\n` +
        `Detected API endpoints:\n` +
        apiSummary.map(a => `  ${a.methods.join('/')} ${a.pattern} (${a.count} call${a.count > 1 ? 's' : ''})`).join('\n') +
        `\nUse "waitForApiResponse" action with value set to the API URL pattern after steps that trigger API calls.\n`
      : '';

    const prompt = `Generate test plans for this page. Each plan is scoped to one suite type.
${appContextBlock}${functionalityBlock}${descriptionBlock}${apiBlock}
Page: ${pageModel.url}
Title: ${pageModel.title}
Type: ${pageModel.siteType}
Purpose: ${pageModel.purpose}

Page Model:
${JSON.stringify(pageModel, null, 2)}

Available elements (from accessibility tree — use ONLY these exact [role] 'name' pairs):
${roleNameList}

${duplicates ? `DUPLICATE ELEMENTS (appear multiple times — do NOT write tests that click these without disambiguation):\n${duplicates}\n` : ''}

${formsDetail ? `FORM FIELD RELATIONSHIPS:\n${formsDetail}\n` : ''}

Generate plans for applicable suite types: Navigation, Functional, Forms, Accessibility.
Each plan has at most ${this.maxTestsPerPlan} tests.

Respond with ONLY a JSON array (no markdown fences):
[
  {
    "page": "${pageModel.url}",
    "path": "${pageModel.path}",
    "suite": "Navigation|Functional|Forms|Accessibility",
    "tests": [
      {
        "name": "descriptive test name",
        "steps": [
          {
            "action": "click|fill|check|select|navigate|hover|press|wait|waitForOptions|waitForApiResponse",
            "target": { "role": "exact role", "name": "exact name from tree" },
            "value": "for fill/select actions, the value to enter. For waitForApiResponse, the API URL pattern to wait for (e.g. '/api/products'). null otherwise",
            "expectedOutcome": "description of what should happen",
            "dependsOn": "step index (0-based) that must complete before this step, or null if no dependency"
          }
        ]
      }
    ]
  }
]

CRITICAL RULES:
1. Every target.name MUST be an exact string from the available elements list.
2. Every target.role MUST match the role from the available elements list.
3. Do not invent element names or roles. If an element doesn't exist, don't write a test for it.
4. Keep tests realistic and self-contained — each test should verify one user journey.
5. Max ${this.maxTestsPerPlan} tests per plan.
6. Do NOT use element names that contain countdown timers or dynamic time-based text (e.g., "Sale ends in 6 days : 1 hrs : 6 min : 26 sec"). Skip those tests.
7. For DUPLICATE elements (listed above), do NOT write click tests for them — clicks will cause strict mode violations. Instead, assert they are visible using a visibility check: the test generator will automatically add .first() and { exact: true } to disambiguate.

FORM-SPECIFIC RULES:
8. For cascading/dependent dropdowns (e.g., Year → Model → Trim), use the "waitForOptions" action AFTER selecting the parent field and BEFORE selecting the child field. This tells the test generator to wait for the child dropdown's options to populate.
9. Use "dependsOn" to explicitly mark step dependencies — the generator will add appropriate waits.
10. For multi-step forms, fill fields in the correct order (parent before child) and add a "wait" step between dependent selects.
11. For form submission tests, always include the submit button click as the last step and assert the expected outcome (URL change, success message, or error message).
12. For search forms, fill the search field, click search, and assert that search results are visible or the URL changed to a results page.

ASSERTION RULES:
13. Each test's last step should have an expectedOutcome that describes a SPECIFIC, verifiable outcome — not a generic "page loads". Use outcomes like "URL changes to /results", "success message 'Vehicle added' appears", "dropdown options populate with models for selected year".
14. For Navigation tests, assert URL changes or specific page content appears.
15. For Functional tests, assert the specific feature behavior (dialog opens, dropdown expands, search results appear).
16. For Accessibility tests, assert the element is visible, focusable, or has the expected ARIA state.

API-DRIVEN SPA RULES (for SPA apps that fetch data from APIs — any framework, any backend):
17. If the page makes API calls on load or after interactions, use the "waitForApiResponse" action to wait for the API response before asserting on the rendered content. Set "value" to a URL substring that identifies the API (e.g. "/api/products", "execute-api").
18. After clicking a link/button that triggers an API call and re-renders content, add a "waitForApiResponse" step with dependsOn pointing to the click step.
19. For dependent dropdowns backed by APIs (selecting Year fetches Models from /api/models), add a "waitForApiResponse" step with value="/api/models" AFTER the parent select and BEFORE the child select.
20. Do NOT use waitForApiResponse for static content that doesn't involve API calls — use "wait" or "waitForOptions" instead.`;

    let rawResponse = null;
    try {
      rawResponse = await this.llm.complete(prompt, { maxTokens: 8192 });
      console.log(`[DEBUG plan] LLM response length=${rawResponse.length}, first 300 chars:\n${rawResponse.substring(0, 300)}`);
      const plans = extractJSON(rawResponse);

      // Validate: ensure all targets reference real elements AND filter out
      // time-sensitive element names (countdown timers) that will change between
      // planning and test execution, causing locator mismatches.
      const isTimeSensitive = isTimeSensitiveName;

      const validatedPlans = plans.map(plan => {
        const isAccessibilitySuite = plan.suite === 'Accessibility';
        return {
          ...plan,
          tests: plan.tests.map(test => ({
            ...test,
            steps: test.steps.filter(step => {
              if (!step.target || !step.target.name) return true;
              // Reject time-sensitive element names — they'll fail at execution time
              if (isTimeSensitive(step.target.name)) return false;
              // Find the matching element — try exact match first, then fuzzy
              let matchEl = snapshot.roleNamePairs.find(
                e => e.role === step.target.role && e.name === step.target.name
              );
              // Fuzzy fallback: trim whitespace + case-insensitive
              if (!matchEl) {
                matchEl = snapshot.roleNamePairs.find(
                  e => e.role === step.target.role &&
                    (e.name || '').trim().toLowerCase() === (step.target.name || '').trim().toLowerCase()
                );
              }
              if (matchEl) {
                // Use the exact name from the snapshot for the generated test
                step.target.name = matchEl.name;
                // Preserve iframe selector so the Generator can use frameLocator()
                if (matchEl.iframeSelector) {
                  step.target.iframeSelector = matchEl.iframeSelector;
                }
                // Skip steps targeting hidden elements in Accessibility suites.
                // Accessibility tests assert elements are visible/focusable, but
                // hidden elements (e.g. spinbuttons inside a collapsed date/time
                // picker) will always fail these assertions. The element exists
                // in the DOM but isn't visible until a trigger opens the widget.
                if (isAccessibilitySuite && matchEl.visible === false) {
                  return false;
                }
                // For Forms/Functional suites, mark hidden elements so the
                // Generator knows to wrap assertions on them in .catch() or
                // skip them if the trigger click didn't open the widget.
                if (matchEl.visible === false) {
                  step.target.hidden = true;
                }
                return true;
              }
              return false;
            }),
          })).filter(test => test.steps.length > 0),
        };
      }).filter(plan => plan.tests.length > 0);

      if (validatedPlans.length > 0) {
        return validatedPlans;
      }

      // All plans were filtered out — fall through to fallback
      console.warn(`[plan] LLM returned ${plans.length} plan(s) but all were filtered out by validation — using fallback`);
      return this.generateFallbackPlans(pageModel, snapshot);

    } catch (err) {
      console.error(`Failed to plan for ${pageModel.url}: ${err.message}`);
      if (rawResponse) {
        console.error(`[DEBUG plan] Raw response tail (last 500 chars):\n${rawResponse.slice(-500)}`);
      }
      // Fallback: generate basic plans from the page model directly
      return this.generateFallbackPlans(pageModel, snapshot);
    }
  }

  /**
   * Generate basic test plans from the page model when the LLM fails to produce
   * parseable output or all LLM-generated plans are filtered out by validation.
   * Creates Navigation plans from page navigation links and Forms plans from
   * page form definitions — no LLM required.
   */
  generateFallbackPlans(pageModel, snapshot) {
    const plans = [];
    const roleNamePairs = snapshot.roleNamePairs || [];
    const maxTests = this.maxTestsPerPlan;

    // ── Navigation plan ──
    const navLinks = (pageModel.navigation || [])
      .filter(n => n.role === 'link' && n.name && n.name.trim() && n.destination)
      .filter(n => !isTimeSensitiveName(n.name))
      // Deduplicate by name
      .filter((n, i, arr) => arr.findIndex(x => x.name === n.name) === i)
      .slice(0, maxTests);

    if (navLinks.length > 0) {
      const tests = navLinks.map(link => {
        // Verify the link exists in the snapshot
        const matchEl = roleNamePairs.find(
          e => e.role === 'link' &&
            (e.name || '').trim().toLowerCase() === (link.name || '').trim().toLowerCase()
        );
        const exactName = matchEl ? matchEl.name : link.name.trim();
        return {
          name: `Navigate to ${link.destination} via ${exactName} link`,
          steps: [
            {
              action: 'click',
              target: { role: 'link', name: exactName },
              value: null,
              expectedOutcome: `URL changes to ${link.destination}`,
              dependsOn: null,
            },
          ],
        };
      }).filter(t => t !== null);

      if (tests.length > 0) {
        plans.push({
          page: pageModel.url,
          path: pageModel.path,
          suite: 'Navigation',
          tests,
        });
      }
    }

    // ── Forms plan ──
    const forms = (pageModel.forms || []).filter(f => f.fields && f.fields.length > 0);
    if (forms.length > 0) {
      const tests = forms.slice(0, maxTests).map((form, i) => {
        const steps = [];
        for (const field of form.fields) {
          if (!field.name || !field.name.trim()) continue; // Skip fields with empty names
          if (isTimeSensitiveName(field.name)) continue;

          // Verify the field exists in the snapshot
          const matchEl = roleNamePairs.find(
            e => e.role === field.role &&
              (e.name || '').trim().toLowerCase() === (field.name || '').trim().toLowerCase()
          );
          const exactName = matchEl ? matchEl.name : field.name.trim();

          if (field.role === 'combobox') {
            steps.push({
              action: 'select',
              target: { role: 'combobox', name: exactName },
              value: field.sampleValue || '',
              expectedOutcome: `Dropdown value selected`,
              dependsOn: field.dependsOn ? steps.length - 1 : null,
            });
            // If cascading, add waitForOptions after parent select
            if (field.dependsOn && form.isCascading) {
              steps.push({
                action: 'waitForOptions',
                target: { role: 'combobox', name: exactName },
                value: null,
                expectedOutcome: `Dependent dropdown options populate`,
                dependsOn: steps.length - 1,
              });
            }
          } else {
            steps.push({
              action: 'fill',
              target: { role: field.role, name: exactName },
              value: field.sampleValue || 'test input',
              expectedOutcome: `Field filled with value`,
              dependsOn: null,
            });
          }
        }

        // Add submit button click
        if (form.submitElement && form.submitElement.name) {
          const submitMatch = roleNamePairs.find(
            e => e.role === form.submitElement.role &&
              (e.name || '').trim().toLowerCase() === (form.submitElement.name || '').trim().toLowerCase()
          );
          const submitName = submitMatch ? submitMatch.name : form.submitElement.name.trim();
          steps.push({
            action: 'click',
            target: { role: form.submitElement.role, name: submitName },
            value: null,
            expectedOutcome: 'Form submitted successfully',
            dependsOn: steps.length - 1,
          });
        }

        return {
          name: form.purpose || `Form ${i + 1} submission`,
          steps,
        };
      }).filter(test => test.steps.length > 0);

      if (tests.length > 0) {
        plans.push({
          page: pageModel.url,
          path: pageModel.path,
          suite: 'Forms',
          tests,
        });
      }
    }

    // ── Accessibility plan (always include if there are interactive elements) ──
    // Only include elements that are visible — hidden elements (e.g. inside
    // collapsed widgets) will fail accessibility visibility assertions.
    const interactiveCount = (pageModel.navigation || []).length + (pageModel.forms || []).length;
    if (interactiveCount > 0) {
      plans.push({
        page: pageModel.url,
        path: pageModel.path,
        suite: 'Accessibility',
        tests: [
          {
            name: 'Verify main navigation links are accessible',
            steps: navLinks.slice(0, 3).map(link => {
              const matchEl = roleNamePairs.find(
                e => e.role === 'link' &&
                  (e.name || '').trim().toLowerCase() === (link.name || '').trim().toLowerCase()
              );
              // Skip hidden links — they'll fail visibility assertions
              if (matchEl && matchEl.visible === false) return null;
              return {
                action: 'check',
                target: { role: 'link', name: matchEl ? matchEl.name : link.name.trim() },
                value: null,
                expectedOutcome: 'Element is visible and focusable',
                dependsOn: null,
              };
            }).filter(s => s && s.target.name),
          },
        ].filter(t => t.steps.length > 0),
      });
    }

    console.log(`[plan] Fallback generated ${plans.length} plan(s) with ${plans.reduce((s, p) => s + p.tests.length, 0)} test(s) for ${pageModel.url}`);
    return plans;
  }

  /**
   * Build a detailed form summary that identifies field relationships and
   * cascading dependencies. This information is passed to the LLM so it can
   * generate tests that respect form field ordering.
   */
  buildFormsDetail(pageModel, snapshot) {
    if (!pageModel.forms || pageModel.forms.length === 0) return '';

    const lines = [];

    for (let i = 0; i < pageModel.forms.length; i++) {
      const form = pageModel.forms[i];
      lines.push(`Form ${i + 1}: ${form.purpose || 'Unknown purpose'}`);

      if (form.fields && form.fields.length > 0) {
        lines.push('  Fields (in order of expected interaction):');
        for (let j = 0; j < form.fields.length; j++) {
          const field = form.fields[j];
          const req = field.required ? ' [required]' : '';
          const sample = field.sampleValue ? ` (sample: "${field.sampleValue}")` : '';
          lines.push(`    ${j + 1}. [${field.role}] '${field.name}'${req}${sample}`);
        }
      }

      if (form.submitElement) {
        lines.push(`  Submit: [${form.submitElement.role}] '${form.submitElement.name}'`);
      }

      // Detect potential cascading dropdowns — combobox fields with names
      // suggesting hierarchical relationships (year/model/trim, country/state/city, etc.)
      const combos = (form.fields || []).filter(f => f.role === 'combobox' || f.type === 'select-one');
      if (combos.length >= 2) {
        const cascadeHints = this.detectCascadingDropdowns(combos);
        if (cascadeHints) {
          lines.push(`  CASCADING DROPDOWNS DETECTED:`);
          lines.push(cascadeHints);
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Detect cascading dropdown patterns by analyzing field names.
   * Common patterns: year→model→trim, country→state→city, category→subcategory.
   */
  detectCascadingDropdowns(combos) {
    const cascadePatterns = [
      { keywords: ['year', 'model', 'trim', 'make', 'submodel', 'engine', 'driveline', 'transmission'], label: 'vehicle selector' },
      { keywords: ['country', 'state', 'city', 'province', 'region', 'zip', 'postal'], label: 'address selector' },
      { keywords: ['category', 'subcategory', 'type', 'subtype'], label: 'category selector' },
      { keywords: ['brand', 'product', 'variant', 'size', 'color'], label: 'product selector' },
    ];

    const comboNames = combos.map(c => (c.name || '').toLowerCase());
    const lines = [];

    for (const pattern of cascadePatterns) {
      const matches = combos.filter(c =>
        pattern.keywords.some(kw => (c.name || '').toLowerCase().includes(kw))
      );

      if (matches.length >= 2) {
        // Sort by keyword priority to get the correct order
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

    // Generic heuristic: if 2+ comboboxes and names suggest ordering (contains numbers or sequential words)
    if (lines.length === 0 && combos.length >= 2) {
      lines.push(`    Multiple dropdowns detected. Fill in order: ${combos.map(c => `'${c.name}'`).join(' → ')}`);
      lines.push(`    If selecting one dropdown changes the options of another, wait for options to update between selections.`);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  getUsage() {
    return this.llm.getUsage();
  }
}

module.exports = { Planner };
