import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { EditorPlaybackRef as PlayerRef } from './editorPlayback';
import type { Rect } from './overlayGeometry';
import { findMeasureItem, findMeasureRoot, measureItemRect } from './measureBox';
import type { LegacyMeasurementReader } from '../../preview/native/legacyMeasurement';
import { nativeMeasurementRect } from './nativeMeasurements';

/** 実測できる対象種別（mainVideo / cutSegment は全画面＝実描画そのものなので対象外）。 */
export type MeasuredKind = 'telop' | 'image' | 'videoInsert';

/** 枠の出所。e2e はここを見て「実測が効いている」ことをアサートする。 */
export type BoxSource = 'measured' | 'fallback';

export interface MeasuredBox {
  /** 実測枠（stage ローカル座標）。null なら呼び出し側が従来式へフォールバックする。 */
  rect: Rect | null;
  source: BoxSource;
}

export interface UseMeasuredBoxParams {
  /** overlay root（`.pv-overlay`）の ref。座標原点と探索スコープの起点に使う。 */
  rootRef: RefObject<HTMLElement | null>;
  /** 測定対象の種別（null なら測定しない）。 */
  kind: MeasuredKind | null;
  /** 測定対象の ID（null なら測定しない）。 */
  id: number | null;
  /** 現在フレーム購読用（選択対象のみ・rAF 集約で再測する）。 */
  playerRef: RefObject<PlayerRef | null>;
  readNativeMeasurement?: LegacyMeasurementReader;
}

/** 2 つの矩形が同値か（量子化済みの値どうしなので厳密比較で足りる）。 */
function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * 選択中アイテムの実描画矩形を測り続けるフック（設計書 §1）。
 *
 * - 探索は overlay root の**親（= pv-stage）配下の `[data-sme-root]` 起点**に限定する
 *   （document 全域を見ない＝複数 Player・再マウント過渡での誤爆防止）
 * - 再測契機: 各描画後（layout effect）／player `frameupdate`（選択対象のみ・rAF 集約）／
 *   対象要素と stage の ResizeObserver ／対象内 `img` load・`video` loadedmetadata ／
 *   `document.fonts` の `loadingdone`。**MutationObserver は使わない**（裁定 P1-4）
 * - 一時的な実測失敗（測定ルート不在・中身がまだ描かれていない＝ロード中）は
 *   **直前の有効実測値を保持**し、従来式への即時ジャンプを避ける。
 *   対象（kind/id）が変わったとき、および**対象ラッパーごと無い（現在フレームで非表示）**
 *   ときは保持値を破棄して従来式へ戻す（古い位置に枠を残さない）
 * - **ドラッグ中も測定を続ける**（レビュー P1-1）。移動量の基準は `DragBase` の snapshot で
 *   既に凍結されているため、表示まで凍結すると枠とハンドルが掴んだ位置に置き去りになるだけで
 *   利得がない。発振は 0.5px 量子化と同値比較で抑える
 * - 失敗の warn は復旧しない異常（対象ラッパー不在・例外）に限る。測定ルート不在・
 *   中身が未描画（ロード中）は通常運用で起きる過渡なので黙って保持する
 */
