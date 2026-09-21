import React, { useState, useEffect } from 'react';

export default function ResultsView({ runId, results, onNewRun, onReExecute }) {
  const [tests, setTests] = useState([]);
  const [activeTab, setActiveTab] = useState('summary');
  const [activeFile, setActiveFile] = useState(null);
  const [reExecHealing, setReExecHealing] = useState(true);
  const [reExecuting, setReExecuting] = useState(false);

  useEffect(() => {
    if (!runId) return;
    fetch(`/api/runs/${runId}/tests`)
      .then(r => r.json())
      .then(data => {
        setTests(data.tests || []);
        if (data.tests?.length > 0) setActiveFile(data.tests[0].filename);
      })
      .catch(() => {});
  }, [runId]);

  if (!results) return null;

  return (
    <>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 20 }}>Test Generation Results</div>
        <div className="results-summary">
          <div className="stat-card">
            <div className="stat-value total">{results.totalTests}</div>
            <div className="stat-label">Total Tests</div>
          </div>
          <div className="stat-card">
            <div className="stat-value pass">{results.passed}</div>
            <div className="stat-label">Passed</div>
          </div>
          <div className="stat-card">
            <div className="stat-value fail">{results.failed}</div>
            <div className="stat-label">Failed</div>
          </div>
          <div className="stat-card">
            <div className="stat-value fixme">{results.fixme}</div>
            <div className="stat-label">Fixme</div>
          </div>
        </div>
        {results.tokenUsage && (results.tokenUsage.inputTokens > 0 || results.tokenUsage.outputTokens > 0) && (
          <div style={{
            marginTop: 16, padding: '12px 16px', borderRadius: 'var(--radius)',
            background: 'var(--bg-input)', border: '1px solid var(--border)',
            display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center',
          }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>LLM Token Usage:</span>
            <span style={{ fontSize: 13 }}>
              <strong>{(results.tokenUsage.inputTokens || 0).toLocaleString()}</strong> input tokens
            </span>
            <span style={{ fontSize: 13 }}>
              <strong>{(results.tokenUsage.outputTokens || 0).toLocaleString()}</strong> output tokens
            </span>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {results.tokenUsage.calls || 0} LLM calls
            </span>
            <span style={{
              fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 12,
              background: 'var(--accent)', color: 'white',
            }}>
              {((results.tokenUsage.inputTokens || 0) + (results.tokenUsage.outputTokens || 0)).toLocaleString()} total
            </span>
          </div>
        )}
      </div>

      <div className="card">
        <div className="tabs">
          <button className={`tab ${activeTab === 'summary' ? 'active' : ''}`} onClick={() => setActiveTab('summary')}>
            Plan Summary
          </button>
          <button className={`tab ${activeTab === 'code' ? 'active' : ''}`} onClick={() => setActiveTab('code')}>
            Generated Tests ({tests.length})
          </button>
        </div>

        {activeTab === 'summary' && (
          <div>
            {results.plans.map((plan, i) => (
              <div key={i} style={{
                padding: '12px 16px',
                background: 'var(--bg-input)',
                borderRadius: 'var(--radius)',
                marginBottom: 8,
                border: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: 14 }}>{plan.planId}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    {plan.suite} • {plan.page}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: 13, fontFamily: 'var(--font-mono)' }}>
                  <span style={{ color: 'var(--success)' }}>{plan.passed}✓</span>
                  <span style={{ color: 'var(--error)' }}>{plan.failed}✗</span>
                  {plan.fixme > 0 && <span style={{ color: 'var(--warning)' }}>{plan.fixme}⚠</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'code' && (
          <div>
            {tests.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No test files generated yet.</p>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
                  {tests.map(t => (
                    <button
                      key={t.filename}
                      className={`btn ${activeFile === t.filename ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ fontSize: 12, padding: '6px 12px' }}
                      onClick={() => setActiveFile(t.filename)}
                    >
                      {t.filename}
                    </button>
                  ))}
                </div>
                {activeFile && (
                  <div className="code-block">
                    <div className="code-header">
                      <span>{activeFile}</span>
                      <button
                        className="btn btn-secondary"
                        style={{ fontSize: 11, padding: '4px 10px' }}
                        onClick={() => {
                          const test = tests.find(t => t.filename === activeFile);
                          if (test) navigator.clipboard.writeText(test.content);
                        }}
                      >
                        Copy
                      </button>
                    </div>
                    <div className="code-content">
                      {tests.find(t => t.filename === activeFile)?.content || ''}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Re-execute & New Run actions ── */}
      <div className="card" style={{ marginTop: 8 }}>
        <div className="card-title" style={{ marginBottom: 16 }}>Actions</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 14 }}>
            <input
              type="checkbox"
              checked={reExecHealing}
              onChange={e => setReExecHealing(e.target.checked)}
              style={{ width: 16, height: 16, cursor: 'pointer' }}
            />
            Enable Healing during re-execution
          </label>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            disabled={reExecuting || !runId}
            onClick={async () => {
              setReExecuting(true);
              await onReExecute(runId, reExecHealing);
              setReExecuting(false);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            {reExecuting ? 'Starting...' : 'Re-execute Tests'}
          </button>
          <button
            className="btn btn-secondary"
            disabled={!runId}
            onClick={() => window.open(`/api/runs/${runId}/report`, '_blank')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            Download HTML Report
          </button>
          <button className="btn btn-secondary" onClick={onNewRun}>
            ← Start New Run
          </button>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 10 }}>
          Re-execution re-runs the existing generated tests without regenerating them,
          saving LLM tokens. Enable healing to let the LLM fix any failures.
          The HTML report is a comprehensive, executive-friendly summary suitable for sharing with stakeholders.
        </p>
      </div>
    </>
  );
}
