import type { CutSegmentLite, Layout, Motion, MotionState, SegmentLayout } from './types';

const MIN_RATE = 0.1;
const MAX_RATE = 16;

/** core clampMainSpeed 相当（自己完結・非有限は MIN）。speedSegments と同一。 */
function clampRate(r: number): number {
  if (!Number.isFinite(r)) return MIN_RATE;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, r));
}

/** speedScale 相当（round(f/rate)・rate===1 恒等）。speedSegments と同一。 */
function scale(frame: number, rate: number): number {
  if (rate === 1) return frame;
  return Math.round(frame / rate);
}

/** 区間 id の実効 rate（個別指定 ?? 全体）。clamp 済み。 */
function rateFor(seg: CutSegmentLite, mainSpeed: number, segmentSpeeds?: Record<number, number>): number {
  const o = segmentSpeeds?.[seg.id];
  return o === undefined ? clampRate(mainSpeed) : clampRate(o);
}

/** 個別指定が「実質」効いているか（全エントリが clamp 後 mainSpeed と一致なら false）。 */
function hasPerSeg(cutData: CutSegmentLite[], mainSpeed: number, segmentSpeeds?: Record<number, number>): boolean {
  if (!segmentSpeeds) return false;
  return cutData.some((seg) => {
    const o = segmentSpeeds[seg.id];
    return o !== undefined && clampRate(o) !== clampRate(mainSpeed);
  });
}

/** 区間ごとレイアウトの範囲（最終出力フレーム）。 */
export interface LayoutRange {
  id: number;
  start: number;
  end: number;
}

/**
 * 各カット区間の「最終出力フレーム範囲」を返す。
 * speedPayload/speedSegments の from/durationInFrames と同一算術（プレビュー＝書き出し一致をテストでロック）。
 * 個別指定ゼロ: 各境界を独立に scale（uniform・バイト同値）。
 * 個別指定あり: 区間ごとに rate を引き、前区間尺の累積で start を積む。
 */
export function layoutSegmentRanges(
  cutData: CutSegmentLite[],
  mainSpeed: number,
  segmentSpeeds?: Record<number, number>,
): LayoutRange[] {
  if (!hasPerSeg(cutData, mainSpeed, segmentSpeeds)) {
    return cutData.map((seg) => {
      const start = scale(seg.playbackStart, mainSpeed);
      const end = scale(seg.playbackEnd, mainSpeed);
      return { id: seg.id, start, end: Math.max(start + 1, end) };
    });
  }
  let acc = 0;
  return cutData.map((seg) => {
    const rate = rateFor(seg, mainSpeed, segmentSpeeds);
    const start = acc;
    const dur = Math.max(1, Math.round((seg.playbackEnd - seg.playbackStart) / rate));
    acc += dur;
    return { id: seg.id, start, end: start + dur };
  });
}

/** frame が属する区間 id（start<=frame<end）。無ければ null。 */
export function activeLayoutSegmentIdAt(frame: number, ranges: LayoutRange[]): number | null {
  for (const r of ranges) {
    if (frame >= r.start && frame < r.end) return r.id;
  }
  return null;
}

// ── 2点アニメの補間（Harness Editor の core/motion.ts と同式・自己完結） ──

interface MotionFull { x: number; y: number; scale: number; rotation: number }

function mclamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clampMotionFull(s: MotionFull): MotionFull {
  return {
    x: mclamp(s.x, -1.5, 1.5),
    y: mclamp(s.y, -1.5, 1.5),
    scale: mclamp(s.scale, 0.05, 8),
    rotation: mclamp(s.rotation, -360, 360),
  };
}

