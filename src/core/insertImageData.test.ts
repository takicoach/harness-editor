import { describe, expect, it } from 'vitest';
import {
  parseInsertImageData,
  formatInsertImageArray,
  serializeInsertImageData,
} from './insertImageData';
import type { ImageSegment } from './types';

const SOURCE = `import { FPS } from '../videoConfig';
import type { ImageSegment } from './types';

const toFrame = (sec: number) => Math.floor(sec * FPS);

// ==== 挿入画像配置データ ====
export const insertImageData: ImageSegment[] = [
  { id: 1, startFrame: toFrame(3.0), endFrame: toFrame(5.5), file: 'photo1.png', type: 'photo' },
  { id: 2, startFrame: 300, endFrame: 450, file: 'gen/info.png', type: 'infographic', scale: 1.2 },
];
`;

describe('parseInsertImageData', () => {
  it('insertImageData 配列を読み取り toFrame を解決する', () => {
    const images = parseInsertImageData(SOURCE, 60);
    expect(images).toEqual([
      { id: 1, startFrame: 180, endFrame: 330, file: 'photo1.png', type: 'photo' },
      { id: 2, startFrame: 300, endFrame: 450, file: 'gen/info.png', type: 'infographic', scale: 1.2 },
    ]);
  });

  it('source が null なら空配列', () => {
    expect(parseInsertImageData(null, 60)).toEqual([]);
  });

  it('insertImageData が配列でなければ throw する', () => {
    expect(() => parseInsertImageData('export const insertImageData = 5;', 60)).toThrow(
      /insertImageData 配列/,
    );
  });
});

describe('formatInsertImageArray', () => {
  it('空配列は []', () => {
    expect(formatInsertImageArray([])).toBe('[]');
  });

  it('scale 未定義は出力しない', () => {
    const images: ImageSegment[] = [
      { id: 2, startFrame: 60, endFrame: 200, file: 'a.png', type: 'photo' },
    ];
    const out = formatInsertImageArray(images);
    expect(out).toContain('id: 2,');
    expect(out).toContain('startFrame: 60,');
    expect(out).toContain('endFrame: 200,');
    expect(out).toContain('file: "a.png",');
    expect(out).toContain('type: "photo",');
    expect(out).not.toContain('scale');
  });

  it('特殊文字を含むファイル名をエスケープする', () => {
    const out = formatInsertImageArray([
      { id: 1, startFrame: 0, endFrame: 60, file: 'a"b\\c.png', type: 'photo' },
    ]);
    expect(out).toContain('file: "a\\"b\\\\c.png",');
  });
});

describe('serializeInsertImageData', () => {
  it('配列リテラルだけ差し替え import / ヘッダを保つ', () => {
    const out = serializeInsertImageData(SOURCE, [
      { id: 9, startFrame: 100, endFrame: 200, file: 'x.png', type: 'overlay' },
    ]);
    expect(out).toContain("import { FPS } from '../videoConfig';");
    expect(out).toContain("import type { ImageSegment } from './types';");
    expect(out).toContain('// ==== 挿入画像配置データ ====');
    expect(out).toContain('id: 9,');
    expect(out).toContain('type: "overlay",');
    expect(out).not.toContain('photo1.png');
    expect(parseInsertImageData(out, 60)).toEqual([
      { id: 9, startFrame: 100, endFrame: 200, file: 'x.png', type: 'overlay' },
    ]);
  });

  it('source が null かつ画像が空なら null（ファイルを作らない）', () => {
    expect(serializeInsertImageData(null, [])).toBeNull();
  });

  it('source が null かつ画像があれば新規ファイル雛形を生成する', () => {
    const out = serializeInsertImageData(null, [
      { id: 1, startFrame: 10, endFrame: 90, file: 'a.png', type: 'photo' },
    ]);
    expect(out).not.toBeNull();
    expect(out).toContain('export const insertImageData');
    expect(out).toContain("import type { ImageSegment } from './types'");
    expect(parseInsertImageData(out, 60)).toEqual([
      { id: 1, startFrame: 10, endFrame: 90, file: 'a.png', type: 'photo' },
    ]);
  });

  it('既存ソース + 空配列なら insertImageData 配列を [] にする', () => {
    const out = serializeInsertImageData(SOURCE, []);
    expect(out).not.toBeNull();
    expect(parseInsertImageData(out, 60)).toEqual([]);
  });
});

