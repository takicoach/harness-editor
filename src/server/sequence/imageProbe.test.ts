import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageDisplaySize, inspectImageStream, isAnimatedWebp, jpegExifOrientation, readImageHead } from './imageProbe';
import { animatedWebpHeader, makeMediaSamples, withExifOrientation, type MediaSamples } from './__fixtures__/mediaSamples';

let samples: MediaSamples;
beforeAll(() => { samples = makeMediaSamples(mkdtempSync(join(tmpdir(), 'image-probe-'))); }, 30_000);
afterAll(() => { rmSync(samples.dir, { recursive: true, force: true }); });

describe('JPEG の EXIF の向き（設計 M3c）', () => {
  it('試料の向き 6 を読み、向きの無い JPEG と JPEG 以外は 1', async () => {
    expect(jpegExifOrientation(await readImageHead(samples.exifRotatedJpg))).toBe(6);
    expect(jpegExifOrientation(await readImageHead(samples.landscapeJpg))).toBe(1);
    expect(jpegExifOrientation(await readImageHead(samples.landscapePng))).toBe(1);
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('向き %i をそのまま返す（ビッグエンディアン）', (orientation) => {
    expect(jpegExifOrientation(withExifOrientation(readFileSync(samples.landscapeJpg), orientation))).toBe(orientation);
  });
  it('範囲外（9）や壊れた見出しは 1', () => {
    expect(jpegExifOrientation(withExifOrientation(readFileSync(samples.landscapeJpg), 9))).toBe(1);
    expect(jpegExifOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00]))).toBe(1);
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('リトルエンディアン（II）でも向き %i をそのまま返す', (orientation) => {
    expect(jpegExifOrientation(withExifOrientation(readFileSync(samples.landscapeJpg), orientation, 'II'))).toBe(orientation);
  });
  it('APP1 の宣言長が実際のバイト列より長くても例外にせず 1 を返す（宣言長 0x1000・本体 10 バイト）', () => {
    const header = Buffer.alloc(4);
    header.writeUInt16BE(0xffe1, 0);
    header.writeUInt16BE(0x1000, 2);
    const body = Buffer.alloc(10, 0);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8]), header, body]);
    expect(jpegExifOrientation(bytes)).toBe(1);
  });
  it('TIFF の IFD 位置が範囲外（0xFFFFFFF0）でも例外にせず 1 を返す', () => {
    const tiff = Buffer.alloc(8);
    tiff.write('MM', 0, 'latin1');
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(0xfffffff0, 4);
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const header = Buffer.alloc(4);
    header.writeUInt16BE(0xffe1, 0);
    header.writeUInt16BE(body.length + 2, 2);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8]), header, body]);
    expect(jpegExifOrientation(bytes)).toBe(1);
  });
  it('APP0（JFIF）→ XMP の APP1 → Exif の APP1 の順でも、Exif の向きを読む', () => {
    const app0Body = Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]);
    const app0Header = Buffer.alloc(2);
    app0Header.writeUInt16BE(app0Body.length + 2, 0);
    const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), app0Header, app0Body]);

    const xmpBody = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from('<x/>', 'latin1')]);
    const xmpHeader = Buffer.alloc(4);
    xmpHeader.writeUInt16BE(0xffe1, 0);
    xmpHeader.writeUInt16BE(xmpBody.length + 2, 2);
    const xmpApp1 = Buffer.concat([xmpHeader, xmpBody]);

    const minimalJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const withExif = withExifOrientation(minimalJpeg, 3);
    const exifApp1 = withExif.subarray(2, withExif.length - 2);

    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, xmpApp1, exifApp1]);
    expect(jpegExifOrientation(bytes)).toBe(3);
  });
});

describe('表示上の縦横', () => {
  it('向き 5〜8 だけ縦横を入れ替える', () => {
    expect([1, 2, 3, 4].map((o) => imageDisplaySize(640, 360, o))).toEqual(Array(4).fill({ width: 640, height: 360 }));
    expect([5, 6, 7, 8].map((o) => imageDisplaySize(640, 360, o))).toEqual(Array(4).fill({ width: 360, height: 640 }));
  });
});

