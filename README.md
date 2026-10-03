# AutoTest Agent — Autonomous Playwright Test Generation

**What is this?** AutoTest Agent writes and runs website tests for you automatically. Instead of a human writing Playwright test scripts by hand, you give it your website's URL, and the system:

1. **Explores** your website with a real browser — captures each page's accessibility snapshot, links, forms, API calls, and console/page errors
2. **Analyzes** each page deterministically (site-type heuristics, element catalog, cascading-dropdown detection — zero AI calls)
3. **Plans** test scenarios — Navigation, Forms, and Accessibility suites are built deterministically; the AI is only asked to plan the Functional suite, where intent inference actually adds value
4. **Generates** real Playwright `.spec.ts` files — a deterministic recorder-first approach; AI generation only runs when the recorder can't cover a plan
5. **Runs** the tests in a real browser (API responses replayed from recorded HAR files for determinism)
6. **Heals** broken tests — a zero-token deterministic repair pass handles mechanical failures first; the AI only sees what it can't fix, and only the failing test block, not the whole file

You watch all of this happen live in a friendly web interface. No coding required.

**Why the deterministic-first design?** Earlier versions sent every page through the AI at every stage. Now most work is done by deterministic Playwright features (aria snapshots, HAR replay, clock freezing, targeted re-runs) — the AI is reserved for what it's genuinely good at. The result: dramatically lower token usage, faster runs, and fewer flaky tests.

---

## Highlights

- **Deterministic-first pipeline** — the AI is used only where it earns its keep: Functional-suite planning, fallback generation, and escalated healing. Everything else is deterministic Playwright.
- **Four test suites per page** — Navigation, Forms, Accessibility (aria-snapshot baseline + Axe WCAG audits), and Functional (AI-planned user journeys).
- **Targeted testing** — build a screen registry once, then test only the screens that changed. Attach "what changed" notes, Jira tasks, or acceptance criteria per screen.
- **Self-healing** — mechanical failures (strict mode, name drift, hidden widgets, URL mismatches, network timeouts) are repaired deterministically at zero token cost; the rest go to the AI with tightly scoped prompts.
- **Zero-token re-runs** — a cross-run spec cache reuses generated specs for pages that haven't changed.
- **9 LLM providers** — Anthropic, AWS Bedrock, Azure OpenAI, OpenRouter, Grok, NVIDIA NIM, Ollama, vLLM, OmniRoute. One is enough.
- **Auth support** — no login, Basic Auth, form login, Bearer token, and OAuth/SSO via interactive login capture (cookies + localStorage, MFA-friendly).
- **Honest reporting** — unfixable tests become `test.fixme("reason")`, never silently deleted. CAPTCHA-blocked flows are flagged the same way.

---

## Table of Contents