export function useMeasuredBox({
  rootRef,
  kind,
  id,
  playerRef,
  readNativeMeasurement,
}: UseMeasuredBoxParams): MeasuredBox {
  const [rect, setRect] = useState<Rect | null>(null);
  /** 現在保持している実測値の対象キー（対象が変わったら破棄する）。 */
  const keyRef = useRef<string | null>(null);
  /** kind＋原因ごとに 1 回だけ warn する。 */
  const warnedRef = useRef<Set<string>>(new Set());
  const rafRef = useRef<number | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  /** ResizeObserver / メディアイベントを張っている対象要素。 */
  const observedRef = useRef<Element | null>(null);
  const mediaRef = useRef<{ el: Element; type: string; fn: () => void }[]>([]);

  const key = kind === null || id === null ? null : `${kind}:${id}`;

  /**
   * 復旧しない異常だけを 1 回警告する（kind＋原因単位・レビュー P3-1）。
   * 測定ルート不在（Player 再マウント過渡）と中身が未描画（ロード中）は**通常運用の過渡**なので
   * 鳴らさない — 正常時に鳴る警告は、本当の異常が来たときに無視される。
   */
  const warnOnce = useCallback((reason: string): void => {
    const k = `${kind ?? '-'}:${reason}`;
    if (warnedRef.current.has(k)) return;
    warnedRef.current.add(k);
    console.warn(
      `[measured-overlay] 実測できないため従来式の枠で表示します (${k})` +
        (reason === 'item' ? ' ※対象が現在フレームで非表示のときは正常' : ''),
    );
  }, [kind]);

  /** 対象要素へ張った ResizeObserver とメディアイベントを外す（ref のみ触る）。 */
  const detachObservers = useCallback((): void => {
    roRef.current?.disconnect();
    roRef.current = null;
    for (const m of mediaRef.current) m.el.removeEventListener(m.type, m.fn);
    mediaRef.current = [];
    observedRef.current = null;
  }, []);

  /** 対象要素へ ResizeObserver とメディアイベントを張り替える。 */
  const attachObservers = useCallback((el: Element, onChange: () => void): void => {
    if (observedRef.current === el) return;
    detachObservers();
    observedRef.current = el;
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => onChange());
      ro.observe(el);
      roRef.current = ro;
    }
    const bind = (nodes: Element[], type: string): void => {
      for (const n of nodes) {
        const fn = (): void => onChange();
        n.addEventListener(type, fn);
        mediaRef.current.push({ el: n, type, fn });
      }
    };
    bind(Array.from(el.querySelectorAll('img')), 'load');
    bind(Array.from(el.querySelectorAll('video')), 'loadedmetadata');
  }, [detachObservers]);

  /** 実測を 1 回行う（同値なら state を更新しない）。 */
  const measure = useCallback((): void => {
    const overlay = rootRef.current;
    if (kind === null || id === null || overlay === null) return;
    try {
      if (readNativeMeasurement) {
        detachObservers();
        const snapshot=readNativeMeasurement(kind,id),item=snapshot?.items.find(value=>value.kind===kind&&value.id===id);
        const next=snapshot&&item?nativeMeasurementRect(snapshot,item,overlay.getBoundingClientRect()):null;
        setRect(prev=>sameRect(prev,next)?prev:next);
        return;
      }
      // overlay（.pv-overlay）の親＝ .pv-stage。Player の描画はこの中にある。
      const scope = overlay.parentElement ?? overlay;
      const root = findMeasureRoot(scope);
      // 測定ルート不在は Player 再マウントの過渡。直前の実測値を保持して黙って待つ。
      if (root === null) return;
      const item = findMeasureItem(root, kind, id);
      if (item === null) {
        // ラッパーごと無い＝現在フレームで描かれていない（表示状態が変わった）。
        // これは過渡ではないので**保持値を破棄**して従来式へ戻す（古い枠を残さない）。
        warnOnce('item');
        detachObservers();
        setRect((prev) => (prev === null ? prev : null));
        return;
      }
      // **測定の成否より先に**再測イベントを張る（レビュー P2-1）。
      // 未ロードの img は寸法ゼロ＝測定不能だが、そこで配線を諦めると load が来ても
      // 誰も測り直さず永久にフォールバックのままになる。
      attachObservers(item, () => scheduleRef.current());
      const next = measureItemRect(item, {
        frame: root.getBoundingClientRect(),
        origin: overlay.getBoundingClientRect(),
      });
      if (next === null) return;
      setRect((prev) => (sameRect(prev, next) ? prev : next));
    } catch {
      warnOnce('exception');
    }
  }, [attachObservers, detachObservers, id, kind, rootRef, warnOnce, readNativeMeasurement]);

  /** rAF で集約した再測（連続イベントで測定が積み上がらないようにする）。 */
  const schedule = useCallback((): void => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      measureRef.current();
    });
  }, []);

  // 最新の measure / schedule をイベントリスナから呼ぶための ref。
  const measureRef = useRef(measure);
  const scheduleRef = useRef(schedule);
  measureRef.current = measure;
  scheduleRef.current = schedule;

  // 対象が変わったら保持していた実測値を破棄する（別対象の枠を使い回さない）。
  // 描画中の state 調整（React の「props 変化に合わせて state を直す」定石）。
  if (keyRef.current !== key) {
    keyRef.current = key;
    if (rect !== null) setRect(null);
  }

  // 対象が変わったら observer を張り替える。**measure の layout effect より前に宣言する**
  // （後ろに置くと、直前に張ったばかりの observer を外してしまう）。
  useLayoutEffect(() => {
    detachObservers();
  }, [key, detachObservers]);

  // 各描画後に実測する（React 再描画がそのまま再測契機になる）。
  useLayoutEffect(() => {
    measureRef.current();
  });

  // player のフレーム更新（選択対象 1 件のみ・rAF 集約）。
  useEffect(() => {
    if (kind === null || id === null) return;
    const player = playerRef.current;
    if (!player) return;
    const onFrame = (): void => scheduleRef.current();
    player.addEventListener('frameupdate', onFrame);
    return () => player.removeEventListener('frameupdate', onFrame);
  }, [playerRef, kind, id]);

  // stage のリサイズ（レターボックス変化）とフォント読み込み完了。
  useEffect(() => {
    const overlay = rootRef.current;
    const onChange = (): void => scheduleRef.current();
    let ro: ResizeObserver | null = null;
    if (overlay !== null && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onChange);
      ro.observe(overlay);
    }
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.addEventListener?.('loadingdone', onChange);
    return () => {
      ro?.disconnect();
      fonts?.removeEventListener?.('loadingdone', onChange);
    };
  }, [rootRef]);

  // アンマウント時の後片付け（rAF・observer・メディアイベント）。
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      detachObservers();
    };
  }, [detachObservers]);

  return { rect, source: rect === null ? 'fallback' : 'measured' };
}
