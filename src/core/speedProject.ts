import { speedScale, speedUnscale, playbackToSpeed, speedToPlayback } from './speedEngine';
import type { SpeedSegment } from './speedEngine';

/**
 * 要素配列を「速度反映座標（書き出し座標）」⇄「最終座標」へ写す純関数群。
 * 速度の最外段スケール。startFrame/endFrame のみ写し、originalStart/originalEnd・
 * sourceInFrame 等の他フィールドは spread で不変（速度に依らないキー）。
 * rate===1 は同一参照を返す（無回帰＝バイト同値）。
 */
export function scaleStartEnd<T extends { startFrame: number; endFrame: number }>(items: T[], rate: number): T[] {
  if (rate === 1) return items;
  return items.map((it) => ({ ...it, startFrame: speedScale(it.startFrame, rate), endFrame: speedScale(it.endFrame, rate) }));
}
export function unscaleStartEnd<T extends { startFrame: number; endFrame: number }>(items: T[], rate: number): T[] {
  if (rate === 1) return items;
  return items.map((it) => ({ ...it, startFrame: speedUnscale(it.startFrame, rate), endFrame: speedUnscale(it.endFrame, rate) }));
}

/** SE は endFrame 省略可（undefined はそのまま通す）。 */
export function scaleSe<T extends { startFrame: number; endFrame?: number }>(items: T[], rate: number): T[] {
  if (rate === 1) return items;
  return items.map((it) => ({
    ...it,
    startFrame: speedScale(it.startFrame, rate),
    endFrame: it.endFrame !== undefined ? speedScale(it.endFrame, rate) : undefined,
  }));
}
export function unscaleSe<T extends { startFrame: number; endFrame?: number }>(items: T[], rate: number): T[] {
  if (rate === 1) return items;
  return items.map((it) => ({
    ...it,
    startFrame: speedUnscale(it.startFrame, rate),
    endFrame: it.endFrame !== undefined ? speedUnscale(it.endFrame, rate) : undefined,
  }));
}

/** サブ動画は startFrame/endFrame を scale、playbackRate は own×rate（メイン速度に乗算）、sourceInFrame は不変。 */
export function scaleVideoInserts<T extends { startFrame: number; endFrame: number; playbackRate?: number }>(items: T[], rate: number): T[] {
  // rate===1 は同一参照を返す（無回帰＝バイト同値の要）。playbackRate 未指定はそのまま
  // 未指定で通す（serializeInsertVideoData は undefined のとき行を出さない＝既存出力と一致）。
  if (rate === 1) return items;
  return items.map((it) => ({
    ...it,
    startFrame: speedScale(it.startFrame, rate),
    endFrame: speedScale(it.endFrame, rate),
    playbackRate: (it.playbackRate ?? 1) * rate,
  } as T & { playbackRate: number }));
}
export function unscaleVideoInserts<T extends { startFrame: number; endFrame: number; playbackRate?: number }>(items: T[], rate: number): T[] {
  if (rate === 1) return items;
  return items.map((it) => {
    const own = (it.playbackRate ?? rate) / rate; // stored = own*rate → own = stored/rate
    return {
      ...it,
      startFrame: speedUnscale(it.startFrame, rate),
      endFrame: speedUnscale(it.endFrame, rate),
      playbackRate: own === 1 ? undefined : own,
    };
  });
}

// ── 区分線形（per-segment Plan 2）── uniform 群は据え置き ────────────────────

/**
 * 区間内の局所速度（その playback フレームが属する区間の rate）。
 * プレビュー applySpeed の rateAt と同一規則（区間外＝末尾区間の rate）。
 */
export function segmentRateAt(playbackFrame: number, segs: SpeedSegment[]): number {
  for (const s of segs) {
    if (playbackFrame >= s.start && playbackFrame < s.end) return s.rate;
  }
  return segs.at(-1)?.rate ?? 1;
}

/** 要素配列（startFrame/endFrame）を区分線形で書き出し座標へ写す。 */
export function scaleStartEndPiecewise<T extends { startFrame: number; endFrame: number }>(
  items: T[],
  segs: SpeedSegment[],
): T[] {
  return items.map((it) => ({
    ...it,
    startFrame: playbackToSpeed(it.startFrame, segs),
    endFrame: playbackToSpeed(it.endFrame, segs),
  }));
}
export function unscaleStartEndPiecewise<T extends { startFrame: number; endFrame: number }>(
  items: T[],
  segs: SpeedSegment[],
): T[] {
  return items.map((it) => ({
    ...it,
    startFrame: speedToPlayback(it.startFrame, segs),
    endFrame: speedToPlayback(it.endFrame, segs),
  }));
}

/** SE（endFrame 省略可）を区分線形で写す。 */
export function scaleSePiecewise<T extends { startFrame: number; endFrame?: number }>(
  items: T[],
  segs: SpeedSegment[],
): T[] {
  return items.map((it) => ({
    ...it,
    startFrame: playbackToSpeed(it.startFrame, segs),
    endFrame: it.endFrame !== undefined ? playbackToSpeed(it.endFrame, segs) : undefined,
  }));
}
export function unscaleSePiecewise<T extends { startFrame: number; endFrame?: number }>(
  items: T[],
  segs: SpeedSegment[],
): T[] {
  return items.map((it) => ({
    ...it,
    startFrame: speedToPlayback(it.startFrame, segs),
    endFrame: it.endFrame !== undefined ? speedToPlayback(it.endFrame, segs) : undefined,
  }));
}

/**
 * サブ動画を区分線形で写す。playbackRate は own × 開始区間の rate（プレビューと同一）。
 * sourceInFrame は不変。
 */
export function scaleVideoInsertsPiecewise<T extends { startFrame: number; endFrame: number; playbackRate?: number }>(
  items: T[],
  segs: SpeedSegment[],
): T[] {
  return items.map((it) => ({
    ...it,
    startFrame: playbackToSpeed(it.startFrame, segs),
    endFrame: playbackToSpeed(it.endFrame, segs),
    playbackRate: (it.playbackRate ?? 1) * segmentRateAt(it.startFrame, segs),
  } as T & { playbackRate: number }));
}
export function unscaleVideoInsertsPiecewise<T extends { startFrame: number; endFrame: number; playbackRate?: number }>(
  items: T[],
  segs: SpeedSegment[],
): T[] {
  return items.map((it) => {
    const playbackStart = speedToPlayback(it.startFrame, segs);
    const segRate = segmentRateAt(playbackStart, segs);
    const own = (it.playbackRate ?? segRate) / segRate; // stored = own * segRate → own = stored / segRate
    return {
      ...it,
      startFrame: playbackStart,
      endFrame: speedToPlayback(it.endFrame, segs),
      playbackRate: own === 1 ? undefined : own,
    };
  });
}