describe('insertImageData position 往復', () => {
  it('position を配列リテラルへ出力する', () => {
    const out = formatInsertImageArray([
      { id: 1, startFrame: 0, endFrame: 120, file: 'a.png', type: 'photo', position: { x: -0.5, y: 0.25 }, scale: 0.8 },
    ]);
    expect(out).toContain('position: { x: -0.5, y: 0.25 },');
    expect(out).toContain('scale: 0.8,');
  });
  it('position 無しは出力しない（後方互換）', () => {
    const out = formatInsertImageArray([{ id: 1, startFrame: 0, endFrame: 120, file: 'a.png', type: 'photo' }]);
    expect(out).not.toContain('position:');
  });
  it('parse→format の往復で position が保たれる', () => {
    const src = `import type { ImageSegment } from './types';
export const insertImageData: ImageSegment[] = [
  { id: 1, startFrame: 0, endFrame: 120, file: "a.png", type: "photo", position: { x: 0.5, y: -0.5 }, scale: 1 },
];`;
    const parsed = parseInsertImageData(src, 60);
    expect(parsed[0]?.position).toEqual({ x: 0.5, y: -0.5 });
  });
});

describe('formatInsertImageArray enter/exit', () => {
  it('enter/exit を指定時のみ出力（direction は slideIn のみ）', () => {
    const out = formatInsertImageArray([
      {
        id: 1, startFrame: 0, endFrame: 120, file: 'a.png', type: 'photo',
        enter: { kind: 'zoom', frames: 12 },
        exit: { kind: 'slideIn', frames: 10, direction: 'down' },
      },
    ]);
    expect(out).toContain('enter: { kind: "zoom", frames: 12 },');
    expect(out).toContain('exit: { kind: "slideIn", frames: 10, direction: "down" },');
  });
  it('未指定なら enter/exit を出力しない', () => {
    const out = formatInsertImageArray([
      { id: 1, startFrame: 0, endFrame: 120, file: 'a.png', type: 'photo' },
    ]);
    expect(out).not.toContain('enter:');
    expect(out).not.toContain('exit:');
  });
});

describe('insertImageData opacity/rotation 往復', () => {
  it('opacity / rotation を配列リテラルへ出力する', () => {
    const out = formatInsertImageArray([
      { id: 1, startFrame: 0, endFrame: 120, file: 'a.png', type: 'photo', opacity: 0.5, rotation: 20 },
    ]);
    expect(out).toContain('opacity: 0.5,');
    expect(out).toContain('rotation: 20,');
  });
  it('opacity / rotation 無しは出力しない（後方互換）', () => {
    const out = formatInsertImageArray([{ id: 1, startFrame: 0, endFrame: 120, file: 'a.png', type: 'photo' }]);
    expect(out).not.toContain('opacity:');
    expect(out).not.toContain('rotation:');
  });
  it('parse→format の往復で opacity / rotation が保たれる', () => {
    const src = `import type { ImageSegment } from './types';
export const insertImageData: ImageSegment[] = [
  { id: 1, startFrame: 0, endFrame: 120, file: "a.png", type: "photo", opacity: 0.3, rotation: -45 },
];`;
    const parsed = parseInsertImageData(src, 60);
    expect(parsed[0]?.opacity).toBe(0.3);
    expect(parsed[0]?.rotation).toBe(-45);
    const out = formatInsertImageArray(parsed);
    expect(out).toContain('opacity: 0.3,');
    expect(out).toContain('rotation: -45,');
  });
});

describe('insertImageData motion（2点アニメ）', () => {
  it('motion を書き出して往復できる', async () => {
    const { serializeInsertImageData, parseInsertImageData } = await import('./insertImageData');
    const out = serializeInsertImageData(null, [
      {
        id: 1, startFrame: 0, endFrame: 60, file: 'a.png', type: 'photo',
        motion: { preset: 'panRight', intensity: 0.4, from: { opacity: 0.5 } },
      },
    ]);
    expect(parseInsertImageData(out, 60)[0]).toMatchObject({
      motion: { preset: 'panRight', intensity: 0.4, from: { opacity: 0.5 } },
    });
  });
});
