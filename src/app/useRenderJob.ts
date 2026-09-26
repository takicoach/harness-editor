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

import { useEffect, useRef, useState } from 'react';
import type { RenderOptions } from '../shared/renderPreset';
import { useHeavyJobConfirm, type UseHeavyJobConfirmReturn } from './useHeavyJobConfirm';
import { useEventChannelWithSync } from './eventBus';
import { asFastCutIneligibleReason, type FastCutIneligibleReason } from '../shared/captureOverlays';
import { CAPTURE_ENGINE_MESSAGES } from '../shared/captureEngineMessages';
import { renderHttpError } from './renderHttpError';

/** 進捗情報。 */
export interface RenderProgress {
  frames: number;
  total: number;
  percent: number;
}

/**
 * 撮影段の見積り（I-3・server/renderJobTypes.ts の RenderCaptureEstimate と同形）。
 * サーバの型をそのまま import せず複製する（RenderProgress と同じ既存方針・
 * server コードをクライアントバンドルへ持ち込まないため）。
 */
export interface RenderCaptureEstimate {
  /** 撮影対象の相異なるシグネチャ数（情報用・**進捗の分母ではない**・C-1）。 */
  distinctFrames: number;
  /** 実際に Chromium で撮る枚数（run 総数）。進捗の分母・完了判定はこちら（C-1）。 */
  capturedTotal: number;
  /** 予測撮影時間（ms）。 */
  estimatedMs: number;
  /** 撮影済み枚数（M2d T3・申し送り⑥）。未指定は撮影開始前の初回見積り。 */
  capturedFrames?: number;
}

