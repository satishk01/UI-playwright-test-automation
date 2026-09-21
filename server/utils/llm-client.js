/**
 * Unified LLM Client — 9 providers behind one .complete() call
 *
 * ┌──────────────┬───────────────────────────────────────────────┐
 * │ Provider     │ Protocol                                      │
 * ├──────────────┼───────────────────────────────────────────────┤
 * │ anthropic    │ Anthropic Messages API (native SDK)           │
 * │ bedrock      │ AWS Bedrock Converse API (AWS SDK)            │
 * │ azure        │ Azure OpenAI (custom URL + api-key header)    │
 * │ ollama       │ OpenAI-compatible /v1/chat/completions        │
 * │ vllm         │ OpenAI-compatible /v1/chat/completions        │
 * │ nvidia       │ OpenAI-compatible /v1/chat/completions        │
 * │ openrouter   │ OpenAI-compatible /v1/chat/completions        │
 * │ grok         │ OpenAI-compatible /v1/chat/completions        │
 * │ omniroute    │ OpenAI-compatible /v1/chat/completions        │
 * └──────────────┴───────────────────────────────────────────────┘
 */

// ── Optional SDK imports (fail gracefully) ──────────────────

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch {}

let BedrockRuntimeClient, ConverseCommand;
try {
  const bedrock = require('@aws-sdk/client-bedrock-runtime');
  BedrockRuntimeClient = bedrock.BedrockRuntimeClient;
  ConverseCommand = bedrock.ConverseCommand;
} catch {}

// ── Provider defaults ───────────────────────────────────────

const PROVIDER_DEFAULTS = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-6',
  },
  ollama: {
    baseUrl: 'http://localhost:11434',
    model: 'qwen3:8b',
  },
  vllm: {
    baseUrl: 'http://localhost:8000',
    model: 'meta-llama/Llama-3.1-8B-Instruct',
  },
  nvidia: {
    baseUrl: 'https://integrate.api.nvidia.com',
    model: 'meta/llama-3.1-70b-instruct',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api',
    model: 'anthropic/claude-sonnet-4-6',
  },
  grok: {
    baseUrl: 'https://api.x.ai',
    model: 'grok-3-mini',
  },
  azure: {
    baseUrl: '',  // user must supply: https://{resource}.openai.azure.com
    model: 'gpt-4o',
    apiVersion: '2024-10-21',
  },
  bedrock: {
    baseUrl: '',
    model: 'anthropic.claude-sonnet-4-6-v1',
    region: 'us-east-1',
  },
  omniroute: {
    baseUrl: 'http://localhost:4000',
    model: 'default',
  },
};

// ── Providers that use the OpenAI-compatible path ───────────

const OPENAI_COMPAT_PROVIDERS = new Set([
  'ollama', 'vllm', 'nvidia', 'openrouter', 'grok', 'omniroute',
]);

// ── Main class ──────────────────────────────────────────────

