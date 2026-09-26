/**
 * useDenoise — /api/events（denoise チャネル）の購読フック。
 *
 * 状態: idle / running / done / error
 * 適用済みフラグ: applied（マーカーが applied=true の場合 true）
 *
 * 設計方針:
 * - denoise チャネルは SSE 1 本統合バス（EventBusProvider）経由で常時購読する。
 * - 実行前に strength（弱/中/強）を POST ボディで送る。
 * - 元に戻す（restore）は POST /api/denoise/restore を呼ぶ。
 */

import { useRef, useState } from 'react';
import { useHeavyJobConfirm, type UseHeavyJobConfirmReturn } from './useHeavyJobConfirm';
import { useEventChannelWithSync } from './eventBus';

/** ノイズ除去の実行強度。 */
export type DenoiseStrength = 'weak' | 'mid' | 'strong';

/** useDenoise が管理するフェーズ状態。 */
export type DenoiseStatus = 'idle' | 'running' | 'done' | 'error';

/** 内部状態オブジェクト。 */
export type DenoiseState =
  | { status: 'idle'; applied: boolean }
  | { status: 'running'; phase: string; startedAt: number; applied: boolean }
  | { status: 'done'; applied: boolean }
  | { status: 'error'; error: { code: string; message: string }; applied: boolean };

/** INITIAL_DENOISE_STATE（テストから参照可能にエクスポート）。 */
export const INITIAL_DENOISE_STATE: DenoiseState = { status: 'idle', applied: false };

// ─────────────────────────────────────────────────────────────────────────────
// SSE メッセージ型

export type DenoiseSseMessage =
  | { type: 'idle' }
  | { type: 'snapshot'; job: { phase: string; startedAt: number; error?: { code: string; message: string } } }
  | { type: 'event'; event: { phase: string; error?: { code: string; message: string } } }
  | { type: 'done'; phase: string; error?: { code: string; message: string } };

// ─────────────────────────────────────────────────────────────────────────────
// 純関数（テスト容易性のためエクスポート）

/**
 * SSE データ文字列をパースして DenoiseSseMessage を返す。
 * パース失敗は null。
 */
export function parseDenoiseEvent(data: string): DenoiseSseMessage | null {
  try {
    return JSON.parse(data) as DenoiseSseMessage;
  } catch {
    return null;
  }
}

/**
 * 現在の DenoiseState と受信した SSE メッセージから次の状態を計算する（純関数）。
 */
export function nextDenoiseState(prev: DenoiseState, msg: DenoiseSseMessage): DenoiseState {
  if (msg.type === 'idle') {
    return prev;
  }

  if (msg.type === 'snapshot') {
    const job = msg.job;
    if (job.phase === 'done') {
      return { status: 'done', applied: true };
    }
    if (job.phase === 'failed') {
      return {
        status: 'error',
        error: job.error ?? { code: 'unknown', message: '不明なエラー' },
        applied: prev.applied,
      };
    }
    if (job.phase === 'cancelled') {
      return { status: 'idle', applied: prev.applied };
    }
    return { status: 'running', phase: job.phase, startedAt: job.startedAt, applied: prev.applied };
  }

  if (msg.type === 'event') {
    const ev = msg.event;
    if (ev.phase === 'failed') {
      return {
        status: 'error',
        error: ev.error ?? { code: 'unknown', message: '不明なエラー' },
        applied: prev.applied,
      };
    }
    if (ev.phase === 'cancelled') {
      return { status: 'idle', applied: prev.applied };
    }
    if (prev.status === 'running') {
      return { ...prev, phase: ev.phase };
    }
    return prev;
  }

  if (msg.type === 'done') {
    if (msg.phase === 'done') {
      return { status: 'done', applied: true };
    }
    if (msg.phase === 'failed') {
      return {
        status: 'error',
        error: msg.error ?? { code: 'unknown', message: '不明なエラー' },
        applied: prev.applied,
      };
    }
    // cancelled
    return { status: 'idle', applied: prev.applied };
  }

  return prev;
}

