import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useHeavyJobConfirm } from '../useHeavyJobConfirm';
import { useEventChannelWithSync } from '../eventBus';
import { HeavyJobConfirmDialog } from './HeavyJobConfirmDialog';

type BannerState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running'; phase: string; percent?: number; startedAt: number }
  | { kind: 'completed' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: { code: string; message: string } };

interface TranscribeBannerProps {
  projectId: string;
  onReloadRequested: () => void;
}

export function TranscribeBanner({ projectId, onReloadRequested }: TranscribeBannerProps) {
  const [state, setState] = useState<BannerState>({ kind: 'idle' });
  const [elapsedSec, setElapsedSec] = useState(0);
  const onReloadRef = useRef(onReloadRequested);
  onReloadRef.current = onReloadRequested;
  const heavyJobConfirm = useHeavyJobConfirm();

  // transcribe チャネルを常時購読する（タブ閉じ→再開復帰用の既存 job 状態もここで受け取る）。
  // マウント時（projectId 変更時）は sync でキャッチアップする（バス接続確立後のマウントでは
  // 接続時初期スナップショットを取り逃すため）。
  useEventChannelWithSync('transcribe', projectId, (raw: unknown) => {
    const msg = raw as SseMessage;
    setState((prev) => nextBannerState(prev, msg));
  });

  // running 中は 1 秒ごとに経過時間を更新
  useEffect(() => {
    if (state.kind !== 'running') {
      setElapsedSec(0);
      return;
    }
    const startedAt = state.startedAt;
    setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [state.kind, state.kind === 'running' ? state.startedAt : 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const onStart = async (): Promise<void> => {
    setState({ kind: 'starting' });
    try {
      const outcome = await heavyJobConfirm.start(`/api/transcribe?id=${encodeURIComponent(projectId)}`, {
        method: 'POST',
      });
      if (outcome === 'cancelled') {
        setState({ kind: 'idle' });
        return;
      }
      const res = outcome;
      if (!res.ok) {
        const body: { error?: string } = await res.json().catch(() => ({}));
        const code = body.error ?? 'unknown';
        setState({
          kind: 'failed',
          error: { code, message: body.error ?? `HTTP ${res.status}` },
        });
        return;
      }
      const body: { startedAt: number } = await res.json();
      setState({ kind: 'running', phase: 'starting', startedAt: body.startedAt });
      // SSE 接続は state.kind を deps にした useEffect が張り直す。
    } catch (e) {
      setState({ kind: 'failed', error: { code: 'network', message: String(e) } });
    }
  };

  const onCancel = async (): Promise<void> => {
    await fetch(`/api/transcribe?id=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
    // cancelled イベントは SSE で来るので setState はそこに任せる
  };

  return (
    <div className={`tx-misalign tx-misalign-${state.kind}`} role="status">
      {renderContent(state, elapsedSec, onStart, onCancel, onReloadRef.current)}
      {heavyJobConfirm.pendingConfirm ? (
        <HeavyJobConfirmDialog
          running={heavyJobConfirm.pendingConfirm.running}
          onConfirm={heavyJobConfirm.confirm}
          onDismiss={heavyJobConfirm.dismiss}
        />
      ) : null}
    </div>
  );
}

function renderContent(
  state: BannerState,
  elapsedSec: number,
  onStart: () => void,
  onCancel: () => void,
  onReload: () => void,
): ReactNode {
  if (state.kind === 'idle') {
    return (
      <>
        <span>transcript と動画の長さが大きく異なるため、単語チップ（クリックでカット）は無効化されています。</span>
        <button className="tx-misalign-btn" onClick={onStart}>
          video から transcript を作り直す（推定 1-3 分）
        </button>
      </>
    );
  }
  if (state.kind === 'starting') {
    return <span>準備中…</span>;
  }
  if (state.kind === 'running') {
    const phaseJa = phaseLabel(state.phase);
    return (
      <>
        <span>再 transcribe 中… {phaseJa}　経過 {elapsedSec} 秒</span>
        <button className="tx-misalign-btn ghost" onClick={onCancel}>キャンセル</button>
      </>
    );
  }
  if (state.kind === 'completed') {
    return (
      <>
        <span>✓ 再 transcribe 完了。反映するには再読込してください。</span>
        <button className="tx-misalign-btn" onClick={onReload}>再読込</button>
      </>
    );
  }
  if (state.kind === 'cancelled') {
    return <span>キャンセルしました。</span>;
  }
  if (state.kind === 'failed') {
    return <span>失敗しました: {errorMessage(state.error)}</span>;
  }
  return null;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'starting': return '準備中';
    case 'loading-model': return 'モデル読込中';
    case 'analyzing': return '解析中';
    case 'writing': return '書き出し中';
    default: return phase;
  }
}

function errorMessage(error: { code: string; message: string }): string {
  switch (error.code) {
    case 'no-whisper-backend':
      return 'Whisper が見つかりません。Mac: pip install mlx-whisper / Windows: pip install openai-whisper を実行してから再度お試しください';
    case 'video-not-found':
      return 'main.mp4 が見つかりません';
    case 'video-unreadable':
      return '動画ファイルが読めません';
    case 'params-invalid':
      return error.message;
    default:
      return error.message;
  }
}

type SseMessage =
  | { type: 'idle' }
  | {
      type: 'snapshot';
      job: {
        phase: string;
        percent?: number;
        startedAt: number;
        error?: { code: string; message: string };
      };
    }
  | {
      type: 'event';
      event: {
        phase: string;
        percent?: number;
        error?: { code: string; message: string };
      };
    }
  | {
      type: 'done';
      phase: 'completed' | 'failed' | 'cancelled';
      error?: { code: string; message: string };
    };

/**
 * 現在の BannerState と transcribe チャネルのメッセージから次の状態を計算する（純関数）。
 * SSE 1 本統合以前は EventSource の onmessage 内で直接 setState していたが、
 * 常時購読（接続の開閉を伴わない）に伴い純関数へ切り出した。
 */
export function nextBannerState(prev: BannerState, msg: SseMessage): BannerState {
  if (msg.type === 'idle') {
    return prev;
  }
  if (msg.type === 'snapshot') {
    if (msg.job.phase === 'completed') return { kind: 'completed' };
    if (msg.job.phase === 'failed') {
      return { kind: 'failed', error: msg.job.error ?? { code: 'unknown', message: '不明' } };
    }
    if (msg.job.phase === 'cancelled') return { kind: 'cancelled' };
    return {
      kind: 'running',
      phase: msg.job.phase,
      percent: msg.job.percent,
      startedAt: msg.job.startedAt,
    };
  }
  if (msg.type === 'event') {
    const ev = msg.event;
    if (ev.phase !== 'completed' && ev.phase !== 'failed' && ev.phase !== 'cancelled') {
      if (prev.kind !== 'running') return prev;
      return { ...prev, phase: ev.phase, percent: ev.percent };
    }
    return prev;
  }
  // msg.type === 'done'
  if (msg.phase === 'completed') return { kind: 'completed' };
  if (msg.phase === 'cancelled') return { kind: 'cancelled' };
  return { kind: 'failed', error: msg.error ?? { code: 'unknown', message: '不明' } };
}
