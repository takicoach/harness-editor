import type { MediaStream } from '../../../core/sequence/model';
import { rational, type Rational } from '../../../core/sequence/time';

const DEFAULT_FPS: Rational = { num: 30, den: 1 };
export function streamFps(stream: MediaStream): Rational { return stream.frameRate ?? DEFAULT_FPS; }
/** 最後のコマの中央が長さの内側に収まる数（検証の「コマの時刻が動画の外」に当たらない）。 */
export function frameCountOf(stream: MediaStream): number {
  const fps = streamFps(stream);
  return Math.max(1, Math.floor(stream.duration.num * fps.num / (stream.duration.den * fps.den)));
}
export function frameTime(frame: number, fps: Rational): number { return (frame + .5) * fps.den / fps.num; }
export function sourceTimeOf(frame: number, fps: Rational): Rational { return rational((2 * frame + 1) * fps.den, 2 * fps.num); }
export function formatFrameTime(frame: number, fps: Rational): string {
  const perSecond = Math.max(1, Math.round(fps.num / fps.den)), seconds = Math.floor(frame / perSecond);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}.${pad(frame % perSecond)}`;
}
