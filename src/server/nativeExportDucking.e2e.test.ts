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
 * ダッキング（volume 式）の実 ffmpeg 統合テスト（M1c 最終タスク）。
 * planFastCut は通さず、フィルタ生成 → buildFastCutArgs → 実 ffmpeg 実行を直接検証する
 * （プロジェクト fixture 不要）。ffmpeg 不在なら skip。
 *
 * fps=30 での区間換算（design v2:70 の区分線形・duckGainExpr と同値）:
 *   region { start:24, end:36 } → duck 区間 0.8s〜1.2s
 *   attackFrames:3              → attack 区間 0.7s〜0.8s（羽根）
 *   releaseFrames:9             → release 区間 1.2s〜1.5s（羽根）
 *   sustain（gain 一定 = 0.25）は 0.8s〜1.2s の全域
 * 検証窓 [0.9,1.1] は attack/release の羽根から十分離れた sustain 純域
 * （attack 終端 0.8s から 0.1s、release 始端 1.2s まで 0.1s の余白）なので、
 * 傾斜混入のない gain=0.25 の純粋な平坦区間として RMS 比較できる。
 *
 * attack/release のランプは ffmpeg（volume=…:eval=frame の連続線形）と Remotion
 * （フレーム階段）とで厳密同値ではない（sustain と非 duck 域は一致・spec v2:70 の意図的近似）。
 * 本ファイルの検証は sustain 純域と全体差分（duck 有無）に限定しているのはそのため。
 */
const ffmpeg = resolveFfmpegBin();