1. [What You Need Before You Start](#1-what-you-need-before-you-start)
2. [Step 1 — Install Node.js](#2-step-1--install-nodejs)
3. [Step 2 — Get the Project Files](#3-step-2--get-the-project-files)
4. [Step 3 — Install Dependencies (includes browsers)](#4-step-3--install-dependencies-includes-browsers)
5. [Step 4 — Create Your Configuration File (.env)](#5-step-4--create-your-configuration-file-env)
6. [Step 5 — Start the Application](#6-step-5--start-the-application)
7. [Step 6 — Run Your First Test (Full Walkthrough)](#7-step-6--run-your-first-test-full-walkthrough)
8. [Understanding the User Interface — Every Field Explained](#8-understanding-the-user-interface--every-field-explained)
9. [Watching the Pipeline Run](#9-watching-the-pipeline-run)
10. [Reading the Results](#10-reading-the-results)
11. [Re-running Tests (spec cache & re-execute)](#11-re-running-tests-spec-cache--re-execute)
12. [Screen Registries — Test Only What Changed](#12-screen-registries--test-only-what-changed)
13. [Configuration Presets — Save Your Settings](#13-configuration-presets--save-your-settings)
14. [Running Generated Tests Manually](#14-running-generated-tests-manually)
15. [Running the Project's Own Unit Tests](#15-running-the-projects-own-unit-tests)
16. [Where Everything Is Stored](#16-where-everything-is-stored)
17. [All Environment Variables](#17-all-environment-variables)
18. [HTTP API Reference](#18-http-api-reference)
19. [Troubleshooting — Common Problems and Fixes](#19-troubleshooting--common-problems-and-fixes)
20. [Stopping the Application](#20-stopping-the-application)
21. [Quick Command Cheat Sheet](#21-quick-command-cheat-sheet)

---

## 1. What You Need Before You Start

| Requirement | What it is | How to check if you have it |
|---|---|---|
| **Node.js 20 or newer** | The runtime that runs the app (required by Playwright 1.63) | Open a terminal and type `node --version` |
| **npm 9 or newer** | Comes bundled with Node.js | Type `npm --version` |
| **A web browser** | Chrome, Edge, or Firefox | You already have this |
| **An AI (LLM) account** | One API key — e.g. Anthropic or AWS Bedrock | See Step 4 |
| **A website to test** | The URL of the app you want to test | e.g. `https://your-app.com` |

> **Windows users:** everything below works in **Command Prompt**, **PowerShell**, or **Git Bash**.

---

## 2. Step 1 — Install Node.js

If you already have Node **v20+**, skip to Step 2.

1. Go to **https://nodejs.org** in your browser.
2. Click the big green **LTS** (Long Term Support) download button.
3. Run the installer and click **Next** through every screen (keep "Add to PATH" checked).
4. When it finishes, **close and reopen** any terminal windows.
5. Verify:

   ```
   node --version    →  v20.x.x or higher
   npm --version     →  10.x.x or higher
   ```

---

## 3. Step 2 — Get the Project Files

Either:

- **Clone it with git:**
  ```
  git clone <your-repository-url>
  cd UI-playwright-test-automation
  ```

- **Or unzip it** if you received it as a ZIP file, then open a terminal inside the folder.
  - **Windows tip:** open the folder in File Explorer, click the address bar, type `cmd`, and press Enter.

You know you're in the right place when `dir` (Windows) or `ls` (Mac/Linux) shows `package.json` and folders named `client`, `server`, and `tests`.

---

## 4. Step 3 — Install Dependencies (includes browsers)

```
npm run install:all
```

This installs dependencies for **both** parts of the app — the **server** (the brain) and the **client** (the web interface) — and then automatically downloads the Playwright browsers via a `postinstall` hook. No separate browser step is needed.

> **Equivalent manual commands:** `npm install` then `cd client && npm install && cd ..`
>
> **If browsers ever need reinstalling:** `npx playwright install` (idempotent — safe to run again anytime).
>
> **Linux users only:** if you get missing-system-library errors, run `npx playwright install-deps` (needs admin rights).

---

## 5. Step 4 — Create Your Configuration File (.env)

The `.env` file stores your settings — most importantly, which AI provider to use and your API key.

### 5a. Create the file

- **Windows (Command Prompt):** `copy .env.example .env`
- **Windows (PowerShell):** `Copy-Item .env.example .env`
- **Mac/Linux:** `cp .env.example .env`

### 5b. Pick your AI provider — the minimum you must set

**You only need ONE provider.** The simplest option is Anthropic (Claude):

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-your-real-key-here
LLM_MODEL=claude-sonnet-4-6
```

Get an API key at **https://console.anthropic.com** → API Keys → Create Key. Paste it after the `=` sign, with no quotes and no spaces.

**Using AWS Bedrock instead?** Set:

```env
LLM_PROVIDER=bedrock
LLM_MODEL=anthropic.claude-sonnet-4-6-v1
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

Your IAM user/role needs `bedrock:InvokeModel` on the model, and the model must be enabled in the Bedrock console for your region. See `DEPLOY.md` for the exact IAM policy.

**Other providers** (Azure OpenAI, OpenRouter, Grok, NVIDIA NIM, Ollama for fully-local/free usage, vLLM, OmniRoute) are documented inside `.env.example` and `DEPLOY.md` — you can also configure them **in the UI per run** without touching `.env` at all.

> **Important:** `.env` contains secrets. Never email it, commit it, or paste it in chat. It is excluded from git via `.gitignore` — keep it that way.

### 5c. Optional settings in .env

Everything else has sensible defaults. See [Section 17](#17-all-environment-variables) for the full list. Save and close the file.

---

## 6. Step 5 — Start the Application

```
npm run dev
```

This starts **two** things at once:

- the **backend server** on `http://localhost:3001`
- the **web interface** on `http://localhost:5173`

Leave this terminal **open** while you use the app. Then open:

```
http://localhost:5173
```

> **Tip:** In dev mode use port **5173** (the UI). Port 3001 is the API behind it.

---

## 7. Step 6 — Run Your First Test (Full Walkthrough)

1. **Open** `http://localhost:5173`.
2. In the **Target Application** card, enter a URL — e.g. the public demo app:
   ```
   https://demo.playwright.dev/todomvc/
   ```
3. *(Optional)* Type a run description.
4. In the **LLM Provider** card:
   - Pick the provider tab matching your `.env` (e.g. **Anthropic**).
   - Leave the API Key field blank if the key is already in `.env` — it falls back automatically.
   - Click **Test Connection** → wait for `✓ Connected`. Fix your key before continuing if it fails.
5. In the **Authentication** card, leave it on **No Login** for the demo site.
6. Skip **Target Screens** and **Advanced Options** for now.
7. Click **Start Test Generation**.
8. Watch the stages light up live — Explore → Analyze → Plan → Generate → Execute (→ Heal if needed).
9. When it completes, click **View Results** for pass/fail counts, generated code, and a downloadable HTML report.

**Expected result:** several generated `.spec.ts` files, most or all tests passing. Total time: a few minutes.

---

## 8. Understanding the User Interface — Every Field Explained

### Card 1 — Configuration Presets
Save all your settings under a name to reload in one click. See [Section 13](#13-configuration-presets--save-your-settings).

### Card 2 — Target Application
- **Application URL** *(required)* — must include `http://` or `https://`.
- **Run Description** *(optional)* — a note for yourself; shows in run history and the report. It's also passed to the AI as application context, so a good description produces more relevant tests.

### Card 3 — LLM Provider
The AI is used for Functional-suite planning, fallback spec generation, and LLM-escalated healing.

- **Provider tabs** — Anthropic, AWS Bedrock, Azure OpenAI, OpenRouter, Grok, NVIDIA NIM, Ollama, vLLM, OmniRoute.
- **Model** — dropdown, or "Custom model..." to type any model ID.
- **Base URL** — shown for providers that need it (Azure endpoint, self-hosted, Ollama…).
- **API Key** — leave blank to use the key from `.env`.
- **AWS Bedrock fields** *(Bedrock only)*: Region; credential type (long-term keys, temporary/assumed-role with session token, or Bedrock API key / custom gateway URL). Leave access-key fields blank if the machine already has AWS credentials (env vars, `~/.aws`, IAM role).
- **Test Connection** — verifies settings before you spend time on a run.

> **Cost note:** for Anthropic and Bedrock, the static portion of every AI prompt is sent with **prompt caching** enabled (`cache_control` / `cachePoint`), so repeated calls across pages bill cached input at roughly 10% of the normal rate. Providers that support it also get **structured JSON output**, eliminating parse-failure retries.

### Card 4 — Authentication (how the explorer logs into YOUR app)

| Option | When to use it | What to fill in |
|---|---|---|
| **No Login** | Public websites | Nothing |
| **Basic Auth** | Browser-popup username/password | Username + Password |
| **Form Login** | A normal login page | Login URL (optional), username, password, optionally CSS selectors |
| **Bearer Token** | Apps/APIs accepting `Authorization: Bearer` | Paste the token |
| **OAuth / SSO** | Cognito, Azure AD, Google, Okta, Auth0, corporate SSO | Use **Interactive Login Capture** — click *Launch Browser & Login*, log in yourself (including MFA/SSO), then click *Capture Session*. Cookies + localStorage are grabbed automatically. A manual JSON option exists under "Manual entry". |

The captured login session is saved to `auth-state.json` in the run folder, and generated tests load it automatically. If the auth state is missing at execution time, tests `test.abort()` immediately instead of running doomed steps.

### Card 5 — Target Screens *(optional)*
Test **only the pages that changed** instead of crawling the whole app — faster and cheaper. Requires a **screen registry** (see [Section 12](#12-screen-registries--test-only-what-changed)).

For each screen you tick, you can optionally provide:

- **Changed functionality** — comma-separated hints ("new search bar, updated product grid") the AI prioritizes when planning tests.
- **Screen description / test context** — free-form text: paste a Jira task, user story, or acceptance criteria. The AI uses it to write tests that verify the described requirements while still covering the rest of the page.
- **Crawl depth from each selected screen** — `0` captures only the selected screens; higher values also follow links outward from them.

### Advanced Options *(expandable card)*
- **Max crawl depth** — link-levels the explorer follows (default 3). Disabled when a registry is selected (target depth controls it instead).
- **Max pages** — cap on pages captured (default 20). Not applied to selected screens in targeted mode — all selected screens are always captured.
- **Test timeout / retries** — per-test duration limit and retry count (retries run isolated in a clean worker, separating real failures from interference flakes).
- **Application Context** — base URL (enables relative navigation in generated tests), viewport, user agent, extra HTTP headers (JSON), and **API URL patterns** — comma-separated URL fragments (`/api/`, `execute-api`, `graphql`) identifying your app's API calls. These drive HAR recording during generation and `routeFromHAR` replay in generated tests.

### Card 6 — Self-Healing
- **Enable Self-Healing** *(ON by default)* — failed tests go through the deterministic repair pass first (strict-mode fixes, name drift, hidden widgets, URL assertions, network timeouts — all zero-token), then only unfixable failures reach the AI. Re-runs use `--test-list` so only previously-failed tests execute. When OFF, all suites run in one fast batch and unfixable failures become `test.fixme`.

Then **Start Test Generation** kicks off the run.

---

## 9. Watching the Pipeline Run

The pipeline view streams progress live (Server-Sent Events — no refreshing).

| Stage | What it's doing |
|---|---|
| **Explore** | Launches headless Chromium (service workers blocked, reduced motion, clock frozen at a fixed instant, locale pinned to `en-US`), logs in if needed, crawls your site. Captures per page: an **AI-mode aria snapshot** (`page.ariaSnapshot`) with element refs and bounding boxes, a default-mode **aria baseline** for accessibility diffs, CDP accessibility tree + iframe trees (fallback), links (including inside iframes), forms, API calls, **console/page errors**, and **CAPTCHA detection**. Also expands collapsed menus/popups/accordions so elements inside them reach the planner. Saved to `knowledge/snapshots.json`. |
| **Analyze** | **Deterministic** — builds a page model (site type, purpose, element catalog, cascading-form detection) from the snapshot. Zero AI calls. Saved to `knowledge/page_models.json`. |
| **Plan** | Navigation / Forms / Accessibility plans are built **deterministically** from the snapshot. The AI makes **one call per page** for the Functional suite only — fed the compact aria YAML plus your per-screen functionality hints and descriptions — and emits the page purpose as a side output. Saved to `knowledge/plans.json`. |
| **Generate** | **Recorder-first:** the deterministic record-and-ground recorder replays plan steps against the live page (with HAR recording of API traffic and a frozen clock). The AI is only called if the recorder fails or skips >50% of steps. The Accessibility suite is fully deterministic — an aria-snapshot baseline + accessible-name assertions + Axe WCAG audits. |
| **Execute** | Runs each spec with the real Playwright runner. Generated specs replay API traffic from the recorded HAR (`routeFromHAR`), freeze the clock, block service workers, and `test.abort()` early if required auth state is missing. |
| **Heal** *(if enabled)* | A **deterministic repair table** fixes mechanical failures at zero token cost. Remaining failures are classified and sent to the AI as **scoped prompts** (failing test block + aria snapshot captured at failure time) — never the whole file. Re-runs use `--test-list` (failed tests only). Still-failing tests become `test.fixme("reason")` — never silently deleted. A heal that would *reduce* the test count is rejected automatically. |
| **Report** | Builds `report.html` — an executive-friendly, self-contained HTML report — and totals token usage per stage (`run-meta.json`). |

You can navigate away and come back via **Run History** — every run is stored on disk.

---

## 10. Reading the Results

- **Total / Passed / Failed / Skipped / Fixme counts** per suite and overall.
- **The generated test code** — real Playwright TypeScript you can copy into your own suite (Copy button per file).
- **Download Report** — a self-contained HTML file suitable for sharing with stakeholders.
- **Re-execute** — run the same tests again, with an optional healing toggle (see next section).
- **Token usage** — input/output tokens and AI call counts per run. Expect **0 calls** for Analyze, ~1/page for Plan, and often 0 for Generate/Heal.

Generated tests use accessibility-first locators (`getByRole` with `{ exact: true }`), `expect.poll` for dynamic content, HAR-replayed APIs, and a frozen clock — which is why they need Playwright ≥ 1.63 (already in `package.json`).

---

## 11. Re-running Tests (spec cache & re-execute)

Two ways to re-run:

- **Re-execute** *(Results view / Run History)* — runs the same `.spec.ts` files again, with an **Enable Healing** checkbox. No regeneration, so no AI cost unless healing is on and something fails. Works after server restarts — the full run config (auth, options, LLM, app context) is persisted in `run-meta.json`.
- **A fresh generation run of the same app** — the **spec cache** (`runs/_cache/spec-cache.json`) hashes each page's aria snapshot (a content hash — element refs and bounding boxes are stripped since they vary between renders). If a page is unchanged since the last run, its previously generated spec is reused — zero AI calls, zero recorder time, and the recorded HAR is copied into the new run so `routeFromHAR` still resolves. Suites cache independently; a changed page regenerates normally while untouched pages hit the cache. Cached Functional specs even skip the Functional-planning AI call entirely.

Cache details:

- Entries are keyed by `sha256(origin + path | content hash | generator version)` — the generator version is bumped whenever the emitted spec logic changes, so stale cached specs never silently run old code.
- Capped at 500 entries / 30 days, oldest pruned first.
- `SPEC_CACHE_DISABLE=1` in `.env` — disable reads and writes entirely.
- `options.specCache: false` per run via the API.
- `SPEC_CACHE_DIR=/path` — relocate the cache directory.

> **Comparing runs before/after:** disable the cache for the first run (`SPEC_CACHE_DISABLE=1`) to measure the pipeline itself, then run again without it to see the cache-hit savings.

---

## 12. Screen Registries — Test Only What Changed

A **screen registry** is a saved list of your app's pages with friendly names ("Home", "Checkout"…). Build it once per app/environment.

**To build a registry:**

1. Enter your **Application URL**.
2. Under **Target Screens**, click **+ Build New Registry**.
3. Name it (e.g. `myapp-prod`), set crawl depth/pages, click **Build Registry**.

Registry builds use a **light discovery crawl**: pages are captured concurrently (see `CRAWL_CONCURRENCY`) and only URL, title, and outbound links are recorded — the heavy per-page captures (aria snapshots, forms, API tracking) are skipped, so building is much faster than a test run. If you rebuild an existing name, it's treated as a recrawl-and-update.

**To use it:** pick the registry, tick the screens you changed, optionally fill in **Changed functionality** and/or **Screen description** per screen (passed to the AI so it focuses tests there), set the **crawl depth from each selected screen** (0 = only those screens), and start.

**To update it:** select the registry → **Recrawl / Update Screens** — custom names you've assigned are preserved. You can also rename screens inline, add a screen manually by URL, or remove screens; click **Save Changes** to persist edits. **Delete Registry** removes the file entirely.

Registries live as JSON files in `registries/`.

---

## 13. Configuration Presets — Save Your Settings

- **Save:** fill the form → type a name → **Save New**.
- **Load:** pick it → **Load**.
- **Overwrite / Delete:** select → save under the same name / **Delete**.

Presets are stored on the server in `presets/` — they survive browser cache clears. Note that presets can include credentials (API keys, auth details), so the `presets/` folder is git-ignored.

---

## 14. Running Generated Tests Manually

Each run folder is a self-contained Playwright project (it has its own `playwright.config.ts`, generated `testDir`, recorded HARs, and aria baselines):

```
cd runs\<run-id>
npx playwright test
```

(Use forward slashes on Mac/Linux.)

Useful flags:

- `--headed` — watch the browser
- `--ui` — Playwright's interactive test UI
- `-g "test name"` — run one test
- `--test-list <file>` — run only the tests listed in a file

---

## 15. Running the Project's Own Unit Tests

```
npm test
```

Runs `node --test tests/*.test.js` — no browser or AI key needed. Covers network capture, app-context validation, pipeline persistence, the deterministic repair table, aria-snapshot utilities, and the spec cache (109 tests).

---

## 16. Where Everything Is Stored

```
UI-playwright-test-automation/
├── .env                  ← YOUR secrets/config (never share)
├── .env.example          ← template with every option documented
├── client/               ← the web interface (React + Vite)
├── server/               ← the backend (Express + pipeline)
│   ├── pipeline/         ← explore → analyze → plan → generate → execute → heal
│   │                     (+ orchestrator, re-executor)
│   ├── routes/           ← API endpoints (pipeline, runs, presets, registries,
│   │                       auth-capture)
│   └── utils/            ← LLM client, aria snapshots, page model, spec cache,
│                           deterministic healer, network capture, reports
├── presets/              ← your saved configuration presets (.json)
├── registries/           ← your screen registries (.json)
├── runs/_cache/          ← cross-run spec cache (spec-cache.json)
├── runs/<run-id>/        ← one folder per run — a self-contained project:
│   ├── knowledge/        ← snapshots.json, page_models.json, plans.json, *.har
│   ├── generated-tests/  ← the .spec.ts Playwright tests  ★ the valuable output
│   ├── test-results/     ← Playwright JSON results per suite
│   ├── playwright.config.ts ← generated per-run config (HAR replay, clock, etc.)
│   ├── auth-state.json   ← saved login session for reuse
│   ├── run-meta.json     ← the config + token telemetry for this run
│   └── report.html       ← downloadable report
├── tests/                ← the project's own unit tests
├── TOKEN_REDUCTION_PLAN.md ← the determinism/token-reduction design doc
└── DEPLOY.md             ← deployment & provider reference (advanced)
```

> **Note:** `run-meta.json` can contain credentials so re-execution works after restarts — keep `runs/` private. It is git-ignored (along with `presets/`, `registries/`, `backupruns/`, and `test-results/`).

---

## 17. All Environment Variables

| Variable | Default | What it controls |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | AI provider: `anthropic`, `bedrock`, `azure`, `ollama`, `vllm`, `nvidia`, `openrouter`, `grok`, `omniroute` |
| `LLM_MODEL` / `LLM_BASE_URL` / `LLM_API_KEY` | provider defaults | Model ID, endpoint, key (see `.env.example` for per-provider vars) |
| `PORT` | `3001` | Backend port |
| `NODE_ENV` | `development` | `production` serves the built client from the backend |
| `MAX_CRAWL_DEPTH` | `3` | Link-levels the explorer follows |
| `MAX_PAGES` | `20` | Max pages captured in a full crawl (not applied to selected screens in targeted mode) |
| `PLAYWRIGHT_TIMEOUT` | `30000` | Page-wait budget (ms) |
| `NETWORKIDLE_TIMEOUT` | `10000` | Network-idle wait during capture (ms). After the first timeout, remaining pages skip straight to `domcontentloaded` + API settle |
| `API_SETTLE_TIMEOUT` | `8000` | Extra wait for API calls to settle (ms) |
| `CRAWL_CONCURRENCY` | `3` | Parallel pages during light discovery crawls (registry building) |
| `LIGHT_NETWORKIDLE_TIMEOUT` | `5000` | Network-idle budget for light crawls (ms) |
| `LIGHT_LINK_WAIT` | `4000` | How long light crawls wait for the first link to render (ms) |
| `LIGHT_LINK_SETTLE` | `1500` | Cap on the link-count stability poll during light crawls (ms) |
| `MAX_DISCLOSURE_TRIGGERS` | `10` | How many collapsed menus/popups/accordions the explorer opens per page |
| `MAX_HEAL_ITERATIONS` | `3` | Heal attempts per suite |
| `MAX_TESTS_PER_PLAN` | `4` | Tests per page/suite |
| `ARIA_SNAPSHOT_DEPTH` | `0` (unlimited) | Cap aria-snapshot depth on huge pages — a hard prompt-size ceiling |
| `DISABLE_CLOCK` | unset | `1` disables the frozen-clock emulation (explore, recorder, generated tests) |
| `SPEC_CACHE_DISABLE` | unset | `1` disables the cross-run spec cache |
| `SPEC_CACHE_DIR` | `runs/_cache` | Relocate the spec-cache directory |
| AWS vars | — | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_BEDROCK_API_KEY`, `AWS_BEDROCK_BASE_URL` |
| Azure vars | — | `AZURE_DEPLOYMENT`, `AZURE_API_VERSION` |

---

## 18. HTTP API Reference

The backend (`http://localhost:3001`) exposes a REST + SSE API if you want to drive runs without the UI:

| Method & path | Purpose |
|---|---|
| `GET /api/pipeline/providers` | List the 9 LLM providers with models and required fields |
| `POST /api/pipeline/health-check` | Verify an LLM config (`{ provider, model, apiKey, ... }`) |
| `POST /api/pipeline/start` | Start a run — `{ targetUrl, auth?, options?, llm?, description?, appContext? }` → `{ runId }` |
| `GET /api/pipeline/stream/:runId` | SSE stream — starts the pipeline and streams stage events until `complete` |
| `GET /api/pipeline/status/:runId` | Run state snapshot |
| `POST /api/pipeline/re-execute/:runId` | Re-run an existing run's tests — `{ enableHealing }` → new `{ runId }` |
| `GET /api/pipeline/re-execute-stream/:runId` | SSE stream for a re-execution |
| `GET /api/runs` | Run history (rebuilt from `runs/` on disk after restarts) |
| `GET /api/runs/:id/tests` · `GET /api/runs/:id/knowledge` · `GET /api/runs/:id/report` | Generated code, knowledge artifacts, HTML report |
| `PATCH /api/runs/:id/description` | Edit a run's description |
| `GET/POST/DELETE /api/presets[/:name]` | Manage configuration presets |
| `POST /api/registries/build` · `GET/PUT/DELETE /api/registries[/:name]` | Build and manage screen registries |
| `POST /api/auth-capture/start` · `GET /:id/status` · `POST /:id/capture` · `POST /:id/cancel` | Interactive OAuth/SSO login capture |

Useful `options` fields for `/start`: `maxDepth`, `maxPages`, `testTimeout`, `retries`, `enableHealing`, `specCache`, `targetScreens` (`[{ url, name?, functionality?, description? }]`), `targetDepth`. `appContext` supports `baseURL`, `viewport`, `userAgent`, `extraHTTPHeaders`, `apiPatterns`, and `locale` (BCP-47 — pinned identically at capture and execution so locale-sensitive rendering doesn't produce false diffs; defaults to `en-US`).

---

## 19. Troubleshooting — Common Problems and Fixes

| Symptom | Likely cause / fix |
|---|---|
| `node is not recognized` | Node isn't installed or PATH wasn't updated — reinstall from nodejs.org (v20+), reopen the terminal |
| Browser shows nothing at `localhost:5173` | Dev servers aren't running — `npm run dev` and keep the terminal open |
| "Test Connection" fails | Wrong key/model, or local server (Ollama/vLLM) not started. Bedrock: check `bedrock:InvokeModel` IAM permission + model enabled in your region |
| Browser launch errors | Run `npx playwright install` (postinstall normally covers this) |
| `TypeError: page.frameLocator is not a function` / `locator.visible is not a function` | Old Playwright — generated tests need ≥1.63. Run `npm install` to update |
| Explorer captured 0 pages | Site never finished loading — raise `PLAYWRIGHT_TIMEOUT` / `NETWORKIDLE_TIMEOUT`; check the site is reachable |
| Planner generated 0 plans | No interactive elements found — try a stronger model or a page with real UI controls |
| Tests fail on a login-required site | Check the **Authentication** card — *Form Login* or *OAuth → Interactive Login Capture* |
| Port already in use (`EADDRINUSE`) | Something else is on 3001 or 5173 — close it, or change `PORT` |
| Time-dependent tests act strange | The frozen clock fixes rendering at a fixed instant — set `DISABLE_CLOCK=1` if your app genuinely needs real time |
| Menu/submenu items not tested | The explorer opens up to `MAX_DISCLOSURE_TRIGGERS` (10) collapsed widgets per page — raise it for menu-heavy apps |
| Second run skipped generation for some pages | The spec cache is working — unchanged pages reuse specs. Set `SPEC_CACHE_DISABLE=1` to force regeneration |
| Stale tests after the app changed | Snapshot hash changed → cache misses automatically. If behavior still looks stale, delete `runs/_cache/` and re-run |
| HAR replay makes a test flaky | Generated specs use `notFound: 'fallback'` — unmatched requests hit the live network. Re-generate to record a fresh HAR |
| Registry build is slow | It's a concurrent light crawl — check `CRAWL_CONCURRENCY` (default 3) and raise it; lower the registry's max depth/pages |
| Slow runs / high token cost | Lower `MAX_PAGES`/`MAX_CRAWL_DEPTH`, use Target Screens, rely on the spec cache for reruns |
| All tests end up `fixme` | The AI model is too weak — use a stronger model (e.g. Claude Sonnet) |
| Ollama gives garbage output | Use a 14B+ parameter model (`qwen3:14b` or better) |
| Server restarted and history looks empty | Check `runs/` — history is rebuilt from disk automatically |
| Dates/numbers differ between capture and test | Locale is pinned to `en-US` in both — if your app needs a different locale, set `appContext.locale` via the API |

---

## 20. Stopping the Application

- In the terminal running `npm run dev`, press **Ctrl + C**.
- Runs, presets, and registries remain on disk. Restart later with `npm run dev` → `http://localhost:5173`.

**Production mode** (single server, no Vite):

```
npm run build:client     # one-time build
npm start                # serves everything on http://localhost:3001
```

(On Windows cmd/PowerShell, `npm start` may need `set NODE_ENV=production` first — `npm run dev` is the recommended everyday mode.)

---

## 21. Quick Command Cheat Sheet

| Task | Command |
|---|---|
| Install everything (deps + browsers) | `npm run install:all` |
| Reinstall browsers | `npx playwright install` |
| Start the app (dev) | `npm run dev` → `http://localhost:5173` |
| Run project's unit tests | `npm test` |
| Build for production | `npm run build:client` |
| Start in production | `npm start` → `http://localhost:3001` |
| Re-run generated tests by hand | `cd runs/<id>` then `npx playwright test` |
| Force fresh generation (no cache) | `SPEC_CACHE_DISABLE=1` in `.env` |

---

## Need More Detail?

- **`TOKEN_REDUCTION_PLAN.md`** — the design doc behind the deterministic-first, low-token pipeline.
- **`DEPLOY.md`** — provider-by-provider config reference, IAM policies, deployment notes.
- **`.env.example`** — every environment variable with inline documentation.
