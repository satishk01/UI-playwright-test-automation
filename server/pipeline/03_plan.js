const { createLLMClient } = require('../utils/llm-client');
const { extractJSON } = require('../utils/json-extract');
const { isTimeSensitiveName } = require('../utils/time-sensitive');
const { describeElementsForPrompt } = require('../utils/aria-snapshot');
const { detectCascadingDropdowns } = require('../utils/page-model');

class Planner {
  constructor(llmConfig = {}, description = '') {
    this.llm = createLLMClient(llmConfig);
    this.maxTestsPerPlan = parseInt(process.env.MAX_TESTS_PER_PLAN || '4', 10);
    this.description = (description || '').trim();
  }

  /**
   * @param {object[]} pageModels
   * @param {object[]} snapshots
   * @param {object} [opts]
   * @param {Set<string>} [opts.skipFunctionalPages] — page URLs whose
   *   Functional spec is served from the cross-run cache (§9): skip the LLM
   *   call entirely for these pages.
   */
  async plan(pageModels, snapshots, opts = {}) {
    const allPlans = [];

    for (const model of pageModels) {
      const snapshot = snapshots.find(s => s.url === model.url) || snapshots[0];
      const pagePlans = await this.planOnePage(model, snapshot, {
        skipFunctional: opts.skipFunctionalPages && opts.skipFunctionalPages.has(model.url),
      });
      allPlans.push(...pagePlans);
    }

    return allPlans;
  }

  async planOnePage(pageModel, snapshot, opts = {}) {
    const plans = [];

    // §6: Navigation / Forms / Accessibility plans are built deterministically
    // — the data they need (links, form fields, element names) is already in
    // the snapshot. The LLM only adds real value for the Functional suite
    // (intent inference, multi-step flows, business context).
    plans.push(...this.generateDeterministicPlans(pageModel, snapshot));

    if (!opts.skipFunctional) {
      const functionalPlan = await this.planFunctionalLLM(pageModel, snapshot);
      if (functionalPlan) {
        plans.push(functionalPlan);
      } else {
        // The LLM call failed or produced no valid tests — emit a marked
        // stub so the suite still appears in results as fixme instead of
        // silently vanishing (a whole missing suite is invisible in the
        // report, which hides coverage loss).
        plans.push({
          page: pageModel.url,
          path: pageModel.path,
          suite: 'Functional',
          tests: [],
          planningFailed: true,
        });
      }
    } else {
      // §9: the Functional spec is served from the cross-run cache — emit a
      // stub plan so the Generator's cache-hit branch still writes the cached
      // spec file. Without this the suite would silently disappear on re-runs.
      plans.push({
        page: pageModel.url,
        path: pageModel.path,
        suite: 'Functional',
        tests: [],
        cached: true,
      });
    }

    return plans;
  }

