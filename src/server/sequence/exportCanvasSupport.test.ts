import { expect, it } from 'vitest';
import { avcCodec, CANVAS_KEY_FRAME_INTERVAL, CANVAS_QUANTIZER, canvasEncoderArguments, canvasEncoderConfig, canvasExportUnavailable } from './exportCanvasSupport';

const mac = { platform: 'darwin' as const, arch: 'arm64' };
it('allows the canvas engine only on Apple silicon at the full resolution, with the reason in Japanese otherwise', () => {
  expect(canvasExportUnavailable({ resolution: 'full', quality: 'high', engine: 'canvas' }, mac)).toBeNull();
  expect(canvasExportUnavailable({ resolution: 'full', quality: 'light', engine: 'canvas' }, mac)).toBeNull();
  for (const machine of [{ platform: 'darwin' as const, arch: 'x64' }, { platform: 'win32' as const, arch: 'x64' }, { platform: 'linux' as const, arch: 'arm64' }])
    expect(canvasExportUnavailable({ resolution: 'full', quality: 'high', engine: 'canvas' }, machine)).toBe('速い書き出しは Apple シリコンの Mac でだけ使えます');
  for (const resolution of ['1080p', '720p'] as const)
    expect(canvasExportUnavailable({ resolution, quality: 'high', engine: 'canvas' }, mac)).toBe('速い書き出しは解像度「そのまま」の時だけ使えます');
  // The screenshot path has no conditions of its own.
  expect(canvasExportUnavailable({ resolution: '720p', quality: 'high' }, { platform: 'win32', arch: 'x64' })).toBeNull();
});
it('reads the machine from the process when none is given', () => {
  const expected = process.platform === 'darwin' && process.arch === 'arm64' ? null : '速い書き出しは Apple シリコンの Mac でだけ使えます';
  expect(canvasExportUnavailable({ resolution: 'full', quality: 'high', engine: 'canvas' })).toBe(expected);
});
it.each([
  [1920, 1080, 30, 1, 'avc1.640028'], [1920, 1080, 60, 1, 'avc1.64002a'], [2688, 1512, 60000, 1001, 'avc1.640033'],
  [1080, 1920, 30, 1, 'avc1.640028'], [3840, 2160, 60, 1, 'avc1.640034'], [1920, 1080, 30000, 1001, 'avc1.640028'],
  [320, 180, 30000, 1001, 'avc1.64001f'], [1280, 720, 60, 1, 'avc1.640020'], [1920, 1080, 24, 1, 'avc1.640028'],
] as const)('chooses the H.264 level of %i×%i at %i/%i fps: %s', (width, height, num, den, codec) => {
  expect(avcCodec({ width, height }, { num, den })).toBe(codec);
});
it('refuses a size or rate beyond the H.264 level table instead of claiming a level the stream exceeds', () => {
  expect(() => avcCodec({ width: 8192, height: 8192 }, { num: 60, den: 1 })).toThrow(/H\.264/);
  expect(() => avcCodec({ width: 7680, height: 4320 }, { num: 240, den: 1 })).toThrow(/H\.264/);
  // A strip small in area but 1063 macroblocks tall: beyond sqrt(8 × MaxFS) = 1055 even at level 6.2.
  expect(() => avcCodec({ width: 16, height: 17000 }, { num: 30, den: 1 })).toThrow(/H\.264/);
  // The same strip 1000 macroblocks tall fits level 6 (sqrt(8 × 139264) = 1055) but no lower level.
  expect(avcCodec({ width: 16, height: 16000 }, { num: 30, den: 1 })).toBe('avc1.64003c');
});
it('keeps one quality value per setting and a key frame every 60 frames', () => {
  expect(CANVAS_QUANTIZER).toEqual({ high: 22, standard: 29, light: 30 });
  expect(Object.isFrozen(CANVAS_QUANTIZER)).toBe(true);
  expect(CANVAS_KEY_FRAME_INTERVAL).toBe(60);
});
it('configures the browser encoder for constant quality H.264 in Annex B at the project rate', () => {
  expect(canvasEncoderConfig({ width: 1920, height: 1080 }, { num: 30000, den: 1001 }, 'high')).toEqual({
    codec: 'avc1.640028', width: 1920, height: 1080, framerate: 30000 / 1001, bitrateMode: 'quantizer', hardwareAcceleration: 'prefer-hardware', avc: { format: 'annexb' }, quantizer: 22 });
  expect(canvasEncoderConfig({ width: 2688, height: 1512 }, { num: 60000, den: 1001 }, 'standard')).toMatchObject({ codec: 'avc1.640033', framerate: 60000 / 1001, quantizer: 29 });
});
it('muxes the H.264 stream without re-encoding, stamps frame n at n × den/num and tags the colours like the screenshot path', () => {
  const args = canvasEncoderArguments({ fps: { num: 30000, den: 1001 }, audioFile: '/tmp/a.f32le', output: '/tmp/out.mp4' });
  expect(args).toEqual(['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-framerate', '30000/1001', '-i', 'pipe:0',
    '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', '/tmp/a.f32le', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
    '-bsf:v', 'h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=13:matrix_coefficients=1,setts=ts=N*1001/30000/TB:duration=1001/30000/TB',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '192k', '-movie_timescale', '48000', '-movflags', '+faststart', '-y', '/tmp/out.mp4']);
  expect(canvasEncoderArguments({ fps: { num: 25, den: 1 }, audioFile: 'a', output: 'o' })).toContain('h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=13:matrix_coefficients=1,setts=ts=N*1/25/TB:duration=1/25/TB');
});