/** 区間の頭→終わりの進行度で位置/大きさ/回転を補間する（opacity はメイン動画では使わない）。 */
export function sampleLayoutMotion(
  motion: Motion,
  base: MotionFull,
  frame: number,
  rangeStart: number,
  rangeEnd: number,
): MotionFull {
  const k = mclamp(motion.intensity ?? 0.5, 0, 1);
  let from: MotionFull = { ...base };
  let to: MotionFull = { ...base };
  if (motion.preset === 'zoomIn') to = { ...to, scale: base.scale * (1 + 0.8 * k) };
  if (motion.preset === 'zoomOut') from = { ...from, scale: base.scale * (1 + 0.8 * k) };
  if (motion.preset === 'panLeft') { from = { ...from, x: base.x + 0.4 * k }; to = { ...to, x: base.x - 0.4 * k }; }
  if (motion.preset === 'panRight') { from = { ...from, x: base.x - 0.4 * k }; to = { ...to, x: base.x + 0.4 * k }; }
  const apply = (target: MotionFull, o: MotionState | undefined): MotionFull => ({
    x: o?.x ?? target.x,
    y: o?.y ?? target.y,
    scale: o?.scale ?? target.scale,
    rotation: o?.rotation ?? target.rotation,
  });
  from = clampMotionFull(apply(from, motion.from));
  to = clampMotionFull(apply(to, motion.to));
  const span = rangeEnd - rangeStart;
  const p = span <= 0 ? 1 : mclamp((frame - rangeStart) / span, 0, 1);
  const t = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  return clampMotionFull({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    scale: from.scale + (to.scale - from.scale) * t,
    rotation: from.rotation + (to.rotation - from.rotation) * t,
  });
}

// ── 大域キーフレーム（カット非依存・原本フレームアンカー。core/layoutKeyframes.ts と同式・自己完結） ──

/** payload ローカル: 原本フレームアンカーのキーフレーム（core/layoutKeyframes の LayoutKeyframe と同スキーマ）。 */
export interface LayoutKeyframe {
  originalFrame: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

function easeInOutCubic(t: number): number {
  const x = mclamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * KF sample 専用クランプ。core/layoutKeyframes.ts の clampSample と**同レンジ**
 * （x/y [-1,1]・scale [0.1,8]・rotation [-180,180]）。motion 用の clampMotionFull とはレンジが違うため、
 * 手写しコピー流儀（両側同式）を徹底し、範囲外の手編集値でも preview=export のズレを出さない。
 */
function clampKeyframeSample(s: MotionFull): MotionFull {
  return {
    x: mclamp(s.x, -1, 1),
    y: mclamp(s.y, -1, 1),
    scale: mclamp(s.scale, 0.1, 8),
    rotation: mclamp(s.rotation, -180, 180),
  };
}

/** core/layoutKeyframes.ts の sampleAtOriginalFrame と同式（自己完結）。 */
export function sampleKeyframesAtOriginal(keyframes: LayoutKeyframe[], originalFrame: number): MotionFull {
  const ks = keyframes;
  if (ks.length === 0) return { x: 0, y: 0, scale: 1, rotation: 0 };
  const first = ks[0]!;
  const last = ks[ks.length - 1]!;
  if (originalFrame <= first.originalFrame) return clampKeyframeSample(first);
  if (originalFrame >= last.originalFrame) return clampKeyframeSample(last);
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i]!;
    const b = ks[i + 1]!;
    if (originalFrame >= a.originalFrame && originalFrame <= b.originalFrame) {
      const span = b.originalFrame - a.originalFrame;
      const p = span <= 0 ? 1 : (originalFrame - a.originalFrame) / span;
      const t = easeInOutCubic(p);
      return clampKeyframeSample({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        scale: a.scale + (b.scale - a.scale) * t,
        rotation: a.rotation + (b.rotation - a.rotation) * t,
      });
    }
  }
  return clampKeyframeSample(last);
}