describe.skipIf(!ffmpeg.ok)('nativeExport ダッキング（実 ffmpeg 統合）', () => {
  it('duck 区間の RMS が gain 通りに減衰し、ducking 有無で PCM が実測差を持つ', () => {
    const bin = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';
    const dir = mkdtempSync(join(tmpdir(), 'native-export-ducking-e2e-'));
    const mainPath = join(dir, 'main.mp4');
    const bgmPath = join(dir, 'bgm.wav');
    const outDuckPath = join(dir, 'out-duck.mp4');
    const outNoDuckPath = join(dir, 'out-no-duck.mp4');
    const scriptDuckPath = join(dir, 'filter-duck.txt');
    const scriptNoDuckPath = join(dir, 'filter-no-duck.txt');
    try {
      // 1. main.mp4: 2秒・64x64・30fps + 無音（anullsrc — BGM だけを測るため）
      execFileSync(bin, [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=30',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:duration=2',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        mainPath,
      ]);

      // 2. bgm.wav: 2秒・660Hz・振幅ブースト（M1a の -af volume=10 先例）
      execFileSync(bin, [
        '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
        '-af', 'volume=10',
        bgmPath,
      ]);

      const cutScript = buildCutFilterScript([{ start: 0, end: 60 }], 30);

      // ducking あり: duck 区間 0.8s-1.2s（24-36 frame）に gain=0.25
      const duckScript = applyAudioMix(
        cutScript,
        [{
          startFrame: 0,
          endFrame: 60,
          volume: 0.5,
          ducking: {
            gain: 0.25,
            attackFrames: 3,
            releaseFrames: 9,
            regions: [{ start: 24, end: 36 }],
          },
        }],
        30,
      );
      writeFileSync(scriptDuckPath, duckScript);

      // ducking なし: 同一 MixClip から ducking のみ外す（比較対象）
      const noDuckScript = applyAudioMix(
        cutScript,
        [{ startFrame: 0, endFrame: 60, volume: 0.5 }],
        30,
      );
      writeFileSync(scriptNoDuckPath, noDuckScript);

      const target = { width: 64, height: 64 };
      const options = { resolution: 'full' as const, quality: 'standard' as const };

      execFileSync(bin, buildFastCutArgs({
        input: mainPath,
        filterScript: scriptDuckPath,
        output: outDuckPath,
        options,
        target,
        hardware: false,
        extraInputs: [{ path: bgmPath }],
      }));

      execFileSync(bin, buildFastCutArgs({
        input: mainPath,
        filterScript: scriptNoDuckPath,
        output: outNoDuckPath,
        options,
        target,
        hardware: false,
        extraInputs: [{ path: bgmPath }],
      }));

      // (a) フレーム数厳密一致
      expect(probeFrameCount(outDuckPath)).toBe(60);

      const decode = (p: string): Buffer =>
        execFileSync(
          bin,
          ['-hide_banner', '-i', p, '-map', 'a:0', '-f', 's16le', '-ac', '2', '-ar', '48000', '-'],
          { maxBuffer: 512 * 1024 * 1024 },
        );
      const duckPcm = decode(outDuckPath);
      const noDuckPcm = decode(outNoDuckPath);

      // (b) duck 中窓（sustain 純域）の RMS / 非 duck 窓の RMS が gain=0.25 の ±0.05 帯
      const duckRms = pcmWindowRms(duckPcm, 48000, 2, 0.9, 1.1);
      const outsideRms = pcmWindowRms(duckPcm, 48000, 2, 0.2, 0.6);
      const ratio = duckRms / outsideRms;
      expect(ratio).toBeGreaterThan(0.25 - 0.05);
      expect(ratio).toBeLessThan(0.25 + 0.05);

      // (c) ducking 無し版との comparePcm maxAbsDiff > 1000（式が実際に効いている証拠）
      expect(comparePcm(duckPcm, noDuckPcm).maxAbsDiff).toBeGreaterThan(1000);

      // かつ非 duck 窓同士の RMS 差 < 5%（duck 区間の外は不変）
      const noDuckOutsideRms = pcmWindowRms(noDuckPcm, 48000, 2, 0.2, 0.6);
      const outsideDiffRatio = Math.abs(outsideRms - noDuckOutsideRms) / noDuckOutsideRms;
      expect(outsideDiffRatio).toBeLessThan(0.05);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 実規模回帰（C-1・最終広域レビュー）: region 300 個の envelope で filter script が
   * 実 ffmpeg 8.1.2 の av_expr_parse に受理されることを検証する。
   * 平衡木化（buildDuckGainAst）前の線形 min 畳み込みは region 92 個で AST 深度が
   * av_expr_parse の再帰深度上限 100 を超え parse 失敗する（91 個は通る）。実プロジェクトの
   * 講義動画（7〜9 分）は 92〜111 region で該当していた。300 region は実プロジェクトの
   * 上限を大きく超える回帰ガードとして選んだ。
   * main は既存 fixture（main.mp4 相当・2秒・64x64・30fps）を流用し、音声内容の検証は行わず
   * 「受理される（ffmpeg が exit 0 で終わる）」と probeFrameCount のみを見る（実行時間を抑えるため）。
   */
  it('C-1: region 300 個の filter script が実 ffmpeg に受理される（av_expr_parse 深度上限の回帰）', () => {
    const bin = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';
    const dir = mkdtempSync(join(tmpdir(), 'native-export-ducking-300-'));
    const mainPath = join(dir, 'main.mp4');
    const bgmPath = join(dir, 'bgm.wav');
    const outPath = join(dir, 'out.mp4');
    const scriptPath = join(dir, 'filter-300.txt');
    try {
      execFileSync(bin, [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=30',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:duration=2',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        mainPath,
      ]);
      execFileSync(bin, [
        '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
        '-af', 'volume=10',
        bgmPath,
      ]);

      const cutScript = buildCutFilterScript([{ start: 0, end: 60 }], 30);

      // region 300 個: [0,1) を fps=30 の1 frame 幅で 300 個並べる（クリップ長 60 frame の外まで
      // はみ出しても構わない — 目的は AST 深度の規模を作ることであって、実際の可聴域ではない）。
      const regions = Array.from({ length: 300 }, (_, i) => ({ start: i * 2, end: i * 2 + 1 }));
      const script300 = applyAudioMix(
        cutScript,
        [{
          startFrame: 0,
          endFrame: 60,
          volume: 0.5,
          ducking: { gain: 0.25, attackFrames: 3, releaseFrames: 9, regions },
        }],
        30,
      );
      writeFileSync(scriptPath, script300);

      const target = { width: 64, height: 64 };
      const options = { resolution: 'full' as const, quality: 'standard' as const };

      // ここが本検証: av_expr_parse に受理されず exit 非0 で execFileSync が投げれば FAIL。
      execFileSync(bin, buildFastCutArgs({
        input: mainPath,
        filterScript: scriptPath,
        output: outPath,
        options,
        target,
        hardware: false,
        extraInputs: [{ path: bgmPath }],
      }));

      expect(probeFrameCount(outPath)).toBe(60);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
