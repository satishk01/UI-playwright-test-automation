# AutoTest Agent — Deployment & Validation Guide

Autonomous E2E test generation pipeline with 9 LLM providers: explore a site, plan scenarios, generate grounded Playwright code, and self-heal failures.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       React Frontend (Vite)                     │
│                                                                 │
│  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  Config   │  │  Pipeline  │  │ Results  │  │    Code      │  │
│  │  + LLM    │  │  Progress  │  │ Summary  │  │    Viewer    │  │
│  └──────────┘  └────────────┘  └──────────┘  └──────────────┘  │
└───────────────────────┬─────────────────────────────────────────┘
                        │ SSE + REST
┌───────────────────────▼─────────────────────────────────────────┐
│                    Express.js Backend                           │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                  Unified LLM Client                        │  │
│  │  Anthropic │ Bedrock │ Azure │ OpenRouter │ Grok │ NVIDIA  │  │
│  │  Ollama │ vLLM │ OmniRoute                                 │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Explore → Analyze → Plan → Generate ⇄ Execute ⇄ Heal     │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## Prerequisites

| Requirement | Version | Purpose                     |
|-------------|---------|------------------------------|
| Node.js     | ≥ 18    | Server + client runtime      |
| npm         | ≥ 9     | Package management           |
| LLM access  | —       | At least one provider below  |

---

## Quick Start

```bash
git clone <your-repository-url>
cd UI-playwright-test-automation
npm install && cd client && npm install && cd ..
npx playwright install chromium
cp .env.example .env          # edit with your provider config
npm run dev                   # http://localhost:5173
```

---

## LLM Providers

### Provider Comparison

| Provider     | Protocol        | API Key    | Cost       | Latency | Notes                                     |
|--------------|-----------------|------------|------------|---------|-------------------------------------------|
| Anthropic    | Native SDK      | Required   | Per-token  | 2–5s    | Best quality; direct Claude access         |
| AWS Bedrock  | AWS SDK Converse| IAM/keys   | Per-token  | 2–4s    | Multi-model; IAM instance profile support  |
| Azure OpenAI | Azure REST      | Required   | Per-token  | 2–4s    | Enterprise; custom deployments             |
| OpenRouter   | OpenAI-compat   | Required   | Per-token  | Varies  | 200+ models via one key                    |
| Grok (xAI)   | OpenAI-compat   | Required   | Per-token  | 1–3s    | xAI's Grok-3 family                       |
| NVIDIA NIM   | OpenAI-compat   | Required*  | Per-token* | 1–3s    | Cloud or self-hosted NIM containers        |
| Ollama       | OpenAI-compat   | None       | Free       | Varies  | Local; pull model first                    |
| vLLM         | OpenAI-compat   | Optional   | Your GPU   | 1–3s    | Self-hosted; any HF model                  |
| OmniRoute    | OpenAI-compat   | Optional   | Gateway    | Varies  | Custom AI gateway/router                   |

### 1. Anthropic (Claude)

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=claude-sonnet-4-6
```

Models: `claude-sonnet-4-6` · `claude-haiku-4-5-20251001` · `claude-opus-4-6`

### 2. AWS Bedrock

Uses the Bedrock Converse API via the AWS SDK. Supports IAM instance profiles (no credentials needed on EC2/ECS) or explicit access keys.

```env
LLM_PROVIDER=bedrock
LLM_MODEL=anthropic.claude-sonnet-4-6-v1
AWS_REGION=us-east-1
# Optional — leave blank on EC2/ECS with an IAM role:
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

Models: `anthropic.claude-*` · `us.amazon.nova-pro-v1:0` · `meta.llama3-1-70b-instruct-v1:0` · `mistral.mistral-large-2407-v1:0`

IAM policy required:
```json
{
  "Effect": "Allow",
  "Action": "bedrock:InvokeModel",
  "Resource": "arn:aws:bedrock:*::foundation-model/*"
}
```

### 3. Azure OpenAI

```env
LLM_PROVIDER=azure
LLM_BASE_URL=https://your-resource.openai.azure.com
LLM_API_KEY=your-azure-api-key
LLM_MODEL=gpt-4o
AZURE_DEPLOYMENT=my-gpt4o-deployment
AZURE_API_VERSION=2024-10-21
```

Models: `gpt-4o` · `gpt-4o-mini` · `gpt-4-turbo` · `gpt-4` · `gpt-35-turbo`