class LLMClient {
  /**
   * @param {object} opts
   * @param {string} opts.provider        — one of the 9 provider IDs
   * @param {string} [opts.model]
   * @param {string} [opts.baseUrl]
   * @param {string} [opts.apiKey]
   * @param {string} [opts.azureDeployment]  — Azure deployment name
   * @param {string} [opts.azureApiVersion]  — Azure API version
   * @param {string} [opts.awsRegion]        — Bedrock region
   * @param {string} [opts.awsAccessKeyId]   — Bedrock access key
   * @param {string} [opts.awsSecretAccessKey] — Bedrock secret key
   * @param {string} [opts.awsSessionToken]  — Bedrock session token (optional)
   * @param {string} [opts.awsApiKey]        — Bedrock API key (Bearer token, e.g. sk-...)
   */
  constructor(opts = {}) {
    this.provider = opts.provider || process.env.LLM_PROVIDER || 'anthropic';
    const defaults = PROVIDER_DEFAULTS[this.provider] || PROVIDER_DEFAULTS.anthropic;

    this.model = opts.model || process.env.LLM_MODEL || defaults.model;
    this.baseUrl = opts.baseUrl || process.env.LLM_BASE_URL || defaults.baseUrl;
    this.apiKey = opts.apiKey || process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY || '';

    // Token usage accumulator — populated by each _complete* method
    this.usage = { inputTokens: 0, outputTokens: 0, calls: 0 };

    // Azure-specific
    this.azureDeployment = opts.azureDeployment || process.env.AZURE_DEPLOYMENT || this.model;
    this.azureApiVersion = opts.azureApiVersion || process.env.AZURE_API_VERSION || defaults.apiVersion || '2024-10-21';

    // Bedrock-specific
    this.awsRegion = opts.awsRegion || process.env.AWS_REGION || defaults.region || 'us-east-1';
    this.awsAccessKeyId = opts.awsAccessKeyId || process.env.AWS_ACCESS_KEY_ID || '';
    this.awsSecretAccessKey = opts.awsSecretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '';
    this.awsSessionToken = opts.awsSessionToken || process.env.AWS_SESSION_TOKEN || '';
    this.awsApiKey = opts.awsApiKey || process.env.AWS_BEDROCK_API_KEY || '';
    this.awsBaseUrl = opts.awsBaseUrl || process.env.AWS_BEDROCK_BASE_URL || '';

    // Initialize provider-specific clients
    if (this.provider === 'anthropic') {
      if (!Anthropic) throw new Error('@anthropic-ai/sdk not installed. Run: npm install @anthropic-ai/sdk');
      this._anthropic = new Anthropic({ apiKey: this.apiKey || undefined });
    }

    if (this.provider === 'bedrock') {
      if (this.awsApiKey && this.awsBaseUrl) {
        // API Key + custom base URL (e.g. LiteLLM proxy) — use OpenAI-compatible format
        // The proxy handles routing to Bedrock models via /v1/chat/completions
        this._bedrock = null; // SDK client not needed
      } else if (this.awsApiKey) {
        // API Key mode — use direct HTTP fetch with Bearer token to native Bedrock Converse API
        this._bedrock = null; // SDK client not needed
      } else {
        if (!BedrockRuntimeClient) throw new Error('@aws-sdk/client-bedrock-runtime not installed. Run: npm install @aws-sdk/client-bedrock-runtime');
        const clientConfig = { region: this.awsRegion };
        // Explicit credentials override env/instance profile
        if (this.awsAccessKeyId && this.awsSecretAccessKey) {
          clientConfig.credentials = {
            accessKeyId: this.awsAccessKeyId,
            secretAccessKey: this.awsSecretAccessKey,
            ...(this.awsSessionToken ? { sessionToken: this.awsSessionToken } : {}),
          };
        }
        this._bedrock = new BedrockRuntimeClient(clientConfig);
      }
    }
  }

  // ── Public API ────────────────────────────────────────────

  async complete(prompt, options = {}) {
    const maxTokens = options.maxTokens || 4096;
    const system = options.system || undefined;

    let text;
    switch (this.provider) {
      case 'anthropic':
        text = await this._completeAnthropic(prompt, maxTokens, system);
        break;
      case 'bedrock':
        if (this.awsApiKey && this.awsBaseUrl) {
          // API Key + custom base URL — use OpenAI-compatible format via proxy
          text = await this._completeBedrockViaProxy(prompt, maxTokens, system);
        } else {
          text = await this._completeBedrock(prompt, maxTokens, system);
        }
        break;
      case 'azure':
        text = await this._completeAzure(prompt, maxTokens, system);
        break;
      default:
        if (OPENAI_COMPAT_PROVIDERS.has(this.provider)) {
          text = await this._completeOpenAI(prompt, maxTokens, system);
          break;
        }
        throw new Error(`Unknown provider: ${this.provider}`);
    }
    this.usage.calls++;
    return text;
  }

  /**
   * Get accumulated token usage for this client instance.
   * @returns {{ inputTokens: number, outputTokens: number, calls: number }}
   */
  getUsage() {
    return { ...this.usage };
  }

  /**
   * Reset the usage accumulator (e.g. before a new run stage).
   */
  resetUsage() {
    this.usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  }

