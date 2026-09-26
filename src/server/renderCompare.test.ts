import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVideos, comparePcm, parseSsimAll, pcmWindowRms } from './renderCompare';
import { resolveFfmpegBin } from './resolveFfmpeg';

describe('parseSsimAll', () => {
  it('ffmpeg ssim フィルタの集計行から All 値を取り出す', () => {
    const line = '[Parsed_ssim_0 @ 0x0] SSIM Y:0.982 (17.4) U:0.991 (20.6) V:0.990 (20.2) All:0.985123 (18.3)';
    expect(parseSsimAll(line)).toBeCloseTo(0.985123, 6);
  });
  it('無ければ null', () => {
    expect(parseSsimAll('no ssim here')).toBeNull();
  });
});

describe('comparePcm', () => {
  it('同一バッファは差ゼロ', () => {
    const a = Buffer.from([0, 0, 10, 0, 246, 255]); // s16le: 0, 10, -10
    expect(comparePcm(a, Buffer.from(a))).toEqual({ lengthDiff: 0, maxAbsDiff: 0 });
  });
  it('長さ差と最大サンプル差を返す', () => {
    const a = Buffer.from([0, 0, 10, 0]);
    const b = Buffer.from([0, 0, 13, 0, 1, 0]);
    expect(comparePcm(a, b)).toEqual({ lengthDiff: 1, maxAbsDiff: 3 });
  });
});

const ffmpeg = resolveFfmpegBin();

// 較正テスト（I-5）: compareVideos が実際に「同じ／違う」を弁別できることを実測で確認する。
// ffmpeg 不在環境ではスキップ（compareVideos 自体が null を返す設計のため）。
describe.skipIf(!ffmpeg.ok)('compareVideos（較正）', () => {
  it('同一動画同士は ssimAll が 0.99 超・明度を変えた版とは 0.99 未満', () => {
    const bin = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';
    const dir = mkdtempSync(join(tmpdir(), 'render-compare-calib-'));
    const refPath = join(dir, 'ref.mp4');
    const samePath = join(dir, 'same.mp4');
    const brightPath = join(dir, 'bright.mp4');
    try {
      execFileSync(bin, [
        '-y', '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=64x64:rate=30',
        '-pix_fmt', 'yuv420p', refPath,
      ]);
      execFileSync(bin, ['-y', '-i', refPath, '-c', 'copy', samePath]);
      execFileSync(bin, [
        '-y', '-i', refPath, '-vf', 'eq=brightness=0.3', '-pix_fmt', 'yuv420p', brightPath,
      ]);

      const sameReport = compareVideos(refPath, samePath);
      expect(sameReport).not.toBeNull();
      expect(sameReport!.ssimAll).not.toBeNull();
      expect(sameReport!.ssimAll!).toBeGreaterThan(0.99);

      const brightReport = compareVideos(refPath, brightPath);
      expect(brightReport).not.toBeNull();
      expect(brightReport!.ssimAll).not.toBeNull();
      expect(brightReport!.ssimAll!).toBeLessThan(0.99);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pcmWindowRms', () => {
  it('無音区間は 0、フルスケール矩形波区間は 1 に近い', () => {
    // 48kHz/2ch・s16le: 前半0.1秒無音・後半0.1秒 ±32767 交互
    const sr = 48000, ch = 2, n = Math.floor(sr * 0.2);
    const buf = Buffer.alloc(n * ch * 2);
    for (let i = Math.floor(n / 2); i < n; i++) {
      const v = i % 2 === 0 ? 32767 : -32767;
      for (let c = 0; c < ch; c++) buf.writeInt16LE(v, (i * ch + c) * 2);
    }
    expect(pcmWindowRms(buf, sr, ch, 0, 0.1)).toBeLessThan(0.001);
    expect(pcmWindowRms(buf, sr, ch, 0.1, 0.2)).toBeGreaterThan(0.9);
  });
});

// 較正テスト（I-5）: comparePcm が実際の ffmpeg デコード結果で「同じ／違う」を弁別できることを実測で確認する。
// ffmpeg 不在環境ではスキップ。
describe.skipIf(!ffmpeg.ok)('comparePcm（sine 較正）', () => {
  it('同一 sine は maxAbsDiff 0・音量 0.5 の sine とは大きな差が出る', () => {
    const bin = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';
    const dir = mkdtempSync(join(tmpdir(), 'render-compare-pcm-calib-'));
    const sinePath = join(dir, 'sine.wav');
    const halfPath = join(dir, 'half.wav');
    try {
      execFileSync(bin, [
        '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-af', 'volume=10', sinePath,
      ]);
      execFileSync(bin, [
        '-y', '-i', sinePath, '-af', 'volume=0.5', halfPath,
      ]);

      const decode = (p: string): Buffer =>
        execFileSync(
          bin,
          ['-hide_banner', '-i', p, '-map', 'a:0', '-f', 's16le', '-ac', '2', '-ar', '48000', '-'],
          { maxBuffer: 512 * 1024 * 1024 },
        );

      const sinePcm = decode(sinePath);
      const halfPcm = decode(halfPath);

      expect(comparePcm(sinePcm, sinePcm)).toEqual({ lengthDiff: 0, maxAbsDiff: 0 });
      expect(comparePcm(sinePcm, halfPcm).maxAbsDiff).toBeGreaterThan(8000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
