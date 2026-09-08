import { useCallback, useEffect, useRef, useState } from 'react';
import { xToFrameMapped, CLICK_MOVE_THRESHOLD_PX } from './timelineGeometry';
import type { DisplayMap } from '../../core/timelineDisplayMap';

/** ドラッグ中の状態。drag 中でなければ null。 */
export interface DragState<H> {
  /** ドラッグ対象のつまみ識別子（呼び出し側が定義する型）。 */
  handle: H;
  /** 現在ドラッグ中の原本フレーム（吸着後）。 */
  frame: number;
  /**
   * しきい値を超えて動いた＝**ドラッグとして確定した**か。純クリックの間は false。
   * 端ドラッグ自動スクロールのように「ドラッグ確定後だけ働かせたい」機能のゲートに使う
   * （pointerdown 直後から効かせると、端ゾーンでブロックをクリックしただけで動いてしまう）。
   */
  moved: boolean;
}

interface UseTimelineDragOptions<H> {
  /** トラックの「原本フレーム 0」に対応する画面 X 座標を返す。pointermove ごとに呼ぶ。 */
  getTrackOriginX: () => number;
  /** 現在のズーム（1 フレームあたりピクセル数）。 */
  pxPerFrame: number;
  /** 表示マップ（per-segment 速度有効時）。省略時は恒等（xToFrame と同一）。 */
  map?: DisplayMap;
  /** ドラッグ移動のたびに呼ばれる。返り値が「確定する原本フレーム」（吸着適用済み）。 */
  onDrag: (handle: H, rawFrame: number) => number;
  /** pointerup で呼ばれる。最終フレームで状態をコミットする（pointercancel では呼ばれない）。 */
  onCommit: (handle: H, finalFrame: number) => void;
  /**
   * 「純クリック」（pointerdown から pointerup までポインタが CLICK_MOVE_THRESHOLD_PX を
   * 超えて動かなかった）で呼ばれる。
   *
   * 指定した場合、そのとき **onCommit は呼ばれない**。ブロックのクリックは「選択」であって
   * 編集ではないため、コミットすると (1) 空の Undo 履歴が積まれる (2) 吸着 ON では
   * beginDrag の `applySnap(originFrame)` が掴んだ端を吸着先へ寄せてしまい、
   * 動かしていないブロックが黙って移動する、という 2 つの副作用が出る。
   * 後片付け（吸着ガイドの消去など）だけをここで行うこと。
   *
   * 未指定なら従来どおり onCommit が呼ばれる。範囲選択のように「クリック自体が
   * 意味を持つ（選択解除・頭出し）」用途はこちら。
   */
  onClick?: (handle: H) => void;
  /**
   * ドラッグ開始からの「**自前の**自動スクロール量」の累積 px（右方向＝正）。
   *
   * 端ドラッグ自動スクロール（edge-autoscroll）はポインタが静止していてもコンテンツを
   * 動かす＝つまみは進む。クリック/ドラッグ判定はその分を足した「実際に動かした量」で
   * 行う必要がある（足さないと、送っている最中に離した操作が純クリック扱いになり
   * 確定が黙って捨てられる）。
   *
   * **数えるのは自動スクロールが足した量だけ**。トラック原点の移動量を使うと、ズーム・
   * サブパネルの開閉・再生追従スクロールのような「ユーザーが動かしていない」原点移動まで
   * 移動量に化けてクリックがドラッグに化ける。未指定なら 0＝画面 X の差だけで判定（従来式）。
   */
  getAutoScrollDx?: () => number;
  /**
   * ドラッグの**取り消し**（監査 interaction-3）。
   *
   * 以前は `pointerup` と `pointercancel` を同じ `onUp` に繋いでいたため、ブラウザ／OS が
   * ジェスチャを打ち切っても「その時点の位置」で確定していた。掴んだ後に「やっぱりやめる」
   * 経路も無かった。ここは
   *   - pointercancel（割り込み）
   *   - ドラッグ中の Escape
   * の 2 つから呼ばれ、**コミットせずに** ドラッグ前の状態へ戻す責任を持つ。
   * 未指定なら「何も確定せずドラッグを終える」だけ（ライブ表示は setDrag(null) で消える）。
   */
  onCancel?: (handle: H) => void;
}

interface UseTimelineDragResult<H> {
  /** 現在のドラッグ状態（描画用）。 */
  drag: DragState<H> | null;
  /**
   * つまみの onPointerDown から呼ぶ。ドラッグを開始する。
   * @param originFrame 掴んだつまみの元の原本フレーム。デルタ方式の基準に使う。
   */
  beginDrag: (handle: H, e: React.PointerEvent, originFrame: number) => void;
}

/**
 * タイムラインのつまみドラッグを管理する汎用フック。
 * window へ pointermove / pointerup / pointercancel / keydown(Escape) を貼り、終了時に必ず外す。
 */
