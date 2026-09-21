import React, { useState, useEffect, useCallback } from 'react';

export default function RunHistory({ onBack, onReExecute, onViewReport }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editDesc, setEditDesc] = useState('');
  const [filter, setFilter] = useState('all'); // all | completed | failed

  const loadRuns = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/runs');
      const data = await res.json();
      setRuns(data);
      setError(null);
    } catch (err) {
      setError('Failed to load runs: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  const saveDescription = async (runId) => {
    try {
      await fetch(`/api/runs/${runId}/description`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: editDesc }),
      });
      setEditingId(null);
      loadRuns();
    } catch (err) {
      alert('Failed to save description: ' + err.message);
    }
  };

  const startEdit = (run) => {
    setEditingId(run.id);
    setEditDesc(run.description || '');
  };

  const filtered = runs.filter(r => {
    if (filter === 'completed') return r.status === 'completed' && r.failed === 0;
    if (filter === 'failed') return r.failed > 0;
    return true;
  });

  const formatDate = (iso) => {
    if (!iso) return 'N/A';
    try {
      return new Date(iso).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch { return iso; }
  };

  const totalRuns = runs.length;
  const totalCompleted = runs.filter(r => r.status === 'completed').length;
  const totalFailed = runs.filter(r => r.failed > 0).length;

  return (
    <>
      {/* ── Header with back button ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="card-title" style={{ marginBottom: 4, borderBottom: 'none', paddingBottom: 0 }}>
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
              </svg>
              Test Run History
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
              Browse all past test runs. Generate reports or re-execute any previous run.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={loadRuns} disabled={loading}>
              {loading ? 'Loading...' : '↻ Refresh'}
            </button>
            <button className="btn btn-secondary" onClick={onBack}>
              ← Back to New Run
            </button>
          </div>
        </div>

        {/* Summary stats */}
        <div style={{ display: 'flex', gap: 24, marginTop: 16, flexWrap: 'wrap' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--accent)' }}>{totalRuns}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Total Runs</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#2e7d32' }}>{totalCompleted}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Completed</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#c62828' }}>{totalFailed}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>With Failures</div>
          </div>
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          {[
            { key: 'all', label: 'All Runs' },
            { key: 'completed', label: 'All Passed' },
            { key: 'failed', label: 'Has Failures' },
          ].map(f => (
            <button
              key={f.key}
              className={`auth-tab ${filter === f.key ? 'active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="card" style={{ borderLeft: '4px solid #f44336' }}>
          <p style={{ color: '#c62828' }}>{error}</p>
        </div>
      )}

      {/* ── Runs list ── */}
      {loading && runs.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <p style={{ color: 'var(--text-muted)' }}>Loading runs...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <p style={{ color: 'var(--text-muted)' }}>No runs found. Start a new test run to see it here.</p>
        </div>
      ) : (
        filtered.map(run => {
          const passRate = run.totalTests > 0 ? Math.round((run.passed / run.totalTests) * 100) : null;
          const statusColor = run.status === 'completed'
            ? (run.failed > 0 ? '#f44336' : '#4caf50')
            : run.status === 'tests-generated' ? '#ff9800'
            : run.status === 'analyzed' ? '#2196f3'
            : '#9e9e9e';
          const statusLabel = run.status === 'completed' ? 'Completed'
            : run.status === 'tests-generated' ? 'Tests Generated'
            : run.status === 'analyzed' ? 'Analyzed'
            : run.status === 'queued' ? 'Queued'
            : run.status === 'running' ? 'Running'
            : 'Unknown';

          return (
            <div className="card" key={run.id} style={{ marginBottom: 12, padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                {/* Left: run info */}
                <div style={{ flex: 1, minWidth: 250 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{
                      display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
                      background: statusColor, flexShrink: 0,
                    }} />
                    <strong style={{ fontSize: 15 }}>{statusLabel}</strong>
                    {run.inMemory && (
                      <span style={{
                        fontSize: 10, padding: '2px 6px', borderRadius: 4,
                        background: 'var(--accent)', color: 'white', fontWeight: 600,
                      }}>ACTIVE</span>
                    )}
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{formatDate(run.createdAt)}</span>
                  </div>

                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, wordBreak: 'break-all' }}>
                    {run.targetUrl}
                  </div>

                  {/* Description (inline edit) */}
                  {editingId === run.id ? (
                    <div style={{ marginTop: 8 }}>
                      <input
                        type="text"
                        value={editDesc}
                        onChange={e => setEditDesc(e.target.value)}
                        placeholder="Add a description for this run..."
                        style={{ width: '100%', padding: '6px 10px', fontSize: 13 }}
                        autoFocus
                      />
                      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                        <button className="btn btn-primary" style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => saveDescription(run.id)}>Save</button>
                        <button className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => setEditingId(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{ fontSize: 13, color: run.description ? 'var(--text)' : 'var(--text-muted)', fontStyle: run.description ? 'normal' : 'italic', cursor: 'pointer', marginTop: 4 }}
                      onClick={() => startEdit(run)}
                      title="Click to edit description"
                    >
                      {run.description || 'Click to add description...'}
                    </div>
                  )}

                  {/* Test stats */}
                  {run.totalTests > 0 && (
                    <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13 }}>
                        <strong>{run.totalTests}</strong> tests
                      </span>
                      <span style={{ fontSize: 13, color: '#2e7d32' }}>
                        <strong>{run.passed}</strong> passed
                      </span>
                      {run.failed > 0 && (
                        <span style={{ fontSize: 13, color: '#c62828' }}>
                          <strong>{run.failed}</strong> failed
                        </span>
                      )}
                      {run.fixme > 0 && (
                        <span style={{ fontSize: 13, color: '#f57f17' }}>
                          <strong>{run.fixme}</strong> for review
                        </span>
                      )}
                      {passRate !== null && (
                        <span style={{
                          fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                          background: passRate >= 80 ? '#e8f5e9' : passRate >= 50 ? '#fff3e0' : '#ffebee',
                          color: passRate >= 80 ? '#2e7d32' : passRate >= 50 ? '#e65100' : '#c62828',
                        }}>
                          {passRate}% pass rate
                        </span>
                      )}
                    </div>
                  )}

                  {/* Token usage */}
                  {run.tokenUsage && (run.tokenUsage.inputTokens > 0 || run.tokenUsage.outputTokens > 0) && (
                    <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        Tokens:
                      </span>
                      <span style={{ fontSize: 12 }}>
                        <strong>{(run.tokenUsage.inputTokens || 0).toLocaleString()}</strong> in
                      </span>
                      <span style={{ fontSize: 12 }}>
                        <strong>{(run.tokenUsage.outputTokens || 0).toLocaleString()}</strong> out
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        ({run.tokenUsage.calls || 0} LLM calls)
                      </span>
                      <span style={{
                        fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 8,
                        background: 'var(--accent)', color: 'white',
                      }}>
                        {((run.tokenUsage.inputTokens || 0) + (run.tokenUsage.outputTokens || 0)).toLocaleString()} total
                      </span>
                    </div>
                  )}
                </div>

                {/* Right: actions */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 160 }}>
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: 13 }}
                    disabled={run.status !== 'completed' && run.status !== 'tests-generated'}
                    onClick={() => onViewReport(run.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: 'middle', marginRight: 4 }}>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    HTML Report
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: 13 }}
                    disabled={!run.inMemory && run.status !== 'completed' && run.status !== 'tests-generated'}
                    onClick={() => onReExecute(run.id, false)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ verticalAlign: 'middle', marginRight: 4 }}>
                      <polyline points="23 4 23 10 17 10" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                    Re-execute
                  </button>
                </div>
              </div>

              {/* Run ID (small, at bottom) */}
              <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                {run.id}
              </div>
            </div>
          );
        })
      )}
    </>
  );
}
