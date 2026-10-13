import type { Phase } from './claudeTerminalState';

const LABELS = ['導入', 'ログイン', '接続の確認', '使える'] as const;
export interface ReadinessView { steps: Array<{ label: (typeof LABELS)[number]; state: 'done' | 'current' | 'todo' }>; message: string; ready: boolean }
/** AI タブの上の「導入 → ログイン → 接続の確認 → 使える」。終了・切断・確認中は null（それぞれの画面が案内する）。 */
export function readinessSteps(input: { phase: Phase; purpose: 'work' | 'login'; connected: boolean; loginExpired?: boolean }): ReadinessView | null {
  const { phase, purpose, connected, loginExpired = false } = input, running = phase === 'starting' || phase === 'connected';
  const current = phase === 'need-install' || phase === 'installing' || phase === 'install-failed' ? 0
    : phase === 'need-login' || (running && purpose === 'login') ? 1
    : phase === 'starting' || (phase === 'connected' && !connected) ? 2
    : phase === 'connected' ? 3 : null;
  if (current === null) return null;
  const ready = current === 3;
  const message = current === 0 ? 'AI を使うには、まず導入します（Claude は上の「インストール」、Codex は「導入手順を見る」から）。'
    : current === 1 ? (phase === 'need-login' && loginExpired ? 'ログインが切れています。「ログインする」を押すと下に AI の画面が開き、ブラウザでログインの画面が出ます。ログインしてください。'
      : phase === 'need-login' ? 'ログインが必要です。「ログインする」を押すと下に AI の画面が開くので、案内どおりにログインしてください。'
      : 'ログインが終わったら「ログインできたので始める」を押してください。')
    : current === 2 ? 'AI とエディタの接続を確かめています…（初回は 10 秒ほどかかります）'
    : 'AI が使えます。下の入力欄に「冒頭を詰めて」のように打って Enter を押してください。';
  return { ready, message, steps: LABELS.map((label, index) => ({ label, state: ready || index < current ? 'done' : index === current ? 'current' : 'todo' })) };
}
