/**
 * pngRgba.ts のユニットテスト。
 * - filter 型 0-4 それぞれを踏む合成 PNG（node:zlib で自作）で画素を pin
 * - RGB(colorType 2) → RGBA(A=255) 展開
 * - 複数 IDAT チャンク連結
 * - 非対応形式（bitDepth≠8・palette・interlace）の throw
 */

import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePngRgba } from './pngRgba';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// 最小 CRC32 実装（PNG チャンク CRC。デコーダは CRC を検査しないためテスト側で正しい値である必要はないが、
// 実 PNG に近い構造で作るため実装しておく）
function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0;
    crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function ihdrChunk(width: number, height: number, bitDepth: number, colorType: number, interlace = 0): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data.writeUInt8(bitDepth, 8);
  data.writeUInt8(colorType, 9);
  data.writeUInt8(0, 10); // compression
  data.writeUInt8(0, 11); // filter
  data.writeUInt8(interlace, 12);
  return chunk('IHDR', data);
}

function buildPng(opts: {
  width: number;
  height: number;
  bitDepth?: number;
  colorType?: number;
  interlace?: number;
  /** row-major raw scanline bytes INCLUDING per-row filter byte (already filtered) */
  filteredRows: Buffer[];
  splitIdat?: boolean;
}): Buffer {
  const bitDepth = opts.bitDepth ?? 8;
  const colorType = opts.colorType ?? 6;
  const interlace = opts.interlace ?? 0;
  const raw = Buffer.concat(opts.filteredRows);
  const compressed = deflateSync(raw);
  const idatChunks = opts.splitIdat
    ? [chunk('IDAT', compressed.subarray(0, Math.ceil(compressed.length / 2))), chunk('IDAT', compressed.subarray(Math.ceil(compressed.length / 2)))]
    : [chunk('IDAT', compressed)];
  return Buffer.concat([
    SIG,
    ihdrChunk(opts.width, opts.height, bitDepth, colorType, interlace),
    ...idatChunks,
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// filter 0 (None)
// ---------------------------------------------------------------------------

describe('decodePngRgba: filter type 0 (None)', () => {
  it('2x1 RGBA、無変換の生値がそのまま画素になる', () => {
    const row0 = Buffer.concat([Buffer.from([0]), Buffer.from([10, 20, 30, 255, 40, 50, 60, 128])]);
    const png = buildPng({ width: 2, height: 1, filteredRows: [row0] });
    const decoded = decodePngRgba(png);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(1);
    expect(Array.from(decoded.data)).toEqual([10, 20, 30, 255, 40, 50, 60, 128]);
  });
});

// ---------------------------------------------------------------------------
// filter 1 (Sub)
// ---------------------------------------------------------------------------

describe('decodePngRgba: filter type 1 (Sub)', () => {
  it('2x1 RGBA: 2画素目は1画素目からの差分で符号化 → 復元値が一致', () => {
    // 目標画素: [10,20,30,255], [15,25,35,255]
    // Sub: byte[i] = raw[i] - raw[i-bpp] (bpp=4, i<4 は a=0)
    const target = [10, 20, 30, 255, 15, 25, 35, 255];
    const filtered = target.map((v, i) => {
      const a = i >= 4 ? (target[i - 4] ?? 0) : 0;
      return (v - a) & 0xff;
    });
    const row0 = Buffer.concat([Buffer.from([1]), Buffer.from(filtered)]);
    const png = buildPng({ width: 2, height: 1, filteredRows: [row0] });
    const decoded = decodePngRgba(png);
    expect(Array.from(decoded.data)).toEqual(target);
  });
});

// ---------------------------------------------------------------------------
// filter 2 (Up)
// ---------------------------------------------------------------------------

describe('decodePngRgba: filter type 2 (Up)', () => {
  it('2x2 RGBA: 2行目は1行目からの差分で符号化 → 復元値が一致', () => {
    const row0Target = [1, 2, 3, 255, 4, 5, 6, 255];
    const row1Target = [11, 12, 13, 255, 14, 15, 16, 255];
    const row0Filtered = row0Target; // filter 0
    const row1Filtered = row1Target.map((v, i) => (v - (row0Target[i] ?? 0)) & 0xff);
    const rows = [
      Buffer.concat([Buffer.from([0]), Buffer.from(row0Filtered)]),
      Buffer.concat([Buffer.from([2]), Buffer.from(row1Filtered)]),
    ];
    const png = buildPng({ width: 2, height: 2, filteredRows: rows });
    const decoded = decodePngRgba(png);
    expect(Array.from(decoded.data)).toEqual([...row0Target, ...row1Target]);
  });
});

// ---------------------------------------------------------------------------
// filter 3 (Average)
// ---------------------------------------------------------------------------

describe('decodePngRgba: filter type 3 (Average)', () => {
  it('2x2 RGBA: floor((a+b)/2) 規格どおりの符号化 → 復元値が一致', () => {
    const row0Target = [10, 20, 30, 255, 50, 60, 70, 255];
    const row1Target = [90, 100, 110, 255, 130, 140, 150, 255];
    const row0Filtered = row0Target.map((v, i) => {
      const a = i >= 4 ? (row0Target[i - 4] ?? 0) : 0;
      return (v - Math.floor(a / 2)) & 0xff; // b=0 for first row
    });
    const row1Filtered = row1Target.map((v, i) => {
      const a = i >= 4 ? (row1Target[i - 4] ?? 0) : 0;
      const b = row0Target[i] ?? 0;
      return (v - Math.floor((a + b) / 2)) & 0xff;
    });
    const rows = [
      Buffer.concat([Buffer.from([3]), Buffer.from(row0Filtered)]),
      Buffer.concat([Buffer.from([3]), Buffer.from(row1Filtered)]),
    ];
    const png = buildPng({ width: 2, height: 2, filteredRows: rows });
    const decoded = decodePngRgba(png);
    expect(Array.from(decoded.data)).toEqual([...row0Target, ...row1Target]);
  });
});

// ---------------------------------------------------------------------------
// filter 4 (Paeth)
// ---------------------------------------------------------------------------

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

describe('decodePngRgba: filter type 4 (Paeth)', () => {
  it('2x2 RGBA: Paeth 予測子で符号化 → 復元値が一致', () => {
    const row0Target = [5, 15, 25, 255, 45, 55, 65, 255];
    const row1Target = [85, 95, 105, 255, 125, 135, 145, 255];
    const row1Filtered = row1Target.map((v, i) => {
      const a = i >= 4 ? (row1Target[i - 4] ?? 0) : 0;
      const b = row0Target[i] ?? 0;
      const c = i >= 4 ? (row0Target[i - 4] ?? 0) : 0;
      return (v - paeth(a, b, c)) & 0xff;
    });
    const rows = [
      // row0 は filter 0（生値）のまま。row1 が row0 を参照するため row0Target と一致必須
      Buffer.concat([Buffer.from([0]), Buffer.from(row0Target)]),
      Buffer.concat([Buffer.from([4]), Buffer.from(row1Filtered)]),
    ];
    const png = buildPng({ width: 2, height: 2, filteredRows: rows });
    const decoded = decodePngRgba(png);
    expect(Array.from(decoded.data)).toEqual([...row0Target, ...row1Target]);
  });
});

// ---------------------------------------------------------------------------
// Paeth: c 枝（左上）を明示的に踏む fixture
// ---------------------------------------------------------------------------

describe('decodePngRgba: filter type 4 (Paeth) — c 枝の選択を pin', () => {
  it('a=10,b=20,c=14 では paeth 予測子が c(=14) を選ぶ（手計算: pa=6,pb=4,pc=2）', () => {
    // 実装が誤って b を返す退行（predictor=20）が入ると、raw の逆算値がずれて decode 結果が
    // ターゲット値と一致しなくなる（c 枝を独立に pin する）。
    const cVal = 14; // row0 pixel0 の R（= row1 pixel1 R から見た「左上」）
    const bVal = 20; // row0 pixel1 の R（= row1 pixel1 R から見た「真上」）
    const aVal = 10; // row1 pixel0 の R（= row1 pixel1 R から見た「左」）
    const target1 = 99; // row1 pixel1 の R（判定対象）
    // 手計算の検算: paeth(10,20,14) は pa=|20-14|=6, pb=|10-14|=4, pc=|10+20-14-14|=2 → c を選ぶ
    expect(paeth(aVal, bVal, cVal)).toBe(cVal);

    // R チャンネルだけ上記の a/b/c 関係を作り、G/B/A は任意値（同じ Paeth 符号化式で計算するため
    // 実装が正しければどのみち一致する）。
    const row0Target = [cVal, 200, 210, 255, bVal, 220, 230, 255];
    const row1Target = [aVal, 5, 6, 255, target1, 7, 8, 255];
    const row1Filtered = row1Target.map((v, i) => {
      const a = i >= 4 ? (row1Target[i - 4] ?? 0) : 0;
      const b = row0Target[i] ?? 0;
      const c = i >= 4 ? (row0Target[i - 4] ?? 0) : 0;
      return (v - paeth(a, b, c)) & 0xff;
    });
    const rows = [
      Buffer.concat([Buffer.from([0]), Buffer.from(row0Target)]),
      Buffer.concat([Buffer.from([4]), Buffer.from(row1Filtered)]),
    ];
    const png = buildPng({ width: 2, height: 2, filteredRows: rows });
    const decoded = decodePngRgba(png);
    expect(Array.from(decoded.data)).toEqual([...row0Target, ...row1Target]);
  });
});

// ---------------------------------------------------------------------------
// RGB(colorType 2) → RGBA 展開
// ---------------------------------------------------------------------------

describe('decodePngRgba: colorType 2 (RGB) → A=255 展開', () => {
  it('2x1 RGB、filter 0 の生値に A=255 が付与される', () => {
    const row0 = Buffer.concat([Buffer.from([0]), Buffer.from([100, 150, 200, 10, 20, 30])]);
    const png = buildPng({ width: 2, height: 1, colorType: 2, filteredRows: [row0] });
    const decoded = decodePngRgba(png);
    expect(Array.from(decoded.data)).toEqual([100, 150, 200, 255, 10, 20, 30, 255]);
  });

  it('2x2 RGB・filter 1(Sub)＋filter 4(Paeth): 3byte 単位(bpp=3)で復元してから4byte展開される（bpp=4退行の検出用）', () => {
    // このテストの意義: colorType 2 の filter 復元は「stride=width*3・bpp=3」で行い、
    // その後に width*4 の RGBA へ展開する必要がある。実装が誤って bpp=4 のまま filter 復元すると
    // （＝RGBA と同じロジックを RGB に流用すると）、各行のバイト境界がずれて画素値が破壊される。
    // 2行以上・filter 1/4 を使うことで、そのずれを確実に踏む。
    const row0Target = [10, 20, 30, 40, 50, 60]; // 2px x 3ch(RGB)
    const row1Target = [70, 80, 90, 100, 110, 120];
    const bpp = 3;
    // row0: filter 1 (Sub) — bpp=3 で左画素からの差分
    const row0Filtered = row0Target.map((v, i) => {
      const a = i >= bpp ? (row0Target[i - bpp] ?? 0) : 0;
      return (v - a) & 0xff;
    });
    // row1: filter 4 (Paeth) — bpp=3 で a/b/c を参照
    const row1Filtered = row1Target.map((v, i) => {
      const a = i >= bpp ? (row1Target[i - bpp] ?? 0) : 0;
      const b = row0Target[i] ?? 0;
      const c = i >= bpp ? (row0Target[i - bpp] ?? 0) : 0;
      return (v - paeth(a, b, c)) & 0xff;
    });
    const rows = [
      Buffer.concat([Buffer.from([1]), Buffer.from(row0Filtered)]),
      Buffer.concat([Buffer.from([4]), Buffer.from(row1Filtered)]),
    ];
    const png = buildPng({ width: 2, height: 2, colorType: 2, filteredRows: rows });
    const decoded = decodePngRgba(png);
    const expected = [
      row0Target[0], row0Target[1], row0Target[2], 255,
      row0Target[3], row0Target[4], row0Target[5], 255,
      row1Target[0], row1Target[1], row1Target[2], 255,
      row1Target[3], row1Target[4], row1Target[5], 255,
    ];
    expect(Array.from(decoded.data)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// 複数 IDAT 連結
// ---------------------------------------------------------------------------

describe('decodePngRgba: 複数 IDAT チャンク', () => {
  it('IDAT が2チャンクに分割されていても連結して decode できる', () => {
    const row0 = Buffer.concat([Buffer.from([0]), Buffer.from([1, 2, 3, 255, 4, 5, 6, 255])]);
    const row1 = Buffer.concat([Buffer.from([0]), Buffer.from([7, 8, 9, 255, 10, 11, 12, 255])]);
    const png = buildPng({ width: 2, height: 2, filteredRows: [row0, row1], splitIdat: true });
    const decoded = decodePngRgba(png);
    expect(Array.from(decoded.data)).toEqual([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
  });
});

// ---------------------------------------------------------------------------
// 非対応形式の throw
// ---------------------------------------------------------------------------

describe('decodePngRgba: 非対応形式の throw', () => {
  it('bitDepth ≠ 8 は throw する', () => {
    const row0 = Buffer.concat([Buffer.from([0]), Buffer.from([0xff])]);
    const png = buildPng({ width: 2, height: 1, bitDepth: 16, filteredRows: [row0] });
    expect(() => decodePngRgba(png)).toThrow(/bitDepth/);
  });

  it('palette (colorType 3) は throw する', () => {
    const row0 = Buffer.concat([Buffer.from([0]), Buffer.from([0, 1])]);
    const png = buildPng({ width: 2, height: 1, colorType: 3, filteredRows: [row0] });
    expect(() => decodePngRgba(png)).toThrow(/colorType/);
  });

  it('grayscale (colorType 0) は throw する', () => {
    const row0 = Buffer.concat([Buffer.from([0]), Buffer.from([0, 1])]);
    const png = buildPng({ width: 2, height: 1, colorType: 0, filteredRows: [row0] });
    expect(() => decodePngRgba(png)).toThrow(/colorType/);
  });

  it('width=0 は throw する', () => {
    const png = buildPng({ width: 0, height: 1, filteredRows: [Buffer.from([0])] });
    expect(() => decodePngRgba(png)).toThrow(/寸法/);
  });

  it('height=0 は throw する', () => {
    const png = buildPng({ width: 1, height: 0, filteredRows: [] });
    expect(() => decodePngRgba(png)).toThrow(/寸法/);
  });

  it('インターレースありは throw する', () => {
    const row0 = Buffer.concat([Buffer.from([0]), Buffer.from([1, 2, 3, 255])]);
    const png = buildPng({ width: 1, height: 1, interlace: 1, filteredRows: [row0] });
    expect(() => decodePngRgba(png)).toThrow(/インターレース/);
  });

  it('PNG シグネチャ不一致は throw する', () => {
    const bogus = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(() => decodePngRgba(bogus)).toThrow(/シグネチャ/);
  });
});
