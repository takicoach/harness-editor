// src/app/useCaptureEngineStatus.ts
/**
 * 撮影エンジン（chrome-headless-shell）の状態取得フック（M2d T2 修正ラウンド2・I-1）。
 *
 * 旧実装は `captureEngineFetchedRef`（ref ガード）1本の effect で「初回とダイアログ open の
 * ときだけ fetch する」を作っていたが、React.StrictMode の二重マウント
 * （mount → cleanup → mount）で事故を起こしていた: 1 回目の mount 実行が ref を true にして
 * fetch を開始 → cleanup でその fetch の `cancelled` が true になる → 2 回目の mount 実行は
 * ref が既に true・`exportDialogOpen` も false のため early return し、新しい fetch を
 * 発行しない。結果、着地するはずの応答が「1 回目（cancelled 済みで無視）」しかなく、
 * StrictMode 下では起動時 prefetch が一切反映されなかった
 * （`useCaptureEngineStatus.test.tsx` の正対照つきプローブで実証）。
 *
 * 修正: ref ガードを廃止し、責務を2本の effect に分ける。
 * 1. mount 用 effect（deps: []）— 初回の取得（冪等 GET なので StrictMode の二重実行で
 *    2 回 fetch が飛んでも実害はない。`cancelled` はそれぞれの fetch 呼び出しに閉じた
 *    ローカル変数のため、2 回目の mount の fetch は 2 回目自身の cleanup でしか
 *    止まらない＝正しく着地する）。
 * 2. `exportDialogOpen` が true になるたびの再取得 effect（前回値は保持したまま取り直す・
 *    閉じる操作では再取得しない）。
 */
import { useEffect, useState } from 'react';
import { fetchJson } from './fetchJson';
import { parseCaptureEngineStatus, type CaptureEngineStatus } from './captureEngineStatus';

/** 状態取得の共通本体。呼び出し側 effect の cleanup と紐づくキャンセルクロージャを返す。 */
function fetchAndApply(setCaptureEngine: (v: CaptureEngineStatus) => void): () => void {
  let cancelled = false;
  void fetchJson<unknown>('/api/capture-engine/status')
    .then((data) => {
      const parsed = parseCaptureEngineStatus(data);
      if (!cancelled && parsed !== null) setCaptureEngine(parsed);
    })
    .catch(() => { /* 失敗は前回値のまま（初回は undefined＝従来表示） */ });
  return () => { cancelled = true; };
}

/**
 * 起動時に1回取得し、`exportDialogOpen` が true になるたびに取り直す（前回値は保つ）。
 * 起動時 fetch があるため、2 回目以降にダイアログを開いた時は初期表示から実値が入る。
 */
export function useCaptureEngineStatus(exportDialogOpen: boolean): CaptureEngineStatus | undefined {
  const [captureEngine, setCaptureEngine] = useState<CaptureEngineStatus | undefined>(undefined);

  // mount 用（deps: []）。ref ガードを持たないため、StrictMode の二重マウントでも
  // それぞれの mount 実行が独立した fetch を発行し、cleanup も自分自身の fetch にしか効かない。
  useEffect(() => fetchAndApply(setCaptureEngine), []);

  // ダイアログを開いた時だけ取り直す（閉じる操作・open のまま維持では再取得しない）。
  useEffect(() => {
    if (!exportDialogOpen) return;
    return fetchAndApply(setCaptureEngine);
  }, [exportDialogOpen]);

  return captureEngine;
}
