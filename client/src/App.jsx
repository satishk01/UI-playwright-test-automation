import React, { useState } from 'react';
import ConfigPanel from './components/ConfigPanel.jsx';
import PipelineView from './components/PipelineView.jsx';
import ResultsView from './components/ResultsView.jsx';
import RunHistory from './components/RunHistory.jsx';
import { useSSE } from './hooks/useSSE.js';

export default function App() {
  const [runId, setRunId] = useState(null);
  const [sseMode, setSseMode] = useState('pipeline'); // pipeline | re-execute
  const [view, setView] = useState('config'); // config | pipeline | results | history
  const [originalRunId, setOriginalRunId] = useState(null); // for re-execute
  const { stages, status, results, error } = useSSE(runId, sseMode);

  const handleStart = async (config) => {
    try {
      const res = await fetch('/api/pipeline/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }
      setSseMode('pipeline');
      setOriginalRunId(null);
      setRunId(data.runId);
      setView('pipeline');
    } catch (err) {
      alert('Failed to start pipeline: ' + err.message);
    }
  };

  const handleReExecute = async (sourceRunId, enableHealing) => {
    try {
      const res = await fetch(`/api/pipeline/re-execute/${sourceRunId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enableHealing }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }
      setSseMode('re-execute');
      setOriginalRunId(sourceRunId);
      setRunId(data.runId);
      setView('pipeline');
    } catch (err) {
      alert('Failed to re-execute: ' + err.message);
    }
  };

  const handleViewResults = () => setView('results');
  const handleNewRun = () => {
    setRunId(null);
    setOriginalRunId(null);
    setSseMode('pipeline');
    setView('config');
  };

  const handleViewReport = (id) => {
    window.open(`/api/runs/${id}/report`, '_blank');
  };

  return (
    <div className="app">
      <header className="app-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1>
              <span>▷</span> AutoTest Agent
            </h1>
            <p>Autonomous E2E test generation — explore, plan, generate, and self-heal</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {view !== 'config' && (
              <button className="btn btn-secondary" onClick={handleNewRun}>
                + New Run
              </button>
            )}
            {view !== 'history' && (
              <button className="btn btn-secondary" onClick={() => setView('history')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: 'middle', marginRight: 4 }}>
                  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                </svg>
                Run History
              </button>
            )}
          </div>
        </div>
      </header>

      {view === 'config' && (
        <ConfigPanel onStart={handleStart} />
      )}

      {view === 'pipeline' && (
        <PipelineView
          stages={stages}
          status={status}
          error={error}
          results={results}
          onViewResults={handleViewResults}
          onNewRun={handleNewRun}
        />
      )}

      {view === 'results' && (
        <ResultsView
          runId={originalRunId || runId}
          results={results}
          onNewRun={handleNewRun}
          onReExecute={handleReExecute}
        />
      )}

      {view === 'history' && (
        <RunHistory
          onBack={handleNewRun}
          onReExecute={handleReExecute}
          onViewReport={handleViewReport}
        />
      )}
    </div>
  );
}
