/**
 * 依存追加なしの自前 PNG デコーダ（node:zlib のみ）。
 *
 * 対応形式:
 * - bitDepth: 8 のみ
 * - colorType: 6（RGBA）・2（RGB → alpha=255 に展開）
 * - インターレース: なし（Adam7 は非対応）
 *
 * 上記以外（bitDepth ≠ 8・palette(colorType 0/3/4)・インターレースあり）は明示的に throw する。
 * 撮影ドライバ（Chromium screenshot）の出力形式が本デコーダで decode できることは
 * captureSmoke.e2e.test.ts の存在検査で担保する（T1 ではここでは扱わない）。
 *
 * 注意: 本デコーダは各チャンクの CRC を検査しない（chunk 送りに利用するのみ）。
 * 破損データは inflate 失敗や画素値の不整合として顕在化するが、CRC 不一致による
 * 早期検出は行わない（撮影パイプライン内部の信頼済み PNG のみを入力とする用途のため）。
 */

import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface DecodedRgba {
  width: number;
  height: number;
  /** RGBA・行優先・パディングなし（length = width*height*4） */
  data: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

interface Ihdr {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

function parseChunks(buf: Buffer): { ihdr: Ihdr; idat: Buffer } {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('decodePngRgba: PNG シグネチャ不一致（PNG ファイルではない）');
  }
  let offset = 8;
  let ihdr: Ihdr | null = null;
  const idatChunks: Buffer[] = [];
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > buf.length) {
      throw new Error(`decodePngRgba: チャンク "${type}" が buffer 末尾を超える（破損データ）`);
    }
    const data = buf.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (len < 13) throw new Error('decodePngRgba: IHDR チャンク長が不正');
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8),
        colorType: data.readUInt8(9),
        interlace: data.readUInt8(12),
      };
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4; // + CRC
  }
  if (!ihdr) throw new Error('decodePngRgba: IHDR チャンクが見つからない');
  if (ihdr.width === 0 || ihdr.height === 0) {
    throw new Error(`decodePngRgba: 不正な寸法（width=${ihdr.width} height=${ihdr.height}）`);
  }
  if (idatChunks.length === 0) throw new Error('decodePngRgba: IDAT チャンクが見つからない');
  return { ihdr, idat: Buffer.concat(idatChunks) };
}

/**
 * 8bit RGBA(colorType 6) / RGB(colorType 2) の非インターレース PNG を decode する。
 * 対応外の形式（bitDepth≠8・palette・インターレースあり）は throw する。
 */
export function decodePngRgba(png: Buffer): DecodedRgba {
  const { ihdr, idat } = parseChunks(png);
  const { width, height, bitDepth, colorType, interlace } = ihdr;

  if (interlace !== 0) {
    throw new Error('decodePngRgba: インターレース PNG は非対応（Adam7 未実装）');
  }
  if (bitDepth !== 8) {
    throw new Error(`decodePngRgba: 未対応の bitDepth=${bitDepth}（8bit のみ対応）`);
  }
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(
      `decodePngRgba: 未対応の colorType=${colorType}（対応: 6=RGBA, 2=RGB→A=255 展開。palette 等は非対応）`,
    );
  }

  const srcChannels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(idat);
  const stride = width * srcChannels;
  const expectedRawLength = height * (stride + 1);
  if (raw.length < expectedRawLength) {
    throw new Error(
      `decodePngRgba: inflate 後のデータ長が不足（期待 ${expectedRawLength} 実測 ${raw.length}）`,
    );
  }

  const data = new Uint8Array(width * height * 4);
  let prior = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filterType = raw[rowStart] ?? 0;
    const rowData = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const recon = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= srcChannels ? (recon[i - srcChannels] ?? 0) : 0;
      const b = prior[i] ?? 0;
      const c = i >= srcChannels ? (prior[i - srcChannels] ?? 0) : 0;
      const raw8 = rowData[i] ?? 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = raw8;
          break;
        case 1:
          value = raw8 + a;
          break;
        case 2:
          value = raw8 + b;
          break;
        case 3:
          value = raw8 + Math.floor((a + b) / 2);
          break;
        case 4:
          value = raw8 + paeth(a, b, c);
          break;
        default:
          throw new Error(`decodePngRgba: 未対応の PNG フィルタ種別=${filterType}`);
      }
      recon[i] = value & 0xff;
    }
    prior = recon;

    const destRowStart = y * width * 4;
    if (srcChannels === 4) {
      for (let x = 0; x < width; x++) {
        const si = x * 4;
        const di = destRowStart + x * 4;
        data[di] = recon[si] ?? 0;
        data[di + 1] = recon[si + 1] ?? 0;
        data[di + 2] = recon[si + 2] ?? 0;
        data[di + 3] = recon[si + 3] ?? 0;
      }
    } else {
      for (let x = 0; x < width; x++) {
        const si = x * 3;
        const di = destRowStart + x * 4;
        data[di] = recon[si] ?? 0;
        data[di + 1] = recon[si + 1] ?? 0;
        data[di + 2] = recon[si + 2] ?? 0;
        data[di + 3] = 255;
      }
    }
  }

  return { width, height, data };
}
