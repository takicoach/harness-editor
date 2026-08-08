export interface DuckEnvelope {
  regions: Array<{ start: number; end: number }>;
  gain: number;
  attackFrames: number;
  releaseFrames: number;
}

export interface BgmClip {
  id: number;
  file: string;
  startFrame: number;
  endFrame: number;
  volume: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  ducking?: DuckEnvelope;
}
