import { describe, expect, it } from 'vitest';
import { parseSeData, formatSeArray, serializeSeData } from './seData';
import type { SoundEffect } from './types';

const SOURCE = `import type { SoundEffect } from './SEPlayer';

// ==== SE配置データ ====
export const seData: SoundEffect[] = [
  { id: 1, startFrame: 30, file: 'パッ (1).mp3', volume: 0.3 },
];
`;

describe('parseSeData', () => {
  it('seData 配列を読み取る', () => {
    const se = parseSeData(SOURCE);
    expect(se).toEqual([{ id: 1, startFrame: 30, file: 'パッ (1).mp3', volume: 0.3 }]);
  });

  it('source が null なら空配列', () => {
    expect(parseSeData(null)).toEqual([]);
  });

  it('seData が配列でなければ throw する', () => {
    expect(() => parseSeData('export const seData = 5;')).toThrow(/seData 配列/);
  });
});

describe('formatSeArray', () => {
  it('空配列は []', () => {
    expect(formatSeArray([])).toBe('[]');
  });

  it('volume 未定義は出力しない', () => {
    const se: SoundEffect[] = [{ id: 2, startFrame: 60, file: 'ポン.mp3' }];
    const out = formatSeArray(se);
    expect(out).toContain('id: 2,');
    expect(out).toContain('startFrame: 60,');
    expect(out).toContain('file: "ポン.mp3",');
    expect(out).not.toContain('volume');
  });

  it('特殊文字を含むファイル名をエスケープする', () => {
    const out = formatSeArray([{ id: 1, startFrame: 0, file: 'a"b\\c.mp3' }]);
    expect(out).toContain('file: "a\\"b\\\\c.mp3",');
  });

  it('formatSeArray は endFrame を常に出力しフェードは非0のみ出力', () => {
    const out = formatSeArray([
      { id: 1, startFrame: 30, endFrame: 120, file: 'a.mp3', volume: 0.3 },
      { id: 2, startFrame: 0, endFrame: 60, file: 'b.mp3', fadeInFrames: 5, fadeOutFrames: 0 },
    ]);
    expect(out).toContain('endFrame: 120,');
    expect(out).toContain('fadeInFrames: 5,');
    expect(out).not.toContain('fadeOutFrames:'); // 0 は省略
  });
});

describe('serializeSeData', () => {
  it('配列リテラルだけ差し替え import / ヘッダを保つ', () => {
    const out = serializeSeData(SOURCE, [{ id: 9, startFrame: 99, file: 'x.mp3' }]);
    expect(out).toContain("import type { SoundEffect } from './SEPlayer';");
    expect(out).toContain('// ==== SE配置データ ====');
    expect(out).toContain('id: 9,');
    expect(out).not.toContain('パッ');
    expect(parseSeData(out)).toEqual([{ id: 9, startFrame: 99, file: 'x.mp3' }]);
  });

  it('source が null かつ SE が空なら null（ファイルを作らない）', () => {
    expect(serializeSeData(null, [])).toBeNull();
  });

  it('source が null かつ SE があれば新規ファイル雛形を生成する', () => {
    const out = serializeSeData(null, [{ id: 1, startFrame: 10, file: 'a.mp3' }]);
    expect(out).not.toBeNull();
    expect(out).toContain('export const seData');
    expect(parseSeData(out)).toEqual([{ id: 1, startFrame: 10, file: 'a.mp3' }]);
  });

  it('既存ソース + 空配列なら seData 配列を [] にする', () => {
    const out = serializeSeData(SOURCE, []);
    expect(out).not.toBeNull();
    expect(parseSeData(out)).toEqual([]);
  });
});