export function useTimelineDrag<H>({
  getTrackOriginX,
  pxPerFrame,
  map,
  onDrag,
  onCommit,
  onClick,
  getAutoScrollDx,
  onCancel,
}: UseTimelineDragOptions<H>): UseTimelineDragResult<H> {
  const [drag, setDrag] = useState<DragState<H> | null>(null);
  // 最新のコールバック・値を ref で持ち、リスナを貼り直さずに済むようにする。
  const stateRef = useRef({ getTrackOriginX, pxPerFrame, map, onDrag, onCommit, onClick, getAutoScrollDx, onCancel });
  stateRef.current = { getTrackOriginX, pxPerFrame, map, onDrag, onCommit, onClick, getAutoScrollDx, onCancel };
  // ドラッグ中の最新フレームを ref に保持（pointerup でコミットに使う）。
  const dragRef = useRef<DragState<H> | null>(null);
  dragRef.current = drag;
  // デルタ方式用: 掴んだ時点の「ポインタフレーム」「つまみの元フレーム」「画面 X」
  // 「トラック原点の画面 X」を保持。
  const grabRef = useRef<{ grabPointerFrame: number; originFrame: number; grabClientX: number } | null>(null);
  // 掴んだ位置から CLICK_MOVE_THRESHOLD_PX を超えて動いたか（＝ドラッグか）。
  //
  // 契約: **px のまま測る**（2026-08-17 規約）。吸着後のフレーム値で比べると、掴んだ端が
  // 吸着点の近くにあるとき実際に動かしても値が変わらず「動いていない」と誤判定し、吸着 ON の
  // 小ドラッグがコミットされずライブ表示から巻き戻る。逆にズームアウト時（pxPerFrame<1）は
  // 1px の揺れが数フレーム差になりクリックがドラッグに化ける。
  //
  // 測る量は「画面 X の移動」＋「**自前の**自動スクロールが足した量」（getAutoScrollDx）。
  // 端ドラッグ自動スクロール中はポインタが止まったままコンテンツが動くので、画面 X だけだと
  // 送っている最中に離した操作が純クリック扱いになり確定が捨てられる。逆に「トラック原点の
  // 移動量」で測ると、ズーム・サブパネル開閉・再生追従のような**ユーザー起因でない**原点移動まで
  // 拾ってクリックがドラッグに化ける。自動スクロールが無い間は加算 0＝従来式と同値。
  // 一度でも閾値を超えたら、最後に元の位置へ戻ってもドラッグ扱いのまま。
  const movedRef = useRef(false);

  const beginDrag = useCallback((handle: H, e: React.PointerEvent, originFrame: number) => {
    e.preventDefault();
    e.stopPropagation();
    const { getTrackOriginX: originX, pxPerFrame: ppf, map: m, onDrag: drag0 } = stateRef.current;
    const grabPointerFrame = xToFrameMapped(e.clientX - originX(), ppf, m);
    grabRef.current = { grabPointerFrame, originFrame, grabClientX: e.clientX };
    // beginDrag 時点では delta === 0 なので rawFrame === originFrame（ジャンプなし）。
    const snapped = drag0(handle, originFrame);
    movedRef.current = false;
    setDrag({ handle, frame: snapped, moved: false });
  }, []);

  useEffect(() => {
    if (drag === null) return;

    function onMove(e: PointerEvent): void {
      const { getTrackOriginX: originX, pxPerFrame: ppf, map: m, onDrag: drag0, getAutoScrollDx: autoDx } = stateRef.current;
      const current = dragRef.current;
      if (current === null) return;
      const grab = grabRef.current;
      if (grab === null) return;
      const currentPointerFrame = xToFrameMapped(e.clientX - originX(), ppf, m);
      const rawFrame = grab.originFrame + (currentPointerFrame - grab.grabPointerFrame);
      // 画面 X の移動 ＋ 自前の自動スクロールが足した量。自動スクロールが無ければ従来式と同値。
      const movedPx = (e.clientX - grab.grabClientX) + (autoDx?.() ?? 0);
      if (Math.abs(movedPx) > CLICK_MOVE_THRESHOLD_PX) movedRef.current = true;
      const snapped = drag0(current.handle, rawFrame);
      setDrag({ handle: current.handle, frame: snapped, moved: movedRef.current });
    }

    function onUp(): void {
      const current = dragRef.current;
      if (current !== null) {
        const { onCommit: commit, onClick: click } = stateRef.current;
        // しきい値以下しか動いていない純クリックで onClick があれば、コミットせず選択のみで終える。
        if (!movedRef.current && click !== undefined) {
          click(current.handle);
        } else {
          commit(current.handle, current.frame);
        }
      }
      setDrag(null);
    }

    // 取り消し（確定しない）。pointercancel と Escape の共通出口。
    function onCancelDrag(): void {
      const current = dragRef.current;
      if (current !== null) stateRef.current.onCancel?.(current.handle);
      setDrag(null);
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      // ドラッグ中の Escape は「このドラッグをやめる」。他の Escape 購読
      // （カット選択の解除・モーダル閉じ）へ流さない。
      e.preventDefault();
      e.stopPropagation();
      onCancelDrag();
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancelDrag);
    // capture 相で拾う（先に走る他の Escape ハンドラに横取りさせない）。
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancelDrag);
      window.removeEventListener('keydown', onKeyDown, true);
    };
    // drag が null↔非null に変わったときだけリスナを貼り直す。
  }, [drag === null]);

  return { drag, beginDrag };
}
