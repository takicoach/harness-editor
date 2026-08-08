/**
 * useRenderJob — /api/events（render チャネル）の購読フック。
 *
 * 状態: idle / running / done / error
 * useDenoise.ts の構造を踏襲（applied/restore の概念は無く、percent 進捗を持つ）。
 *
 * 設計方針:
 * - render チャネルは SSE 1 本統合バス（EventBusProvider）経由で常時購読する
 *   （2026-07-23 以前は idle/running のときだけ EventSource を張っていたが、
 *   1 タブ = SSE 1 本の統合に伴い「常時購読・メッセージが来なければ何も起きない」に変更）。
 * - percent は progress?.percent ?? null（null はスピナー表示）。
 * - cancel は DELETE /api/render?id=、reveal は POST /api/render/reveal?id=。
 * - reset は done/error → idle に戻す（バナーの「閉じる」用）。
 */

import { useRef, useState } from 'react';
import type { RenderOptions } from '../shared/renderPreset';
import { useHeavyJobConfirm, type UseHeavyJobConfirmReturn } from './useHeavyJobConfirm';
import { useEventChannelWithSync } from './eventBus';

/** 進捗情報。 */
export interface RenderProgress {
  frames: number;
  total: number;
  percent: number;
}

/** useRenderJob が管理する状態オブジェクト。 */
export type RenderState =
  | { status: 'idle' }
  | { status: 'running'; phase: string; percent: number | null; startedAt: number }
  | { status: 'done'; warning?: string }
  | { status: 'error'; error: { code: string; message: string } };

/** INITIAL_RENDER_STATE（テストから参照可能にエクスポート）。 */
export const INITIAL_RENDER_STATE: RenderState = { status: 'idle' };

// ─────────────────────────────────────────────────────────────────────────────
// SSE メッセージ型

export type RenderSseMessage =
  | { type: 'idle' }
  | {
      type: 'snapshot';
      job: {
        phase: string;
        startedAt: number;
        progress?: RenderProgress;
        error?: { code: string; message: string };
        /** 完了はしたが気になる点（例: 出力フレーム数が想定と違う）。 */
        warning?: string;
      };
    }
  | {
      type: 'event';
      event: { phase: string; progress?: RenderProgress; error?: { code: string; message: string }; warning?: string };
    }
  | { type: 'done'; phase: string; error?: { code: string; message: string }; warning?: string };

// ─────────────────────────────────────────────────────────────────────────────
// 純関数（テスト容易性のためエクスポート）

/**
 * SSE データ文字列をパースして RenderSseMessage を返す。
 * パース失敗は null。
 */
export function parseRenderEvent(data: string): RenderSseMessage | null {
  try {
    return JSON.parse(data) as RenderSseMessage;
  } catch {
    return null;
  }
}

/**
 * reveal 失敗の表示文（純関数）。404 は「出力が見つからない」で、それ以外は汎用。
 * 黙って握り潰すと「ボタンが無反応」に見えるため必ず文言を返す。
 */
export function revealErrorMessage(status: number): string {
  if (status === 404) return '書き出しファイルが見つかりません（out フォルダに動画がありません）。';
  return `書き出しファイルを開けませんでした（エラー ${status}）。`;
}

/**
 * 現在の RenderState と受信した SSE メッセージから次の状態を計算する（純関数）。
 */
export function nextRenderState(prev: RenderState, msg: RenderSseMessage): RenderState {
  if (msg.type === 'idle') {
    return prev;
  }

  if (msg.type === 'snapshot') {
    const job = msg.job;
    if (job.phase === 'done') {
      return job.warning === undefined ? { status: 'done' } : { status: 'done', warning: job.warning };
    }
    if (job.phase === 'failed') {
      return {
        status: 'error',
        error: job.error ?? { code: 'unknown', message: '不明なエラー' },
      };
    }
    if (job.phase === 'cancelled') {
      return { status: 'idle' };
    }
    return {
      status: 'running',
      phase: job.phase,
      percent: job.progress?.percent ?? null,
      startedAt: job.startedAt,
    };
  }

  if (msg.type === 'event') {
    const ev = msg.event;
    if (ev.phase === 'failed') {
      return {
        status: 'error',
        error: ev.error ?? { code: 'unknown', message: '不明なエラー' },
      };
    }
    if (ev.phase === 'cancelled') {
      return { status: 'idle' };
    }
    if (prev.status === 'running') {
      return { ...prev, phase: ev.phase, percent: ev.progress?.percent ?? prev.percent };
    }
    return prev;
  }

  if (msg.type === 'done') {
    if (msg.phase === 'done') {
      return msg.warning === undefined ? { status: 'done' } : { status: 'done', warning: msg.warning };
    }
    if (msg.phase === 'failed') {
      return {
        status: 'error',
        error: msg.error ?? { code: 'unknown', message: '不明なエラー' },
      };
    }
    // cancelled
    return { status: 'idle' };
  }

  return prev;
}

// ─────────────────────────────────────────────────────────────────────────────
// フック

