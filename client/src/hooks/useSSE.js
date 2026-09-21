import { useState, useEffect, useRef, useCallback } from 'react';

export function useSSE(runId, mode = 'pipeline') {
  const [stages, setStages] = useState([]);
  const [status, setStatus] = useState('idle');
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const esRef = useRef(null);

  const connect = useCallback(() => {
    if (!runId) return;

    setStatus('connecting');
    setStages([]);
    setResults(null);
    setError(null);

    const url = mode === 're-execute'
      ? `/api/pipeline/re-execute-stream/${runId}`
      : `/api/pipeline/stream/${runId}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('connected', () => setStatus('connected'));

    es.addEventListener('status', (e) => {
      const data = JSON.parse(e.data);
      setStatus(data.status);
    });

    es.addEventListener('stage', (e) => {
      const data = JSON.parse(e.data);
      setStages(prev => [...prev, data]);
    });

    es.addEventListener('complete', (e) => {
      const data = JSON.parse(e.data);
      setResults(data);
      setStatus('completed');
      es.close();
    });

    es.addEventListener('error', (e) => {
      try {
        const data = JSON.parse(e.data);
        setError(data.message);
      } catch {
        setError('Connection lost');
      }
      setStatus('error');
      es.close();
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setStatus(prev => prev === 'completed' ? prev : 'disconnected');
      }
    };
  }, [runId, mode]);

  useEffect(() => {
    connect();
    return () => {
      if (esRef.current) esRef.current.close();
    };
  }, [connect]);

  return { stages, status, results, error };
}
