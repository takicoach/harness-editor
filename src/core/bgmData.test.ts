import { describe, expect, it } from 'vitest';
import { parseBgmData, formatBgmArray, serializeBgmData, bgmSourceHasDucking } from './bgmData';
import type { BgmClip } from './types';

const sample: BgmClip[] = [
  { id: 1, file: 'bright.mp3', startFrame: 0, endFrame: 600, volume: 0.2, fadeInFrames: 30, fadeOutFrames: 30 },
  { id: 2, file: 'calm.mp3', startFrame: 600, endFrame: 1200, volume: 0.12, fadeInFrames: 0, fadeOutFrames: 60 },
];

describe('parseBgmData', () => {
  it('source が null なら空配列', () => {
    expect(parseBgmData(null)).toEqual([]);
  });

  it('bgmData 配列を読み取る', () => {
    const src = `import type { BgmClip } from './types';
export const bgmData: BgmClip[] = [
  { id: 1, file: "bright.mp3", startFrame: 0, endFrame: 600, volume: 0.2, fadeInFrames: 30, fadeOutFrames: 30 },
];`;
    const r = parseBgmData(src);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: 1, file: 'bright.mp3', startFrame: 0, endFrame: 600, volume: 0.2 });
  });

  it('volume を [0,1] にクランプし、fade を 0 以上にする', () => {
    const src = `export const bgmData = [
      { id: 1, file: "a.mp3", startFrame: 0, endFrame: 100, volume: 1.5, fadeInFrames: -5, fadeOutFrames: 10 },
      { id: 2, file: "b.mp3", startFrame: 0, endFrame: 100, volume: -0.3, fadeInFrames: 0, fadeOutFrames: 0 },
    ];`;
    const r = parseBgmData(src);
    expect(r[0]!.volume).toBe(1);
    expect(r[0]!.fadeInFrames).toBe(0);
    expect(r[1]!.volume).toBe(0);
  });
});

describe('formatBgmArray / serializeBgmData', () => {
  it('空配列は []', () => {
    expect(formatBgmArray([])).toBe('[]');
  });

  it('clips が空で source が null なら null を返す', () => {
    expect(serializeBgmData([], null)).toBeNull();
  });

  it('往復（serialize→parse）で内容が保たれる', () => {
    const src = serializeBgmData(sample, null) as string;
    const back = parseBgmData(src);
    expect(back).toEqual(sample);
  });

  it('既存 source の配列だけ置換しても往復する（replaceExportArray パス）', () => {
    const initial = serializeBgmData([sample[0]!], null) as string;
    const updated = serializeBgmData(sample, initial) as string;
    expect(parseBgmData(updated)).toEqual(sample);
    expect(updated).toContain("import type { BgmClip }"); // ヘッダ保持
  });

  it('ファイル名の特殊文字をエスケープする', () => {
    const out = formatBgmArray([{ id: 1, file: 'a"b.mp3', startFrame: 0, endFrame: 10, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 }]);
    expect(out).toContain('\\"');
  });
});

describe('formatBgmArray — ducking', () => {
  const base: BgmClip = { id: 1, file: 'a.mp3', startFrame: 0, endFrame: 100, volume: 0.5, fadeInFrames: 0, fadeOutFrames: 0 };

  it('ducking 無しは出力に含めない', () => {
    expect(formatBgmArray([base])).not.toContain('ducking');
  });
  it('ducking 有りは出力に含める', () => {
    const withDuck: BgmClip = { ...base, ducking: { regions: [{ start: 0, end: 30 }], gain: 0.5, attackFrames: 3, releaseFrames: 9 } };
    const out = formatBgmArray([withDuck]);
    expect(out).toContain('ducking:');
    expect(out).toContain('gain: 0.5');
    expect(out).toContain('start: 0');
    expect(out).toContain('end: 30');
  });
  it('出力は parseBgmData で往復でき ducking は読み戻されない（派生）', () => {
    const withDuck: BgmClip = { ...base, ducking: { regions: [{ start: 0, end: 30 }], gain: 0.5, attackFrames: 3, releaseFrames: 9 } };
    const source = `import type { BgmClip } from './types';\nexport const bgmData: BgmClip[] = ${formatBgmArray([withDuck])};\n`;
    const parsed = parseBgmData(source);
    expect(parsed[0]!.volume).toBe(0.5);
    expect(parsed[0]!.ducking).toBeUndefined();
  });
  it('ducking.regions 複数は正しくカンマ区切りで出力する', () => {
    const withDuck: BgmClip = {
      ...base,
      ducking: { regions: [{ start: 0, end: 30 }, { start: 60, end: 90 }], gain: 0.3, attackFrames: 2, releaseFrames: 6 },
    };
    const out = formatBgmArray([withDuck]);
    expect(out).toContain('{ start: 0, end: 30 }, { start: 60, end: 90 }');
  });
});

describe('bgmSourceHasDucking', () => {
  it('source が null なら false', () => {
    expect(bgmSourceHasDucking(null)).toBe(false);
  });

  it('ducking 有りなら true（formatBgmArray の整形出力）', () => {
    const withDuck: BgmClip = {
      id: 1, file: 'a.mp3', startFrame: 0, endFrame: 100, volume: 0.5, fadeInFrames: 0, fadeOutFrames: 0,
      ducking: { regions: [{ start: 0, end: 30 }], gain: 0.5, attackFrames: 3, releaseFrames: 9 },
    };
    const source = `import type { BgmClip } from './types';\nexport const bgmData: BgmClip[] = ${formatBgmArray([withDuck])};\n`;
    expect(bgmSourceHasDucking(source)).toBe(true);
  });

  it('ducking 無しなら false', () => {
    const source = `import type { BgmClip } from './types';\nexport const bgmData: BgmClip[] = ${formatBgmArray([{ ...sample[0]! }])};\n`;
    expect(bgmSourceHasDucking(source)).toBe(false);
  });

  it('1 行に潰した形（ducking が行頭に来ない）でも true を検知する（評価済みモジュール判定・整形非依存）', () => {
    const source =
      "export const bgmData = [{ id:1, file:'a.mp3', startFrame:0, endFrame:45, volume:0.2, fadeInFrames:0, fadeOutFrames:0, ducking: { gain: 0.3 } }];";
    expect(bgmSourceHasDucking(source)).toBe(true);
  });

  it('パース不能（配列でない）なら安全側で true', () => {
    expect(bgmSourceHasDucking('export const bgmData = 123;')).toBe(true);
  });

  it('評価失敗（構文エラー）なら安全側で true', () => {
    expect(bgmSourceHasDucking('export const bgmData = [{{{ syntax error')).toBe(true);
  });
});
