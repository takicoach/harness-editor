import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { EventBusProvider } from './eventBus';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root が見つかりません');
createRoot(rootEl).render(
  <React.StrictMode>
    {/* SSE 1 本統合（/api/events）。App が useEventBusProjectId で選択中プロジェクトを伝える。 */}
    <EventBusProvider>
      <App />
    </EventBusProvider>
  </React.StrictMode>,
);