export interface UseRenderJobReturn {
  state: RenderState;
  /** 書き出しを開始する（options 省略時は既定プリセット）。 */
  start: (options?: RenderOptions) => Promise<void>;
  /** 実行中のジョブをキャンセルする。 */
  cancel: () => Promise<void>;
  /** 書き出し済みファイルを Finder で表示する。 */
  reveal: () => Promise<void>;
  /**
   * 直近の reveal が失敗した理由（成功・未実行なら null）。
   * 従来は console.warn だけで、ユーザーにはボタンが「無反応」に見えていた。
   */
  revealError: string | null;
  /** done/error 状態を idle に戻す（バナーの「閉じる」用）。 */
  reset: () => void;
  /** 重ジョブ負荷確認ダイアログの状態・操作（HeavyJobConfirmDialog に配線する）。 */
  heavyJobConfirm: UseHeavyJobConfirmReturn;
}

/**
 * 書き出し（render）の状態管理フック。
 *
 * @param projectId - 対象プロジェクト ID。空文字の場合は何もしない。
 */
export function useRenderJob(projectId: string): UseRenderJobReturn {
  const [state, setState] = useState<RenderState>(INITIAL_RENDER_STATE);
  const [revealError, setRevealError] = useState<string | null>(null);
  const heavyJobConfirm = useHeavyJobConfirm();

  // プロジェクト切替時に状態をリセット（描画中の同期的リセット・R-9 同型ガード）。
  const prevProjectIdRef = useRef(projectId);
  if (prevProjectIdRef.current !== projectId) {
    prevProjectIdRef.current = projectId;
    setState(INITIAL_RENDER_STATE);
    // reveal エラーもプロジェクトに紐づく。持ち越すと切替先の書き出し完了時に
    // 前プロジェクトの「見つかりません」が誤帰属して表示される。
    setRevealError(null);
  }

  // render チャネルを常時購読する（idle/running のときだけ張っていた従来ロジックは廃止）。
  // マウント時（projectId 変更時）は sync でキャッチアップする（バス接続確立後の
  // マウントでは接続時初期スナップショットを取り逃すため）。
  useEventChannelWithSync('render', projectId, (raw: unknown) => {
    const msg = raw as RenderSseMessage;
    setState((prev) => nextRenderState(prev, msg));
  });

  // state は非同期反映のため、同一レンダー内の連続呼び出しは state ガードをすり抜ける。
  // ref を同期的な排他ロックとして併用する（App の installingRef と同じ規約）。
  const startingRef = useRef(false);

  const start = async (options?: RenderOptions): Promise<void> => {
    if (!projectId || state.status === 'running' || startingRef.current) return;
    startingRef.current = true;
    setState({ status: 'running', phase: 'preparing', percent: null, startedAt: Date.now() });
    try {
      const outcome = await heavyJobConfirm.start(`/api/render?id=${encodeURIComponent(projectId)}`, {
        method: 'POST',
        ...(options
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options) }
          : {}),
      });
      if (outcome === 'cancelled') {
        setState(INITIAL_RENDER_STATE);
        return;
      }
      const res = outcome;
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        const code = typeof body['error'] === 'string' ? body['error'] : 'unknown';
        setState({
          status: 'error',
          error: { code, message: typeof body['error'] === 'string' ? body['error'] : `HTTP ${res.status}` },
        });
      }
      // 成功時は SSE が state を更新するので、ここでは何もしない。
    } catch (e) {
      setState({ status: 'error', error: { code: 'network', message: String(e) } });
    } finally {
      startingRef.current = false;
    }
  };

  const cancel = async (): Promise<void> => {
    if (!projectId) return;
    try {
      await fetch(`/api/render?id=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      // 完了は SSE(cancelled) 経由で state が idle に落ちる。
    } catch (e) {
      setState({ status: 'error', error: { code: 'network', message: String(e) } });
    }
  };

  const reveal = async (): Promise<void> => {
    if (!projectId) return;
    setRevealError(null);
    try {
      const res = await fetch(`/api/render/reveal?id=${encodeURIComponent(projectId)}`, {
        method: 'POST',
      });
      if (!res.ok) {
        setRevealError(revealErrorMessage(res.status));
        return;
      }
      // fallback=true は「今回の書き出し」ではなく out/ の最新を開いた場合。
      // 別解像度の古いファイルを開いている可能性があるので黙って成功にしない。
      const body = (await res.json().catch(() => ({}))) as { fallback?: unknown };
      if (body.fallback === true) {
        setRevealError('out フォルダの最新ファイルを開きました（今回の書き出しファイルが特定できませんでした）。');
      }
    } catch {
      setRevealError('書き出しファイルを開けませんでした（エディタとの通信に失敗）。');
    }
  };

  const reset = (): void => {
    setRevealError(null);
    setState((prev) => (prev.status === 'done' || prev.status === 'error' ? INITIAL_RENDER_STATE : prev));
  };

  return { state, start, cancel, reveal, reset, revealError, heavyJobConfirm };
}
