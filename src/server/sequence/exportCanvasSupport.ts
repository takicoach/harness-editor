/** The canvas engine's fixed choices (HTML in Canvas + the browser's VideoEncoder, exportCanvas.ts): where it may run,
 * the H.264 level, the constant-quality values and FFmpeg's muxing arguments. Pure, so each is checked on its own. */
import type { NativeExportSettings } from '../../shared/nativeExport';
import type { RenderQuality } from '../../shared/renderPreset';

/** AVC QP per quality (constant quality, like the screenshot path's x264 CRF), chosen so the file is about the size of
 * the screenshot path's at the same quality. Measured on 10 minutes of real footage through the product path
 * (2026-11-10, 1920×1080 30000/1001; screenshot path → canvas): high 526 → 576 MB, standard 165 → 166 MB,
 * light 135 → 146 MB. One QP step is about 15% of the size (27: 234 MB, 28: 198 MB). At the same size the hardware
 * encoder is about 1 dB below x264 at standard and light (mean PSNR against the high export 42.4 vs 43.6, 42.0 vs 43.0). */
export const CANVAS_QUANTIZER: Readonly<Record<RenderQuality, number>> = Object.freeze({ high: 22, standard: 29, light: 30 });
/** A key frame, and a hand-over of the encoded bytes to FFmpeg, every this many frames. */
export const CANVAS_KEY_FRAME_INTERVAL = 60;

/** null = the settings can run here. A string = why not (shown to the user). The screenshot path has no conditions. */
export function canvasExportUnavailable(settings: NativeExportSettings, machine: { platform: NodeJS.Platform; arch: string } = { platform: process.platform, arch: process.arch }): string | null {
  if (settings.engine !== 'canvas') return null;
  // Only Apple silicon carries Chrome 157 (HTML in Canvas); the other machines keep 148.
  if (machine.platform !== 'darwin' || machine.arch !== 'arm64') return '速い書き出しは Apple シリコンの Mac でだけ使えます';
  // The canvas is the drawing page at its own size; scaling it is not built (every real export so far was full/high).
  if (settings.resolution !== 'full') return '速い書き出しは解像度「そのまま」の時だけ使えます';
  return null;
}

/** H.264 Table A-1: level_idc, MaxMBPS (macroblocks per second), MaxFS (macroblocks per frame). 3.1 is the floor. */
const AVC_LEVELS: ReadonlyArray<readonly [number, number, number]> = [
  [31, 108_000, 3_600], [32, 216_000, 5_120], [40, 245_760, 8_192], [41, 245_760, 8_192], [42, 522_240, 8_704],
  [50, 589_824, 22_080], [51, 983_040, 36_864], [52, 2_073_600, 36_864], [60, 4_177_920, 139_264], [61, 8_355_840, 139_264], [62, 16_711_680, 139_264],
];
/** High profile ('avc1.6400' + the level in two hex digits) at the lowest level whose frame size, frame side
 * (each side at most sqrt(8 × MaxFS) macroblocks) and macroblock rate hold the stream. */
export function avcCodec(resolution: { width: number; height: number }, fps: { num: number; den: number }): string {
  const across = Math.ceil(resolution.width / 16), down = Math.ceil(resolution.height / 16), frame = across * down;
  for (const [level, maxRate, maxFrame] of AVC_LEVELS) {
    // frame × num/den ≤ maxRate, in integers.
    if (frame <= maxFrame && across * across <= 8 * maxFrame && down * down <= 8 * maxFrame && frame * fps.num <= maxRate * fps.den)
      return `avc1.6400${level.toString(16).padStart(2, '0')}`;
  }
  throw new Error(`速い書き出しは ${resolution.width}×${resolution.height}・${fps.num}/${fps.den} fps を扱えません（H.264 の水準の上限を超えています）`);
}

/** The VideoEncoder configuration plus the per-frame QP (encode(frame, {avc: {quantizer}})). */
export interface CanvasEncoderConfig {
  codec: string; width: number; height: number; framerate: number; bitrateMode: 'quantizer'; hardwareAcceleration: 'prefer-hardware';
  avc: { format: 'annexb' }; quantizer: number;
}
export function canvasEncoderConfig(resolution: { width: number; height: number }, fps: { num: number; den: number }, quality: RenderQuality): CanvasEncoderConfig {
  return { codec: avcCodec(resolution, fps), width: resolution.width, height: resolution.height, framerate: fps.num / fps.den,
    bitrateMode: 'quantizer', hardwareAcceleration: 'prefer-hardware', avc: { format: 'annexb' }, quantizer: CANVAS_QUANTIZER[quality] };
}

/** FFmpeg: the H.264 stream (Annex B) on stdin as it is, the prepared PCM as AAC, into MP4. */
export function canvasEncoderArguments({ fps, audioFile, output }: { fps: { num: number; den: number }; audioFile: string; output: string }): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-framerate', `${fps.num}/${fps.den}`, '-i', 'pipe:0',
    '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', audioFile, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
    // Raw H.264 has no timestamps and the demuxer's guess drifts: stamp frame n at n / fps (no B-frames, checked after).
    // The VUI colour tags match the screenshot path's: BT.709 primaries and matrix, sRGB transfer, limited range.
    '-bsf:v', `h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=13:matrix_coefficients=1,setts=ts=N*${fps.den}/${fps.num}/TB:duration=${fps.den}/${fps.num}/TB`,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-color_range', 'tv',
    // The same audio and movie clock as the screenshot path (exportRunner.encoderArguments).
    '-c:a', 'aac', '-b:a', '192k', '-movie_timescale', '48000', '-movflags', '+faststart', '-y', output];
}
