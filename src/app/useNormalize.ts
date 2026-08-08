/**
 * useNormalize — /api/normalize の SSE 購読フック（loudnorm 音量正規化）。
 *
 * useDenoise を手本にしつつ:
 *  - 強さ型は loud/standard/quiet
 *  - 適用状態はマウント時に GET /api/normalize/status で自前取得（loadProjectFiles 非依存）
 */
import { useEffect, useRef, useState } from 'react';
import { useHeavyJobConfirm, type UseHeavyJobConfirmReturn } from './useHeavyJobConfirm';
import { useEventChannelWithSync } from './eventBus';

export type NormalizeStrength = 'loud' | 'standard' | 'quiet';
export type NormalizeStatus = 'idle' | 'running' | 'done' | 'error';

export type NormalizeState =
  | { status: 'idle'; applied: boolean }
  | { status: 'running'; phase: string; startedAt: number; applied: boolean }
  | { status: 'done'; applied: boolean }
  | { status: 'error'; error: { code: string; message: string }; applied: boolean };

/** INITIAL_NORMALIZE_STATE（テストから参照可能にエクスポート）。 */
export const INITIAL_NORMALIZE_STATE: NormalizeState = { status: 'idle', applied: false };

// ─────────────────────────────────────────────────────────────────────────────
// SSE メッセージ型

export type NormalizeSseMessage =
  | { type: 'idle' }
  | { type: 'snapshot'; job: { phase: string; startedAt: number; error?: { code: string; message: string } } }
  | { type: 'event'; event: { phase: string; error?: { code: string; message: string } } }
  | { type: 'done'; phase: string; error?: { code: string; message: string } };

// ─────────────────────────────────────────────────────────────────────────────
// 純関数（テスト容易性のためエクスポート）

/**
 * SSE データ文字列をパースして NormalizeSseMessage を返す。
 * パース失敗は null。
 */
export function parseNormalizeEvent(data: string): NormalizeSseMessage | null {
  try {
    return JSON.parse(data) as NormalizeSseMessage;
  } catch {
    return null;
  }
}

/**
 * 現在の NormalizeState と受信した SSE メッセージから次の状態を計算する（純関数）。
 */
export function nextNormalizeState(prev: NormalizeState, msg: NormalizeSseMessage): NormalizeState {
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

export interface UseNormalizeReturn {
  state: NormalizeState;
  /** 音量正規化を開始する。 */
  start: (strength: NormalizeStrength) => Promise<void>;
  /** 音量正規化を元に戻す（バックアップから復元）。 */
  restore: () => Promise<void>;
  /** 重ジョブ負荷確認ダイアログの状態・操作（HeavyJobConfirmDialog に配線する）。 */
  heavyJobConfirm: UseHeavyJobConfirmReturn;
}

/**
 * 音量正規化の状態管理フック。
 *
 * @param projectId - 対象プロジェクト ID。空文字の場合は何もしない。
 */
export function useNormalize(projectId: string): UseNormalizeReturn {
  const [state, setState] = useState<NormalizeState>(INITIAL_NORMALIZE_STATE);
  const heavyJobConfirm = useHeavyJobConfirm();

  // プロジェクト切替で状態リセット（描画中の同期リセット・React 公式パターン）。
  const prevProjectIdRef = useRef(projectId);
  if (prevProjectIdRef.current !== projectId) {
    prevProjectIdRef.current = projectId;
    setState(INITIAL_NORMALIZE_STATE);
  }

  // 適用状態を自前取得（マウント・projectId 変更時）。
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    fetch(`/api/normalize/status?id=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { applied?: boolean } | null) => {
        if (cancelled || !body) return;
        setState((prev) =>
          prev.status === 'idle' ? { ...prev, applied: body.applied === true } : prev,
        );
      })
      .catch(() => {
        /* 取得失敗は applied=false のまま（無害） */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // normalize チャネルを常時購読する。マウント時（projectId 変更時）は sync でキャッチアップ
  // する（バス接続確立後のマウントでは接続時初期スナップショットを取り逃すため。
  // 特に「再読込」で TranscriptPanel 配下ごと unmount→remount するケースが該当）。
  useEventChannelWithSync('normalize', projectId, (raw: unknown) => {
    const msg = raw as NormalizeSseMessage;
    setState((prev) => nextNormalizeState(prev, msg));
  });

  const start = async (strength: NormalizeStrength): Promise<void> => {
    if (!projectId || state.status === 'running') return;
    setState((prev) => ({ ...prev, status: 'running', phase: 'preparing', startedAt: Date.now() }));
    try {
      const outcome = await heavyJobConfirm.start(`/api/normalize?id=${encodeURIComponent(projectId)}`, {
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
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
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
        `/api/normalize/restore?id=${encodeURIComponent(projectId)}`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
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

  return { state, start, restore, heavyJobConfirm };
}
