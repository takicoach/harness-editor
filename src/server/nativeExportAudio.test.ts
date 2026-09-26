import { describe, expect, it } from 'vitest';
import { applyAudioMix } from './nativeExportAudio';

const BASE = '[0:v]fps=30,trim=start=0.000000:end=1.000000,setpts=PTS-STARTPTS[v0];\n' +
  '[0:a]atrim=start=0.000000:end=1.000000,asetpts=PTS-STARTPTS[a0];\n' +
  '[v0][a0]concat=n=1:v=1:a=1[outv][outa]\n';

describe('applyAudioMix', () => {
  it('クリップ空なら不変', () => {
    expect(applyAudioMix(BASE, [], 30)).toBe(BASE);
  });
  it('concat の [outa] を [cuta] に付け替え、各系統と amix を追記する', () => {
    const out = applyAudioMix(BASE, [
      { startFrame: 30, endFrame: 120, volume: 0.3 },
    ], 30);
    expect(out).toContain('[outv][cuta]');
    expect(out).toContain('[1:a]atrim=0:3.000000,asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.3,adelay=1000:all=1[mix0]');
    expect(out).toContain('amix=inputs=2:normalize=0:dropout_transition=0:duration=first[outa]');
  });
  it('フェードは afade（in: st=0 / out: st=(dur-1-fadeOut)/fps）で入る', () => {
    const out = applyAudioMix(BASE, [
      { startFrame: 0, endFrame: 90, volume: 1, fadeInFrames: 6, fadeOutFrames: 9 },
    ], 30);
    expect(out).toContain('afade=t=in:st=0:d=0.200000');
    expect(out).toContain('afade=t=out:st=2.666667:d=0.300000');
    expect(out).not.toContain('volume='); // volume 1 は省略
  });
  it('fadeOut が尺より長い場合は st=0・d=(dur-1)/fps に丸まる（尺をはみ出さない）', () => {
    const out = applyAudioMix(BASE, [
      { startFrame: 0, endFrame: 30, volume: 1, fadeOutFrames: 100 },
    ], 30);
    expect(out).toContain('afade=t=out:st=0.000000:d=0.966667');
  });
  it('複数クリップは配列順に [1:a][2:a]... と対応しラベルが一意', () => {
    const out = applyAudioMix(BASE, [
      { startFrame: 30, endFrame: 120, volume: 0.3 },
      { startFrame: 0, endFrame: 60, volume: 0.2, fadeInFrames: 6 },
    ], 30);
    expect(out).toContain('[1:a]');
    expect(out).toContain('[2:a]');
    expect(out).toContain('amix=inputs=3:normalize=0:dropout_transition=0:duration=first[outa]');
  });

  describe('ducking', () => {
    it('volume 式（eval=frame）が afade と adelay の間に挿入される（fade あり）', () => {
      const out = applyAudioMix(BASE, [
        {
          startFrame: 0,
          endFrame: 90,
          volume: 1,
          fadeInFrames: 6,
          fadeOutFrames: 9,
          ducking: { regions: [{ start: 10, end: 20 }], gain: 0.25, attackFrames: 3, releaseFrames: 3 },
        },
      ], 30);
      expect(out).toContain("volume='");
      expect(out).toContain(':eval=frame');
      const afadeOutIdx = out.indexOf('afade=t=out');
      const volumeExprIdx = out.indexOf("volume='");
      const adelayIdx = out.indexOf('adelay=');
      expect(afadeOutIdx).toBeGreaterThan(-1);
      expect(volumeExprIdx).toBeGreaterThan(afadeOutIdx);
      expect(adelayIdx).toBeGreaterThan(volumeExprIdx);
    });

    it('volume 式が volume=const（fade 無し）の直後・adelay の前に入る', () => {
      const out = applyAudioMix(BASE, [
        {
          startFrame: 30,
          endFrame: 120,
          volume: 0.3,
          ducking: { regions: [{ start: 10, end: 20 }], gain: 0.25, attackFrames: 3, releaseFrames: 3 },
        },
      ], 30);
      const constVolumeIdx = out.indexOf('volume=0.3');
      const exprVolumeIdx = out.indexOf("volume='");
      const adelayIdx = out.indexOf('adelay=');
      expect(constVolumeIdx).toBeGreaterThan(-1);
      expect(exprVolumeIdx).toBeGreaterThan(constVolumeIdx);
      expect(adelayIdx).toBeGreaterThan(exprVolumeIdx);
    });

    it("式はカンマ・コロンを含むためシングルクォートで囲まれる（volume='...':eval=frame）", () => {
      const out = applyAudioMix(BASE, [
        {
          startFrame: 0,
          endFrame: 60,
          volume: 1,
          ducking: { regions: [{ start: 10, end: 20 }], gain: 0.25, attackFrames: 3, releaseFrames: 3 },
        },
      ], 30);
      const match = out.match(/volume='([^']+)':eval=frame/);
      expect(match).not.toBeNull();
      // 式自体にカンマ・コロン（if/min/lt の区切り）が含まれることを確認 — クォートが必須である根拠
      expect(match![1]).toMatch(/[,:]/);
    });

    it('ducking undefined なら volume 式は挿入されない（既存挙動）', () => {
      const out = applyAudioMix(BASE, [
        { startFrame: 30, endFrame: 120, volume: 0.3 },
      ], 30);
      expect(out).not.toContain(':eval=frame');
    });
  });
});