describe('動く画像と、読めない画像（設計 M3c・M3d）', () => {
  it('WebP はアニメーション旗で判定する', () => {
    expect(isAnimatedWebp(animatedWebpHeader())).toBe(true);
    const still = animatedWebpHeader(); still[20] = 0;
    expect(isAnimatedWebp(still)).toBe(false);
  });
  it('コマ数が 2 以上なら動く画像。寸法が無ければ表示寸法なし（作成は 1920x1080）', () => {
    expect(inspectImageStream({ width: 64, height: 48, nb_read_frames: '5' }, Buffer.alloc(0), 'a.gif')).toMatchObject({ animated: true, frames: 5 });
    expect(inspectImageStream({ nb_read_frames: '1' }, Buffer.alloc(0), 'a.png')).toEqual({ orientation: 1, frames: 1, animated: false });
    expect(inspectImageStream({ width: 640, height: 360, nb_read_frames: '1' }, withExifOrientation(readFileSync(samples.landscapeJpg), 6), 'a.jpg'))
      .toEqual({ displaySize: { width: 360, height: 640 }, orientation: 6, frames: 1, animated: false });
  });
  it('1コマも復号できない画像は、寸法 0 と報告されても「読み取れない」', () => {
    expect(() => inspectImageStream({ width: 0, height: 0, nb_read_frames: 'N/A' }, Buffer.alloc(0), 'broken.png')).toThrow('画像を読み取れません');
    expect(() => inspectImageStream({ width: 0, height: 0 }, Buffer.alloc(0), 'broken.png')).toThrow('画像を読み取れません');
  });
  it('動く WebP の見出しがあれば、nb_read_frames が読めなくても「読み取れない」にしない（I-1）', () => {
    expect(inspectImageStream({ width: 0, height: 0 }, animatedWebpHeader(), 'a.webp')).toMatchObject({ animated: true, frames: 0 });
  });
  it('nb_read_frames が 1 でも、動く WebP の見出しがあれば animated は true（I-1）', () => {
    expect(inspectImageStream({ width: 0, height: 0, nb_read_frames: '1' }, animatedWebpHeader(), 'a.webp')).toMatchObject({ animated: true });
  });
  it('配布版で AV1 のソフト復号器が無い場合、寸法だけで受け付ける（I-1）', () => {
    expect(inspectImageStream({ codec_name: 'av1', width: 64, height: 48 }, Buffer.alloc(0), 'a.avif'))
      .toEqual({ displaySize: { width: 64, height: 48 }, orientation: 1, frames: 1, animated: false });
  });
  it('AV1 でも寸法が無い、または codec_name が av1 でなければ「読み取れない」のまま（I-1・I-3）', () => {
    // codec_name が png（寸法はあるが復号 0 コマ）: undecodableAv1 の codec_name 条件を実際に試す。
    expect(() => inspectImageStream({ codec_name: 'png', width: 64, height: 48 }, Buffer.alloc(0), 'broken.png')).toThrow('画像を読み取れません');
    // codec_name が無い（寸法はある）: codec_name === 'av1' の条件を実際に試す。
    expect(() => inspectImageStream({ width: 64, height: 48 }, Buffer.alloc(0), 'a.avif')).toThrow('画像を読み取れません');
    // codec_name は av1 だが高さが 0: 寸法の && 条件を実際に試す。
    expect(() => inspectImageStream({ codec_name: 'av1', width: 64, height: 0 }, Buffer.alloc(0), 'a.avif')).toThrow('画像を読み取れません');
  });
  it('動く AVIF（ftyp の主ブランドが avis）は animated（M-8）', () => {
    const head = Buffer.alloc(16);
    head.writeUInt32BE(16, 0); head.write('ftyp', 4, 'latin1'); head.write('avis', 8, 'latin1');
    expect(inspectImageStream({ codec_name: 'av1', width: 64, height: 48 }, head, 'a.avif')).toMatchObject({ animated: true, frames: 1 });
  });
});
