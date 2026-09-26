import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFfmpegBin } from '../../resolveFfmpeg';

/**
 * テスト専用: 音声・画像の試料を ffmpeg で作る（実案件・実際の学習フォルダは読まない）。
 * 表紙画像付きの mp3/m4a は、ffprobe が disposition.attached_pic=1 の映像ストリーム（mjpeg・90000/1）を返す形。
 */
export interface MediaSamples {
  dir: string;
  /** 2 秒・48kHz・モノラルの正弦波 */
  wav: string;
  /** 2 秒・表紙なしの mp3 */
  mp3: string;
  /** 2 秒・表紙（64x48 の JPEG）付き。音声が index 0、表紙が index 1 */
  coverMp3: string;
  coverM4a: string;
  /** 640x360 の横長 PNG / JPEG、360x640 の縦長 PNG、500x500 の正方形 PNG */
  landscapePng: string;
  landscapeJpg: string;
  portraitPng: string;
  squarePng: string;
  /** 640x360 で符号化し、EXIF の向き 6（右へ 90° 回転して表示）を付けた JPEG。表示は 360x640 */
  exifRotatedJpg: string;
  /** 5 コマの GIF と 1 コマの GIF */
  animatedGif: string;
  stillGif: string;
  /** 単色（切り替わりの確認用）640x360 */
  red: string;
  green: string;
  blue: string;
  /** 画像の拡張子だが中身は文字列 */
  brokenPng: string;
}

function ffmpeg(args: string[]): void {
  const bin = resolveFfmpegBin();
  if (!bin.ok) throw new Error(bin.message);
  execFileSync(bin.bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

/**
 * JPEG の先頭（SOI の直後）に、Orientation だけを持つ EXIF（APP1）を差し込む。
 * `byteOrder` は TIFF ヘッダーのバイト順（既定 'MM' ビッグエンディアン。'II' はリトルエンディアン）。
 */
export function withExifOrientation(jpeg: Buffer, orientation: number, byteOrder: 'MM' | 'II' = 'MM'): Buffer {
  const little = byteOrder === 'II';
  const tiff = Buffer.alloc(26);
  const writeU16 = (at: number, value: number) => (little ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at));
  const writeU32 = (at: number, value: number) => (little ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at));
  tiff.write(byteOrder, 0, 'latin1'); writeU16(2, 42); writeU32(4, 8);
  writeU16(8, 1); writeU16(10, 0x0112); writeU16(12, 3); writeU32(14, 1);
  writeU16(18, orientation); writeU16(20, 0); writeU32(22, 0);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4); app1.writeUInt16BE(0xffe1, 0); app1.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), app1, body, jpeg.subarray(2)]);
}

/** アニメーション旗つきの WebP 見出し（RIFF/WEBP/VP8X）。見出し判定の試験用で、画像としては読めない。 */
export function animatedWebpHeader(): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'latin1'); bytes.writeUInt32LE(22, 4); bytes.write('WEBP', 8, 'latin1');
  bytes.write('VP8X', 12, 'latin1'); bytes.writeUInt32LE(10, 16); bytes[20] = 0x02;
  return bytes;
}

export function makeMediaSamples(dir: string): MediaSamples {
  const at = (name: string) => join(dir, name);
  const cover = at('cover.jpg');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', at('talk.wav')]);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:duration=2', '-c:a', 'libmp3lame', '-b:a', '64k', at('talk.mp3')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:size=64x48', '-frames:v', '1', cover]);
  ffmpeg(['-i', at('talk.wav'), '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-b:a', '64k', '-c:v', 'copy',
    '-id3v2_version', '3', '-disposition:v', 'attached_pic', at('cover.mp3')]);
  ffmpeg(['-i', at('talk.wav'), '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-b:a', '64k', '-c:v', 'copy',
    '-disposition:v', 'attached_pic', at('cover.m4a')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=1', '-frames:v', '1', at('landscape.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=1', '-frames:v', '1', at('landscape.jpg')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=1', '-frames:v', '1', at('portrait.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=500x500:rate=1', '-frames:v', '1', at('square.png')]);
  writeFileSync(at('exif-rotated.jpg'), withExifOrientation(readFileSync(at('landscape.jpg')), 6));
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=5:duration=1', at('animated.gif')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=1', '-frames:v', '1', at('still.gif')]);
  for (const color of ['red', 'green', 'blue']) ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:size=640x360`, '-frames:v', '1', at(`${color}.png`)]);
  writeFileSync(at('broken.png'), 'not an image');
  return {
    dir, wav: at('talk.wav'), mp3: at('talk.mp3'), coverMp3: at('cover.mp3'), coverM4a: at('cover.m4a'),
    landscapePng: at('landscape.png'), landscapeJpg: at('landscape.jpg'), portraitPng: at('portrait.png'), squarePng: at('square.png'),
    exifRotatedJpg: at('exif-rotated.jpg'), animatedGif: at('animated.gif'), stillGif: at('still.gif'),
    red: at('red.png'), green: at('green.png'), blue: at('blue.png'), brokenPng: at('broken.png'),
  };
}
