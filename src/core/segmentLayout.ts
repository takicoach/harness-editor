import type { MainLayout, SegmentLayout } from './types';
import { clampRotation, clampLayoutPos, clampLayoutScale } from './mainLayout';
import { sampleMotion, motionProgress } from './motion';
import { sampleAtOriginalFrame, type LayoutKeyframe } from './layoutKeyframes';

/** cutEngine の再生⇄元フレーム変換（キーフレームマーカー UI 等の呼び出し元がここから import できるよう再輸出）。 */
export { playbackToOriginal } from './cutEngine';

/** SegmentLayout を正規化(クランプ)する。 */
function normalizeSegmentLayout(s: SegmentLayout): SegmentLayout {
  return {
    position: { x: clampLayoutPos(s.position.x), y: clampLayoutPos(s.position.y) },
    scale: clampLayoutScale(s.scale),
    rotation: clampRotation(s.rotation),
    flipH: !!s.flipH,
    flipV: !!s.flipV,
    ...(s.motion !== undefined ? { motion: s.motion } : {}),
  };
}

/** 区間 id の実効レイアウト。個別指定があればそれ(背景は全体から)、無ければ全体ベース。 */
export function resolveSegmentLayout(
  base: MainLayout,
  segmentLayouts: Record<number, SegmentLayout>,
  id: number,
): MainLayout {
  const o = segmentLayouts[id];
  if (o === undefined) return base;
  return { ...normalizeSegmentLayout(o), background: base.background };
}

/** 区間レイアウトが全体レイアウトと実質異なるか（clamp 後比較・冗長エントリ判定の単一ソース）。 */
export function segmentDiffersFromBase(base: MainLayout, s: SegmentLayout): boolean {
  return (
    clampLayoutPos(s.position.x) !== base.position.x ||
    clampLayoutPos(s.position.y) !== base.position.y ||
    clampLayoutScale(s.scale) !== base.scale ||
    clampRotation(s.rotation ?? 0) !== (base.rotation ?? 0) ||
    !!s.flipH !== !!base.flipH ||
    !!s.flipV !== !!base.flipV ||
    // motion 付きは常に「全体と異なる」＝冗長エントリ剪定で落とさない。
    s.motion !== undefined
  );
}

/** 全体と「実質異なる」個別指定が 1 つでもあるか(全部が全体と同一なら false=縮退可)。 */
export function hasPerSegmentLayout(
  base: MainLayout,
  segmentLayouts: Record<number, SegmentLayout>,
): boolean {
  return Object.values(segmentLayouts).some((s) => segmentDiffersFromBase(base, s));
}

/** frame が属する区間 id(start<=frame<end)。無ければ null。 */
export function activeSegmentIdAt(
  frame: number,
  ranges: { id: number; start: number; end: number }[],
): number | null {
  for (const r of ranges) {
    if (frame >= r.start && frame < r.end) return r.id;
  }
  return null;
}

/**
 * 現フレームの実効レイアウト。
 * hasOverlap(重なる系トランジションあり)のときは区間指定を無視し全体ベース(Plan 3 まで非対応)。
 * `layoutKeyframes`（大域・原本フレームアンカーの生キーフレーム列）が 2 点以上あれば、
 * カット区間に縛られず全区間をこれで連続補間駆動する（区間ごと個別指定・区間 motion は無視）。
 * それ以外（0〜1 点）は従来どおり: 現フレームの区間の resolveSegmentLayout → 区間 motion。区間外は全体ベース。
 */
export function effectiveLayoutAt(
  frame: number,
  keptSegments: { id: number; originalStart: number; playbackStart: number; playbackEnd: number }[],
  base: MainLayout,
  segmentLayouts: Record<number, SegmentLayout>,
  hasOverlap: boolean,
  layoutKeyframes: LayoutKeyframe[] = [],
): MainLayout {
  if (hasOverlap) return base;

  // 大域キーフレーム優先（2 点以上）: カット区間に縛られず連続補間で駆動する。
  // ただし効くのは「最初のKF〜最後のKF」の範囲内のみ。範囲外まで端のKF値で
  // クランプすると、KFを2点打っただけで動画全体の見た目（全体レイアウト・
  // 区間ごとのアニメ）が乗っ取られてしまうため、範囲外は従来ロジックへ落とす。
  if (layoutKeyframes.length >= 2) {
    const originalFrame = playbackFrameToOriginal(frame, keptSegments);
    const first = layoutKeyframes[0]!.originalFrame;
    const last = layoutKeyframes[layoutKeyframes.length - 1]!.originalFrame;
    if (originalFrame >= first && originalFrame <= last) {
      const s = sampleAtOriginalFrame(layoutKeyframes, originalFrame);
      return {
        ...base,
        position: { x: s.x, y: s.y },
        scale: s.scale,
        rotation: s.rotation,
        // flipH / flipV / background は base（全体）から。大域KFは位置系のみ駆動。
      };
    }
  }

  // 従来: 区間ごと個別指定 → 区間 motion（既存ロジックそのまま）。
  const ranges = keptSegments.map((s) => ({ id: s.id, start: s.playbackStart, end: s.playbackEnd }));
  const id = activeSegmentIdAt(frame, ranges);
  if (id === null) return base;
  const resolved = resolveSegmentLayout(base, segmentLayouts, id);
  const range = ranges.find((r) => r.id === id)!;
  const motion = segmentLayouts[id]?.motion;
  if (motion === undefined) return resolved;
  const sampled = sampleMotion(
    motion,
    { x: resolved.position.x, y: resolved.position.y, scale: resolved.scale, opacity: 1, rotation: resolved.rotation ?? 0 },
    motionProgress(frame, range.start, range.end),
  );
  return { ...resolved, position: { x: sampled.x, y: sampled.y }, scale: sampled.scale, rotation: sampled.rotation };
}

/**
 * 再生（playback）フレームを原本フレームへ写す（keptSegments 基準・区間内は 1:1）。
 * 区間外（先頭前/末尾後/カット済み）は最寄り区間の端でクランプ。
 */
export function playbackFrameToOriginal(
  frame: number,
  keptSegments: { originalStart: number; playbackStart: number; playbackEnd: number }[],
): number {
  if (keptSegments.length === 0) return frame;
  const first = keptSegments[0]!;
  if (frame <= first.playbackStart) return first.originalStart;
  for (const s of keptSegments) {
    if (frame >= s.playbackStart && frame < s.playbackEnd) {
      return s.originalStart + (frame - s.playbackStart);
    }
  }
  const last = keptSegments[keptSegments.length - 1]!;
  return last.originalStart + (last.playbackEnd - last.playbackStart);
}
