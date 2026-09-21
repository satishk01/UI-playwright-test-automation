# AutoTest Agent — Autonomous Playwright Test Generation

**What is this?** AutoTest Agent is a tool that writes and runs website tests for you automatically. Instead of a human writing Playwright test scripts by hand, you give it your website's URL, and the system:

1. **Explores** your website with a real browser (like a robot clicking around)
2. **Understands** each page using an AI model (Claude, GPT, Llama, etc.)
3. **Plans** test scenarios (what should be checked on each page)
4. **Generates** real Playwright test code (`.spec.ts` files)
5. **Runs** the tests in a real browser
6. **Heals** broken tests — if a test fails, the AI tries to fix it automatically

You watch all of this happen live in a friendly web interface. No coding required.

---

## Table of Contents

1. [What You Need Before You Start](#1-what-you-need-before-you-start)
2. [Step 1 — Install Node.js](#2-step-1--install-nodejs)
3. [Step 2 — Get the Project Files](#3-step-2--get-the-project-files)
4. [Step 3 — Install the Project Dependencies](#4-step-3--install-the-project-dependencies)
5. [Step 4 — Install the Playwright Browser](#5-step-4--install-the-playwright-browser)
6. [Step 5 — Create Your Configuration File (.env)](#6-step-5--create-your-configuration-file-env)
7. [Step 6 — Start the Application](#7-step-6--start-the-application)
8. [Step 7 — Run Your First Test (Full Walkthrough)](#8-step-7--run-your-first-test-full-walkthrough)
9. [Understanding the User Interface — Every Field Explained](#9-understanding-the-user-interface--every-field-explained)
10. [Watching the Pipeline Run](#10-watching-the-pipeline-run)
11. [Reading the Results](#11-reading-the-results)
12. [Re-running Tests Without Regenerating Them](#12-re-running-tests-without-regenerating-them)
13. [Screen Registries — Test Only What Changed](#13-screen-registries--test-only-what-changed)
14. [Configuration Presets — Save Your Settings](#14-configuration-presets--save-your-settings)
15. [Running Generated Tests Manually](#15-running-generated-tests-manually)
16. [Running the Project's Own Unit Tests](#16-running-the-projects-own-unit-tests)
17. [Where Everything Is Stored](#17-where-everything-is-stored)
18. [Troubleshooting — Common Problems and Fixes](#18-troubleshooting--common-problems-and-fixes)
19. [Stopping the Application](#19-stopping-the-application)
20. [Quick Command Cheat Sheet](#20-quick-command-cheat-sheet)

---

## 1. What You Need Before You Start

| Requirement | What it is | How to check if you have it |
|---|---|---|
| **Node.js 18 or newer** | The runtime that runs the app | Open a terminal and type `node --version` |
| **npm 9 or newer** | Comes bundled with Node.js | Type `npm --version` |
| **A web browser** | Chrome, Edge, or Firefox | You already have this |
| **An AI (LLM) account** | One API key — e.g. Anthropic or AWS Bedrock | See Step 5 |
| **A website to test** | The URL of the app you want to test | e.g. `https://your-app.com` |

> **Windows users:** everything below works in **Command Prompt**, **PowerShell**, or **Git Bash**. We show commands that work in all of them.

---

## 2. Step 1 — Install Node.js

Node.js is the engine that runs this application. If you already have it, skip to Step 2.

1. Go to **https://nodejs.org** in your browser.
2. Click the big green **LTS** (Long Term Support) download button.
3. Run the downloaded installer and click **Next** through every screen (the defaults are fine — keep "Add to PATH" checked).
4. When it finishes, **close and reopen** any terminal windows.
5. Verify it worked — open a terminal and type:

   ```
   node --version
   ```

   You should see something like `v20.x.x`. Any version **18 or higher** works.

   ```
   npm --version
   ```

   You should see something like `10.x.x`.

---

## 3. Step 2 — Get the Project Files

You need the project folder on your computer. Either:

- **Clone it with git:**
  ```
  git clone <your-repository-url>
  cd UI-playwright-test-automation
  ```

- **Or unzip it** if you received it as a ZIP file, then open a terminal inside the folder:
  - **Windows tip:** open the folder in File Explorer, click the address bar, type `cmd`, and press Enter. A terminal opens already pointed at the right folder.

You know you're in the right place when `dir` (Windows) or `ls` (Mac/Linux) shows files like `package.json`, `playwright.config.ts`, and folders named `client`, `server`, and `tests`.

---

## 4. Step 3 — Install the Project Dependencies

The project needs a set of libraries to run. npm downloads them automatically.

In the terminal, from inside the project folder, run:

```
npm run install:all
```

This one command installs dependencies for **both** parts of the app:

- the **server** (the brain — talks to the AI and drives the browser), and
- the **client** (the web interface you click around in).

You'll see lots of text scroll by. This can take **1–5 minutes** depending on your internet. When it's done you'll see your command prompt again with no red errors.

> **Equivalent manual commands** (if you prefer): `npm install` then `cd client && npm install && cd ..`

---

## 5. Step 4 — Install the Playwright Browser

The app drives a real browser (Chromium — the engine behind Chrome and Edge) to explore websites and run tests. Playwright downloads its own private copy of that browser, so it doesn't interfere with your normal Chrome install.

Run:

```
npx playwright install chromium
```

This downloads ~150 MB. You only need to do it **once** per computer.

> **Linux users only:** if you get missing-system-library errors later, also run `npx playwright install-deps chromium` (needs admin rights). Windows and Mac users can ignore this.

---

## 6. Step 5 — Create Your Configuration File (.env)

The `.env` file stores your settings — most importantly, which AI provider to use and your API key.

### 6a. Create the file

Make a copy of the example file:

- **Windows (Command Prompt):** `copy .env.example .env`
- **Windows (PowerShell):** `Copy-Item .env.example .env`
- **Mac/Linux:** `cp .env.example .env`

### 6b. Edit the file

Open `.env` in **any text editor** — Notepad works fine (right-click the file → Open with → Notepad), or use VS Code if you have it.

### 6c. Pick your AI provider — the minimum you must set

The AI model is what reads your web pages and writes the tests. **You only need ONE provider.** The simplest option is Anthropic (Claude):

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-your-real-key-here
LLM_MODEL=claude-sonnet-4-6
```

Get an API key at **https://console.anthropic.com** (create account → API Keys → Create Key). Paste it after the `=` sign, with no quotes and no spaces.

**Using AWS Bedrock instead?** If your company runs on AWS, Bedrock is often the approved path. Set:

```env
LLM_PROVIDER=bedrock
LLM_MODEL=anthropic.claude-sonnet-4-6-v1
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

Your IAM user/role needs the `bedrock:InvokeModel` permission on the model, and the model must be enabled in the Bedrock console for your region. See `DEPLOY.md` for the exact IAM policy.

**Other providers** (Azure OpenAI, OpenRouter, Grok, NVIDIA NIM, Ollama for fully-local/free usage, vLLM, OmniRoute) are all documented inside `.env.example` and in `DEPLOY.md` — you can also configure them **in the UI per run** without touching `.env` at all.

> **Important:** the `.env` file contains secrets. Never email it, commit it to a public repo, or paste it in chat. It is excluded from git via `.gitignore` — keep it that way.

### 6d. Optional settings in .env

Everything else has sensible defaults. The ones worth knowing:

| Setting | Default | What it controls |
|---|---|---|
| `PORT` | `3001` | Port the backend listens on |
| `MAX_CRAWL_DEPTH` | `3` | How many link-levels deep the explorer clicks |
| `MAX_PAGES` | `20` | Max pages captured in a full crawl |
| `PLAYWRIGHT_TIMEOUT` | `30000` | How long to wait for pages (ms) |
| `MAX_HEAL_ITERATIONS` | `3` | How many times the AI may try to fix a failing test |
| `MAX_TESTS_PER_PLAN` | `4` | Tests generated per page/suite |

Save and close the file.

---

## 7. Step 6 — Start the Application

From the project folder, run:

```
npm run dev
```

This starts **two** things at once:

- the **backend server** on `http://localhost:3001`
- the **web interface** on `http://localhost:5173`

You'll see log lines like `AutoTest Agent server running on port 3001` and a Vite startup banner. Leave this terminal window **open** while you use the app — closing it shuts the app down.

Now open your browser and go to:

```
http://localhost:5173
```

You should see the **AutoTest Agent** page with the configuration form. 

> **Tip:** You must use port **5173** in development mode — that's the address of the user interface. Port 3001 is the API behind it; visiting it directly shows nothing.

---

## 8. Step 7 — Run Your First Test (Full Walkthrough)

Let's do a safe first run against a public demo site so you can see the whole pipeline work end to end.

1. **Open** `http://localhost:5173` in your browser.
2. In the **Target Application** card, enter the URL:
   ```
   https://demo.playwright.dev/todomvc/
   ```
   (This is a public demo todo app made for testing — perfect for a first run.)
3. *(Optional)* Type a description like `My first test run`.
4. In the **LLM Provider** card:
   - Click the provider tab matching what you put in `.env` (e.g. **Anthropic**).
   - Leave **Model** on its default.
   - If you already put the key in `.env`, you can leave the API Key field **blank** — it falls back to `.env`.
   - Click **Test Connection**. Wait for `✓ Connected — XXXms`. If it fails, fix your key before continuing.
5. In the **Authentication** card, leave it on **No Login** (the demo site is public).
6. Skip **Target Screens** and **Advanced Options** for now.
7. Scroll down and click the **Start Test Generation** button.
8. You're taken to the **Pipeline view**. Watch the stages light up one by one — Explore → Analyze → Plan → Generate → Execute (→ Heal if needed).
9. When it completes, click **View Results** to see pass/fail counts, the generated test code, and the option to download an HTML report.

**Expected result:** several generated `.spec.ts` test files, most or all tests passing. Total time: a few minutes depending on site size and AI speed.

---

## 9. Understanding the User Interface — Every Field Explained

### Card 1 — Configuration Presets
Save all your settings under a name so you can reload them in one click later. See [Section 14](#14-configuration-presets--save-your-settings).

### Card 2 — Target Application
- **Application URL** *(required)* — the address of the site you want tested. Must include `http://` or `https://`.
- **Run Description** *(optional)* — a note for yourself, e.g. "Smoke test for checkout before v2.1 release". Shows up in run history and the report.

### Card 3 — LLM Provider
Choose the AI service that powers the analysis, planning, generation, and healing.

- **Provider tabs** — Anthropic, AWS Bedrock, Azure OpenAI, OpenRouter, Grok, NVIDIA NIM, Ollama, vLLM, OmniRoute.
- **Model** — pick from the dropdown, or choose "Custom model..." to type any model ID.
- **Base URL** — only shown for providers that need it (Azure endpoint, self-hosted servers, Ollama, etc.).
- **API Key** — for providers that need one. Leave blank to use the key from `.env`.
- **AWS Bedrock fields** *(shown only when Bedrock is selected)*:
  - **AWS Region** — the region where Bedrock models are enabled for your account.
  - **Credential Type** — Long-term keys, Temporary/assumed-role keys (adds a session-token field), or a Bedrock API key / custom gateway URL.
  - Leave access-key fields **blank** if the machine already has AWS credentials (env vars, `~/.aws`, or an EC2/ECS IAM role) — the SDK picks them up automatically.
- **Test Connection button** — sends a tiny request to verify your settings **before** you spend time on a run. Always click it after changing providers.

### Card 4 — Authentication (how the explorer logs into YOUR app)

| Option | When to use it | What to fill in |
|---|---|---|
| **No Login** | Public websites | Nothing |
| **Basic Auth** | Old-style browser popup asking for username/password | Username + Password |
| **Form Login** | A normal login page with fields | Login URL (optional), username, password, and optionally the CSS selectors for the fields/submit button |
| **Bearer Token** | Apps/APIs that accept an `Authorization: Bearer` token | Paste the token |
| **OAuth / SSO** | Cognito, Azure AD, Google, Okta, Auth0, corporate SSO | Use **Interactive Login Capture** (recommended) — click *Launch Browser & Login*, a real browser opens, you log in yourself (including any MFA/SSO redirects), then click *Capture Session*. The tool grabs your cookies + localStorage automatically. A manual paste-in-JSON option is also available under "Manual entry". |

### Card 5 — Target Screens *(optional)*
Lets you test **only the pages that changed** instead of crawling the whole app — faster and cheaper on AI tokens. Requires a **screen registry** (see [Section 13](#13-screen-registries--test-only-what-changed)).

### Advanced Options *(click the card to expand)*
- **Max crawl depth** — how many clicks deep the explorer follows links (default 3).
- **Max pages** — safety cap on how many pages get captured (default 20).
- **Test timeout / retries** — how long each test may run and whether failures retry.
- **Application Context** *(subsection at the bottom of this card)* — fine-tune the browser environment: base URL, viewport size, user agent, extra HTTP headers (JSON), and **API URL patterns** — comma-separated URL fragments like `/api/`, `execute-api`, `graphql` that tell the tool which network calls belong to your app, so generated tests wait on real API responses instead of guessing with fixed sleeps.

### Card 6 — Self-Healing
- **Enable Self-Healing** *(checkbox, ON by default)* — when ON, failed tests are analyzed and patched by the AI (up to 3 attempts per plan); when OFF, everything runs in one fast batch and unfixable failures are marked `test.fixme` with a reason comment — faster and cheaper on tokens.

Then the big **Start Test Generation** button at the bottom kicks off the run.

---

## 10. Watching the Pipeline Run

After you click **Start Test Generation**, the pipeline view streams progress live (via Server-Sent Events — no refreshing needed).

| Stage | What it's doing |
|---|---|
| **Explore** | Launches headless Chromium, logs in if needed, crawls your site, captures each page's accessibility tree + which API calls it makes. Saved to `knowledge/snapshots.json`. |
| **Analyze** | The AI reads every snapshot and builds a "page model" — what the page is, what elements exist, what a user can do. Saved to `knowledge/page_models.json`. |
| **Plan** | The AI decides what to test on each page — scenarios like "user can add an item" or "validation error appears on empty submit". Saved to `knowledge/plans.json`. |
| **Generate** | Writes real Playwright `.spec.ts` files. Two strategies run in parallel — a deterministic "record-and-ground" recorder that replays steps against the live page, and pure AI generation — then picks the better output. |
| **Execute** | Runs each spec file with the real Playwright test runner and reports pass/fail per test. |
| **Heal** *(if enabled and needed)* | The AI classifies each failure — is it a bad test plan or bad generated code? — then patches the file and re-runs. Max 3 attempts per suite. Whatever still can't be fixed is marked `test.fixme("reason")` so it's flagged, not silently deleted. |
| **Report** | Builds a downloadable `report.html` and totals token usage (you can see how many AI tokens each stage consumed). |

You can navigate away and come back via **Run History**; every run is stored on disk.

---

## 11. Reading the Results

The **Results** view shows:

- **Pass / Fail / Fixme counts** per suite and overall.
- **The generated test code** — full Playwright TypeScript you can copy into your own test suite.
- **Download Report** — a self-contained HTML file you can email to your team.
- **Re-execute** — run the same generated tests again (see next section).
- **Token usage** — input/output tokens and number of AI calls per stage.

Generated tests use accessibility-first locators (`getByRole`, `getByLabel`…), which makes them resilient to CSS changes.

---

## 12. Re-running Tests Without Regenerating Them

Once tests are generated, you don't need the AI to run them again — the `.spec.ts` files are real Playwright tests.

- In the **Results** view or **Run History**, click **Re-execute** on a run.
- Optionally toggle healing on/off.
- The same tests run against the (possibly updated) site — useful as a regression check after a deployment.

This also works after restarting the server — runs are persisted on disk with their full config (`run-meta.json`), so re-execution uses the same auth and LLM settings as the original run.

---

## 13. Screen Registries — Test Only What Changed

A **screen registry** is a saved list of your app's pages with friendly names (e.g. "Home", "Buy Product", "Checkout"). You build it once per app/environment.

**To build a registry:**

1. Enter your **Application URL**.
2. Under **Target Screens**, click **+ Build New Registry**.
3. Give it a name (e.g. `myapp-prod`), set crawl depth/pages, click **Build Registry**.
4. The tool crawls your app once and lists every discovered screen.

**To use it:** pick the registry from the dropdown, tick the checkboxes for the screens you changed, optionally describe *what changed* per screen (this is passed to the AI so it focuses tests there), set a crawl depth (0 = only those screens), and start the run.

**To update it later:** select the registry → **Recrawl / Update Screens**. Your custom friendly names are preserved. You can also rename screens inline, add screens manually, or remove them.

Registries live as JSON files in the `registries/` folder.

---

## 14. Configuration Presets — Save Your Settings

If you run the tool regularly, presets save you from re-typing everything.

- **Save:** fill in the whole form once → type a name in "Save as new preset" → click **Save New**.
- **Load:** pick it from "Load existing preset" → click **Load**. All fields repopulate, including LLM provider, auth, and advanced options.
- **Overwrite:** select a preset, change settings, save under the same name.
- **Delete:** select it → **Delete**.

Presets are stored on the server in `presets/` — they survive browser cache clears and work from any browser that reaches the app.

---

## 15. Running Generated Tests Manually

The generated `.spec.ts` files are standard Playwright tests. To run them yourself in a terminal:

```
cd runs\<run-id>
npx playwright test --config=../../playwright.config.ts
```

(Use `runs/<run-id>` with forward slashes on Mac/Linux.)

Useful Playwright flags:

- `--headed` — watch the browser while tests run
- `--ui` — open Playwright's interactive test UI
- `-g "test name"` — run just one test

---

## 16. Running the Project's Own Unit Tests

The project has its own test suite (tests of the tool itself — network capture, app-context validation, pipeline persistence). To run them:

```
npm test
```

This runs `node --test tests/*.test.js` — no browser or AI key needed.

---

## 17. Where Everything Is Stored

```
UI-playwright-test-automation/
├── .env                  ← YOUR secrets/config (never share)
├── .env.example          ← template with every option documented
├── client/               ← the web interface (React + Vite)
├── server/               ← the backend (Express + pipeline)
│   ├── pipeline/         ← explore → analyze → plan → generate → execute → heal
│   ├── routes/           ← API endpoints
│   └── utils/            ← LLM client, accessibility, network capture, reports
├── presets/              ← your saved configuration presets (.json)
├── registries/           ← your screen registries (.json)
├── runs/<run-id>/        ← one folder per run:
│   ├── knowledge/        ← snapshots.json, page_models.json, plans.json
│   ├── generated-tests/  ← the .spec.ts Playwright tests  ★ the valuable output
│   ├── test-results/     ← Playwright JSON results per suite
│   ├── auth-state.json   ← saved login session for reuse
│   ├── run-meta.json     ← the config that produced this run
│   └── report.html       ← downloadable report
├── tests/                ← the project's own unit tests
├── playwright.config.ts  ← config used when running generated tests
└── DEPLOY.md             ← deployment & provider reference (advanced)
```

> **Note:** `run-meta.json` can contain credentials so re-execution works after restarts — keep the `runs/` folder private. It is excluded from git via `.gitignore` (along with `presets/` and `registries/`, which can hold credentials and internal URLs).

---

## 18. Troubleshooting — Common Problems and Fixes

| Symptom | Likely cause / fix |
|---|---|
| `node is not recognized` | Node.js isn't installed or PATH wasn't updated — reinstall from nodejs.org and reopen the terminal |
| Browser shows nothing at `localhost:5173` | The dev servers aren't running — run `npm run dev` and keep the terminal open |
| "Test Connection" fails | Wrong API key/model, or (Ollama/vLLM) the local server isn't started. For Bedrock, check `bedrock:InvokeModel` IAM permission and that the model is enabled in your region |
| `Playwright browsers missing` / browser launch errors | Run `npx playwright install chromium` |
| Explorer captured 0 pages | The site never finished loading — raise `PLAYWRIGHT_TIMEOUT` / `NETWORKIDLE_TIMEOUT` in `.env`; check the site is reachable from this machine |
| Planner generated 0 test plans | The AI couldn't find interactive elements — try a stronger model, or a page with real UI controls |
| Tests fail on a site that needs login | Check the **Authentication** card — use *Form Login* or *OAuth → Interactive Login Capture* |
| Port already in use (`EADDRINUSE`) | Something else is on 3001 or 5173 — close it, or change `PORT` in `.env` |
| Slow runs / high token cost | Lower `MAX_PAGES`/`MAX_CRAWL_DEPTH`, use Target Screens, or disable healing for a fast batch run |
| All tests end up `fixme` | The AI model is too weak — use a stronger model (e.g. Claude Sonnet) |
| Ollama gives garbage output | Use a 14B+ parameter model (`qwen3:14b` or better) |
| Server restarted and history looks empty | Check `runs/` folder — history is rebuilt from disk automatically |

---

## 19. Stopping the Application

- In the terminal running `npm run dev`, press **Ctrl + C** (you may need to confirm with `Y` on Windows).
- Everything stops. Your runs, presets, and registries remain saved on disk.
- To start again later: `npm run dev` → open `http://localhost:5173`.

**Production mode** (single server, no Vite):

```
npm run build:client     # one-time build
npm start                # serves everything on http://localhost:3001
```

(On Windows cmd/PowerShell, `npm start` may need `set NODE_ENV=production` first, or use cross-env — `npm run dev` is the recommended everyday mode.)

---

## 20. Quick Command Cheat Sheet

| Task | Command |
|---|---|
| Install everything | `npm run install:all` |
| Install browser (once) | `npx playwright install chromium` |
| Start the app (dev) | `npm run dev` → open `http://localhost:5173` |
| Run project's unit tests | `npm test` |
| Build for production | `npm run build:client` |
| Start in production | `npm start` → `http://localhost:3001` |
| Re-run generated tests by hand | `cd runs/<id>` then `npx playwright test --config=../../playwright.config.ts` |

---

## Need More Detail?

- **`DEPLOY.md`** — provider-by-provider config reference, IAM policies, deployment notes, and the validation checklist.
- **`.env.example`** — every environment variable with inline documentation.
