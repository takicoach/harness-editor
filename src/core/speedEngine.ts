/**
 * メイン動画 全体一律の速度（純粋・依存ゼロのリーフ。クライアント import 可）。
 * Plan 1（プレビュー）は Player の fps を ×rate するだけなので clampMainSpeed のみ使う。
 * speedScale/speedUnscale は Plan 2（書き出し）でフレーム座標を再生/最終 ⇄ 速度後へ写すための
 * 集約点として先行定義する（rate===1 は恒等＝後方互換）。
 */
export const MIN_MAIN_SPEED = 0.1;
export const MAX_MAIN_SPEED = 16;
export const DEFAULT_MAIN_SPEED = 1;

export function clampMainSpeed(rate: number): number {
  if (!Number.isFinite(rate)) return MIN_MAIN_SPEED;
  return Math.min(MAX_MAIN_SPEED, Math.max(MIN_MAIN_SPEED, rate));
}

export function speedScale(frame: number, rate: number): number {
  if (rate === 1) return frame;
  return Math.round(frame / rate);
}

export function speedUnscale(frame: number, rate: number): number {
  if (rate === 1) return frame;
  return Math.round(frame * rate);
}

/** 区間ごと速度の 1 区間（start/end は再生座標、rate は実効倍率）。 */
export interface SpeedSegment {
  id: number;
  start: number;
  end: number;
  rate: number;
}

/**
 * 個別速度が「実質」効いているか。
 * 個別指定が無い／全エントリが mainSpeed と一致（冗長）なら false ＝ 一律経路と同値。
 */
export function hasPerSegmentSpeed(
  segmentSpeeds: Record<number, number>,
  mainSpeed: number,
): boolean {
  const base = clampMainSpeed(mainSpeed);
  return Object.values(segmentSpeeds).some((r) => clampMainSpeed(r) !== base);
}

/** 各カット区間に実効速度（個別指定 ?? 全体）を割り当てる。 */
export function resolveSpeedSegments(
  segments: { id: number; playbackStart: number; playbackEnd: number }[],
  mainSpeed: number,
  segmentSpeeds: Record<number, number>,
): SpeedSegment[] {
  const base = clampMainSpeed(mainSpeed);
  return segments.map((s) => {
    const override = segmentSpeeds[s.id];
    const rate = override === undefined ? base : clampMainSpeed(override);
    return { id: s.id, start: s.playbackStart, end: s.playbackEnd, rate };
  });
}

/** 速度後の総フレーム数（各区間 round(len/rate) の合算）。 */
export function speedTotalFrames(segs: SpeedSegment[]): number {
  return segs.reduce((acc, s) => acc + Math.round((s.end - s.start) / s.rate), 0);
}

/** 再生フレーム → 速度後フレーム（区分線形・区間端で丸めて累積）。 */
export function playbackToSpeed(frame: number, segs: SpeedSegment[]): number {
  let offset = 0;
  for (const s of segs) {
    if (frame <= s.start) return offset;
    const segLen = s.end - s.start;
    const segSpeedLen = Math.round(segLen / s.rate);
    if (frame < s.end) return offset + Math.round((frame - s.start) / s.rate);
    offset += segSpeedLen;
  }
  return offset;
}

/** 速度後フレーム → 再生フレーム（playbackToSpeed の逆）。 */
export function speedToPlayback(frame: number, segs: SpeedSegment[]): number {
  let offset = 0;
  for (const s of segs) {
    const segLen = s.end - s.start;
    const segSpeedLen = Math.round(segLen / s.rate);
    if (frame <= offset) return s.start;
    if (frame < offset + segSpeedLen) return s.start + Math.round((frame - offset) * s.rate);
    offset += segSpeedLen;
  }
  return segs.at(-1)?.end ?? 0;
}
