import { Audio, Sequence, staticFile } from 'remotion';
import { seData } from './seData';

// 式は Harness Editor の src/core/bgmFade.ts（bgmFadeVolume）と一致させる契約。
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
  const lastFrame = durationFrames - 1;
  if (fadeOutFrames > 0 && frameInClip > lastFrame - fadeOutFrames) {
    v *= Math.max(0, (lastFrame - frameInClip) / fadeOutFrames);
  }
  return Math.max(0, Math.min(baseVolume, v));
}

export const SESequence: React.FC = () => {
  return (
    <>
      {seData.map((se) => {
        // endFrame 未指定（旧データ）は従来どおり固定 90。
        const duration = se.endFrame !== undefined ? se.endFrame - se.startFrame : 90;
        if (duration <= 0) return null;
        const base = se.volume ?? 1;
        const fadeIn = se.fadeInFrames ?? 0;
        const fadeOut = se.fadeOutFrames ?? 0;
        const hasFade = fadeIn > 0 || fadeOut > 0;
        return (
          <Sequence key={se.id} from={se.startFrame} durationInFrames={duration}>
            <Audio
              src={staticFile(`se/${se.file}`)}
              volume={(f) => (hasFade ? fadeVolume(f, duration, base, fadeIn, fadeOut) : base)}
            />
          </Sequence>
        );
      })}
    </>
  );
};
