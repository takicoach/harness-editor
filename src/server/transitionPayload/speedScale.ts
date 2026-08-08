import type { CutSegment, SceneTransition } from './types';

/**
 * 速度スケール（payload ローカル・自己完結＝src/core を import しない）。
 * round(f/rate)・rate===1 恒等。core/speedEngine.speedScale と同一計算
 * （speedScale.test.ts で一致を担保）。
 */
export function speedScaleFrame(frame: number, rate: number): number {
  if (rate === 1) return frame;
  return Math.round(frame / rate);
}

/** 区間の playbackStart/playbackEnd を速度スケール（originalStart/End は不変＝ソースフレーム）。 */
export function scaleSegments(cutData: CutSegment[], rate: number): CutSegment[] {
  if (rate === 1) return cutData;
  return cutData.map((s) => ({
    ...s,
    playbackStart: speedScaleFrame(s.playbackStart, rate),
    playbackEnd: speedScaleFrame(s.playbackEnd, rate),
  }));
}

/** 転換の数値 at と durationFrames を速度スケール（'head'/'tail' の at は据え置き）。 */
export function scaleTransitions(transitions: SceneTransition[], rate: number): SceneTransition[] {
  if (rate === 1) return transitions;
  return transitions.map((t) => ({
    ...t,
    at: typeof t.at === 'number' ? speedScaleFrame(t.at, rate) : t.at,
    durationFrames: speedScaleFrame(t.durationFrames, rate),
  }));
}
