/**
 * usePreviewProxy — /api/preview-proxy の SSE 購読フック（プレビュー軽量化）。
 *
 * useNormalize を手本に:
 *  - マウント時に GET /api/preview-proxy/status で「軽量版の有無＋推奨判定（理由付き）」を取得
 *  - 実行中は SSE から percent 進捗を受けて進捗バーを駆動する
 *  - 「今回はしない」は localStorage にプロジェクト単位で記録し、次回以降も出さない
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useHeavyJobConfirm, type UseHeavyJobConfirmReturn } from './useHeavyJobConfirm';
import { useEventChannelWithSync } from './eventBus';

export type PreviewProxyState =
  | { status: 'unknown' }
  | { status: 'idle'; hasProxy: boolean; recommended: boolean; reasons: string[] }
  | { status: 'running'; percent: number | null; startedAt: number }
  | { status: 'done' }
  | { status: 'error'; error: { code: string; message: string } };

export const INITIAL_PREVIEW_PROXY_STATE: PreviewProxyState = { status: 'unknown' };

// ─────────────────────────────────────────────────────────────────────────────
// SSE メッセージ型

export type PreviewProxySseMessage =
  | { type: 'idle' }
  | { type: 'snapshot'; job: { phase: string; startedAt: number; percent: number | null; error?: { code: string; message: string } } }
  | { type: 'event'; event: { phase: string; percent?: number; error?: { code: string; message: string } } }
  | { type: 'done'; phase: string; error?: { code: string; message: string } };

// ─────────────────────────────────────────────────────────────────────────────
// 純関数（テスト容易性のためエクスポート）

export function parsePreviewProxyEvent(data: string): PreviewProxySseMessage | null {
  try {
    return JSON.parse(data) as PreviewProxySseMessage;
  } catch {
    return null;
  }
}

/** 現在の状態と SSE メッセージから次の状態を計算する（純関数）。 */
export function nextPreviewProxyState(
  prev: PreviewProxyState,
  msg: PreviewProxySseMessage,
): PreviewProxyState {
  if (msg.type === 'idle') return prev;

  if (msg.type === 'snapshot') {
    const job = msg.job;
    if (job.phase === 'done') return { status: 'done' };
    if (job.phase === 'failed') {
      return { status: 'error', error: job.error ?? { code: 'unknown', message: '不明なエラー' } };
    }
    if (job.phase === 'cancelled') return prev;
    return { status: 'running', percent: job.percent, startedAt: job.startedAt };
  }

  if (msg.type === 'event') {
    const ev = msg.event;
    if (ev.phase === 'failed') {
      return { status: 'error', error: ev.error ?? { code: 'unknown', message: '不明なエラー' } };
    }
    if (ev.phase === 'cancelled') return prev;
    if (ev.phase === 'done') return { status: 'done' };
    if (prev.status === 'running') {
      return { ...prev, percent: ev.percent ?? prev.percent };
    }
    return prev;
  }

  // msg.type === 'done'
  if (msg.phase === 'done') return { status: 'done' };
  if (msg.phase === 'failed') {
    return { status: 'error', error: msg.error ?? { code: 'unknown', message: '不明なエラー' } };
  }
  return prev; // cancelled は status 再取得（下のフック側）に任せる
}

// ─────────────────────────────────────────────────────────────────────────────
// 「今回はしない」の記録（localStorage・プロジェクト単位）

function dismissKey(projectId: string): string {
  return `sme-preview-proxy-dismissed:${projectId}`;
}

export function readProxyDismissed(projectId: string): boolean {
  try {
    return localStorage.getItem(dismissKey(projectId)) === '1';
  } catch {
    return false;
  }
}

