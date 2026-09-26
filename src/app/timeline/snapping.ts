import type { EditorTelop, Transcript } from '../../core/types';
import { type DisplayMap, originalToDisplay } from '../../core/timelineDisplayMap';

/** 吸着対象の種別。 */
export type SnapKind = 'word' | 'telop' | 'playhead' | 'silence';

/** 吸着対象 1 件。frame は原本フレーム。 */
export interface SnapTarget {
  frame: number;
  kind: SnapKind;
  /** 吸着時に表示する日本語ラベル（例「単語境界:「素振り」」）。 */
  label: string;
}

/**
 * 吸着ターゲットの索引（監査 interaction-8）。
 *
 * 以前は pointermove のたびに `collectSnapTargets` がゼロから配列を組み直し、
 * 1 単語につき 4 オブジェクト＋テンプレート文字列を作って捨てていた（14 分・語数の多い
 * 案件では毎フレーム 1 万件規模）。走査も全件線形で、しかも 1 件ごとに
 * `originalToDisplay`（ブロック走査）を呼んでいた。
 *
 * ここでは
 *   - 索引を**フレーム昇順の並列配列**で持つ（オブジェクトを作らない）
 *   - ラベルは**吸着が決まった 1 件だけ**組む（文字列を毎回作らない）
 *   - 探索は二分探索＋しきい値内だけの走査（表示座標は単調増加なので打ち切れる）
 * とする。
 */
export interface SnapIndex {
  /** 原本フレーム（昇順・重複あり）。 */
  readonly frames: Int32Array;
  /** frames と同じ並びの種別コード（KIND_ORDER の添字）。 */
  readonly kinds: Uint8Array;
  /** word のときの単語テキスト（それ以外は空文字）。ラベル生成は吸着後 1 件だけ。 */
  readonly texts: readonly string[];
  /** 件数（frames.length と同じ。ログ・計測用）。 */
  readonly length: number;
}

/** kinds のコード順。同一フレームに複数種が並ぶときの優先順でもある。 */
const KIND_ORDER: SnapKind[] = ['word', 'silence', 'telop', 'playhead'];

/** ms（transcript の時刻）を原本フレームへ変換する（buildWordChips と同じ式）。 */
function msToFrame(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

/**
 * 直前の入力と結果を 1 件だけ覚えるキャッシュ。
 * 呼び出し側（Timeline）の useMemo と二重の保険にする。参照が同じなら同じ索引を返すので、
 * React の依存配列を書き忘れても pointermove ごとの再構築にはならない。
 */
let lastKey: { transcript: Transcript; telops: EditorTelop[]; fps: number } | null = null;
let lastIndex: SnapIndex | null = null;

/**
 * 吸着ターゲットの索引を構築する。
 * - 単語境界: 各 transcript 単語の開始・終了フレーム。
 * - 無音区間端: 隣り合う単語の「終わり」と「次の始まり」が離れているギャップの両端。
 * - テロップ境界: 各 EditorTelop の originalStart / originalEnd。
 *
 * **再生ヘッドは含めない。** ヘッドはドラッグ中の吸着（applySnap → seekToOriginal）で
 * 毎回動くため、索引に混ぜると pointermove ごとに索引が作り直しになる。ヘッドは
 * `snapFrameIndexed` が単独の候補として直接比べる。
 *
 * 同じ入力（参照同値）で呼ぶと同じ索引オブジェクトを返す。
 */
export function buildSnapIndex(
  transcript: Transcript,
  telops: EditorTelop[],
  fps: number,
): SnapIndex {
  if (
    lastIndex !== null &&
    lastKey !== null &&
    lastKey.transcript === transcript &&
    lastKey.telops === telops &&
    lastKey.fps === fps
  ) {
    return lastIndex;
  }

  const words = transcript.words;
  // 上限件数: 単語 ×2 ＋ 無音端 ×2 ＋ テロップ ×2。
  const cap = words.length * 4 + telops.length * 2;
  const frames = new Int32Array(cap);
  const kinds = new Uint8Array(cap);
  const texts: string[] = new Array<string>(cap).fill('');
  let n = 0;

  function push(frame: number, kind: number, text: string): void {
    frames[n] = frame;
    kinds[n] = kind;
    texts[n] = text;
    n++;
  }

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === undefined) continue;
    push(msToFrame(w.start, fps), 0, w.text);
    push(msToFrame(w.end, fps), 0, w.text);
    const next = words[i + 1];
    if (next === undefined) continue;
    const gapStart = msToFrame(w.end, fps);
    const gapEnd = msToFrame(next.start, fps);
    if (gapEnd > gapStart) {
      push(gapStart, 1, '');
      push(gapEnd, 1, '');
    }
  }
  for (const t of telops) {
    push(t.originalStart, 2, '');
    push(t.originalEnd, 2, '');
  }

  // フレーム昇順（同値は種別コード順）に並べ替える。並列配列なので添字の並びを作ってから写す。
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const orderArr = Array.from(order);
  orderArr.sort((a, b) => {
    const fa = frames[a] as number;
    const fb = frames[b] as number;
    if (fa !== fb) return fa - fb;
    return (kinds[a] as number) - (kinds[b] as number);
  });
  const sortedFrames = new Int32Array(n);
  const sortedKinds = new Uint8Array(n);
  const sortedTexts: string[] = new Array<string>(n).fill('');
  for (let i = 0; i < n; i++) {
    const src = orderArr[i] as number;
    sortedFrames[i] = frames[src] as number;
    sortedKinds[i] = kinds[src] as number;
    sortedTexts[i] = texts[src] as string;
  }

  const index: SnapIndex = {
    frames: sortedFrames,
    kinds: sortedKinds,
    texts: sortedTexts,
    length: n,
  };
  lastKey = { transcript, telops, fps };
  lastIndex = index;
  return index;
}

