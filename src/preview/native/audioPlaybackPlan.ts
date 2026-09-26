import type { ScenePlan } from '../../core/sequence/scenePlan';
import { multiplyTime, rationalFromDecimal } from '../../core/sequence/time';
import type { AudioMixPlan } from './audioMixer';

/** 監視用の再生速度。0.5 は Shift+J/L のスロー（無音）。16 以上はデコーダ未検証のため許可しない。 */
export const MONITOR_RATES = [0.5, 1, 2, 4, 8] as const;

export function validatePlaybackRate(rate: number): void {
  if (!MONITOR_RATES.includes(Math.abs(rate) as (typeof MONITOR_RATES)[number])) throw new Error('再生確認の速度は正逆 0.5・1・2・4・8 倍に対応しています');
}

/** JKL is a monitor clock, not a saved edit. Positive shuttle uses source PCM
 * stretched to content.rate × shuttle by the existing pitch-preserving decoder.
 * Gain/fade/ducking still evaluate on the original canonical frame. Reverse
 * shuttles are silent, matching the old player's non-positive media rate.
 * Slow shuttles (|rate| < 1) are silent too: the decoder's pitch-preserving stretch is only validated at 1x and above. */
export function audioPlaybackPlan(plan: ScenePlan, rate: number): AudioMixPlan {
  validatePlaybackRate(rate);
  if (rate === 1) return plan;
  const magnitude = rationalFromDecimal(Math.abs(rate));
  const originals = new Map(plan.audibleClips.map(clip => [clip.id, clip]));
  return {
    document: { fps: multiplyTime(plan.document.fps, magnitude), sequenceEndFrame: plan.document.sequenceEndFrame },
    audibleClips: rate < 1 ? [] : plan.audibleClips.map(clip => ({
      ...clip,
      content: clip.content.kind === 'audio' ? { ...clip.content, rate: multiplyTime(clip.content.rate, magnitude) } : clip.content,
      ...(clip.insertOwnSpeed ? { insertOwnSpeed: { ...clip.insertOwnSpeed, rate: multiplyTime(clip.insertOwnSpeed.rate, magnitude) } } : {}),
    })),
    audioGain: (clip, frame) => {
      const original = originals.get(clip.id);
      if (!original) throw new Error('再生確認の音声クリップが一致しません');
      return plan.audioGain(original, frame);
    },
  };
}
