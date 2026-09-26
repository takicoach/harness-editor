import { normalizeMainAudioSettings } from '../core/mainAudio';

/** Positions come from the existing completed timeline, after cuts/speed/overlap.
 * This layer converts frame boundaries to sample boundaries; it does not edit order.
 */
export interface MainAudioSegment {
  originalStart: number;
  originalEnd: number;
  finalStart: number;
  durationFrames: number;
  playbackRate: number;
}
export interface MainAudioFilterInput {
  fps: number;
  totalFrames: number;
  segments: readonly MainAudioSegment[];
  settings: unknown;
  hasAudio: boolean;
}
const SAMPLE_RATE = 48_000;
function integer(value: number, label: string, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new Error(`${label} must be a valid frame`);
}
function samples(frame: number, fps: number) {
  const value = Math.round(frame * SAMPLE_RATE / fps);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Audio sample position exceeds the supported range');
  return value;
}
function tempo(rate: number): string[] {
  const filters: string[] = [];
  while (rate > 2) { filters.push('atempo=2'); rate /= 2; }
  while (rate < 0.5) { filters.push('atempo=0.5'); rate *= 2; }
  if (rate !== 1) filters.push(`atempo=${rate}`);
  return filters;
}

/** Self-contained ffmpeg filter for one main-audio stem, keeping all BGM/SE out.
 * Sample delays avoid the millisecond rounding observed in Remotion volume fades.
 * Return a float PCM stem so gain/overlap is not clipped before the final mix.
 */
export function buildMainAudioFilter(input: MainAudioFilterInput): { filter: string; sampleRate: number; totalSamples: number } {
  if (!Number.isFinite(input.fps) || input.fps <= 0 || input.fps > 240) throw new Error('Invalid audio fps');
  integer(input.totalFrames, 'totalFrames', true);
  if (typeof input.hasAudio !== 'boolean') throw new Error('hasAudio must be a boolean');
  if (input.segments.length > 10_000) throw new Error('Too many main audio segments');
  const settings = normalizeMainAudioSettings(input.settings);
  const totalSamples = samples(input.totalFrames, input.fps);
  for (const segment of input.segments) {
    integer(segment.originalStart, 'originalStart'); integer(segment.originalEnd, 'originalEnd', true);
    integer(segment.finalStart, 'finalStart'); integer(segment.durationFrames, 'durationFrames', true);
    if (segment.originalEnd <= segment.originalStart || segment.finalStart + segment.durationFrames > input.totalFrames
      || !Number.isFinite(segment.playbackRate) || segment.playbackRate < 0.1 || segment.playbackRate > 16) {
      throw new Error('Invalid main audio segment');
    }
  }
  if (!input.hasAudio || !input.segments.length || settings.muted) {
    return { filter: `anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=end_sample=${totalSamples}[mainaudio]`, sampleRate: SAMPLE_RATE, totalSamples };
  }
  const segments = input.segments;
  const lines = [`[0:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=${segments.length}${segments.map((_, i) => `[source${i}]`).join('')}`];
  for (const [index, segment] of segments.entries()) {
    const start = samples(segment.finalStart, input.fps);
    const length = samples(segment.finalStart + segment.durationFrames, input.fps) - start;
    const chain = [
      `atrim=start_sample=${samples(segment.originalStart, input.fps)}:end_sample=${samples(segment.originalEnd, input.fps)}`,
      'asetpts=PTS-STARTPTS', ...tempo(segment.playbackRate),
      `apad=whole_len=${length}`, `atrim=end_sample=${length}`,
      `adelay=${start}S:all=1`,
    ];
    lines.push(`[source${index}]${chain.join(',')}[segment${index}]`);
  }
  // A rounded-down boundary can begin one sample before floor(n * fps / rate)
  // advances. Compare the next boundary using the same forward rounding as trim
  // and delay, avoiding a floating-point inverse at half-sample ties.
  const candidate = `floor(n*${input.fps}/${SAMPLE_RATE})`;
  const frame = `min(${input.totalFrames - 1},${candidate}+gte(n,round((${candidate}+1)*${SAMPLE_RATE}/${input.fps})))`;
  const fadeIn = Math.min(settings.fadeInFrames, input.totalFrames);
  const fadeOut = Math.min(settings.fadeOutFrames, input.totalFrames);
  const factor = `${10 ** (settings.gainDb / 20)}*min(${fadeIn ? `min(1,(${frame})/${fadeIn})` : '1'},${fadeOut ? `max(0,min(1,(${input.totalFrames - 1}-(${frame}))/${fadeOut}))` : '1'})`;
  lines.push(`${segments.map((_, i) => `[segment${i}]`).join('')}amix=inputs=${segments.length}:normalize=0:dropout_transition=0,apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples},aeval=exprs='val(0)*(${factor})|val(1)*(${factor})'[mainaudio]`);
  return { filter: lines.join(';\n'), sampleRate: SAMPLE_RATE, totalSamples };
}
