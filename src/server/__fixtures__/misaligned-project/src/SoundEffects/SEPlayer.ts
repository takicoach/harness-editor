export type SoundEffect = {
  id: number;
  startFrame: number;
  endFrame?: number;
  file: string;
  volume?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
};