/** useRenderJob が管理する状態オブジェクト。 */
export type RenderState =
  | { status: 'idle' }
  | {
      status: 'running';
      phase: string;
      percent: number | null;
      startedAt: number;
      outputFile?: string;
      /** 撮影段の見積り（phase='capturing' で判明後に載る。判明前は undefined）。 */
      capture?: RenderCaptureEstimate;
      /**
       * 実行中の注意書き。後続の進捗イベントにwarningがなくても、
       * 一度届いた案内はrunningの間保持する。旧履歴・表示検査の通知にも共通。
       */
      warning?: string;
    }
  | { status: 'done'; warning?: string; outputFile?: string }
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
        outputFile?: string;
        progress?: RenderProgress;
        error?: { code: string; message: string };
        /** 完了はしたが気になる点（例: 出力フレーム数が想定と違う）。 */
        warning?: string;
        /** 撮影段の見積り（phase='capturing' の時のみ・I-3）。 */
        capture?: RenderCaptureEstimate;
      };
    }
  | {
      type: 'event';
      event: {
        phase: string;
        progress?: RenderProgress;
        error?: { code: string; message: string };
        warning?: string;
        /** 撮影段の見積り（phase='capturing' の時のみ・I-3）。 */
        capture?: RenderCaptureEstimate;
      };
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
 * 現在の RenderState と受信した SSE メッセージから次の状態を計算する（純関数）。
 */
export function nextRenderState(prev: RenderState, msg: RenderSseMessage): RenderState {
  if (msg.type === 'idle') {
    return prev;
  }

  if (msg.type === 'snapshot') {
    const job = msg.job;
    if (job.phase === 'done') {
      return {
        status: 'done',
        ...(job.warning === undefined ? {} : { warning: job.warning }),
        ...(job.outputFile === undefined ? {} : { outputFile: job.outputFile }),
      };
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
      ...(job.outputFile === undefined ? {} : { outputFile: job.outputFile }),
      ...(job.capture === undefined ? {} : { capture: job.capture }),
      ...(job.warning === undefined ? {} : { warning: job.warning }),
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
      return {
        ...prev,
        phase: ev.phase,
        percent: ev.progress?.percent ?? (ev.phase === 'preparing' ? null : prev.percent),
        // capture は判明後に来る（M2d T3: 撮影が進むたび最大1秒間隔で複数回届く）。
        // 未着イベントでは前回値を保持する。
        ...(ev.capture === undefined ? {} : { capture: ev.capture }),
        // warning（M-5）も同じ規約: 一度着いたら running の間は保持する（未着イベントで消さない）。
        ...(ev.warning === undefined ? {} : { warning: ev.warning }),
      };
    }
    return prev;
  }

  if (msg.type === 'done') {
    if (msg.phase === 'done') {
      const previous = prev.status === 'running' || prev.status === 'done' ? prev : undefined;
      const warning = msg.warning ?? previous?.warning;
      return {
        status: 'done',
        ...(warning === undefined ? {} : { warning }),
        ...(previous?.outputFile === undefined ? {} : { outputFile: previous.outputFile }),
      };
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

/**
 * 高速書き出しへ入れなかった理由ごとの通知文言（I-2・受入 C）。
 * 理由が無い（撮影と無関係な非適格）ときは null を返し、従来の一般文言（Toolbar 既定）に任せる。
 * 文言の正本は shared/captureEngineMessages.ts（M2d T2 修正2 M-3）。union 網羅は
 * `case undefined:` を明示した上で、残りは Record 側の `satisfies` が型で閉じる（M-2）。
 */
export function fastCutFallbackMessageFor(reason: FastCutIneligibleReason | undefined): string | null {
  switch (reason) {
    case undefined:
      return null;
    case 'chromium-missing':
    case 'env-path-missing':
    case 'unsupported-platform':
      return CAPTURE_ENGINE_MESSAGES[reason].band;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export interface UseRenderJobReturn {
  state: RenderState;
  /**
   * 書き出しを開始する（options 省略時は既定プリセット）。
   * predictedFastCut はクライアント側予測（isCutsOnly）— サーバ実際の判定と食い違ったとき
   * fastCutFallbackNotice を立てるための入力（省略時 false・通知は立たない）。
   */
  start: (options?: RenderOptions, predictedFastCut?: boolean) => Promise<void>;
  /**
   * 実行中のジョブをキャンセルする。
   * @returns 失敗したときは画面に出す日本語のメッセージ、成功なら null（data-safety-11）。
   */
  cancel: () => Promise<string | null>;
  /**
   * 書き出し済みファイルを Finder で表示する。
   * @returns 失敗したときは画面に出す日本語のメッセージ、成功なら null（data-safety-11）。
   */
  reveal: () => Promise<string | null>;
  /** done/error 状態を idle に戻す（バナーの「閉じる」用）。 */
  reset: () => void;
  /** 重ジョブ負荷確認ダイアログの状態・操作（HeavyJobConfirmDialog に配線する）。 */
  heavyJobConfirm: UseHeavyJobConfirmReturn;
  /**
   * クライアント予測=高速 かつ サーバ実際=通常だったときに立つ通知（Task 6）。
   * 「今回は通常の書き出しになりました」の表示に使う。ジョブが running を離れる
   * （done/failed/cancelled）と自動でクリアされる。
   */
  fastCutFallbackNotice: boolean;
  /**
   * 退避理由が分かっているときの通知文言（I-2）。理由なし（または通知が立っていない）なら null
   * ＝ Toolbar は従来の一般文言を出す。
   */
  fastCutFallbackMessage: string | null;
}

/**
 * 書き出し（render）の状態管理フック。
 *
 * @param projectId - 対象プロジェクト ID。空文字の場合は何もしない。
 */
export function useRenderJob(projectId: string): UseRenderJobReturn {
  const [state, setState] = useState<RenderState>(INITIAL_RENDER_STATE);
  const [stateProjectId, setStateProjectId] = useState(projectId);
  const heavyJobConfirm = useHeavyJobConfirm();
  const [fastCutFallbackNotice, setFastCutFallbackNotice] = useState(false);
  const [fastCutFallbackReason, setFastCutFallbackReason] = useState<FastCutIneligibleReason | undefined>(undefined);

  // running を離れたら（done/failed/cancelled）通知をクリアする。
  useEffect(() => {
    if (state.status !== 'running') {
      setFastCutFallbackNotice(false);
      setFastCutFallbackReason(undefined);
    }
  }, [state.status]);

  // Keep the reset guard in React state. A ref mutated by a discarded StrictMode
  // render can suppress the reset in the committed render and leak A's state to B.
  const prevProjectIdRef = useRef(projectId);
  prevProjectIdRef.current = projectId;
  if (stateProjectId !== projectId) {
    setStateProjectId(projectId);
    setState(INITIAL_RENDER_STATE);
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
  /**
   * 「開始要求（POST）が飛んでいる最中に押されたキャンセル」の保留フラグ。
   *
   * 書き出しの実行中表示は POST の応答を待たずに出す（楽観的 running）。そのため
   * ユーザーは**サーバにジョブが登録されるより前に**「×」を押せる。その DELETE は
   * `renderJobs.cancel()` が対象ジョブを見つけられず 404 で捨てられ、直後に登録された
   * ジョブは誰にも止められないまま最後まで走る——押したキャンセルが黙って無効になる。
   * （実測: フルスイート e2e で POST の往復が 44ms を超えた回に再現。
   *  tests/render-button.spec.ts の回帰テストが POST を遅延させて決定論的に再現する。）
   * 保留しておき、POST が着地して初めてジョブが実在する時点で送り直す。
   */
  const cancelPendingRef = useRef(false);
  /**
   * 送信中の DELETE。start 側は**その結果を待ってから**送り直しの要否を決める。
   *
   * 保留フラグだけだと、cancel() が「開始要求中だから届かないかもしれない」と保険で
   * 立てた保留を、その DELETE が実際には 200 で成功していた場合にも下ろせない
   * （応答が返る前に start 側が保留を読んでしまう）。結果、効いたキャンセルに対して
   * POST 着地後に**不要な DELETE をもう 1 回**投げていた。判定材料（DELETE の結果）が
   * 出るまで待てば、保険は要らない。
   */
  const cancelInFlightRef = useRef<Promise<boolean> | null>(null);

  /** DELETE /api/render を 1 回送る（状態遷移は SSE(cancelled) に委ねる）。 */
  const sendCancel = async (): Promise<Response> =>
    fetch(`/api/render?id=${encodeURIComponent(projectId)}`, { method: 'DELETE' });

  const start = async (options?: RenderOptions, predictedFastCut = false): Promise<void> => {
    if (!projectId || state.status === 'running' || startingRef.current) return;
    startingRef.current = true;
    cancelPendingRef.current = false;
    setState({ status: 'running', phase: 'preparing', percent: null, startedAt: Date.now() });
    setFastCutFallbackNotice(false); // 新規開始のたびに前回分をリセットする。
    setFastCutFallbackReason(undefined);
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
        setState({
          status: 'error',
          error: renderHttpError(body, res.status),
        });
      } else {
        // クライアント予測=高速 かつ サーバ実際=通常のときだけ通知を立てる（Task 6）。
        // サーバ判定が最終権威 — 予測から false（最初から通常予告）のときは出さない。
        const body = await res.json().catch(() => null) as { native?:boolean; fastCut?: boolean; fastCutIneligible?: unknown; outputFile?: unknown } | null;
        if (typeof body?.outputFile === 'string' && prevProjectIdRef.current === projectId) {
          const outputFile = body.outputFile;
          setState(prev => prev.status === 'running' || prev.status === 'done' ? { ...prev, outputFile } : prev);
        }
        const actualFastCut = body?.fastCut === true;
        setFastCutFallbackNotice(predictedFastCut && !actualFastCut && body?.native !== true);
        // 理由は値検査してから取り込む（未知の値はサーバの型崩れとして無視＝従来文言）。
        setFastCutFallbackReason(asFastCutIneligibleReason(body?.fastCutIneligible));
      }
      // 成功時の state 遷移は SSE に委ねる（ここでは何もしない）。
      // POST 応答前に押されたキャンセルは、まだジョブが無い時刻にサーバへ届いて
      // 捨てられている。ジョブが実在する今、送り直す（押したキャンセルを効かせる）。
      // 送信中の DELETE があるなら、その結果（効いたのか 404 で捨てられたのか）を待つ。
      // 待たずに保留フラグだけ見ると、成功していたキャンセルにも再送してしまう。
      if (cancelInFlightRef.current !== null) await cancelInFlightRef.current.catch(() => false);
      if (cancelPendingRef.current) {
        cancelPendingRef.current = false;
        await sendCancel();
      }
    } catch (e) {
      setState({ status: 'error', error: { code: 'network', message: String(e) } });
    } finally {
      startingRef.current = false;
    }
  };

  // 押したのに何も起きない状態を無くす（data-safety-11）。失敗は呼び出し側が
  // トーストへ流せるよう、日本語のメッセージとして返す（null は「止められた／止まる見込み」）。
  const cancel = async (): Promise<string | null> => {
    if (!projectId) return null;
    // 開始要求がまだ飛んでいる最中なら、この DELETE はジョブ登録前に着いて捨てられうる。
    // start 側で送り直させる（cancelPendingRef の説明を参照）。
    // まず保険で保留を立てる（この DELETE が応答を返す前に POST が着地しうるため）。
    // 応答が「効いた（ok）」と分かった時点で下ろす — start 側はこの判定を待つ。
    if (startingRef.current) cancelPendingRef.current = true;
    const inFlight = (async () => (await sendCancel()).ok)();
    cancelInFlightRef.current = inFlight;
    try {
      const ok = await inFlight;
      // 効いたなら送り直さない（POST 着地後の不要な DELETE を止める）。
      // 404（＝まだジョブが無い）で、かつ開始要求が飛んでいる最中なら送り直す。
      if (ok) cancelPendingRef.current = false;
      else if (startingRef.current) cancelPendingRef.current = true;
      // 開始要求も飛んでいないのに効かなかった（ジョブ消失＝404 等）なら「止まったつもり」に
      // しない（data-safety-11）。
      else return '書き出しを止められませんでした。画面を再読込してからもう一度お試しください';
      // 完了は SSE(cancelled) 経由で state が idle に落ちる。
      return null;
    } catch (e) {
      setState({ status: 'error', error: { code: 'network', message: String(e) } });
      return '書き出しを止められませんでした（接続できません）';
    } finally {
      if (cancelInFlightRef.current === inFlight) cancelInFlightRef.current = null;
    }
  };

  const reveal = async (): Promise<string | null> => {
    if (!projectId) return null;
    try {
      const res = await fetch(`/api/render/reveal?id=${encodeURIComponent(projectId)}`, {
        method: 'POST',
      });
      if (!res.ok) return '書き出したファイルの場所を開けませんでした';
      return null;
    } catch {
      return '書き出したファイルの場所を開けませんでした（接続できません）';
    }
  };

  const reset = (): void => {
    setState((prev) => (prev.status === 'done' || prev.status === 'error' ? INITIAL_RENDER_STATE : prev));
  };

  return {
    state,
    start,
    cancel,
    reveal,
    reset,
    heavyJobConfirm,
    fastCutFallbackNotice,
    fastCutFallbackMessage: fastCutFallbackNotice ? fastCutFallbackMessageFor(fastCutFallbackReason) : null,
  };
}