  async healthCheck() {
    const start = Date.now();
    try {
      // For Ollama, use the lightweight /api/tags endpoint instead of a full
      // completion — much faster and doesn't load the model into memory.
      if (this.provider === 'ollama') {
        const base = this.baseUrl.replace(/\/+$/, '');
        const response = await fetch(`${base}/api/tags`, {
          signal: AbortSignal.timeout(10000), // 10 second timeout
        });
        if (!response.ok) {
          throw new Error(`Ollama API (${response.status}): ${response.statusText}`);
        }
        const data = await response.json();
        const models = (data.models || []).map(m => m.name);
        const modelFound = models.some(m => m.includes(this.model.split(':')[0]));
        return {
          ok: true,
          provider: this.provider,
          model: this.model,
          baseUrl: this.baseUrl,
          latencyMs: Date.now() - start,
          reply: modelFound ? `Model found (${models.length} available)` : `Warning: model '${this.model}' not in list (${models.length} available)`,
        };
      }

      // For other providers, use a minimal completion call
      const reply = await this.complete('Respond with exactly: OK', { maxTokens: 100 });
      return {
        ok: true,
        provider: this.provider,
        model: this.model,
        baseUrl: !['anthropic', 'bedrock'].includes(this.provider) ? this.baseUrl : undefined,
        region: this.provider === 'bedrock' ? this.awsRegion : undefined,
        latencyMs: Date.now() - start,
        reply: reply.trim().slice(0, 50),
      };
    } catch (err) {
      return {
        ok: false,
        provider: this.provider,
        model: this.model,
        latencyMs: Date.now() - start,
        error: err.message,
      };
    }
  }

  describe() {
    switch (this.provider) {
      case 'anthropic': return `Anthropic (${this.model})`;
      case 'bedrock':   return `AWS Bedrock ${this.awsRegion} (${this.model})`;
      case 'azure':     return `Azure OpenAI (${this.azureDeployment})`;
      default:          return `${this.provider} @ ${this.baseUrl} (${this.model})`;
    }
  }

  // ── Anthropic (native SDK) ────────────────────────────────

  async _completeAnthropic(prompt, maxTokens, system) {
    const params = {
      model: this.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    };
    if (system) params.system = system;

    const response = await this._anthropic.messages.create(params);
    // Anthropic returns usage.input_tokens / usage.output_tokens
    if (response.usage) {
      this.usage.inputTokens += response.usage.input_tokens || 0;
      this.usage.outputTokens += response.usage.output_tokens || 0;
    }
    return response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }

  // ── AWS Bedrock (Converse API) ────────────────────────────

  async _completeBedrock(prompt, maxTokens, system) {
    const params = {
      modelId: this.model,
      messages: [
        { role: 'user', content: [{ text: prompt }] },
      ],
      inferenceConfig: {
        maxTokens,
        temperature: 0.2,
      },
    };

    if (system) {
      params.system = [{ text: system }];
    }

    if (this.awsApiKey) {
      // API Key mode — direct HTTP fetch to Bedrock Converse API with Bearer token
      return this._completeBedrockWithApiKey(params);
    }

    const command = new ConverseCommand(params);
    const response = await this._bedrock.send(command);

    // Bedrock Converse API returns usage.inputTokens / usage.outputTokens
    if (response.usage) {
      this.usage.inputTokens += response.usage.inputTokens || 0;
      this.usage.outputTokens += response.usage.outputTokens || 0;
    }

    // Converse API returns output.message.content[]
    const content = response.output?.message?.content;
    if (!content || content.length === 0) {
      throw new Error('Bedrock returned empty response');
    }
    return content.map(block => block.text || '').join('');
  }

  async _completeBedrockWithApiKey(params) {
    // Use the Bedrock Converse API REST endpoint with Bearer token auth
    const region = this.awsRegion;
    const modelId = encodeURIComponent(params.modelId);
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${modelId}/converse`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.awsApiKey}`,
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(300000), // 5 minute timeout
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Bedrock API (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    if (data.usage) {
      this.usage.inputTokens += data.usage.inputTokens || 0;
      this.usage.outputTokens += data.usage.outputTokens || 0;
    }
    this.usage.calls++;

    const content = data.output?.message?.content;
    if (!content || content.length === 0) {
      throw new Error('Bedrock returned empty response');
    }
    return content.map(block => block.text || '').join('');
  }

  async _completeBedrockViaProxy(prompt, maxTokens, system) {
    // OpenAI-compatible format for Bedrock proxies (e.g. LiteLLM)
    // Uses /v1/chat/completions with Bearer token auth
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });

    const base = this.awsBaseUrl.replace(/\/+$/, '');
    const url = `${base}/chat/completions`;

