import React, { useState, useEffect } from 'react';

const AUTH_TYPES = [
  { id: 'none', label: 'No Login' },
  { id: 'basic', label: 'Basic Auth' },
  { id: 'form', label: 'Form Login' },
  { id: 'bearer', label: 'Bearer Token' },
  { id: 'oauth', label: 'OAuth / SSO' },
];

const PROVIDER_HINTS = {
  anthropic: 'Uses the native Anthropic Messages API. API key from console.anthropic.com.',
  bedrock: 'Uses AWS Bedrock Converse API. Credentials fall back to instance profile / env vars if left blank.',
  azure: 'Uses Azure OpenAI Service. Set your resource endpoint and deployment name.',
  openrouter: 'Unified gateway to 200+ models. API key from openrouter.ai/keys.',
  grok: 'xAI\'s Grok models. API key from console.x.ai.',
  nvidia: 'NVIDIA NIM hosted inference or self-hosted containers. Key from build.nvidia.com.',
  ollama: 'Local inference — no API key needed. Run ollama serve and pull your model first.',
  vllm: 'Self-hosted vLLM server. Launch with: vllm serve <model> --api-key <key>.',
  omniroute: 'OpenAI-compatible AI gateway/router. Point to your OmniRoute endpoint.',
};

export default function ConfigPanel({ onStart }) {
  const [targetUrl, setTargetUrl] = useState('');
  const [description, setDescription] = useState('');
  const [authType, setAuthType] = useState('none');
  const [authConfig, setAuthConfig] = useState({});
  const [advanced, setAdvanced] = useState(false);
  const [options, setOptions] = useState({ maxDepth: 3, maxPages: 20, testTimeout: 60000, retries: 1 });
  const [enableHealing, setEnableHealing] = useState(true);

  // ── Screen Registry / Targeted Testing ──
  // Lets the user test only the screens that changed (by friendly name) instead
  // of crawling the whole app. A registry maps friendly names → URLs and is
  // built once (then updated when the UI changes). At run time the user picks a
  // registry, selects the changed screens, optionally notes what functionality
  // changed, and sets a light-crawl depth from each selected screen.
  const [registries, setRegistries] = useState([]);
  const [selectedRegistryName, setSelectedRegistryName] = useState('');
  const [registryScreens, setRegistryScreens] = useState([]); // [{ name, url, path, title }]
  const [selectedScreenUrls, setSelectedScreenUrls] = useState({}); // url -> true
  const [screenFunctionality, setScreenFunctionality] = useState({}); // url -> string
  const [screenDescription, setScreenDescription] = useState({}); // url -> string (free-form context, e.g. Jira task)
  const [targetDepth, setTargetDepth] = useState(0);
  // Build/update form
  const [registryName, setRegistryName] = useState('');
  const [registryMaxDepth, setRegistryMaxDepth] = useState(3);
  const [registryMaxPages, setRegistryMaxPages] = useState(30);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState(null);
  const [showRegistryBuilder, setShowRegistryBuilder] = useState(false);

  // Manual screen addition
  const [manualScreenUrl, setManualScreenUrl] = useState('');
  const [manualScreenName, setManualScreenName] = useState('');

  // Application context — Playwright browser context options applied during
  // both crawl (Explorer) and test execution (Executor). Kept in sync so the
  // generated tests see the same environment the snapshots were captured in.
  const [appContext, setAppContext] = useState({
    baseURL: '',
    viewportWidth: 1280,
    viewportHeight: 720,
    userAgent: '',
    extraHTTPHeadersRaw: '',
    apiPatternsRaw: '',
  });
  const updateAppContext = (key, value) => setAppContext(prev => ({ ...prev, [key]: value }));

  // LLM state
  const [providers, setProviders] = useState([]);
  const [llmProvider, setLlmProvider] = useState('anthropic');
  const [llmModel, setLlmModel] = useState('');
  const [llmBaseUrl, setLlmBaseUrl] = useState('');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmCustomModel, setLlmCustomModel] = useState('');
  // Azure extras
  const [azureDeployment, setAzureDeployment] = useState('');
  const [azureApiVersion, setAzureApiVersion] = useState('2024-10-21');
  // Bedrock extras
  const [awsRegion, setAwsRegion] = useState('us-east-1');
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('');
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('');
  const [awsCredentialType, setAwsCredentialType] = useState('long-term');
  const [awsSessionToken, setAwsSessionToken] = useState('');
  const [awsApiKey, setAwsApiKey] = useState('');
  const [awsBaseUrl, setAwsBaseUrl] = useState('');

  const [healthStatus, setHealthStatus] = useState(null);
  const [healthChecking, setHealthChecking] = useState(false);

  // ── Configuration Presets ──
  // Lets the user save the full set of run settings (LLM provider, advanced
  // options, healing, app context, auth) under a friendly name so they don't
  // have to re-enter everything on every run.  Presets are stored on the
  // server (on disk) so they survive browser restarts, cache clears, and
  // work regardless of which URL is used to access the app.
  const [presets, setPresets] = useState([]);
  const [selectedPreset, setSelectedPreset] = useState('');
  const [presetName, setPresetName] = useState('');
  const [presetMsg, setPresetMsg] = useState(null); // { type: 'success'|'error', text }

  const refreshPresets = () => {
    fetch('/api/presets')
      .then(r => r.json())
      .then(data => setPresets(data.presets || []))
      .catch(() => {});
  };
  useEffect(() => { refreshPresets(); }, []);

  // Gather every configurable field into a plain object that can be serialised.
  const collectSettings = () => ({
    targetUrl,
    description,
    authType,
    authConfig,
    llmProvider,
    llmModel,
    llmBaseUrl,
    llmApiKey,
    llmCustomModel,
    azureDeployment,
    azureApiVersion,
    awsRegion,
    awsAccessKeyId,
    awsSecretAccessKey,
    awsCredentialType,
    awsSessionToken,
    awsApiKey,
    awsBaseUrl,
    options,
    enableHealing,
    appContext,
  });

  // Restore every configurable field from a preset object.
  const applyPreset = (preset) => {
    if (!preset || !preset.settings) return;
    const s = preset.settings;
    if (s.targetUrl !== undefined) setTargetUrl(s.targetUrl);
    if (s.description !== undefined) setDescription(s.description);
    if (s.authType !== undefined) setAuthType(s.authType);
    if (s.authConfig !== undefined) setAuthConfig(s.authConfig);
    if (s.llmProvider !== undefined) setLlmProvider(s.llmProvider);
    if (s.llmModel !== undefined) setLlmModel(s.llmModel);
    if (s.llmBaseUrl !== undefined) setLlmBaseUrl(s.llmBaseUrl);
    if (s.llmApiKey !== undefined) setLlmApiKey(s.llmApiKey);
    if (s.llmCustomModel !== undefined) setLlmCustomModel(s.llmCustomModel);
    if (s.azureDeployment !== undefined) setAzureDeployment(s.azureDeployment);
    if (s.azureApiVersion !== undefined) setAzureApiVersion(s.azureApiVersion);
    if (s.awsRegion !== undefined) setAwsRegion(s.awsRegion);
    if (s.awsAccessKeyId !== undefined) setAwsAccessKeyId(s.awsAccessKeyId);
    if (s.awsSecretAccessKey !== undefined) setAwsSecretAccessKey(s.awsSecretAccessKey);
    if (s.awsCredentialType !== undefined) setAwsCredentialType(s.awsCredentialType);
    if (s.awsSessionToken !== undefined) setAwsSessionToken(s.awsSessionToken);
    if (s.awsApiKey !== undefined) setAwsApiKey(s.awsApiKey);
    if (s.awsBaseUrl !== undefined) setAwsBaseUrl(s.awsBaseUrl);
    if (s.options !== undefined) setOptions(s.options);
    if (s.enableHealing !== undefined) setEnableHealing(s.enableHealing);
    if (s.appContext !== undefined) setAppContext(s.appContext);
    setPresetMsg({ type: 'success', text: `Loaded preset "${preset.name}"` });
  };

  const handleLoadPreset = async () => {
    if (!selectedPreset) return;
    try {
      const res = await fetch(`/api/presets/${encodeURIComponent(selectedPreset)}`);
      if (!res.ok) { setPresetMsg({ type: 'error', text: 'Preset not found.' }); return; }
      const data = await res.json();
      applyPreset(data);
    } catch (err) {
      setPresetMsg({ type: 'error', text: 'Failed to load preset: ' + err.message });
    }
  };

  const handleSavePreset = async () => {
    const name = presetName.trim();
    if (!name) { setPresetMsg({ type: 'error', text: 'Enter a preset name first.' }); return; }
    const exists = presets.some(p => p.name === name);
    try {
      const res = await fetch('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, settings: collectSettings() }),
      });
      const data = await res.json();
      if (data.error) { setPresetMsg({ type: 'error', text: data.error }); return; }
      refreshPresets();
      setSelectedPreset(name);
      setPresetMsg({ type: 'success', text: exists ? `Updated preset "${name}"` : `Saved new preset "${name}"` });
    } catch (err) {
      setPresetMsg({ type: 'error', text: 'Failed to save preset: ' + err.message });
    }
  };

  const handleDeletePreset = async () => {
    if (!selectedPreset) return;
    try {
      const res = await fetch(`/api/presets/${encodeURIComponent(selectedPreset)}`, { method: 'DELETE' });
      if (!res.ok) { setPresetMsg({ type: 'error', text: 'Failed to delete preset.' }); return; }
      refreshPresets();
      setPresetName('');
      setSelectedPreset('');
      setPresetMsg({ type: 'success', text: `Deleted preset "${selectedPreset}"` });
    } catch (err) {
      setPresetMsg({ type: 'error', text: 'Failed to delete preset: ' + err.message });
    }
  };

  const handlePresetSelect = (name) => {
    setSelectedPreset(name);
    setPresetName(name);
    setPresetMsg(null);
  };

  // Interactive login capture state
  const [captureSessionId, setCaptureSessionId] = useState(null);
  const [captureStatus, setCaptureStatus] = useState(null); // null | 'launching' | 'waiting' | 'capturing' | 'done' | 'error'
  const [captureError, setCaptureError] = useState(null);
  const [captureSummary, setCaptureSummary] = useState(null);

  useEffect(() => {
    fetch('/api/pipeline/providers')
      .then(r => r.json())
      .then(data => {
        setProviders(data.providers || []);
        const first = data.providers?.[0];
        if (first) {
          setLlmModel(first.defaultModel);
          setLlmBaseUrl(first.defaultBaseUrl);
        }
      })
      .catch(() => {});
  }, []);

  // Load the list of saved screen registries so the user can pick one.
  const refreshRegistries = () => {
    fetch('/api/registries')
      .then(r => r.json())
      .then(data => setRegistries(data.registries || []))
      .catch(() => {});
  };
  useEffect(() => { refreshRegistries(); }, []);

  // Load a registry's screens when the user selects one from the dropdown.
  const handleRegistrySelect = (name) => {
    setSelectedRegistryName(name);
    setSelectedScreenUrls({});
    setScreenFunctionality({});
    if (!name) {
      setRegistryScreens([]);
      setRegistryName('');
      return;
    }
    fetch(`/api/registries/${encodeURIComponent(name)}`)
      .then(r => r.json())
      .then(data => {
        setRegistryScreens(data.screens || []);
        // Pre-populate builder state for easy recrawling/updating!
        setRegistryName(data.name || name);
        if (data.targetUrl) {
          setTargetUrl(data.targetUrl);
        }
        if (data.crawlSettings) {
          if (data.crawlSettings.maxDepth) setRegistryMaxDepth(data.crawlSettings.maxDepth);
          if (data.crawlSettings.maxPages) setRegistryMaxPages(data.crawlSettings.maxPages);
        }
      })
      .catch(() => setRegistryScreens([]));
  };

  const toggleScreen = (url) => setSelectedScreenUrls(prev => {
    const next = { ...prev };
    if (next[url]) delete next[url]; else next[url] = true;
    return next;
  });

  const updateScreenName = (url, newName) => setRegistryScreens(prev =>
    prev.map(s => s.url === url ? { ...s, name: newName } : s)
  );

  const updateFunctionality = (url, value) => setScreenFunctionality(prev => ({ ...prev, [url]: value }));
  const updateScreenDescription = (url, value) => setScreenDescription(prev => ({ ...prev, [url]: value }));

  const handleDeleteRegistry = async () => {
    if (!selectedRegistryName) return;
    if (!window.confirm(`Are you sure you want to delete the registry "${selectedRegistryName}"? This cannot be undone.`)) return;
    try {
      await fetch(`/api/registries/${encodeURIComponent(selectedRegistryName)}`, {
        method: 'DELETE',
      });
      refreshRegistries();
      setSelectedRegistryName('');
      setRegistryScreens([]);
      setSelectedScreenUrls({});
      setScreenFunctionality({});
    } catch { /* non-fatal */ }
  };

  const handleRemoveScreen = (url) => {
    setRegistryScreens(prev => prev.filter(s => s.url !== url));
    setSelectedScreenUrls(prev => {
      const next = { ...prev };
      delete next[url];
      return next;
    });
  };

  const handleAddManualScreen = () => {
    const url = manualScreenUrl.trim();
    const name = manualScreenName.trim();
    if (!url || !name) { alert('Please enter both Screen Name and URL.'); return; }

    // Derive a path if possible
    let path = '';
    try {
      const parsed = new URL(url);
      path = parsed.pathname;
    } catch {
      path = url;
    }

    const newScreen = { name, url, path, title: name };
    setRegistryScreens(prev => {
      if (prev.some(s => s.url === url)) {
        alert('A screen with this URL already exists in the registry.');
        return prev;
      }
      return [...prev, newScreen];
    });

    setManualScreenUrl('');
    setManualScreenName('');
  };

  // Persist renamed screens back to the registry file so the names survive.
  const saveRegistryEdits = async () => {
    if (!selectedRegistryName) return;
    try {
      await fetch(`/api/registries/${encodeURIComponent(selectedRegistryName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screens: registryScreens }),
      });
    } catch { /* non-fatal */ }
  };

  // Build (or update) a registry by crawling the app once.
  const handleBuildRegistry = async () => {
    if (!targetUrl.trim()) { alert('Please enter the Application URL first.'); return; }
    if (!registryName.trim()) { alert('Please enter a registry name.'); return; }
    setBuilding(true);
    setBuildError(null);
    try {
      const res = await fetch('/api/registries/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: registryName.trim(),
          targetUrl: targetUrl.trim(),
          auth: { type: authType, ...authConfig },
          appContext: buildAppContext(),
          maxDepth: registryMaxDepth,
          maxPages: registryMaxPages,
        }),
      });
      const data = await res.json();
      if (data.error) { setBuildError(data.error); return; }
      refreshRegistries();
      setSelectedRegistryName(data.name);
      setRegistryScreens(data.screens || []);
      setSelectedScreenUrls({});
      setScreenFunctionality({});
      setShowRegistryBuilder(false);
    } catch (err) {
      setBuildError('Failed to build registry: ' + err.message);
    } finally {
      setBuilding(false);
    }
  };

  const currentProvider = providers.find(p => p.id === llmProvider);

  const handleProviderChange = (id) => {
    setLlmProvider(id);
    setHealthStatus(null);
    setLlmCustomModel('');
    const prov = providers.find(p => p.id === id);
    if (prov) {
      setLlmModel(prov.defaultModel);
      setLlmBaseUrl(prov.defaultBaseUrl);
      setLlmApiKey('');
      setAzureDeployment(prov.defaultModel);
      setAzureApiVersion('2024-10-21');
      setAwsRegion('us-east-1');
      setAwsAccessKeyId('');
      setAwsSecretAccessKey('');
      setAwsCredentialType('long-term');
      setAwsSessionToken('');
      setAwsApiKey('');
      setAwsBaseUrl('');
    }
  };

  const buildLlmConfig = () => {
    const config = {
      provider: llmProvider,
      model: llmCustomModel || llmModel,
      baseUrl: llmBaseUrl || undefined,
      apiKey: llmApiKey || undefined,
    };
    if (llmProvider === 'azure') {
      config.azureDeployment = azureDeployment || config.model;
      config.azureApiVersion = azureApiVersion;
    }
    if (llmProvider === 'bedrock') {
      config.awsRegion = awsRegion;
      config.awsCredentialType = awsCredentialType;
      if (awsCredentialType === 'api-key') {
        if (awsApiKey) config.awsApiKey = awsApiKey;
        if (awsBaseUrl) config.awsBaseUrl = awsBaseUrl;
      } else {
        if (awsAccessKeyId) config.awsAccessKeyId = awsAccessKeyId;
        if (awsSecretAccessKey) config.awsSecretAccessKey = awsSecretAccessKey;
        if (awsCredentialType === 'temporary' && awsSessionToken) config.awsSessionToken = awsSessionToken;
      }
    }
    return config;
  };

  const handleHealthCheck = async () => {
    setHealthChecking(true);
    setHealthStatus(null);
    try {
      const res = await fetch('/api/pipeline/health-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildLlmConfig()),
      });
      setHealthStatus(await res.json());
    } catch (err) {
      setHealthStatus({ ok: false, error: err.message });
    }
    setHealthChecking(false);
  };

  const updateAuth = (key, value) => setAuthConfig(prev => ({ ...prev, [key]: value }));

  // ── Interactive Login Capture ──
  const startLoginCapture = async () => {
    if (!targetUrl.trim()) {
      alert('Please enter the Application URL first.');
      return;
    }
    setCaptureStatus('launching');
    setCaptureError(null);
    setCaptureSummary(null);
    try {
      const res = await fetch('/api/auth-capture/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: targetUrl.trim() }),
      });
      const data = await res.json();
      if (data.error) {
        setCaptureStatus('error');
        setCaptureError(data.error);
        return;
      }
      setCaptureSessionId(data.sessionId);
      setCaptureStatus('waiting');
    } catch (err) {
      setCaptureStatus('error');
      setCaptureError('Failed to launch browser: ' + err.message);
    }
  };

  const captureSession = async () => {
    if (!captureSessionId) return;
    setCaptureStatus('capturing');
    setCaptureError(null);
    try {
      const res = await fetch(`/api/auth-capture/${captureSessionId}/capture`, {
        method: 'POST',
      });
      const data = await res.json();
      if (data.error) {
        setCaptureStatus('error');
        setCaptureError(data.error);
        return;
      }
      // Populate auth config with captured cookies + localStorage
      const cookiesJson = JSON.stringify(data.cookies, null, 2);
      const lsJson = JSON.stringify(data.localStorage, null, 2);
      updateAuth('cookiesRaw', cookiesJson);
      updateAuth('cookies', data.cookies);
      updateAuth('localStorageRaw', lsJson);
      updateAuth('localStorage', data.localStorage);
      setCaptureSummary(data.summary);
      setCaptureStatus('done');
      setCaptureSessionId(null);
    } catch (err) {
      setCaptureStatus('error');
      setCaptureError('Failed to capture session: ' + err.message);
    }
  };

  const cancelLoginCapture = async () => {
    if (!captureSessionId) {
      setCaptureStatus(null);
      return;
    }
    try {
      await fetch(`/api/auth-capture/${captureSessionId}/cancel`, { method: 'POST' });
    } catch {}
    setCaptureSessionId(null);
    setCaptureStatus(null);
  };

  const buildAppContext = () => {
    const ctx = {};
    if (appContext.baseURL.trim()) ctx.baseURL = appContext.baseURL.trim();
    // Only emit viewport when the user deviates from defaults — avoids
    // overriding Playwright defaults with redundant values.
    const vw = parseInt(appContext.viewportWidth, 10);
    const vh = parseInt(appContext.viewportHeight, 10);
    if (!isNaN(vw) && !isNaN(vh) && (vw !== 1280 || vh !== 720)) {
      ctx.viewport = { width: vw, height: vh };
    }
    if (appContext.userAgent.trim()) ctx.userAgent = appContext.userAgent.trim();
    if (appContext.extraHTTPHeadersRaw.trim()) {
      try {
        const headers = JSON.parse(appContext.extraHTTPHeadersRaw);
        if (headers && typeof headers === 'object' && !Array.isArray(headers) && Object.keys(headers).length > 0) {
          ctx.extraHTTPHeaders = headers;
        }
      } catch {
        // Ignore malformed JSON — validated on submit
      }
    }
    if (appContext.apiPatternsRaw.trim()) {
      // Parse comma-separated or newline-separated patterns
      const patterns = appContext.apiPatternsRaw
        .split(/[,\n]/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
      if (patterns.length > 0) ctx.apiPatterns = patterns;
    }
    return ctx;
  };

  const handleSubmit = () => {
    if (!targetUrl.trim()) return;
    let appContextError = null;
    if (appContext.extraHTTPHeadersRaw.trim()) {
      try {
        const parsed = JSON.parse(appContext.extraHTTPHeadersRaw);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
          appContextError = 'Extra HTTP Headers must be a JSON object.';
        }
      } catch (err) {
        appContextError = 'Extra HTTP Headers is not valid JSON: ' + err.message;
      }
    }
    if (appContextError) {
      alert(appContextError);
      return;
    }

    // Build targetScreens from the registry selection. When the user picked
    // specific screens, the run uses targeted crawl mode (only those screens
    // + a light crawl of `targetDepth` link levels) instead of crawling the
    // whole app — saving LLM tokens by focusing on what changed.
    const selectedUrls = Object.keys(selectedScreenUrls);
    let targetScreens = null;
    if (selectedUrls.length > 0) {
      targetScreens = selectedUrls.map(url => {
        const screen = registryScreens.find(s => s.url === url) || { url };
        const funcRaw = (screenFunctionality[url] || '').trim();
        const functionality = funcRaw
          ? funcRaw.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
          : null;
        const descRaw = (screenDescription[url] || '').trim();
        const screenDesc = descRaw || null;
        return { url: screen.url, name: screen.name, functionality, description: screenDesc };
      });
      // Persist any friendly-name edits the user made before starting the run.
      saveRegistryEdits();
    }

    onStart({
      targetUrl: targetUrl.trim(),
      description: description.trim(),
      auth: { type: authType, ...authConfig },
      options: {
        ...options,
        enableHealing,
        ...(targetScreens ? { targetScreens, targetDepth } : {}),
      },
      llm: buildLlmConfig(),
      appContext: buildAppContext(),
    });
  };

  // Show baseUrl for providers that support it
  const showBaseUrl = llmProvider !== 'anthropic' && llmProvider !== 'bedrock';
  // Azure base URL is required
  const baseUrlLabel = llmProvider === 'azure'
    ? 'Resource Endpoint (required)'
    : 'Base URL';
  const baseUrlPlaceholder = llmProvider === 'azure'
    ? 'https://your-resource.openai.azure.com'
    : currentProvider?.defaultBaseUrl || 'http://localhost:8000';

  return (
    <>
      {/* ── Configuration Presets ── */}
      <div className="card">
        <div className="card-title">
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" />
          </svg>
          Configuration Presets
          <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>
            (optional — save & reload your settings)
          </span>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>
          Save your LLM provider, authentication, advanced options, and healing settings under a
          name. Next time, load the preset instead of re-entering everything. You can overwrite an
          existing preset or create a new one.
        </p>

        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          {/* Load existing preset */}
          <div className="form-group" style={{ flex: 1 }}>
            <label>Load existing preset</label>
            <select
              value={selectedPreset}
              onChange={e => handlePresetSelect(e.target.value)}
            >
              <option value="">— Select a preset —</option>
              {presets.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <button
              className="btn btn-secondary"
              onClick={handleLoadPreset}
              disabled={!selectedPreset}
              style={{ fontSize: 13, whiteSpace: 'nowrap' }}
            >
              Load
            </button>
          </div>
          <div className="form-group">
            <button
              className="btn btn-secondary"
              onClick={handleDeletePreset}
              disabled={!selectedPreset}
              style={{ fontSize: 13, whiteSpace: 'nowrap', color: 'var(--error)' }}
            >
              Delete
            </button>
          </div>
        </div>

        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          {/* Save / create preset */}
          <div className="form-group" style={{ flex: 1 }}>
            <label>
              {presets.some(p => p.name === presetName.trim())
                ? 'Update existing preset (overwrite)'
                : 'Save as new preset'}
            </label>
            <input
              placeholder="e.g. myapp-prod-llm"
              value={presetName}
              onChange={e => { setPresetName(e.target.value); setPresetMsg(null); }}
            />
          </div>
          <div className="form-group">
            <button
              className="btn btn-primary"
              onClick={handleSavePreset}
              disabled={!presetName.trim()}
              style={{ fontSize: 13, whiteSpace: 'nowrap' }}
            >
              {presets.some(p => p.name === presetName.trim()) ? 'Overwrite' : 'Save New'}
            </button>
          </div>
        </div>

        {presetMsg && (
          <div style={{
            marginTop: 8,
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: 13,
            background: presetMsg.type === 'success' ? '#f1f8f4' : '#fdf2f4',
            color: presetMsg.type === 'success' ? '#2e7d32' : '#c62828',
            border: `1px solid ${presetMsg.type === 'success' ? '#c8e6c9' : '#ffcdd2'}`,
          }}>
            {presetMsg.text}
          </div>
        )}
      </div>

      {/* ── Target URL ── */}
      <div className="card">
        <div className="card-title">
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          Target Application
        </div>
        <div className="form-group">
          <label>Application URL</label>
          <input type="url" placeholder="https://your-app.example.com" value={targetUrl} onChange={e => setTargetUrl(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Run Description <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional — for your reference)</span></label>
          <textarea
            placeholder="e.g. Smoke test for checkout flow before v2.1 release"
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={2}
            style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: 14 }}
          />
        </div>
      </div>

      {/* ── LLM Provider ── */}
      <div className="card">
        <div className="card-title">
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
          </svg>
          LLM Provider
        </div>

        <div className="auth-tabs" style={{ flexWrap: 'wrap' }}>
          {providers.map(p => (
            <button
              key={p.id}
              className={`auth-tab ${llmProvider === p.id ? 'active' : ''}`}
              onClick={() => handleProviderChange(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>

        {currentProvider && (
          <>
            {/* Hint text */}
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>
              {PROVIDER_HINTS[llmProvider] || ''}
            </p>

            {/* Model + Base URL row */}
            <div className="form-row">
              <div className="form-group">
                <label>Model</label>
                <select value={llmModel} onChange={e => { setLlmModel(e.target.value); setLlmCustomModel(''); if (llmProvider === 'azure') setAzureDeployment(e.target.value); }}>
                  {currentProvider.models.map(m => <option key={m} value={m}>{m}</option>)}
                  <option value="__custom__">Custom model...</option>
                </select>
              </div>

              {showBaseUrl && (
                <div className="form-group">
                  <label>{baseUrlLabel}</label>
                  <input value={llmBaseUrl} onChange={e => setLlmBaseUrl(e.target.value)} placeholder={baseUrlPlaceholder} />
                </div>
              )}
            </div>

            {/* Custom model name */}
            {llmModel === '__custom__' && (
              <div className="form-group">
                <label>Custom Model Name</label>
                <input value={llmCustomModel} onChange={e => setLlmCustomModel(e.target.value)}
                  placeholder={llmProvider === 'ollama' ? 'e.g. phi3:mini' : llmProvider === 'openrouter' ? 'e.g. google/gemini-2.5-pro' : 'e.g. org/model-name'} />
              </div>
            )}

            {/* API Key (providers that need it) */}
            {currentProvider.requiresKey && (
              <div className="form-group">
                <label>
                  API Key
                  {llmProvider === 'anthropic' && <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}> — uses ANTHROPIC_API_KEY from .env if blank</span>}
                </label>
                <input type="password" value={llmApiKey} onChange={e => setLlmApiKey(e.target.value)}
                  placeholder={
                    llmProvider === 'nvidia' ? 'nvapi-...' :
                    llmProvider === 'grok' ? 'xai-...' :
                    llmProvider === 'openrouter' ? 'sk-or-...' :
                    llmProvider === 'azure' ? 'your-azure-api-key' :
                    'sk-...'
                  } />
              </div>
            )}

            {/* ── Azure-specific fields ── */}
            {llmProvider === 'azure' && (
              <div className="form-row">
                <div className="form-group">
                  <label>Deployment Name</label>
                  <input value={azureDeployment} onChange={e => setAzureDeployment(e.target.value)} placeholder="my-gpt4o-deployment" />
                </div>
                <div className="form-group">
                  <label>API Version</label>
                  <input value={azureApiVersion} onChange={e => setAzureApiVersion(e.target.value)} placeholder="2024-10-21" />
                </div>
              </div>
            )}

            {/* ── AWS Bedrock-specific fields ── */}
            {llmProvider === 'bedrock' && (
              <>
                <div className="form-group">
                  <label>AWS Region</label>
                  <select value={awsRegion} onChange={e => setAwsRegion(e.target.value)}>
                    {['us-east-1','us-east-2','us-west-2','eu-west-1','eu-west-2','eu-west-3','eu-central-1','ap-southeast-1','ap-southeast-2','ap-northeast-1','ap-south-1','ca-central-1','sa-east-1'].map(r =>
                      <option key={r} value={r}>{r}</option>
                    )}
                  </select>
                </div>
                <div className="form-group">
                  <label>Credential Type</label>
                  <select value={awsCredentialType} onChange={e => { setAwsCredentialType(e.target.value); setAwsSessionToken(''); setAwsApiKey(''); }}>
                    <option value="long-term">Long-term (Access Key + Secret Key)</option>
                    <option value="temporary">Temporary / Assumed Role (Access Key + Secret Key + Session Token)</option>
                    <option value="api-key">API Key (Bearer Token)</option>
                  </select>
                </div>
                {awsCredentialType === 'api-key' ? (
                  <>
                    <div className="form-group">
                      <label>Bedrock API Key</label>
                      <input type="password" value={awsApiKey} onChange={e => setAwsApiKey(e.target.value)} placeholder="sk-..." />
                    </div>
                    <div className="form-group">
                      <label>Custom Base URL (optional)</label>
                      <input value={awsBaseUrl} onChange={e => setAwsBaseUrl(e.target.value)} placeholder="http://litellm-alb-xxx.us-east-1.elb.amazonaws.com/v1" />
                      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                        Provide a custom base URL if accessing Bedrock through a proxy or gateway (e.g. LiteLLM). Uses OpenAI-compatible API format. If left blank, uses native Bedrock Converse API with the API key as a Bearer token.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="form-row">
                      <div className="form-group">
                        <label>AWS Access Key ID (optional — falls back to env/instance profile)</label>
                        <input value={awsAccessKeyId} onChange={e => setAwsAccessKeyId(e.target.value)} placeholder="AKIA..." />
                      </div>
                      <div className="form-group">
                        <label>AWS Secret Access Key</label>
                        <input type="password" value={awsSecretAccessKey} onChange={e => setAwsSecretAccessKey(e.target.value)} placeholder="••••••" />
                      </div>
                    </div>
                    {awsCredentialType === 'temporary' && (
                      <div className="form-group">
                        <label>AWS Session Token</label>
                        <input type="password" value={awsSessionToken} onChange={e => setAwsSessionToken(e.target.value)} placeholder="Temporary session token from STS" />
                      </div>
                    )}
                    <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
                      If running on EC2/ECS with an IAM role, leave credentials blank — the SDK will use the instance profile automatically.
                      Ensure your IAM policy grants <code>bedrock:InvokeModel</code> on the selected model.
                    </p>
                  </>
                )}
              </>
            )}

            {/* ── OmniRoute hint ── */}
            {llmProvider === 'omniroute' && (
              <div className="form-group">
                <label>API Key (if your OmniRoute gateway requires one)</label>
                <input type="password" value={llmApiKey} onChange={e => setLlmApiKey(e.target.value)} placeholder="optional" />
              </div>
            )}

            {/* ── Health Check ── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
              <button className="btn btn-secondary" onClick={handleHealthCheck} disabled={healthChecking} style={{ fontSize: 13 }}>
                {healthChecking ? 'Checking...' : 'Test Connection'}
              </button>
              {healthStatus && (
                <span style={{
                  fontSize: 13,
                  color: healthStatus.ok ? 'var(--success)' : 'var(--error)',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {healthStatus.ok
                    ? `✓ Connected — ${healthStatus.latencyMs}ms`
                    : `✗ ${healthStatus.error}`
                  }
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Authentication ── */}
      <div className="card">
        <div className="card-title">
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          Authentication
        </div>

        <div className="auth-tabs">
          {AUTH_TYPES.map(t => (
            <button key={t.id} className={`auth-tab ${authType === t.id ? 'active' : ''}`}
              onClick={() => { setAuthType(t.id); setAuthConfig({}); }}>
              {t.label}
            </button>
          ))}
        </div>

        {authType === 'none' && (
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No authentication required.</p>
        )}

        {authType === 'basic' && (
          <div className="form-row">
            <div className="form-group">
              <label>Username</label>
              <input placeholder="admin" value={authConfig.username || ''} onChange={e => updateAuth('username', e.target.value)} />
            </div>
            <div className="form-group">
              <label>Password</label>
              <input type="password" placeholder="••••••" value={authConfig.password || ''} onChange={e => updateAuth('password', e.target.value)} />
            </div>
          </div>
        )}

        {authType === 'form' && (
          <>
            <div className="form-group">
              <label>Login Page URL (leave blank to use target URL)</label>
              <input placeholder="https://your-app.com/login" value={authConfig.loginUrl || ''} onChange={e => updateAuth('loginUrl', e.target.value)} />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Username</label>
                <input placeholder="testuser@example.com" value={authConfig.username || ''} onChange={e => updateAuth('username', e.target.value)} />
              </div>
              <div className="form-group">
                <label>Password</label>
                <input type="password" placeholder="••••••" value={authConfig.password || ''} onChange={e => updateAuth('password', e.target.value)} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Username Selector (optional)</label>
                <input placeholder='#email or [name="username"]' value={authConfig.usernameSelector || ''} onChange={e => updateAuth('usernameSelector', e.target.value)} />
              </div>
              <div className="form-group">
                <label>Password Selector (optional)</label>
                <input placeholder='#password' value={authConfig.passwordSelector || ''} onChange={e => updateAuth('passwordSelector', e.target.value)} />
              </div>
            </div>
            <div className="form-group">
              <label>Submit Selector (optional)</label>
              <input placeholder='button[type="submit"]' value={authConfig.submitSelector || ''} onChange={e => updateAuth('submitSelector', e.target.value)} />
            </div>
          </>
        )}

        {authType === 'bearer' && (
          <div className="form-group">
            <label>Bearer Token</label>
            <input placeholder="eyJhbGciOiJIUzI1NiIs..." value={authConfig.token || ''} onChange={e => updateAuth('token', e.target.value)} />
          </div>
        )}

        {authType === 'oauth' && (
          <>
            <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 16 }}>
              For OAuth providers (AWS Cognito, Azure AD, Google, Okta, Auth0), you can either
              log in through an automated browser capture, or manually paste session cookies/tokens below.
            </p>

            {/* ── Interactive Login Capture ── */}
            <div style={{
              background: 'var(--bg-secondary)', borderRadius: 10, padding: 20, marginBottom: 20,
              border: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
                </svg>
                <strong style={{ fontSize: 15 }}>Interactive Login Capture</strong>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
                Click "Launch Browser" to open a real browser window. Log in to your application
                with your SSO/OAuth credentials, then click "Capture Session" to automatically
                extract cookies and localStorage — no manual copying needed.
              </p>

              {captureStatus === null && (
                <button className="btn btn-primary" onClick={startLoginCapture}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                  Launch Browser & Login
                </button>
              )}

              {captureStatus === 'launching' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="spinner" style={{ width: 18, height: 18, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>Launching browser...</span>
                </div>
              )}

              {captureStatus === 'waiting' && (
                <div>
                  <div style={{
                    padding: 12, background: 'var(--bg)', borderRadius: 8, marginBottom: 12,
                    border: '1px solid var(--accent)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div className="spinner" style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                      <span style={{ fontSize: 14, fontWeight: 600 }}>
                        Browser is open — log in to your application now
                      </span>
                    </div>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                      Complete your login in the browser window, then click "Capture Session" below.
                      The browser will auto-close after 5 minutes.
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-primary" onClick={captureSession}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                        <polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" />
                      </svg>
                      Capture Session
                    </button>
                    <button className="btn btn-secondary" onClick={cancelLoginCapture}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {captureStatus === 'capturing' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="spinner" style={{ width: 18, height: 18, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>Capturing cookies and storage...</span>
                </div>
              )}

              {captureStatus === 'done' && captureSummary && (
                <div style={{
                  padding: 14, background: '#f1f8f4', borderRadius: 8,
                  border: '1px solid #c8e6c9',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2e7d32" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <strong style={{ color: '#2e7d32', fontSize: 14 }}>Session captured successfully!</strong>
                  </div>
                  <div style={{ fontSize: 13, color: '#444', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <span><strong>{captureSummary.cookieCount}</strong> cookies</span>
                    <span><strong>{captureSummary.localStorageCount}</strong> localStorage entries</span>
                    {captureSummary.sessionStorageCount > 0 && (
                      <span><strong>{captureSummary.sessionStorageCount}</strong> sessionStorage entries</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 6, wordBreak: 'break-all' }}>
                    Current URL: {captureSummary.currentUrl}
                  </div>
                  <button className="btn btn-secondary" style={{ marginTop: 10, fontSize: 12, padding: '4px 12px' }} onClick={() => setCaptureStatus(null)}>
                    Capture Again
                  </button>
                </div>
              )}

              {captureStatus === 'error' && (
                <div style={{
                  padding: 14, background: '#fdf2f4', borderRadius: 8,
                  border: '1px solid #ffcdd2',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c62828" strokeWidth="2.5">
                      <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                    <strong style={{ color: '#c62828', fontSize: 14 }}>Capture failed</strong>
                  </div>
                  <p style={{ fontSize: 13, color: '#c62828' }}>{captureError}</p>
                  <button className="btn btn-secondary" style={{ marginTop: 10, fontSize: 12, padding: '4px 12px' }} onClick={() => { setCaptureStatus(null); setCaptureError(null); }}>
                    Try Again
                  </button>
                </div>
              )}
            </div>

            {/* ── Manual entry (still available as fallback) ── */}
            <details style={{ marginBottom: 16 }}>
              <summary style={{ cursor: 'pointer', fontSize: 14, color: 'var(--text-muted)', fontWeight: 600, padding: '8px 0' }}>
                Manual entry (advanced — paste cookies/localStorage as JSON)
              </summary>
              <div className="form-group cookie-editor" style={{ marginTop: 12 }}>
                <label>Session Cookies (JSON array)</label>
                <textarea
                  placeholder={`[\n  { "name": "session", "value": "abc123", "domain": ".example.com", "path": "/" }\n]`}
                  value={authConfig.cookiesRaw || ''}
                  onChange={e => {
                    updateAuth('cookiesRaw', e.target.value);
                    try { updateAuth('cookies', JSON.parse(e.target.value)); } catch {}
                  }}
                />
              </div>
              <div className="form-group cookie-editor">
                <label>LocalStorage Entries (JSON object, optional)</label>
                <textarea
                  placeholder={`{\n  "id_token": "eyJ...",\n  "access_token": "eyJ..."\n}`}
                  value={authConfig.localStorageRaw || ''}
                  onChange={e => {
                    updateAuth('localStorageRaw', e.target.value);
                    try { updateAuth('localStorage', JSON.parse(e.target.value)); } catch {}
                  }}
                />
              </div>
            </details>
          </>
        )}
      </div>

      {/* ── Target Screens (Screen Registry) ── */}
      <div className="card">
        <div className="card-title">
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3h18v18H3z" /><path d="M3 9h18" /><path d="M9 21V9" />
          </svg>
          Target Screens
          <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>
            (optional — test only the screens that changed)
          </span>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>
          Pick a screen registry, then select the screens you changed. The run will crawl and
          test only those screens instead of the whole app — saving tokens. Build a registry
          once per app; update it when the UI changes.
        </p>

        {/* Registry picker + build toggle */}
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label>Use existing registry</label>
            <select
              value={selectedRegistryName}
              onChange={e => handleRegistrySelect(e.target.value)}
            >
              <option value="">— Crawl whole app (no targeting) —</option>
              {registries.map(r => (
                <option key={r.name} value={r.name}>
                  {r.name} ({r.screenCount} screens{r.targetUrl ? `, ${r.targetUrl}` : ''})
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <button
              className="btn btn-secondary"
              onClick={() => setShowRegistryBuilder(!showRegistryBuilder)}
              style={{ fontSize: 13, whiteSpace: 'nowrap' }}
            >
              {showRegistryBuilder
                ? 'Cancel'
                : selectedRegistryName
                  ? '🔄 Recrawl / Update Screens'
                  : '+ Build New Registry'}
            </button>
          </div>
          {selectedRegistryName && (
            <div className="form-group">
              <button
                className="btn btn-secondary"
                onClick={handleDeleteRegistry}
                style={{ fontSize: 13, whiteSpace: 'nowrap', color: 'var(--error)', borderColor: 'rgba(239, 68, 68, 0.4)' }}
              >
                Delete Registry
              </button>
            </div>
          )}
        </div>

        {/* Registry builder form */}
        {showRegistryBuilder && (
          <div style={{
            background: 'var(--bg-secondary)', borderRadius: 10, padding: 16, marginBottom: 16,
            border: '1px solid var(--border)',
          }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>
              {registries.some(r => r.name === registryName.trim())
                ? `Recrawl & Update Registry: "${registryName}"`
                : 'Build New Registry'}
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              {registries.some(r => r.name === registryName.trim())
                ? 'Recrawls the application to discover new screens, while preserving your existing friendly screen names and custom configurations.'
                : 'Crawls the application once to discover all screens and automatically assigns friendly screen names.'}
            </p>
            <div className="form-group">
              <label>Registry name</label>
              <input
                placeholder="e.g. myapp-prod"
                value={registryName}
                onChange={e => setRegistryName(e.target.value)}
                disabled={registries.some(r => r.name === registryName.trim())} // Lock the name if updating so they don't accidentally create a new registry instead of recrawling
                style={registries.some(r => r.name === registryName.trim()) ? { opacity: 0.7, cursor: 'not-allowed' } : {}}
              />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Crawl depth</label>
                <input type="number" min="1" max="10" value={registryMaxDepth}
                  onChange={e => setRegistryMaxDepth(parseInt(e.target.value) || 3)} />
              </div>
              <div className="form-group">
                <label>Max pages</label>
                <input type="number" min="1" max="100" value={registryMaxPages}
                  onChange={e => setRegistryMaxPages(parseInt(e.target.value) || 30)} />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button className="btn btn-primary" onClick={handleBuildRegistry} disabled={building}>
                {building
                  ? 'Crawling...'
                  : registries.some(r => r.name === registryName.trim())
                    ? 'Start Recrawl'
                    : 'Build Registry'}
              </button>
              {buildError && (
                <span style={{ fontSize: 13, color: 'var(--error)' }}>{buildError}</span>
              )}
            </div>
          </div>
        )}

        {/* Screen list for the selected registry */}
        {registryScreens.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginBottom: 8, flexWrap: 'wrap', gap: 8,
            }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {Object.keys(selectedScreenUrls).length} of {registryScreens.length} screens selected
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }}
                  onClick={() => setSelectedScreenUrls(Object.fromEntries(registryScreens.map(s => [s.url, true])))}>
                  Select all
                </button>
                <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }}
                  onClick={() => setSelectedScreenUrls({})}>
                  Clear
                </button>
                <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }}
                  onClick={saveRegistryEdits}>
                  Save Changes
                </button>
              </div>
            </div>

            <div className="form-group">
              <label>Crawl depth from each selected screen
                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                  {' '}(0 = only the selected screens; higher = also follow links)
                </span>
              </label>
              <input type="number" min="0" max="5" value={targetDepth}
                onChange={e => setTargetDepth(parseInt(e.target.value) || 0)} style={{ maxWidth: 120 }} />
            </div>

            <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
              {registryScreens.map(screen => {
                const selected = !!selectedScreenUrls[screen.url];
                return (
                  <div key={screen.url} style={{
                    padding: '10px 12px', borderBottom: '1px solid var(--border)',
                    background: selected ? 'var(--bg-secondary)' : 'transparent',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <input type="checkbox" checked={selected}
                        onChange={() => toggleScreen(screen.url)}
                        style={{ width: 16, height: 16, cursor: 'pointer' }} />
                      <input
                        value={screen.name}
                        onChange={e => updateScreenName(screen.url, e.target.value)}
                        style={{ flex: 1, fontSize: 14, fontWeight: 600 }}
                        title="Friendly screen name (editable)"
                      />
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)', flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '30%' }}>
                        {screen.path || screen.url}
                      </span>
                      <button
                        className="btn btn-secondary"
                        onClick={() => handleRemoveScreen(screen.url)}
                        style={{
                          fontSize: 11, padding: '2px 6px', color: 'var(--error)',
                          borderColor: 'rgba(239, 68, 68, 0.2)', background: 'transparent',
                          whiteSpace: 'nowrap', flexShrink: 0, marginLeft: 'auto'
                        }}
                        title="Remove this screen from the registry"
                      >
                        Remove
                      </button>
                    </div>
                    {selected && (
                      <div style={{ marginLeft: 26, marginTop: 8 }}>
                        <input
                          placeholder="Changed functionality (optional, comma-separated) e.g. new search bar, updated product grid"
                          value={screenFunctionality[screen.url] || ''}
                          onChange={e => updateFunctionality(screen.url, e.target.value)}
                          style={{ fontSize: 13 }}
                        />
                        <details style={{ marginTop: 8 }}>
                          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, padding: '4px 0' }}>
                            Screen description / test context (optional — paste a Jira task, user story, or any extra detail)
                          </summary>
                          <textarea
                            placeholder={`e.g.\nAs a user, I want to book an appointment with a doctor so that I can consult them.\n\nAcceptance criteria:\n- User can select a department from the dropdown\n- User can pick a date from the calendar\n- User can choose a time slot\n- Confirmation email is sent after booking`}
                            value={screenDescription[screen.url] || ''}
                            onChange={e => updateScreenDescription(screen.url, e.target.value)}
                            rows={6}
                            style={{
                              resize: 'vertical', fontFamily: 'inherit', fontSize: 13,
                              marginTop: 6, width: '100%',
            }}
                          />
                          <p style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4 }}>
                            This context is passed to the LLM alongside the page model to make
                            test generation more targeted. It supplements — not replaces — the
                            automatic element-based testing.
                          </p>
                        </details>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Manual Screen Addition */}
            <div style={{
              marginTop: 12, padding: 12, borderRadius: 8,
              border: '1px dashed var(--border)', background: 'var(--bg-secondary, rgba(255,255,255,0.02))'
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
                + Add Custom Screen Manually
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 150 }}>
                  <input
                    placeholder="Screen Friendly Name (e.g. Shopping Cart)"
                    value={manualScreenName}
                    onChange={e => setManualScreenName(e.target.value)}
                    style={{ fontSize: 13, height: 32 }}
                  />
                </div>
                <div style={{ flex: 2, minWidth: 200 }}>
                  <input
                    placeholder="Screen URL or Path (e.g. https://example.com/cart)"
                    value={manualScreenUrl}
                    onChange={e => setManualScreenUrl(e.target.value)}
                    style={{ fontSize: 13, height: 32 }}
                  />
                </div>
                <button
                  className="btn btn-primary"
                  onClick={handleAddManualScreen}
                  style={{ fontSize: 12, padding: '0 14px', height: 32 }}
                >
                  Add Screen
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Advanced ── */}
      <div className="card" style={{ cursor: 'pointer' }} onClick={() => setAdvanced(!advanced)}>
        <div className="card-title" style={{ marginBottom: advanced ? 16 : 0 }}>
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            style={{ transform: advanced ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
          Advanced Options
        </div>
        {advanced && (
          <div onClick={e => e.stopPropagation()}>
            <div className="form-row">
              <div className="form-group">
                <label>Max Crawl Depth
                  {selectedRegistryName && (
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                      {' '}(overridden by Target Screens depth)
                    </span>
                  )}
                </label>
                <input
                  type="number" min="1" max="10" value={options.maxDepth}
                  onChange={e => setOptions(p => ({ ...p, maxDepth: parseInt(e.target.value) || 3 }))}
                  disabled={!!selectedRegistryName}
                  style={selectedRegistryName ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                />
                {selectedRegistryName && (
                  <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                    A screen registry is selected — crawl depth is controlled by
                    "Crawl depth from each selected screen" in the Target Screens card above.
                  </p>
                )}
              </div>
              <div className="form-group">
                <label>Max Pages to Explore
                  {selectedRegistryName && (
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                      {' '}(not applied in targeted mode)
                    </span>
                  )}
                </label>
                <input
                  type="number" min="1" max="100" value={options.maxPages}
                  onChange={e => setOptions(p => ({ ...p, maxPages: parseInt(e.target.value) || 20 }))}
                  disabled={!!selectedRegistryName}
                  style={selectedRegistryName ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                />
                {selectedRegistryName && (
                  <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                    In targeted mode all selected screens (plus their light crawl
                    up to the depth above) are captured regardless of this limit.
                  </p>
                )}
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Test Timeout (ms) <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(per test case)</span></label>
                <input type="number" min="5000" max="300000" step="5000" value={options.testTimeout} onChange={e => setOptions(p => ({ ...p, testTimeout: parseInt(e.target.value) || 60000 }))} />
              </div>
              <div className="form-group">
                <label>Retries <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(on failure)</span></label>
                <input type="number" min="0" max="5" value={options.retries} onChange={e => setOptions(p => ({ ...p, retries: parseInt(e.target.value) || 0 }))} />
              </div>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4, marginBottom: 12 }}>
              Higher timeout helps with slow-loading pages. More retries tolerate flaky tests but increase runtime.
            </p>

            {/* ── Application Context (Playwright browser context) ── */}
            <div style={{
              marginTop: 16, paddingTop: 16,
              borderTop: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                Application Context
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>
                Playwright browser context options applied during both crawl and test
                execution. Leave blank to use Playwright defaults.
              </p>

              <div className="form-group">
                <label>Base URL <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(enables relative navigation in generated tests)</span></label>
                <input
                  type="url"
                  placeholder="https://your-app.example.com"
                  value={appContext.baseURL}
                  onChange={e => updateAppContext('baseURL', e.target.value)}
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Viewport Width</label>
                  <input
                    type="number"
                    min="320"
                    max="3840"
                    value={appContext.viewportWidth}
                    onChange={e => updateAppContext('viewportWidth', e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Viewport Height</label>
                  <input
                    type="number"
                    min="240"
                    max="2160"
                    value={appContext.viewportHeight}
                    onChange={e => updateAppContext('viewportHeight', e.target.value)}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>User Agent <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional — overrides default Chromium UA)</span></label>
                <input
                  placeholder="Mozilla/5.0 (custom user agent string)"
                  value={appContext.userAgent}
                  onChange={e => updateAppContext('userAgent', e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Extra HTTP Headers <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(JSON object, optional)</span></label>
                <textarea
                  placeholder={`{\n  "X-Custom-Header": "value",\n  "Accept-Language": "en-US"\n}`}
                  value={appContext.extraHTTPHeadersRaw}
                  onChange={e => updateAppContext('extraHTTPHeadersRaw', e.target.value)}
                  rows={3}
                  style={{ resize: 'vertical', fontFamily: 'var(--font-mono, monospace)', fontSize: 13 }}
                />
              </div>

              <div className="form-group">
                <label>API URL Patterns <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(comma or newline separated, optional — for SPA/API-Gateway apps)</span></label>
                <textarea
                  placeholder={`/api/, execute-api, /v1/products, /graphql`}
                  value={appContext.apiPatternsRaw}
                  onChange={e => updateAppContext('apiPatternsRaw', e.target.value)}
                  rows={2}
                  style={{ resize: 'vertical', fontFamily: 'var(--font-mono, monospace)', fontSize: 13 }}
                />
                <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 6 }}>
                  Identifies your app's API calls so the tool can wait for API responses
                  (via <code>waitForResponse</code>) instead of fixed sleeps. Critical for
                  SPA apps with dynamic data loading (any framework + any backend).
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Healing Toggle ── */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 12 }}>
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
          Self-Healing
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
          <input
            type="checkbox"
            checked={enableHealing}
            onChange={e => setEnableHealing(e.target.checked)}
            style={{ width: 16, height: 16, cursor: 'pointer' }}
          />
          Enable Self-Healing
          <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>
            (uses additional LLM calls to fix failing tests — up to 3 iterations per plan)
          </span>
        </label>
        {!enableHealing && (
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 8 }}>
            When disabled, failing tests are marked as <code>test.fixme()</code> without LLM healing, saving tokens.
          </p>
        )}
      </div>

      {/* ── Start ── */}
      <button className="btn btn-primary" onClick={handleSubmit} disabled={!targetUrl.trim()}
        style={{ width: '100%', justifyContent: 'center', padding: '14px', fontSize: 15 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
        Start Test Generation
      </button>
    </>
  );
}
