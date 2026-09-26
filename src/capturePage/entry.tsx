/**
 * 撮影ページのエントリ（M2b T2）。
 *
 * ここは**起動だけ**。判断は protocol.ts、React/DOM 配線は browserDeps.tsx にあり、
 * どちらも jsdom で単体テスト済み。実ブラウザでしか確かめられないもの（importmap の解決・
 * 実 Chromium での透過撮影）は T3/T4 の守備範囲。
 */
import { createBrowserCaptureDeps, installAsyncErrorTrap } from './browserDeps';
import { createCaptureController, installCaptureApi } from './protocol';

const container = document.getElementById('capture-root');
if (container === null) {
  throw new Error('captureRuntime: #capture-root がありません（撮影ページの HTML が壊れています）');
}

const deps = createBrowserCaptureDeps({
  container,
  asyncErrors: installAsyncErrorTrap(window),
});

installCaptureApi(window as unknown as Record<string, unknown>, createCaptureController(deps));