The deployment name is the name you chose when deploying a model in Azure AI Studio.

### 4. OpenRouter

Single API key to access 200+ models from Anthropic, OpenAI, Google, Meta, DeepSeek, Qwen, and more.

```env
LLM_PROVIDER=openrouter
LLM_API_KEY=sk-or-...
LLM_MODEL=anthropic/claude-sonnet-4-6
```

Models: `anthropic/claude-sonnet-4-6` · `openai/gpt-4o` · `google/gemini-2.5-flash` · `meta-llama/llama-3.1-70b-instruct` · `deepseek/deepseek-r1` · `qwen/qwen3-235b-a22b`

Get a key at [openrouter.ai/keys](https://openrouter.ai/keys).

### 5. Grok (xAI)

```env
LLM_PROVIDER=grok
LLM_API_KEY=xai-...
LLM_MODEL=grok-3-mini
```

Models: `grok-3` · `grok-3-mini` · `grok-3-fast`

Get a key at [console.x.ai](https://console.x.ai).

### 6. NVIDIA NIM

Cloud-hosted at build.nvidia.com or self-hosted NIM containers.

```env
LLM_PROVIDER=nvidia
LLM_API_KEY=nvapi-...
LLM_MODEL=meta/llama-3.1-70b-instruct
# Self-hosted: LLM_BASE_URL=http://your-nim-server:8000
```

### 7. Ollama (Local)

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:14b
ollama serve
```

```env
LLM_PROVIDER=ollama
LLM_MODEL=qwen3:14b
LLM_BASE_URL=http://localhost:11434
```

Use 14B+ models for reliable structured JSON output.

### 8. vLLM (Self-hosted)

```bash
pip install vllm
vllm serve meta-llama/Llama-3.1-8B-Instruct --api-key token-abc
```

```env
LLM_PROVIDER=vllm
LLM_MODEL=meta-llama/Llama-3.1-8B-Instruct
LLM_BASE_URL=http://your-gpu-server:8000
LLM_API_KEY=token-abc
```

### 9. OmniRoute (AI Gateway)

For custom OpenAI-compatible gateways, routers, or proxies (LiteLLM, Portkey, Kong AI Gateway, etc.).

```env
LLM_PROVIDER=omniroute
LLM_MODEL=default
LLM_BASE_URL=http://localhost:4000
LLM_API_KEY=                        # if required
```

### Switching Providers at Runtime

The UI has a **LLM Provider** panel with tabbed selection. Each run can use a different provider — the choice is sent per-run to the orchestrator. A **Test Connection** button verifies reachability before you start.

Provider-specific fields (Azure deployment name, Bedrock region/credentials) appear dynamically when you select that provider.

---

## Authentication (Target App)

| Method       | Use Case                                          |
|--------------|---------------------------------------------------|
| No Login     | Public sites                                      |
| Basic Auth   | HTTP Basic username/password                      |
| Form Login   | Login page with form fields                       |
| Bearer Token | APIs / SPAs accepting Authorization header        |
| OAuth / SSO  | Cognito, Azure AD, Google, Okta, Auth0 — paste cookies/tokens from DevTools |

For OAuth: log into your app in a browser → DevTools → Application → export cookies as JSON array and/or localStorage entries as JSON object.

---

## Design Invariants

| Invariant                  | Enforcement                                                       |
|----------------------------|-------------------------------------------------------------------|
| Snapshot grounding         | Every locator derives from accessibility tree `[role] 'name'`     |
| Deletion-proof healing     | Test count can never decrease across heal iterations              |
| Non-regressing convergence | Compile ≤ baseline, passed ≥ baseline, failed < baseline         |
| Bounded iteration          | Max 3 heals → residual failures become `test.fixme()` with reason |
| Run isolation              | Each run gets its own `runs/<uuid>/` directory                    |

---

## Project Structure

```
autotest-agent/
├── server/
│   ├── index.js
│   ├── routes/
│   │   ├── pipeline.js        # /api/pipeline — start, stream, providers, health-check
│   │   └── runs.js             # /api/runs — list, fetch tests
│   ├── utils/
│   │   └── llm-client.js       # Unified 9-provider LLM client
│   └── pipeline/
│       ├── orchestrator.js     # Stage coordination + guardrail
│       ├── 01_explore.js       # BFS crawl + accessibility snapshots
│       ├── 02_analyze.js       # LLM page model generation
│       ├── 03_plan.js          # LLM test scenario planning
│       ├── 04_generate.js      # Record-and-ground + LLM fallback
│       ├── 05_execute.js       # Playwright runner + result parsing
│       └── 06_heal.js          # Failure diagnosis + patching
├── client/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── components/
│   │   │   ├── ConfigPanel.jsx # URL + 9 LLM providers + 5 auth methods
│   │   │   ├── PipelineView.jsx
│   │   │   └── ResultsView.jsx
│   │   ├── hooks/useSSE.js
│   │   └── styles/global.css
│   └── index.html
├── runs/
├── playwright.config.ts
├── .env.example
├── DEPLOY.md
└── package.json
```

---

## Configuration Reference

| Variable               | Default                        | Description                        |
|------------------------|--------------------------------|------------------------------------|
| `LLM_PROVIDER`         | `anthropic`                    | Provider ID (see list above)       |
| `ANTHROPIC_API_KEY`    | —                              | Anthropic API key                  |
| `LLM_API_KEY`          | —                              | Generic API key (most providers)   |
| `LLM_MODEL`            | provider-specific              | Model identifier                   |
| `LLM_BASE_URL`         | provider-specific              | Override endpoint                  |
| `AWS_REGION`           | `us-east-1`                    | Bedrock region                     |
| `AWS_ACCESS_KEY_ID`    | —                              | Bedrock credentials (optional)     |
| `AWS_SECRET_ACCESS_KEY`| —                              | Bedrock credentials (optional)     |
| `AZURE_DEPLOYMENT`     | same as model                  | Azure deployment name              |
| `AZURE_API_VERSION`    | `2024-10-21`                   | Azure API version                  |
| `PORT`                 | `3001`                         | Server port                        |
| `MAX_CRAWL_DEPTH`      | `3`                            | BFS depth limit                    |
| `MAX_PAGES`            | `20`                           | Max pages to snapshot              |
| `PLAYWRIGHT_TIMEOUT`   | `30000`                        | Navigation timeout (ms)            |
| `MAX_HEAL_ITERATIONS`  | `3`                            | Heal attempts before fixme         |
| `MAX_TESTS_PER_PLAN`   | `4`                            | Tests per plan                     |

---

## Validation Checklist

### 1. Provider Connectivity

For each provider you plan to use, select it in the UI, configure credentials, and click **Test Connection**. Verify `✓ Connected` with latency.

### 2. Smoke Test

Enter `https://demo.playwright.dev/todomvc/`, select No Login, pick any provider, and start. Verify all six stages complete and generated specs use only `getByRole()`.

### 3. Auth Test

Test Form Login and OAuth with a protected app. Verify post-login pages are explored.

### 4. Heal Loop

Run against a dynamic site. Watch heal classify failures, verify test count never drops, and `test.fixme()` appears with reasons for unresolvable failures.

### 5. Manual Execution

```bash
cd runs/<run-id>
npx playwright test --config=../../playwright.config.ts
```

---

## Troubleshooting

| Issue                                | Solution                                                |
|--------------------------------------|---------------------------------------------------------|
| Anthropic key error                  | Set `ANTHROPIC_API_KEY` in `.env`                       |
| Bedrock AccessDeniedException        | Check IAM policy grants `bedrock:InvokeModel`           |
| Bedrock credentials not found        | Set `AWS_ACCESS_KEY_ID`/`SECRET` or use instance profile|
| Azure 404 on deployment              | Verify deployment name matches Azure AI Studio           |
| Azure 401                            | Check `api-key` value                                   |
| OpenRouter 402                       | Add credits at openrouter.ai                            |
| Grok 401                             | Verify `xai-` key at console.x.ai                      |
| NVIDIA 401                           | Verify `nvapi-` key at build.nvidia.com                 |
| Ollama connection refused            | Run `ollama serve` first                                |
| Ollama model not found               | Run `ollama pull <model>`                               |
| vLLM 401                             | Match `LLM_API_KEY` with `--api-key` flag               |
| OmniRoute connection refused         | Verify gateway is running at the configured URL          |
| Playwright browsers missing          | `npx playwright install chromium`                       |
| Poor JSON from local model           | Use 14B+ with strong instruction-following              |
| All tests fixme                      | Try a higher-quality model or a simpler page            |