/** テスト用: 1 件キャッシュを捨てる（メモ化の有無を測るとき以外は使わない）。 */
export function resetSnapIndexCache(): void {
  lastKey = null;
  lastIndex = null;
}

/** 索引の i 番目のラベルを組む。**吸着が決まった 1 件にだけ**呼ぶこと。 */
function labelAt(index: SnapIndex, i: number): string {
  const kind = KIND_ORDER[index.kinds[i] as number] ?? 'word';
  if (kind === 'word') return `単語境界:「${index.texts[i] ?? ''}」`;
  if (kind === 'telop') return 'テロップの境界';
  return '無音区間の端';
}

/** frames（昇順）で value 以上が現れる最初の添字（lower bound）。 */
function lowerBound(frames: Int32Array, n: number, value: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((frames[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * rawFrame を、表示座標でしきい値以内にある最寄りのターゲットへ吸着する。
 *
 * 距離は表示座標（map 経由・省略時は原本座標）で測る。`originalToDisplay` は単調増加なので、
 * 二分探索で raw の位置を求め、そこから左右へしきい値を超えるまで歩けば全件走査は不要。
 * 同距離なら**フレームの小さい方**（同フレームなら単語→無音→テロップ→再生ヘッドの順）を選ぶ。
 *
 * @param playheadOriginalFrame 再生ヘッド。索引に入れず毎回 1 件だけ比べる（ヘッドは常に動くため）。
 */
export function snapFrameIndexed(
  rawFrame: number,
  index: SnapIndex,
  thresholdFrames: number,
  map: DisplayMap | undefined,
  playheadOriginalFrame: number | null,
): { frame: number; snapped: SnapTarget | null } {
  const disp = (f: number): number => (map !== undefined ? originalToDisplay(f, map) : f);
  const rawDisplay = disp(rawFrame);
  const { frames, length: n } = index;

  let bestIdx = -1;
  let bestDist = thresholdFrames + 1;

  // 二分探索で raw の位置を求め、しきい値内へ入るところまで左へ戻す。
  let start = lowerBound(frames, n, rawFrame);
  while (start > 0 && rawDisplay - disp(frames[start - 1] as number) <= thresholdFrames) start--;
  // そこから昇順に、表示距離がしきい値を超えたら打ち切る（単調増加なので以降は必ず超える）。
  for (let i = start; i < n; i++) {
    const d = disp(frames[i] as number) - rawDisplay;
    if (d > thresholdFrames) break;
    const dist = Math.abs(d);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  // 再生ヘッド（索引外の単独候補）。同距離では索引側を優先する（従来の並び順と同じ）。
  let headWins = false;
  if (playheadOriginalFrame !== null) {
    const dist = Math.abs(disp(playheadOriginalFrame) - rawDisplay);
    if (dist < bestDist) {
      bestDist = dist;
      headWins = true;
    }
  }

  if (headWins && playheadOriginalFrame !== null) {
    return {
      frame: playheadOriginalFrame,
      snapped: { frame: playheadOriginalFrame, kind: 'playhead', label: '再生ヘッド' },
    };
  }
  if (bestIdx < 0) return { frame: rawFrame, snapped: null };
  const frame = frames[bestIdx] as number;
  return {
    frame,
    snapped: {
      frame,
      kind: KIND_ORDER[index.kinds[bestIdx] as number] ?? 'word',
      label: labelAt(index, bestIdx),
    },
  };
}
