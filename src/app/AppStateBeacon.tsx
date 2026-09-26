import { useEffect, useRef, useState } from 'react';

/**
 * AI エージェント（コンピュータユース）向けの画面状態。
 *
 * 画面から読み取れる状態を DOM に 1 か所へ書き出すことで、
 * エージェントが「保存されたか」「書き出しが終わったか」を
 * 見た目の文字列を推測せずに判定できるようにする（AKARI の status 契約に倣う）。
 * キーの並びは固定 — 増やすときは末尾に足し、既存キーの名前と順序は変えない。
 */
export interface AppStateSnapshot {
  /** 開いている案件名。ホーム（未選択）なら null。 */
  project: string | null;
  /** 未保存の編集があるか。 */
  dirty: boolean;
  /** 保存の状態（idle / saving / saved / error など useEditSession の SaveStatus）。 */
  saveStatus: string;
  /** 再生ヘッドの位置（Player のフレーム）。 */
  playheadFrame: number;
  /** 選択中の対象。未選択なら null。 */
  selection: { kind: string; id: string } | null;
  /** 検証の警告（本文）。 */
  warnings: string[];
  /** 書き出しジョブの状態（idle / running / done / error）。 */
  renderStatus: string;
}

/** DOM の id。エージェントはこの id を直接読む。 */
export const APP_STATE_ELEMENT_ID = 'app-state';

/**
 * 固定キー順の JSON へ直す（純関数）。
 *
 * `</script>` を含む文字列（案件名など）で埋め込みが壊れないよう `<` をエスケープする。
 * JSON としての値は変わらない（`<` は `<` と等価）。
 */
export function serializeAppState(s: AppStateSnapshot): string {
  const ordered = {
    project: s.project,
    dirty: s.dirty,
    saveStatus: s.saveStatus,
    playheadFrame: s.playheadFrame,
    selection: s.selection,
    warnings: s.warnings,
    renderStatus: s.renderStatus,
  };
  return JSON.stringify(ordered, null, 2).replace(/</g, '\\u003c');
}

interface AppStateBeaconProps {
  /** 再生ヘッド以外の状態（描画のたびに新しいオブジェクトで渡してよい）。 */
  state: Omit<AppStateSnapshot, 'playheadFrame'>;
  /** 再生ヘッドの現在フレーム取得（Player は React state を持たないため関数で受ける）。 */
  getPlayheadFrame: () => number;
  /** 書き出し間隔（ms）。既定 250ms。 */
  intervalMs?: number;
}

/**
 * 画面状態を hidden な JSON として DOM へ書き出す。
 *
 * 描画のたびに JSON.stringify すると再生中（毎フレーム）に効くので、
 * 250ms 間隔でまとめて作り、内容が変わったときだけ差し替える。
 */
export function AppStateBeacon({ state, getPlayheadFrame, intervalMs = 250 }: AppStateBeaconProps) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const frameRef = useRef(getPlayheadFrame);
  frameRef.current = getPlayheadFrame;

  const [json, setJson] = useState(() =>
    serializeAppState({ ...state, playheadFrame: getPlayheadFrame() }),
  );

  useEffect(() => {
    const tick = (): void => {
      const next = serializeAppState({
        ...stateRef.current,
        playheadFrame: frameRef.current(),
      });
      // 同じ内容なら差し替えない（再描画を起こさない）。
      setJson((prev) => (prev === next ? prev : next));
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return (
    <script
      type="application/json"
      id={APP_STATE_ELEMENT_ID}
      data-testid={APP_STATE_ELEMENT_ID}
      hidden
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}