// ─────────────────────────────────────────────────────────────────────────────
// フック

export interface UseDenoiseReturn {
  state: DenoiseState;
  /** ノイズ除去を開始する。 */
  start: (strength: DenoiseStrength) => Promise<void>;
  /** ノイズ除去を元に戻す（バックアップから復元）。 */
  restore: () => Promise<void>;
  /**
   * 失敗表示を閉じて idle へ戻す（status-ia-7）。
   * 失敗は status が idle に戻るまで居座るため、利用者が畳めるようにする。
   */
  dismissError: () => void;
  /** 重ジョブ負荷確認ダイアログの状態・操作（HeavyJobConfirmDialog に配線する）。 */
  heavyJobConfirm: UseHeavyJobConfirmReturn;
}

/**
 * ノイズ除去の状態管理フック。
 *
 * @param projectId - 対象プロジェクト ID。空文字の場合は何もしない。
 * @param initialApplied - プロジェクト読込時のマーカー状態（外部から渡す）。
 */
export function useDenoise(projectId: string, initialApplied = false): UseDenoiseReturn {
  const [state, setState] = useState<DenoiseState>(() => ({
    status: 'idle',
    applied: initialApplied,
  }));
  const heavyJobConfirm = useHeavyJobConfirm();

  // プロジェクト切替時に状態をリセット。
  const prevProjectIdRef = useRef(projectId);
  if (prevProjectIdRef.current !== projectId) {
    prevProjectIdRef.current = projectId;
    // 描画中の同期的リセット（React 公式パターン）。
    setState({ status: 'idle', applied: initialApplied });
  }

  // denoise チャネルを常時購読する。マウント時（projectId 変更時）は sync でキャッチアップする
  // （バス接続確立後のマウントでは接続時初期スナップショットを取り逃すため）。
  useEventChannelWithSync('denoise', projectId, (raw: unknown) => {
    const msg = raw as DenoiseSseMessage;
    setState((prev) => nextDenoiseState(prev, msg));
  });

  const start = async (strength: DenoiseStrength): Promise<void> => {
    if (!projectId || state.status === 'running') return;
    setState((prev) => ({ ...prev, status: 'running', phase: 'preparing', startedAt: Date.now() }));
    try {
      const outcome = await heavyJobConfirm.start(`/api/denoise?id=${encodeURIComponent(projectId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strength }),
      });
      if (outcome === 'cancelled') {
        setState((prev) => (prev.status === 'running' ? { status: 'idle', applied: prev.applied } : prev));
        return;
      }
      const res = outcome;
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        const code = typeof body['error'] === 'string' ? body['error'] : 'unknown';
        setState((prev) => ({
          status: 'error',
          error: { code, message: typeof body['error'] === 'string' ? body['error'] : `HTTP ${res.status}` },
          applied: prev.applied,
        }));
      }
      // 成功時は SSE が state を更新するので、ここでは何もしない。
    } catch (e) {
      setState((prev) => ({
        status: 'error',
        error: { code: 'network', message: String(e) },
        applied: prev.applied,
      }));
    }
  };

  const restore = async (): Promise<void> => {
    if (!projectId) return;
    try {
      const res = await fetch(
        `/api/denoise/restore?id=${encodeURIComponent(projectId)}`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        const msg = typeof body['error'] === 'string' ? body['error'] : `HTTP ${res.status}`;
        setState((prev) => ({
          status: 'error',
          error: { code: 'restore-failed', message: msg },
          applied: prev.applied,
        }));
        return;
      }
      setState({ status: 'idle', applied: false });
    } catch (e) {
      setState((prev) => ({
        status: 'error',
        error: { code: 'network', message: String(e) },
        applied: prev.applied,
      }));
    }
  };

  // status-ia-7: error 表示を閉じる。applied（マーカー）は保ったまま idle へ戻す。
  const dismissError = (): void => {
    setState((prev) => (prev.status === 'error' ? { status: 'idle', applied: prev.applied } : prev));
  };

  return { state, start, restore, dismissError, heavyJobConfirm };
}
