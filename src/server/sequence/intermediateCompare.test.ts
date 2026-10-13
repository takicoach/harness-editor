import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { decodeJpegPlanes, intermediateDifference, intermediateMismatch, jpegSize, INTERMEDIATE_TOLERANCE } from './intermediateCompare';

const ffmpeg = resolveFfmpegBin();
const WIDTH = 64, HEIGHT = 48;
/** Opaque RGBA: a dark green field with an amber bar (coloured edges) and a white square. */
function picture(shift = 0): Buffer {
  const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const sx = x - shift, color = sx >= 8 && sx < 40 && y >= 10 && y < 22 ? [255, 200, 0] : sx >= 44 && sx < 56 && y >= 28 && y < 40 ? [255, 255, 255] : [11, 31, 24];
    rgba.set([...color, 255], (y * WIDTH + x) * 4);
  }
  return rgba;
}
const jpegOf = (rgba: Buffer, bin: string) => execFileSync(bin, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${WIDTH}x${HEIGHT}`, '-i', 'pipe:0', '-frames:v', '1',
  '-pix_fmt', 'yuvj420p', '-q:v', '1', '-qmin', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { input: rgba });

it('reads the size from the JPEG header and refuses other bytes', () => {
  if (!ffmpeg.ok) return;
  expect(jpegSize(jpegOf(picture(), ffmpeg.bin))).toEqual({ width: WIDTH, height: HEIGHT });
  expect(() => jpegSize(Buffer.from('not a jpeg'))).toThrow('JPEG ではありません');
});
it.skipIf(!ffmpeg.ok)('decodes the stored full-range planes: grey 128 stays 128, white 255 (no limited-range squeeze)', () => {
  if (!ffmpeg.ok) return;
  const flat = (value: number) => { const rgba = Buffer.alloc(WIDTH * HEIGHT * 4, value); for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; return rgba; };
  for (const value of [128, 255, 0]) {
    const planes = decodeJpegPlanes(ffmpeg.bin, jpegOf(flat(value), ffmpeg.bin));
    expect([planes.y.length, planes.cb.length, planes.cr.length]).toEqual([WIDTH * HEIGHT, WIDTH * HEIGHT / 4, WIDTH * HEIGHT / 4]);
    expect([planes.y[100], planes.cb[10], planes.cr[10]]).toEqual([value, 128, 128]);
  }
});
it.skipIf(!ffmpeg.ok)('accepts the JPEG of the same picture and tells a 1-pixel shift and a colour swap apart', () => {
  if (!ffmpeg.ok) return;
  const jpeg = jpegOf(picture(), ffmpeg.bin);
  const same = intermediateDifference(ffmpeg.bin, picture(), WIDTH, HEIGHT, jpeg);
  expect(intermediateMismatch(same)).toBeUndefined(); expect(same.lumaOver).toBe(0);
  const shifted = intermediateDifference(ffmpeg.bin, picture(1), WIDTH, HEIGHT, jpeg);
  expect(shifted.lumaMax).toBeGreaterThan(INTERMEDIATE_TOLERANCE.lumaMax * 10);
  expect(intermediateMismatch(shifted)).toMatch(/輝度の差 \d+/);
  // The shifted edges: the bar's and the square's left and right columns (12 + 12 rows each side).
  expect(shifted.lumaOver).toBe(2 * 12 + 2 * 12);
  const swapped = picture(); for (let i = 0; i < swapped.length; i += 4) [swapped[i], swapped[i + 2]] = [swapped[i + 2]!, swapped[i]!];
  expect(intermediateDifference(ffmpeg.bin, swapped, WIDTH, HEIGHT, jpeg).chromaBlockMax).toBeGreaterThan(INTERMEDIATE_TOLERANCE.chromaBlockMax * 10);
});
it.skipIf(!ffmpeg.ok)('refuses transparent pixels and a different size rather than comparing them', () => {
  if (!ffmpeg.ok) return;
  const jpeg = jpegOf(picture(), ffmpeg.bin), clear = picture(); clear[3] = 0;
  expect(() => intermediateDifference(ffmpeg.bin, clear, WIDTH, HEIGHT, jpeg)).toThrow('透明な画素');
  expect(() => intermediateDifference(ffmpeg.bin, picture(), WIDTH, HEIGHT - 16, jpeg)).toThrow('画像の大きさが違います');
});