  /**
   * The single LLM call per page (§6): plan the Functional suite and infer
   * the page's `purpose` as a side output.
   */
  async planFunctionalLLM(pageModel, snapshot) {
    const roleNameList = describeElementsForPrompt(snapshot, { includeHidden: true });

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

    const formsDetail = this.buildFormsDetail(pageModel, snapshot);

    const appContextBlock = this.description
      ? `\nApplication context (provided by the user — use this to generate more relevant test scenarios):\n${this.description}\n`
      : '';

    const functionality = snapshot.functionality;
    const functionalityBlock = (Array.isArray(functionality) && functionality.length > 0)
      ? `\nRECENTLY CHANGED FUNCTIONALITY on this screen (prioritise tests around these, but still test the rest of the page):\n` +
        functionality.map(f => `  - ${f}`).join('\n') + `\n`
      : '';

    const screenDescription = snapshot.screenDescription;
    const descriptionBlock = (typeof screenDescription === 'string' && screenDescription.trim().length > 0)
      ? `\nSCREEN CONTEXT / REQUIREMENTS (user-provided — e.g. Jira task, user story, acceptance criteria):\n${screenDescription.trim()}\n` +
        `Use this context to generate tests that verify the described requirements and acceptance criteria.\n` +
        `Still test the rest of the page — this context focuses intent, it does not restrict scope.\n`
      : '';

    const apiSummary = snapshot.apiSummary || [];
    const apiBlock = apiSummary.length > 0
      ? `\nAPI CALLS DETECTED — this page fetches data from APIs (SPA with async data fetch).\n` +
        `Detected API endpoints:\n` +
        apiSummary.map(a => `  ${a.methods.join('/')} ${a.pattern} (${a.count} call${a.count > 1 ? 's' : ''})`).join('\n') +
        `\nUse "waitForApiResponse" action with value set to the API URL pattern after steps that trigger API calls.\n`
      : '';

    // §2: deterministic failure signals — JS errors observed during capture.
    // Elements revealed by opening collapsed disclosures (menus, popups,
    // accordions) during exploration. They are not rendered at rest, so
    // the planner must emit a trigger step before interacting with them.
    const revealed = (snapshot.roleNamePairs || []).filter(e => e.revealedBy && e.name);
    const revealedBlock = revealed.length > 0
      ? `REVEALED ELEMENTS — these live inside collapsed menus/popups/accordions and only exist after their trigger is opened:\n` +
        revealed.slice(0, 40).map(e => `  [${e.role}] '${e.name}' (revealed by "${e.revealedBy}")`).join('\n')
      : '';

    const pageErrors = [...(snapshot.pageErrors || []), ...(snapshot.consoleErrors || [])].slice(0, 10);
    const errorsBlock = pageErrors.length > 0
      ? `\nJS ERRORS OBSERVED during page capture (avoid tests that depend on the broken areas):\n` +
        pageErrors.map(e => `  - ${String(e).slice(0, 200)}`).join('\n') + `\n`
      : '';

    // Static rules go in `system` (§9 prompt caching): identical across all
    // pages, so Anthropic/Bedrock serve them from the prompt cache at ~10%
    // of the input cost on every call after the first.
    const systemPrompt = `You are generating Playwright test plans for the FUNCTIONAL suite of a web page — user journeys that exercise real features (dialogs, dropdowns, search, filters, multi-step flows, business behaviors). Navigation, Forms, and Accessibility suites are handled separately — do NOT plan simple link-clicks, pure form fills, or visibility checks.

Respond with ONLY a JSON object (no markdown fences):
{
  "purpose": "one-line description of what this page does",
  "tests": [
    {
      "name": "descriptive test name",
      "steps": [
        {
          "action": "click|fill|check|select|navigate|hover|press|wait|waitForOptions|waitForApiResponse",
          "target": { "role": "exact role", "name": "exact name from tree" },
          "value": "for fill/select actions, the value to enter. For waitForApiResponse, the API URL pattern. null otherwise",
          "expectedOutcome": "description of what should happen",
          "dependsOn": "step index (0-based) that must complete before this step, or null if no dependency"
        }
      ]
    }
  ]
}

CRITICAL RULES:
1. Every target.name MUST be an exact string from the available elements list.
2. Every target.role MUST match the role from the available elements list.
3. Do not invent element names or roles. If an element doesn't exist, don't write a test for it.
4. Keep tests realistic and self-contained — each test should verify one user journey.
5. Max ${this.maxTestsPerPlan} tests.
6. Do NOT use element names that contain countdown timers or dynamic time-based text. Skip those tests.
7. For DUPLICATE elements (listed above), do NOT write click tests for them — clicks will cause strict mode violations.
8. Each test's last step should have an expectedOutcome that describes a SPECIFIC, verifiable outcome — not a generic "page loads".
9. For Functional tests, assert the specific feature behavior (dialog opens, dropdown expands, search results appear).
10. If the page makes API calls, use "waitForApiResponse" with a URL substring value after steps that trigger API calls.
11. For elements listed under REVEALED ELEMENTS (inside collapsed menus/popups), add a click (or hover) step on the named trigger BEFORE the step that targets the element — the element does not exist until the trigger opens it.
12. Return AT LEAST ONE test. If the page is truly static with no functional behavior, still write a meaningful smoke test (e.g. verify a primary content element renders).`;

    const prompt = `Plan the FUNCTIONAL test suite for this page.
${appContextBlock}${functionalityBlock}${descriptionBlock}${apiBlock}${errorsBlock}
Page: ${pageModel.url}
Title: ${pageModel.title}
Type: ${pageModel.siteType}
Purpose: ${pageModel.purpose}

Page Model:
${JSON.stringify(pageModel, null, 2)}

Available elements (use ONLY these — [ref=eN] are stable element refs, [box=x,y,w,h] zero-size means NOT rendered):
${roleNameList}

${revealedBlock}

${duplicates ? `DUPLICATE ELEMENTS (appear multiple times — do NOT write tests that click these without disambiguation):\n${duplicates}\n` : ''}

${formsDetail ? `FORM FIELD RELATIONSHIPS:\n${formsDetail}\n` : ''}`;

    let rawResponse = null;
    try {
      // §9: structured output request — providers that support it return
      // guaranteed-parseable JSON, eliminating extractJSON fallback re-calls.
      // §9: the static rules ride in `system` with prompt caching enabled.
      rawResponse = await this.llm.complete(prompt, {
        maxTokens: 8192,
        json: true,
        system: systemPrompt,
        cache: true,
      });
      const parsed = extractJSON(rawResponse);
      const tests = Array.isArray(parsed) ? parsed : (parsed.tests || []);

      const validTests = this.validateSteps(tests, snapshot, false);
      if (validTests.length === 0) {
        console.warn(`[plan] Functional plan for ${pageModel.url} produced no valid tests`);
        return null;
      }

      // Side output: fold the inferred purpose back into the page model.
      if (parsed.purpose && typeof parsed.purpose === 'string') {
        pageModel.purpose = parsed.purpose;
      }

      return {
        page: pageModel.url,
        path: pageModel.path,
        suite: 'Functional',
        tests: validTests.slice(0, this.maxTestsPerPlan),
      };
    } catch (err) {
      console.error(`Failed to plan Functional suite for ${pageModel.url}: ${err.message}`);
      if (rawResponse) {
        console.error(`[DEBUG plan] Raw response tail (last 500 chars):\n${rawResponse.slice(-500)}`);
      }
      return null;
    }
  }