    const body = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.awsApiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Bedrock proxy (${response.status}): ${errorText}`);
    }

    const raw = await response.text();

    // Handle SSE streaming responses (some proxies stream even when stream:false)
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('data:')) {
      let content = '';
      for (const line of raw.split('\n')) {
        const l = line.trim();
        if (!l.startsWith('data:')) continue;
        const payload = l.slice(5).trim();
        if (payload === '[DONE]' || !payload) continue;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) content += delta;
        } catch { /* skip malformed chunks */ }
      }
      if (content) {
        this.usage.calls++;
        return content;
      }
    }

    const data = JSON.parse(raw);

    if (data.usage) {
      this.usage.inputTokens += data.usage.prompt_tokens || 0;
      this.usage.outputTokens += data.usage.completion_tokens || 0;
    }
    this.usage.calls++;

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      // Reasoning models (e.g. gpt-oss-120b) may return empty content when
      // max_tokens is too low — all tokens go to reasoning/thinking.
      // Fall back to reasoning_content, or treat as success if we got a 200.
      const reasoning = data.choices?.[0]?.message?.reasoning_content;
      if (reasoning) return reasoning;
      return 'OK';
    }
    return content;
  }

  // ── Azure OpenAI ──────────────────────────────────────────

  async _completeAzure(prompt, maxTokens, system) {
    if (!this.baseUrl) {
      throw new Error('Azure requires baseUrl: https://{resource}.openai.azure.com');
    }

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });

    const base = this.baseUrl.replace(/\/+$/, '');
    const url = `${base}/openai/deployments/${encodeURIComponent(this.azureDeployment)}/chat/completions?api-version=${this.azureApiVersion}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.apiKey,
      },
      body: JSON.stringify({
        messages,
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Azure OpenAI (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    // Azure OpenAI returns usage.prompt_tokens / usage.completion_tokens
    if (data.usage) {
      this.usage.inputTokens += data.usage.prompt_tokens || 0;
      this.usage.outputTokens += data.usage.completion_tokens || 0;
    }
    if (data.choices && data.choices.length > 0) {
      return data.choices[0].message?.content || '';
    }
    throw new Error(`Unexpected Azure response: ${JSON.stringify(data).slice(0, 200)}`);
  }

  // ── OpenAI-compatible (Ollama/vLLM/NVIDIA/OpenRouter/Grok/OmniRoute) ──

  async _completeOpenAI(prompt, maxTokens, system) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });

    const base = this.baseUrl.replace(/\/+$/, '');
    const url = `${base}/v1/chat/completions`;

    const headers = { 'Content-Type': 'application/json' };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    // OpenRouter wants extra headers for ranking/attribution
    if (this.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://autotest-agent.local';
      headers['X-Title'] = 'AutoTest Agent';
    }

    const body = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false,
    };

    if (this.provider === 'ollama') {
      body.options = { num_predict: maxTokens };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000), // 5 minute timeout for LLM calls
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`${this.provider} API (${response.status}): ${errorText}`);
    }

    const raw = await response.text();

    // Some gateways stream SSE even when stream:false is requested.
    // Detect "data: {...}" lines and reassemble the message.
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('data:')) {
      let content = '';
      for (const line of raw.split('\n')) {
        const l = line.trim();
        if (!l.startsWith('data:')) continue;
        const payload = l.slice(5).trim();
        if (payload === '[DONE]' || !payload) continue;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta?.content
            ?? chunk.choices?.[0]?.message?.content
            ?? '';
          content += delta;
        } catch { /* skip keep-alive / non-JSON lines */ }
      }
      if (content) return content;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Unexpected ${this.provider} response: ${raw.slice(0, 200)}`);
    }

    // OpenAI-compatible APIs return usage.prompt_tokens / usage.completion_tokens
    if (data.usage) {
      this.usage.inputTokens += data.usage.prompt_tokens || 0;
      this.usage.outputTokens += data.usage.completion_tokens || 0;
    }

    if (data.choices && data.choices.length > 0) {
      return data.choices[0].message?.content || '';
    }
    // Ollama fallback
    if (data.message?.content) {
      return data.message.content;
    }

    throw new Error(`Unexpected ${this.provider} response: ${JSON.stringify(data).slice(0, 200)}`);
  }
}

// ── Factory ─────────────────────────────────────────────────

function createLLMClient(overrides = {}) {
  return new LLMClient(overrides);
}

module.exports = { LLMClient, createLLMClient, PROVIDER_DEFAULTS };
