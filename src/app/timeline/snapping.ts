import type { EditorTelop, Transcript } from '../../core/types';
import { type DisplayMap, originalToDisplay } from '../../core/timelineDisplayMap';

/** 吸着対象 1 件。frame は原本フレーム。 */
export interface SnapTarget {
  frame: number;
  kind: 'word' | 'telop' | 'playhead' | 'silence';
  /** 吸着時に表示する日本語ラベル（例「単語境界:「素振り」」）。 */
  label: string;
}

/** snapFrame の結果。吸着しなかった場合は target が null。 */
export interface SnapResult {
  frame: number;
  target: SnapTarget | null;
}

/** ms（transcript の時刻）を原本フレームへ変換する（buildWordChips と同じ式）。 */
function msToFrame(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

/**
 * ドラッグ吸着の対象フレーム群を収集する。
 * - 単語境界: 各 transcript 単語の開始・終了フレーム。
 * - テロップ境界: 各 EditorTelop の originalStart / originalEnd。
 * - 再生ヘッド: 現在の再生ヘッドの原本フレーム。
 * - 無音区間端: 隣り合う単語の「終わり」と「次の始まり」が離れているギャップの両端。
 */
export function collectSnapTargets(
  transcript: Transcript,
  telops: EditorTelop[],
  playheadOriginalFrame: number,
  fps: number,
): SnapTarget[] {
  const targets: SnapTarget[] = [];

  // 単語境界。
  for (const w of transcript.words) {
    const start = msToFrame(w.start, fps);
    const end = msToFrame(w.end, fps);
    targets.push({ frame: start, kind: 'word', label: `単語境界:「${w.text}」` });
    targets.push({ frame: end, kind: 'word', label: `単語境界:「${w.text}」` });
  }

  // 無音区間端（単語間ギャップ）。words は時刻昇順を前提に隣接ペアを見る。
  for (let i = 0; i < transcript.words.length - 1; i++) {
    const cur = transcript.words[i];
    const next = transcript.words[i + 1];
    if (cur === undefined || next === undefined) continue;
    const gapStart = msToFrame(cur.end, fps);
    const gapEnd = msToFrame(next.start, fps);
    if (gapEnd > gapStart) {
      targets.push({ frame: gapStart, kind: 'silence', label: '無音区間の始まり' });
      targets.push({ frame: gapEnd, kind: 'silence', label: '無音区間の終わり' });
    }
  }

  // テロップ境界。
  for (const t of telops) {
    targets.push({ frame: t.originalStart, kind: 'telop', label: 'テロップの先頭' });
    targets.push({ frame: t.originalEnd, kind: 'telop', label: 'テロップの末尾' });
  }

  // 再生ヘッド。
  targets.push({
    frame: playheadOriginalFrame,
    kind: 'playhead',
    label: '再生ヘッド',
  });

  // TODO(Milestone D): 同一フレームに複数ターゲットが重複しうる（連続単語の境界等）。
  // ツールチップの優先ラベル選択は Milestone D で検討する。
  return targets;
}

/**
 * frame を、thresholdFrames 以内にあるターゲットのうち最も近いものへ吸着する。
 * 同距離なら配列の先に出たターゲットを優先する。吸着しなければ frame をそのまま返す。
 */
export function snapFrame(
  frame: number,
  targets: SnapTarget[],
  thresholdFrames: number,
): SnapResult {
  let best: SnapTarget | null = null;
  let bestDist = thresholdFrames + 1;
  for (const t of targets) {
    const dist = Math.abs(t.frame - frame);
    if (dist <= thresholdFrames && dist < bestDist) {
      best = t;
      bestDist = dist;
    }
  }
  return best ? { frame: best.frame, target: best } : { frame, target: null };
}

/**
 * 表示座標で距離を測りながら吸着する、DisplayMap 対応版。
 * map が undefined（identity）の場合は原本フレームで距離を測り、snapFrame と同一結果を返す。
 * 返り値の snapped は吸着しなかった場合 null。
 */
export function snapFrameMapped(
  rawFrame: number,
  targets: SnapTarget[],
  thresholdFrames: number,
  map?: DisplayMap,
): { frame: number; snapped: SnapTarget | null } {
  const rawDisplay = map !== undefined ? originalToDisplay(rawFrame, map) : rawFrame;
  let best: SnapTarget | null = null;
  let bestDist = thresholdFrames + 1;
  for (const t of targets) {
    const dist = Math.abs((map !== undefined ? originalToDisplay(t.frame, map) : t.frame) - rawDisplay);
    if (dist <= thresholdFrames && dist < bestDist) {
      best = t;
      bestDist = dist;
    }
  }
  return { frame: best !== null ? best.frame : rawFrame, snapped: best };
}