/**
 * 現フレームの実効レイアウト。
 * `layoutKeyframes`（大域・原本フレームアンカーの生キーフレーム列）が 2 点以上あれば、
 * カット区間に縛られず全区間をこれで連続補間駆動する（区間ごと個別指定・区間 motion は無視）。
 * それ以外（0〜1 点）は従来どおり: 個別指定があればそれ（背景は base から）、無ければ base。
 * motion 付きの区間は区間の頭→終わりの進行度で補間する（エディタの effectiveLayoutAt と同式）。
 * ハードカット／重なり無しでは各フレームで見える区間は 1 つなので、その transform を部分木全体へ掛けて正しい。
 */
export function effectiveLayoutAtFrame(
  frame: number,
  base: Layout,
  segmentLayouts: Record<number, SegmentLayout>,
  ranges: LayoutRange[],
  cutData: CutSegmentLite[],
  layoutKeyframes: LayoutKeyframe[] = [],
): Layout {
  // 大域キーフレーム優先（2 点以上）。効くのは「最初のKF〜最後のKF」の範囲内のみ
  // （core/segmentLayout.ts effectiveLayoutAt と同ルール）。範囲外は従来ロジックへ。
  if (layoutKeyframes.length >= 2) {
    const originalFrame = finalFrameToOriginal(frame, ranges, cutData);
    const first = layoutKeyframes[0]!.originalFrame;
    const last = layoutKeyframes[layoutKeyframes.length - 1]!.originalFrame;
    if (originalFrame >= first && originalFrame <= last) {
      const s = sampleKeyframesAtOriginal(layoutKeyframes, originalFrame);
      return { ...base, position: { x: s.x, y: s.y }, scale: s.scale, rotation: s.rotation };
      // flipH/flipV/background は base から（Layout をスプレッド）。
    }
  }

  // 従来: 区間ごと個別指定 → 区間 motion（既存ロジックそのまま）。
  const id = activeLayoutSegmentIdAt(frame, ranges);
  if (id === null) return base;
  const o = segmentLayouts[id];
  if (o === undefined) return base;
  const resolved = { ...o, background: base.background };
  const range = ranges.find((r) => r.id === id)!;
  if (o.motion === undefined) return resolved;
  const sampled = sampleLayoutMotion(o.motion, { x: o.position.x, y: o.position.y, scale: o.scale, rotation: o.rotation ?? 0 }, frame, range.start, range.end);
  return { ...resolved, position: { x: sampled.x, y: sampled.y }, scale: sampled.scale, rotation: sampled.rotation };
}

/**
 * 最終出力フレーム → 原本フレーム。
 * 1) frame の属する区間 range を ranges から特定。
 * 2) range 内で最終→再生を線形写像（速度スケールの逆）→ 再生フレーム。
 * 3) 再生 → 原本（区間内 1:1）: originalStart + (playbackFrame - playbackStart)。
 * 区間外は最寄り区間の端でクランプ（sample 側も端クランプするため境界は安全）。
 * speed=1: range==playback ゆえ finalSpan==pbSpan で pbFrame==frame → プレビュー playbackFrameToOriginal と厳密一致。
 */
export function finalFrameToOriginal(frame: number, ranges: LayoutRange[], cutData: CutSegmentLite[]): number {
  if (ranges.length === 0 || cutData.length === 0) return frame;
  const segById = new Map(cutData.map((s) => [s.id, s]));
  const firstRange = ranges[0]!;
  const firstSeg = segById.get(firstRange.id)!;
  if (frame <= firstRange.start) return firstSeg.originalStart;
  for (const range of ranges) {
    if (frame >= range.start && frame < range.end) {
      const seg = segById.get(range.id)!;
      const finalSpan = range.end - range.start;
      const pbSpan = seg.playbackEnd - seg.playbackStart;
      const pbFrame = finalSpan <= 0 ? seg.playbackStart : seg.playbackStart + (frame - range.start) * (pbSpan / finalSpan);
      return seg.originalStart + (pbFrame - seg.playbackStart);
    }
  }
  const lastRange = ranges[ranges.length - 1]!;
  const lastSeg = segById.get(lastRange.id)!;
  return lastSeg.originalStart + (lastSeg.playbackEnd - lastSeg.playbackStart);
}
