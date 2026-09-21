const { createLLMClient } = require('../utils/llm-client');
const { extractJSON } = require('../utils/json-extract');

class Analyzer {
  constructor(llmConfig = {}, description = '') {
    this.llm = createLLMClient(llmConfig);
    this.description = (description || '').trim();
  }

  async analyze(snapshots) {
    const pageModels = [];

    for (const snapshot of snapshots) {
      const model = await this.analyzeOnePage(snapshot);
      pageModels.push(model);
    }

    return pageModels;
  }

  async analyzeOnePage(snapshot) {
    const interactiveSummary = snapshot.interactiveElements
      .map(e => `[${e.role}] '${e.name}'${e.disabled ? ' (disabled)' : ''}`)
      .join('\n');

    const formsSummary = snapshot.forms
      .map((f, i) => {
        const fields = f.fields.map(fld =>
          `  - ${fld.type} name="${fld.name}" placeholder="${fld.placeholder || ''}" ${fld.required ? 'required' : ''}`
        ).join('\n');
        return `Form ${i + 1} (${f.method} ${f.action}):\n${fields}`;
      })
      .join('\n\n');

    const appContextBlock = this.description
      ? `\nApplication context (provided by the user — use this to better understand the app):\n${this.description}\n`
      : '';

    const prompt = `Analyze this web page and produce a structured PageModel as JSON.
${appContextBlock}
Page URL: ${snapshot.url}
Page Title: ${snapshot.title}

Interactive elements from the accessibility tree:
${interactiveSummary}

Forms found:
${formsSummary || 'None'}

Links found: ${snapshot.links.length} total

Respond with ONLY a JSON object (no markdown fences) with this structure:
{
  "url": "${snapshot.url}",
  "path": "${snapshot.path}",
  "title": "${snapshot.title}",
  "siteType": "string — e.g. 'e-commerce', 'blog', 'dashboard', 'landing', 'documentation', 'form-based'",
  "purpose": "One-line description of what this page does",
  "navigation": [
    { "role": "link|button", "name": "exact name from tree", "destination": "guessed target" }
  ],
  "forms": [
    {
      "purpose": "what the form does",
      "fields": [
        {
          "role": "textbox|combobox|checkbox|radio",
          "name": "exact accessible name",
          "required": true|false,
          "sampleValue": "realistic test value",
          "dependsOn": "name of another field that must be filled first, or null if independent",
          "fillOrder": "integer indicating the order this field should be filled (1 = first, 2 = second, etc.)"
        }
      ],
      "submitElement": { "role": "button", "name": "exact name" },
      "isCascading": true|false,
      "cascadingDescription": "If cascading, describe the dependency chain, e.g. 'Select Year first, then Model populates based on Year, then Trim populates based on Model'"
    }
  ],
  "keyElements": [
    { "role": "string", "name": "exact name from tree", "significance": "why it matters for testing" }
  ],
  "behaviors": [
    "Short description of an observable behavior, e.g. 'Clicking Search opens a search dialog'"
  ]
}

CRITICAL RULES:
1. Every "name" value MUST be an exact string from the accessibility tree above. Never invent names.
2. Every "role" MUST match the role from the accessibility tree.
3. If you're unsure about a name, omit that element rather than guess.
4. For forms with multiple dropdowns/selects, identify if they are cascading (where selecting one populates the options of another). Set "isCascading" to true and describe the dependency chain.
5. For each form field, set "dependsOn" to the name of the field that must be filled first (if any), and "fillOrder" to the sequence number.
6. For cascading forms, the "fillOrder" must reflect the correct interaction sequence (parent fields before child fields).`;

    let rawResponse = null;
    try {
      rawResponse = await this.llm.complete(prompt);
      console.log(`[DEBUG analyze] LLM response length=${rawResponse.length}, first 300 chars:\n${rawResponse.substring(0, 300)}`);
      return extractJSON(rawResponse);
    } catch (err) {
      console.error(`Failed to analyze ${snapshot.url}: ${err.message}`);
      if (rawResponse) {
        console.error(`[DEBUG analyze] Raw response tail (last 500 chars):\n${rawResponse.slice(-500)}`);
      }
      // Return a minimal model — but include interactiveElements and forms
      // from the snapshot so the planner can still generate basic tests
      // even when the LLM fails (e.g., local models with poor JSON output).
      return {
        url: snapshot.url,
        path: snapshot.path,
        title: snapshot.title,
        siteType: 'unknown',
        purpose: 'Could not analyze — using snapshot data directly',
        navigation: snapshot.interactiveElements
          .filter(e => e.role === 'link' || e.role === 'button')
          .slice(0, 20)
          .map(e => ({ role: e.role, name: e.name, destination: 'unknown' })),
        forms: snapshot.forms.map(f => ({
          purpose: `Form with ${f.fields.length} fields`,
          fields: f.fields.map(fld => ({
            role: fld.type === 'select-one' ? 'combobox' : fld.type === 'checkbox' ? 'checkbox' : 'textbox',
            name: fld.name || fld.placeholder || fld.ariaLabel || 'unknown',
            required: fld.required || false,
            sampleValue: null,
            dependsOn: null,
            fillOrder: 1,
          })),
          submitElement: null,
          isCascading: false,
          cascadingDescription: null,
        })),
        keyElements: snapshot.interactiveElements.slice(0, 20).map(e => ({
          role: e.role,
          name: e.name,
          significance: 'interactive element',
        })),
        behaviors: [],
        // Include raw interactive elements for the planner
        interactiveElements: snapshot.interactiveElements,
      };
    }
  }

  getUsage() {
    return this.llm.getUsage();
  }
}

module.exports = { Analyzer };
