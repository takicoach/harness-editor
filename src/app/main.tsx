import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { EventBusProvider } from './eventBus';
import { NativeApp } from './native/NativeApp';

// Temporary explicit route for verifying old features during their migration.
// Normal entry never imports the legacy Player or old editing state.
const LegacyApp = React.lazy(() => import('./App').then(module => ({ default: module.App })));

const rootEl = document.getElementById('root');
const query = new URLSearchParams(location.search);
if (!rootEl) throw new Error('#root が見つかりません');
createRoot(rootEl).render(
  <React.StrictMode>
    {/* SSE 1 本統合（/api/events）。App が useEventBusProjectId で選択中プロジェクトを伝える。 */}
    <EventBusProvider>
      {query.get('legacy') === '1' ? <React.Suspense fallback={<p>読み込んでいます…</p>}><LegacyApp /></React.Suspense> : <NativeApp />}
    </EventBusProvider>
  </React.StrictMode>,
);
