import type { CutSegment } from './types';

/** 速度後の 1 区間（合成上の配置と動画読み出し）。 */
export interface SpeedSeg {
  from: number;
  durationInFrames: number;
  startFrom: number;
  endAt?: number;
  playbackRate?: number;
}

/** speedScale 相当（自己完結・round(f/rate)・rate===1 恒等）。 */
function scale(frame: number, rate: number): number {
  if (rate === 1) return frame;
  return Math.round(frame / rate);
}

const MIN_RATE = 0.1;
const MAX_RATE = 16;
/** core clampMainSpeed 相当（自己完結・非有限は MIN）。 */
function clampRate(r: number): number {
  if (!Number.isFinite(r)) return MIN_RATE;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, r));
}

/** 区間 id の実効 rate（個別指定 ?? 全体）。clamp 済み。 */
function rateFor(seg: CutSegment, mainSpeed: number, segmentSpeeds?: Record<number, number>): number {
  const o = segmentSpeeds?.[seg.id];
  return o === undefined ? clampRate(mainSpeed) : clampRate(o);
}

/** 個別指定が「実質」効いているか（全エントリが clamp 後 mainSpeed と一致なら false）。 */
function hasPerSeg(cutData: CutSegment[], mainSpeed: number, segmentSpeeds?: Record<number, number>): boolean {
  if (!segmentSpeeds) return false;
  return cutData.some((seg) => {
    const o = segmentSpeeds[seg.id];
    return o !== undefined && clampRate(o) !== clampRate(mainSpeed);
  });
}

/**
 * cutData を「カット＋速度」適用後の Sequence 配置情報へ変換する。
 * 個別指定ゼロ: 既存 uniform 経路（各境界を独立に scale・バイト同値）。
 * 個別指定あり: 区間ごとに rate を引き、前区間尺の累積で from を積む（path2 丸め）。
 * rate===1 の区間は endAt あり（等速）、!==1 は playbackRate（endAt 無し＝透明化回避）。
 */
export function speedSegments(
  cutData: CutSegment[],
  mainSpeed: number,
  segmentSpeeds?: Record<number, number>,
): SpeedSeg[] {
  if (!hasPerSeg(cutData, mainSpeed, segmentSpeeds)) {
    // ── uniform（後方互換・現状ロジックを完全保持） ──
    return cutData.map((seg) => {
      const from = scale(seg.playbackStart, mainSpeed);
      const end = scale(seg.playbackEnd, mainSpeed);
      const durationInFrames = Math.max(1, end - from);
      if (mainSpeed === 1) {
        return { from, durationInFrames, startFrom: seg.originalStart, endAt: seg.originalEnd };
      }
      return { from, durationInFrames, startFrom: seg.originalStart, playbackRate: mainSpeed };
    });
  }
  // ── 区間ごと（累積） ──
  let acc = 0;
  return cutData.map((seg) => {
    const rate = rateFor(seg, mainSpeed, segmentSpeeds);
    const from = acc;
    const durationInFrames = Math.max(1, Math.round((seg.playbackEnd - seg.playbackStart) / rate));
    acc += durationInFrames;
    if (rate === 1) {
      return { from, durationInFrames, startFrom: seg.originalStart, endAt: seg.originalEnd };
    }
    return { from, durationInFrames, startFrom: seg.originalStart, playbackRate: rate };
  });
}

/** 合成尺（speedSegments の尺合計・Root の durationInFrames 用）。 */
export function speedCompositionDuration(
  cutData: CutSegment[],
  cutDurationFrames: number,
  mainSpeed: number,
  segmentSpeeds?: Record<number, number>,
): number {
  if (!hasPerSeg(cutData, mainSpeed, segmentSpeeds)) {
    return Math.round(cutDurationFrames / mainSpeed);
  }
  // per-seg は speedSegments に委譲（区間尺の単一情報源＝合成尺と配置が必ず一致）。
  // hasPerSeg の二重評価は cutData 長 O(n) で無視できる。
  return speedSegments(cutData, mainSpeed, segmentSpeeds).reduce((s, x) => s + x.durationInFrames, 0);
}
