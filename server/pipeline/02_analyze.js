const { buildPageModel } = require('../utils/page-model');

/**
 * Analyzer — now deterministic (token-reduction plan §6).
 *
 * The PageModel is built directly from the snapshot (siteType heuristics,
 * navigation links/buttons, form field mapping, cascading-dropdown
 * detection). The LLM call this stage used to make is folded into the single
 * Functional-planning call in 03_plan.js — which emits `purpose` as a side
 * output, so no semantic information is lost.
 *
 * The constructor keeps its old signature for compatibility with the
 * orchestrator; the LLM config is simply unused.
 */
class Analyzer {
  constructor(llmConfig = {}, description = '') {
    // Deliberately no LLM client — this stage is deterministic.
    this.description = (description || '').trim();
  }

  async analyze(snapshots) {
    const pageModels = [];

    for (const snapshot of snapshots) {
      pageModels.push(this.analyzeOnePage(snapshot));
    }

    return pageModels;
  }

  analyzeOnePage(snapshot) {
    return buildPageModel(snapshot);
  }

  getUsage() {
    return { inputTokens: 0, outputTokens: 0, calls: 0 };
  }
}

module.exports = { Analyzer };
