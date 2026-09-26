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
 * SE 込み nativeExport の実 ffmpeg 統合テスト（M1a 最終タスク）。
 * planFastCut は通さず、フィルタ生成 → buildFastCutArgs → 実 ffmpeg 実行を直接検証する
 * （プロジェクト fixture 不要）。ffmpeg 不在なら skip。
 */
const ffmpeg = resolveFfmpegBin();

describe.skipIf(!ffmpeg.ok)('nativeExport SE（実 ffmpeg 統合）', () => {
  it('SE 窓の RMS が上乗せされ、SE 無し出力とは PCM が実測で異なる', () => {
    const bin = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';
    const dir = mkdtempSync(join(tmpdir(), 'native-export-se-e2e-'));
    const mainPath = join(dir, 'main.mp4');
    const sePath = join(dir, 'se.wav');
    const outWithSePath = join(dir, 'out-with-se.mp4');
    const outNoSePath = join(dir, 'out-no-se.mp4');
    const scriptWithSePath = join(dir, 'filter-with-se.txt');
    const scriptNoSePath = join(dir, 'filter-no-se.txt');
    try {
      // 1. main.mp4: 2秒・64x64・30fps + 440Hz sine
      execFileSync(bin, [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        mainPath,
      ]);

      // 2. se.wav: 0.5秒・1760Hz
      execFileSync(bin, [
        '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=1760:duration=0.5',
        sePath,
      ]);

      // 3. フィルタ生成: 60フレーム全区間を残す → SE を [30,45) フレーム（1.0s〜1.5s）に配置
      const cutScript = buildCutFilterScript([{ start: 0, end: 60 }], 30);
      const seScript = applyAudioMix(
        cutScript,
        [{ startFrame: 30, endFrame: 45, volume: 1 }],
        30,
      );
      writeFileSync(scriptWithSePath, seScript);
      writeFileSync(scriptNoSePath, cutScript);

      const target = { width: 64, height: 64 };
      const options = { resolution: 'full' as const, quality: 'standard' as const };

      execFileSync(bin, buildFastCutArgs({
        input: mainPath,
        filterScript: scriptWithSePath,
        output: outWithSePath,
        options,
        target,
        hardware: false,
        extraInputs: [{ path: sePath }],
      }));

      execFileSync(bin, buildFastCutArgs({
        input: mainPath,
        filterScript: scriptNoSePath,
        output: outNoSePath,
        options,
        target,
        hardware: false,
      }));

      // (a) フレーム数厳密一致
      expect(probeFrameCount(outWithSePath)).toBe(60);

      // (b) SE 窓 [1.0s,1.5s] の RMS が SE 無し窓 [0.2s,0.7s] より 1.15 倍超
      const decode = (p: string): Buffer =>
        execFileSync(
          bin,
          ['-hide_banner', '-i', p, '-map', 'a:0', '-f', 's16le', '-ac', '2', '-ar', '48000', '-'],
          { maxBuffer: 512 * 1024 * 1024 },
        );
      const withSePcm = decode(outWithSePath);
      const seWindowRms = pcmWindowRms(withSePcm, 48000, 2, 1.0, 1.5);
      const noSeWindowRms = pcmWindowRms(withSePcm, 48000, 2, 0.2, 0.7);
      expect(seWindowRms).toBeGreaterThan(noSeWindowRms * 1.15);

      // (c) SE 無し出力との PCM 差が実在する
      const noSePcm = decode(outNoSePath);
      expect(comparePcm(withSePcm, noSePcm).maxAbsDiff).toBeGreaterThan(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