export function writeProxyDismissed(projectId: string): void {
  try {
    localStorage.setItem(dismissKey(projectId), '1');
  } catch {
    /* localStorage 不可（プライベートモード等）は諦める */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// フック

export interface UsePreviewProxyReturn {
  state: PreviewProxyState;
  dismissed: boolean;
  /** 軽量版の生成を開始する。 */
  start: () => Promise<void>;
  /** 実行中の生成をキャンセルする。 */
  cancel: () => Promise<void>;
  /** 「今回はしない」— このプロジェクトでは今後案内しない。 */
  dismiss: () => void;
  /** 重ジョブ負荷確認ダイアログの状態・操作（HeavyJobConfirmDialog に配線する）。 */
  heavyJobConfirm: UseHeavyJobConfirmReturn;
}

export function usePreviewProxy(projectId: string): UsePreviewProxyReturn {
  const [state, setState] = useState<PreviewProxyState>(INITIAL_PREVIEW_PROXY_STATE);
  const [dismissed, setDismissed] = useState(false);
  const heavyJobConfirm = useHeavyJobConfirm();

  const stateRef = useRef(state);
  stateRef.current = state;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // プロジェクト切替で状態リセット（描画中の同期リセット・React 公式パターン）。
  const prevProjectIdRef = useRef(projectId);
  if (prevProjectIdRef.current !== projectId) {
    prevProjectIdRef.current = projectId;
    setState(INITIAL_PREVIEW_PROXY_STATE);
    setDismissed(false);
  }

  /**
   * 軽量版の有無＋推奨判定を取得して state へ反映する。
   * allowDowngradeFromRunning=false（マウント時）は running を格下げしない
   * （start 直後に古い status 応答が届いて running が消える競合を防ぐ）。
   * true（キャンセル通知・ジョブ消滅時）は running を実状態へ収束させる:
   * hasProxy なら done（極短ジョブが SSE 接続前に完了したケース）、無ければ idle へ。
   */
  const fetchStatus = useCallback(
    (allowDowngradeFromRunning: boolean): void => {
      const pid = projectId;
      if (!pid) return;
      fetch(`/api/preview-proxy/status?id=${encodeURIComponent(pid)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { hasProxy?: boolean; recommended?: boolean; reasons?: string[]; running?: boolean } | null) => {
          if (!body || projectIdRef.current !== pid) return;
          const idleFromBody = (): PreviewProxyState => ({
            status: 'idle',
            hasProxy: body.hasProxy === true,
            recommended: body.recommended === true,
            reasons: Array.isArray(body.reasons) ? body.reasons.filter((x): x is string => typeof x === 'string') : [],
          });
          setState((prev) => {
            if (prev.status === 'done' || prev.status === 'error') return prev;
            if (body.running === true) {
              return prev.status === 'running' ? prev : { status: 'running', percent: null, startedAt: Date.now() };
            }
            if (prev.status === 'running') {
              if (!allowDowngradeFromRunning) return prev;
              return body.hasProxy === true ? { status: 'done' } : idleFromBody();
            }
            return idleFromBody();
          });
        })
        .catch(() => {
          if (projectIdRef.current !== pid) return;
          setState((prev) => (prev.status === 'unknown' ? { status: 'idle', hasProxy: false, recommended: false, reasons: [] } : prev));
        });
    },
    [projectId],
  );

  // マウント・projectId 変更時に取得。
  useEffect(() => {
    if (!projectId) return;
    setDismissed(readProxyDismissed(projectId));
    fetchStatus(false);
  }, [projectId, fetchStatus]);

  // preview-proxy チャネルを常時購読する。マウント時（projectId 変更時）は sync で
  // キャッチアップする（バス接続確立後のマウントでは接続時初期スナップショットを取り逃すため）。
  useEventChannelWithSync('preview-proxy', projectId, (raw: unknown) => {
    const msg = raw as PreviewProxySseMessage;
    // running 中に idle が返る＝ジョブが SSE 接続前に片付いた。実状態へ収束させる。
    if (msg.type === 'idle' && stateRef.current.status === 'running') {
      fetchStatus(true);
      return;
    }
    setState((prev) => nextPreviewProxyState(prev, msg));
    if (msg.type === 'done') {
      // cancelled で終わった場合は idle 情報を取り直す（推奨バナーを復帰させる）。
      if (msg.phase === 'cancelled') fetchStatus(true);
    }
  });

  const start = async (): Promise<void> => {
    if (!projectId || state.status === 'running') return;
    setState({ status: 'running', percent: null, startedAt: Date.now() });
    try {
      const outcome = await heavyJobConfirm.start(`/api/preview-proxy?id=${encodeURIComponent(projectId)}`, { method: 'POST' });
      if (outcome === 'cancelled') {
        // ダイアログで「やめておく」→ 実行中に見せていた running を実状態へ戻す。
        fetchStatus(true);
        return;
      }
      const res = outcome;
      if (!res.ok) {
        // 409 = 既に走っている（別タブ等）。失敗ではなく実行中ジョブへ合流し、SSE が進捗を拾う。
        if (res.status === 409) return;
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const msg = typeof body['error'] === 'string' ? body['error'] : `HTTP ${res.status}`;
        setState({ status: 'error', error: { code: 'start-failed', message: msg } });
      }
      // 成功時は SSE が state を更新する。
    } catch (e) {
      setState({ status: 'error', error: { code: 'network', message: String(e) } });
    }
  };

  const cancel = async (): Promise<void> => {
    if (!projectId) return;
    try {
      await fetch(`/api/preview-proxy?id=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
    } catch {
      /* キャンセル失敗は SSE 側の状態に任せる */
    }
  };

  const dismiss = (): void => {
    writeProxyDismissed(projectId);
    setDismissed(true);
  };

  return { state, dismissed, start, cancel, dismiss, heavyJobConfirm };
}
