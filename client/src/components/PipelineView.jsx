import React from 'react';

const STAGE_ORDER = ['explore', 'analyze', 'plan', 'generate', 'execute', 'heal'];
const STAGE_LABELS = {
  explore: 'Explore Site',
  analyze: 'Analyze Pages',
  plan: 'Generate Plans',
  generate: 'Generate Tests',
  execute: 'Execute Tests',
  heal: 'Heal Failures',
};

const STAGE_ICONS = {
  explore: '🔍',
  analyze: '🧠',
  plan: '📋',
  generate: '⚡',
  execute: '▶',
  heal: '🔧',
};

export default function PipelineView({ stages, status, error, results, onViewResults, onNewRun }) {
  // Compute current state of each stage
  const stageStates = {};
  for (const name of STAGE_ORDER) {
    stageStates[name] = { status: 'pending', detail: '' };
  }

  // Track live test execution progress
  let liveTests = { passed: 0, failed: 0, skipped: 0, total: 0, current: '', fileResults: [] };

  for (const entry of stages) {
    const name = entry.stage;
    if (!stageStates[name]) continue;
    stageStates[name].status = entry.status;
    stageStates[name].detail = entry.message || entry.planId || '';

    // Add extra info
    if (entry.pages !== undefined) stageStates[name].detail = `Found ${entry.pages} pages`;
    if (entry.models !== undefined) stageStates[name].detail = `Analyzed ${entry.models} pages`;
    if (entry.plans !== undefined) stageStates[name].detail = `Created ${entry.plans} test plans`;
    if (entry.iteration !== undefined) stageStates[name].detail += ` (iteration ${entry.iteration})`;

    // Track test progress during execution
    if (entry.stage === 'execute' && entry.status === 'progress') {
      if (entry.testStatus === 'passed') liveTests.passed++;
      else if (entry.testStatus === 'failed') liveTests.failed++;
      else if (entry.testStatus === 'skipped') liveTests.skipped++;
      else if (entry.testStatus === 'file_done') {
        liveTests.fileResults.push({
          planId: entry.planId,
          message: entry.message,
          passed: entry.passed,
          failed: entry.failed,
          skipped: entry.skipped,
          total: entry.total,
        });
      }
      liveTests.total = liveTests.passed + liveTests.failed + liveTests.skipped;
      liveTests.current = entry.message || '';
    }
  }

  const isFinished = status === 'completed' || status === 'error';

  return (
    <>
      <div className="card">
        <div className="card-title">
          Pipeline Progress
          {status === 'running' && (
            <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 400, marginLeft: 'auto' }}>
              Running...
            </span>
          )}
          {status === 'completed' && (
            <span style={{ fontSize: 12, color: 'var(--success)', fontWeight: 400, marginLeft: 'auto' }}>
              ✓ Complete
            </span>
          )}
          {status === 'error' && (
            <span style={{ fontSize: 12, color: 'var(--error)', fontWeight: 400, marginLeft: 'auto' }}>
              ✗ Error
            </span>
          )}
        </div>

        <div className="pipeline-stages">
          {STAGE_ORDER.map(name => {
            const state = stageStates[name];
            let indicatorClass = 'pending';
            let indicatorContent = '';

            if (state.status === 'running') { indicatorClass = 'running'; indicatorContent = '●'; }
            else if (state.status === 'done') { indicatorClass = 'done'; indicatorContent = '✓'; }
            else if (state.status === 'error' || state.status === 'escalate') { indicatorClass = 'error'; indicatorContent = '!'; }
            else { indicatorContent = STAGE_ICONS[name]; }

            return (
              <div className="stage" key={name}>
                <div className={`stage-indicator ${indicatorClass}`}>
                  {indicatorContent}
                </div>
                <div className="stage-info">
                  <div className="stage-name">{STAGE_LABELS[name]}</div>
                  {state.detail && <div className="stage-detail">{state.detail}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--error-dim)' }}>
          <div className="card-title" style={{ color: 'var(--error)' }}>Error</div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14, fontFamily: 'var(--font-mono)' }}>{error}</p>
        </div>
      )}

      {/* Live execution progress */}
      {(liveTests.total > 0 || liveTests.fileResults.length > 0) && !isFinished && (
        <div className="card">
          <div className="card-title">
            Test Execution Progress
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 'auto' }}>
              {liveTests.total} tests completed
            </span>
          </div>
          <div style={{ display: 'flex', gap: 20, marginBottom: 12 }}>
            <span style={{ color: 'var(--success)', fontWeight: 600 }}>✓ {liveTests.passed} passed</span>
            <span style={{ color: 'var(--error)', fontWeight: 600 }}>✗ {liveTests.failed} failed</span>
            {liveTests.skipped > 0 && (
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>- {liveTests.skipped} skipped</span>
            )}
          </div>

          {/* Per-file results */}
          {liveTests.fileResults.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              {liveTests.fileResults.map((fr, i) => (
                <div key={i} style={{
                  padding: '6px 12px',
                  marginBottom: 4,
                  background: 'var(--bg-secondary)',
                  borderRadius: 6,
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  border: '1px solid var(--border)',
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                }}>
                  <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{fr.planId}</span>
                  <span style={{ color: 'var(--success)' }}>✓ {fr.passed}</span>
                  {fr.failed > 0 && <span style={{ color: 'var(--error)' }}>✗ {fr.failed}</span>}
                  {fr.skipped > 0 && <span style={{ color: 'var(--text-muted)' }}>- {fr.skipped}</span>}
                  <span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>{fr.total} total</span>
                </div>
              ))}
            </div>
          )}

          {liveTests.current && (
            <div style={{
              padding: '8px 12px',
              background: 'var(--bg-secondary)',
              borderRadius: 6,
              fontSize: 13,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}>
              <span style={{ color: 'var(--accent)' }}>Latest:</span> {liveTests.current}
            </div>
          )}
        </div>
      )}

      {/* Live log */}
      {stages.length > 0 && (
        <div className="card">
          <div className="card-title">Event Log</div>
          <div style={{ maxHeight: 400, overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
            {stages.slice(-50).map((s, i) => {
              const isProgress = s.status === 'progress';
              const color = s.status === 'done' ? 'var(--success)'
                : s.status === 'error' || s.status === 'escalate' ? 'var(--error)'
                : isProgress ? (s.testStatus === 'passed' ? 'var(--success)' : s.testStatus === 'failed' ? 'var(--error)' : 'var(--text-muted)')
                : 'var(--accent)';
              return (
                <div key={i} style={{ padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {new Date(s.timestamp).toLocaleTimeString()}
                  </span>
                  {' '}
                  <span style={{ color }}>
                    [{s.stage}:{s.status}]
                  </span>
                  {' '}
                  {s.message || s.planId || ''}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {isFinished && (
        <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
          {results && (
            <button className="btn btn-primary" onClick={onViewResults}>
              View Results
            </button>
          )}
          <button className="btn btn-secondary" onClick={onNewRun}>
            New Run
          </button>
        </div>
      )}
    </>
  );
}
