/** Compare an export's JPEG intermediate frame (frame-<n>.jpg)
 * with true RGB, such as a PNG screenshot of the preview. Exact RGB equality no longer holds: the JPEG keeps the
 * colour (Cb, Cr) at half resolution, so a coloured edge decodes up to about 140 steps off. What the JPEG does keep:
 *   - luma (Y) at full resolution, off only by the DCT rounding of quality 100: placement, shapes, text and their
 *     brightness, pixel for pixel;
 *   - the average colour of every 16×16 block (4:2:0 averages 2×2 and the decoder spreads it back): fills, tints and
 *     colour grades, block by block.
 * Both sides are taken in the JPEG's own terms (JFIF: BT.601, full range), so nothing but the JPEG itself differs. */
import { execFileSync } from 'node:child_process';

export interface IntermediateDifference {
  /** Largest |ΔY| of any pixel. */ lumaMax: number;
  /** Pixels whose |ΔY| is above INTERMEDIATE_TOLERANCE.lumaMax (for checks that allow a few rounded edge pixels). */ lumaOver: number;
  /** Largest |ΔCb| or |ΔCr| between the means of a 16×16 block (whole blocks only). */ chromaBlockMax: number;
}
/** Chromium's PNG and JPEG captures of the same frame (2026-10-09, 640×360: translucent blur and rotated text over a
 * gradient and canvas, coloured text with a 1-pixel line, solid patches; 3 frames each) differ by at most 2 in luma and
 * 1.09 in a block's mean colour. Preview and export were already allowed one RGB step apart (PNG era), which adds 1
 * to luma (measured 3 with that step) and to the block mean. A 1-pixel shift measured 229-255 in luma and swapping
 * red and blue 135-171 in block colour, so this keeps telling a different picture apart. */
export const INTERMEDIATE_TOLERANCE = { lumaMax: 3, chromaBlockMax: 2 } as const;

/** The frame size of a JPEG (its SOF0..SOF2 marker). */
export function jpegSize(jpeg: Buffer): { width: number; height: number } {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('JPEG ではありません');
  for (let at = 2; at + 9 < jpeg.length;) {
    if (jpeg[at] !== 0xff) throw new Error('JPEG のマーカーが壊れています');
    const marker = jpeg[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xc2) return { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7) };
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
  throw new Error('JPEG に画像の大きさがありません');
}

export interface JpegPlanes { width: number; height: number; y: Uint8Array; cb: Uint8Array; cr: Uint8Array }
/** The decoded YCbCr 4:2:0 planes as stored (full range), without any conversion to RGB. */
export function decodeJpegPlanes(ffmpeg: string, jpeg: Buffer): JpegPlanes {
  const { width, height } = jpegSize(jpeg), cw = Math.ceil(width / 2), ch = Math.ceil(height / 2);
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuvj420p', 'pipe:1'],
    { input: jpeg, maxBuffer: width * height * 2 + 1024 });
  if (raw.length !== width * height + 2 * cw * ch) throw new Error(`JPEG の復号結果の大きさが違います（${raw.length}）`);
  return { width, height, y: raw.subarray(0, width * height), cb: raw.subarray(width * height, width * height + cw * ch), cr: raw.subarray(width * height + cw * ch) };
}

/** RGB to JFIF YCbCr exactly as libjpeg computes it (jccolor.c: fixed point with 16 fractional bits; Cb and Cr are
 * offset by CBCR_OFFSET + ONE_HALF - 1 = (128 << 16) + 32767, so an exact half rounds down). */
const CBCR_ROUND = (128 << 16) + 32767;
function ycc(r: number, g: number, b: number): [number, number, number] {
  return [(19595 * r + 38470 * g + 7471 * b + 32768) >> 16, (-11059 * r - 21709 * g + 32768 * b + CBCR_ROUND) >> 16, (32768 * r - 27439 * g - 5329 * b + CBCR_ROUND) >> 16];
}

/** `rgba`: opaque RGBA rows of the same size as the JPEG (for example a decoded PNG screenshot). */
export function intermediateDifference(ffmpeg: string, rgba: Uint8Array, width: number, height: number, jpeg: Buffer): IntermediateDifference {
  const planes = decodeJpegPlanes(ffmpeg, jpeg);
  if (planes.width !== width || planes.height !== height) throw new Error(`画像の大きさが違います（${width}×${height} → ${planes.width}×${planes.height}）`);
  if (rgba.length !== width * height * 4) throw new Error('RGBA の長さが画像の大きさと合いません');
  const cw = Math.ceil(width / 2), bw = Math.floor(width / 16), bh = Math.floor(height / 16);
  const sums = new Float64Array(bw * bh * 2);
  let lumaMax = 0, lumaOver = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    if (rgba[at + 3] !== 255) throw new Error(`比べる画像に透明な画素があります（${x}, ${y}）`);
    const [luma, cb, cr] = ycc(rgba[at]!, rgba[at + 1]!, rgba[at + 2]!);
    const delta = Math.abs(luma - planes.y[y * width + x]!);
    lumaMax = Math.max(lumaMax, delta); if (delta > INTERMEDIATE_TOLERANCE.lumaMax) lumaOver++;
    const bx = Math.floor(x / 16), by = Math.floor(y / 16);
    if (bx < bw && by < bh) { const block = (by * bw + bx) * 2; sums[block] = sums[block]! + cb; sums[block + 1] = sums[block + 1]! + cr; }
  }
  let chromaBlockMax = 0;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let cb = 0, cr = 0;
    for (let y = by * 8; y < by * 8 + 8; y++) for (let x = bx * 8; x < bx * 8 + 8; x++) { cb += planes.cb[y * cw + x]!; cr += planes.cr[y * cw + x]!; }
    const block = (by * bw + bx) * 2;
    chromaBlockMax = Math.max(chromaBlockMax, Math.abs(sums[block]! / 256 - cb / 64), Math.abs(sums[block + 1]! / 256 - cr / 64));
  }
  return { lumaMax, lumaOver, chromaBlockMax: Math.round(chromaBlockMax * 100) / 100 };
}
/** Undefined within INTERMEDIATE_TOLERANCE; otherwise a message naming the measured difference. */
export function intermediateMismatch(difference: IntermediateDifference): string | undefined {
  const tolerance = INTERMEDIATE_TOLERANCE;
  if (difference.lumaMax <= tolerance.lumaMax && difference.chromaBlockMax <= tolerance.chromaBlockMax) return undefined;
  return `書き出しの中間画像が元の画素と違います（輝度の差 ${difference.lumaMax}・16×16 ごとの色の平均の差 ${difference.chromaBlockMax}、許容 ${tolerance.lumaMax}・${tolerance.chromaBlockMax}）`;
}
