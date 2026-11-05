import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGenerationRun } from '../../src/hooks/useGenerationRun';

export function mountGenerationRecovery() {
  const NativeEventSource = window.EventSource;
  window.EventSource = class extends NativeEventSource {
    constructor(url: string | URL) { super(`http://127.0.0.1:18810${url}`); }
  };
  function Fixture() {
    const [done, setDone] = useState<string[]>([]);
    const run = useGenerationRun({ onDone: (id) => setDone((previous) => [...previous, id]) });
    return <>
      <button onClick={() => run.start({ destination: '北京', days: 3, startDate: '', budgetLevel: '经济',
        partySize: 1, preferences: [], totalBudget: 0, extraNotes: '' })}>开始测试生成</button>
      <pre id="state">{JSON.stringify({ jobId: run.jobId, events: run.events, done, restoring: run.restoring, errorMessage: run.errorMessage })}</pre>
    </>;
  }
  createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Fixture />
    </QueryClientProvider>,
  );
}
