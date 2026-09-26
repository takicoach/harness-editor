import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyAudioMix } from './nativeExportAudio';
import { buildCutFilterScript, buildFastCutArgs } from './fastCutRender';
import { probeFrameCount } from './probeFrames';
import { comparePcm, pcmWindowRms } from './renderCompare';
import { resolveFfmpegBin } from './resolveFfmpeg';

/**
 * BGM ループ・SE+BGM 同時ミックスの実 ffmpeg 統合テスト（M1b 最終タスク）。
 * planFastCut は通さず、フィルタ生成 → buildFastCutArgs → 実 ffmpeg 実行を直接検証する
 * （プロジェクト fixture 不要）。ffmpeg 不在なら skip。
 */
const ffmpeg = resolveFfmpegBin();

describe.skipIf(!ffmpeg.ok)('nativeExport BGM（実 ffmpeg 統合）', () => {
  it('BGM がループ再生され、SE+BGM 同時ミックスで SE の実在が確認できる', () => {
    const bin = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';
    const dir = mkdtempSync(join(tmpdir(), 'native-export-bgm-e2e-'));
    const mainPath = join(dir, 'main.mp4');
    const bgmPath = join(dir, 'bgm.wav');
    const sePath = join(dir, 'se.wav');
    const outBgmPath = join(dir, 'out-bgm.mp4');
    const outBgmSePath = join(dir, 'out-bgm-se.mp4');
    const scriptBgmPath = join(dir, 'filter-bgm.txt');
    const scriptBgmSePath = join(dir, 'filter-bgm-se.txt');
    try {
      // 1. main.mp4: 2秒・64x64・30fps + 440Hz sine（M1a と同一手口）
      execFileSync(bin, [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        mainPath,
      ]);

      // 2. bgm.wav: 0.3秒・880Hz（クリップ尺 1.5s より短い → ループ必須）
      execFileSync(bin, [
        '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.3',
        '-af', 'volume=10',
        bgmPath,
      ]);

      // 3. se.wav: 0.5秒・1760Hz（M1a と同一）
      execFileSync(bin, [
        '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=1760:duration=0.5',
        sePath,
      ]);

      const cutScript = buildCutFilterScript([{ start: 0, end: 60 }], 30);

      // BGM のみ: [0,45) フレーム（0s〜1.5s）に配置
      const bgmScript = applyAudioMix(
        cutScript,
        [{ startFrame: 0, endFrame: 45, volume: 0.5 }],
        30,
      );
      writeFileSync(scriptBgmPath, bgmScript);

      // SE+BGM 同時: se→bgm の順（Task 5 の並び規約と同一）
      const bgmSeScript = applyAudioMix(
        cutScript,
        [
          { startFrame: 30, endFrame: 45, volume: 1 },
          { startFrame: 0, endFrame: 45, volume: 0.5 },
        ],
        30,
      );
      writeFileSync(scriptBgmSePath, bgmSeScript);

      const target = { width: 64, height: 64 };
      const options = { resolution: 'full' as const, quality: 'standard' as const };

      execFileSync(bin, buildFastCutArgs({
        input: mainPath,
        filterScript: scriptBgmPath,
        output: outBgmPath,
        options,
        target,
        hardware: false,
        extraInputs: [{ path: bgmPath, loop: true }],
      }));

      execFileSync(bin, buildFastCutArgs({
        input: mainPath,
        filterScript: scriptBgmSePath,
        output: outBgmSePath,
        options,
        target,
        hardware: false,
        extraInputs: [{ path: sePath }, { path: bgmPath, loop: true }],
      }));

      // (a) フレーム数厳密一致
      expect(probeFrameCount(outBgmPath)).toBe(60);

      // (b) ループ実在: BGM クリップ内の連続 3 窓の RMS が
      //     クリップ外（BGM 停止後）の RMS の 1.15 倍超
      //     （音源 0.3s がループせず 1 回で止まるなら第 2・第 3 窓が落ちる）
      const decode = (p: string): Buffer =>
        execFileSync(
          bin,
          ['-hide_banner', '-i', p, '-map', 'a:0', '-f', 's16le', '-ac', '2', '-ar', '48000', '-'],
          { maxBuffer: 512 * 1024 * 1024 },
        );
      const bgmPcm = decode(outBgmPath);
      const outsideRms = pcmWindowRms(bgmPcm, 48000, 2, 1.6, 1.9);
      const windows: [number, number][] = [[0.0, 0.3], [0.5, 0.8], [1.0, 1.3]];
      for (const [start, end] of windows) {
        const rms = pcmWindowRms(bgmPcm, 48000, 2, start, end);
        expect(rms).toBeGreaterThan(outsideRms * 1.15);
      }

      // (c) SE+BGM 同時: BGM のみ版との PCM 差が実在する（SE の実在）
      const bgmSePcm = decode(outBgmSePath);
      expect(comparePcm(bgmSePcm, bgmPcm).maxAbsDiff).toBeGreaterThan(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