  /**
   * Validate planned steps against the snapshot — drop steps targeting
   * nonexistent/time-sensitive elements, mark hidden elements so the
   * Generator wraps their assertions in .catch().
   */
  validateSteps(tests, snapshot, isAccessibilitySuite) {
    return (tests || []).map(test => ({
      ...test,
      steps: (test.steps || []).filter(step => {
        if (!step.target || !step.target.name) return true;
        // Reject time-sensitive element names — they'll fail at execution time
        if (isTimeSensitiveName(step.target.name)) return false;
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
          step.target.name = matchEl.name;
          if (matchEl.iframeSelector) {
            step.target.iframeSelector = matchEl.iframeSelector;
          }
          if (isAccessibilitySuite && matchEl.visible === false) {
            return false;
          }
          if (matchEl.visible === false) {
            step.target.hidden = true;
          }
          return true;
        }
        return false;
      }),
    })).filter(test => (test.steps || []).length > 0);
  }

  /**
   * Build Navigation / Forms / Accessibility plans deterministically (§6).
   * Previously this was generateFallbackPlans(), used only when the LLM
   * failed — it is now the primary path for these three suites.
   */
  generateDeterministicPlans(pageModel, snapshot) {
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
          name: `Navigate via ${exactName} link`,
          steps: [
            {
              action: 'click',
              target: { role: 'link', name: exactName },
              value: null,
              expectedOutcome: `URL changes or destination content appears`,
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
          const hidden = matchEl && matchEl.visible === false;

          if (field.role === 'combobox') {
            steps.push({
              action: 'select',
              target: { role: 'combobox', name: exactName, ...(hidden ? { hidden: true } : {}) },
              value: field.sampleValue || '',
              expectedOutcome: `Dropdown value selected`,
              dependsOn: field.dependsOn ? steps.length - 1 : null,
            });
            // If cascading, add waitForOptions after parent select
            if (field.dependsOn && form.isCascading) {
              steps.push({
                action: 'waitForOptions',
                target: { role: 'combobox', name: exactName, ...(hidden ? { hidden: true } : {}) },
                value: null,
                expectedOutcome: `Dependent dropdown options populate`,
                dependsOn: steps.length - 1,
              });
            }
          } else {
            steps.push({
              action: 'fill',
              target: { role: field.role, name: exactName, ...(hidden ? { hidden: true } : {}) },
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

    // ── Accessibility plan ──
    // Deterministic semantic checks (§5): the Generator turns these into
    // toHaveAccessibleName/toHaveAccessibleRole assertions plus a
    // toMatchAriaSnapshot baseline diff — no LLM involvement at all.
    const accessibleTargets = roleNamePairs
      .filter(e => e.name && e.name.trim() && e.visible !== false)
      // Skip names with no letters/digits — lone icon-font glyphs
      // (private-use-area chars, e.g. icon fonts) or whitespace produce meaningless assertions.
      .filter(e => /[\p{L}\p{N}]/u.test(e.name))
      .filter(e => ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'searchbox', 'heading', 'navigation', 'main', 'banner', 'contentinfo'].includes(e.role))
      .filter((e, i, arr) => arr.findIndex(x => x.role === e.role && x.name === e.name) === i)
      .slice(0, maxTests * 2);

    if (accessibleTargets.length > 0) {
      plans.push({
        page: pageModel.url,
        path: pageModel.path,
        suite: 'Accessibility',
        tests: [
          {
            name: 'Verify key elements have correct accessible names and roles',
            steps: accessibleTargets.map(el => ({
              action: 'check',
              target: { role: el.role, name: el.name },
              value: null,
              expectedOutcome: 'Element exposes the expected accessible name and role',
              dependsOn: null,
            })),
          },
        ],
      });
    }

    console.log(`[plan] Deterministic generated ${plans.length} plan(s) with ${plans.reduce((s, p) => s + p.tests.length, 0)} test(s) for ${pageModel.url}`);
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
        const cascadeHints = detectCascadingDropdowns(combos);
        if (cascadeHints) {
          lines.push(`  CASCADING DROPDOWNS DETECTED:`);
          lines.push(cascadeHints);
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  getUsage() {
    return this.llm.getUsage();
  }
}

module.exports = { Planner };
