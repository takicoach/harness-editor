import React from 'react';
import { Audio, Sequence, staticFile } from 'remotion';
import { bgmData } from './bgmData';
import type { BgmClip } from './types';

/**
 * BGM を区間で再生する。曲が区間より短ければ loop で埋め、長ければ Sequence が区間で切る。
 * 音量はフェードイン/アウトを適用する。
 *
 * 式は Harness Editor の src/core/bgmFade.ts（bgmFadeVolume）と一致させる契約。
 * 同梱部品は独立コピーのため式を埋め込む。
 */
function fadeVolume(
  frameInClip: number,
  durationFrames: number,
  baseVolume: number,
  fadeInFrames: number,
  fadeOutFrames: number,
): number {
  let v = baseVolume;
  if (fadeInFrames > 0 && frameInClip < fadeInFrames) {
    v *= frameInClip / fadeInFrames;
  }
  // フェードアウトは最終描画フレーム（durationFrames-1）で 0 に達する。
  // Remotion がレンダリングするのは 0..durationFrames-1 のフレームのみ。
  const lastFrame = durationFrames - 1;
  if (fadeOutFrames > 0 && frameInClip > lastFrame - fadeOutFrames) {
    v *= Math.max(0, (lastFrame - frameInClip) / fadeOutFrames);
  }
  return Math.max(0, Math.min(baseVolume, v));
}

/**
 * クリップ内フレームのダッキング係数（0..1）。
 * 式は Harness Editor の src/core/ducking.ts（duckFactorAt）と一致させる契約。
 * 同梱部品は独立コピーのため式を埋め込む。
 */
function duckFactor(frameInClip: number, env: BgmClip['ducking']): number {
  if (!env || env.regions.length === 0) return 1;
  let factor = 1;
  for (const region of env.regions) {
    let local: number;
    if (frameInClip >= region.start && frameInClip < region.end) {
      local = env.gain;
    } else if (frameInClip < region.start && frameInClip >= region.start - env.attackFrames) {
      const t = (frameInClip - (region.start - env.attackFrames)) / env.attackFrames;
      local = 1 + (env.gain - 1) * t;
    } else if (frameInClip >= region.end && frameInClip < region.end + env.releaseFrames) {
      const t = (frameInClip - region.end) / env.releaseFrames;
      local = env.gain + (1 - env.gain) * t;
    } else {
      local = 1;
    }
    if (local < factor) factor = local;
  }
  return factor;
}

export const BgmSequence: React.FC = () => {
  return (
    <>
      {bgmData.map((c: BgmClip) => {
        const duration = c.endFrame - c.startFrame;
        if (duration <= 0) return null;
        return (
          <Sequence key={c.id} from={c.startFrame} durationInFrames={duration}>
            <Audio
              src={staticFile(`BGM/${c.file}`)}
              volume={(f) => fadeVolume(f, duration, c.volume, c.fadeInFrames, c.fadeOutFrames) * duckFactor(f, c.ducking)}
              loop
            />
          </Sequence>
        );
      })}
    </>
  );
};
