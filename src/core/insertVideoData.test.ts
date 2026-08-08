import { describe, expect, it, test } from 'vitest';
import {
  parseInsertVideoData,
  serializeInsertVideoData,
  formatInsertVideoArray,
} from './insertVideoData';
import type { VideoInsert } from './types';

describe('parseInsertVideoData', () => {
  it('source が null なら空配列', () => {
    expect(parseInsertVideoData(null, 60)).toEqual([]);
  });

  it('配列を読み取る', () => {
    const src = `import type { VideoInsert } from './types';
export const insertVideoData: VideoInsert[] = [
  { id: 1, startFrame: 100, endFrame: 200, file: "sub/cam2.mp4", sourceInFrame: 30 },
];
`;
    expect(parseInsertVideoData(src, 60)).toEqual([
      { id: 1, startFrame: 100, endFrame: 200, file: 'sub/cam2.mp4', sourceInFrame: 30 },
    ]);
  });

  it('insertVideoData 配列が無ければ例外', () => {
    const src = `export const wrong = [];`;
    expect(() => parseInsertVideoData(src, 60)).toThrow();
  });
});

describe('formatInsertVideoArray', () => {
  it('空配列は []', () => {
    expect(formatInsertVideoArray([])).toBe('[]');
  });

  it('position / scale を含めて整形する', () => {
    const items: VideoInsert[] = [
      { id: 1, startFrame: 0, endFrame: 10, file: 'a.mp4', sourceInFrame: 5, position: { x: 0.2, y: -0.3 }, scale: 0.5 },
    ];
    const out = formatInsertVideoArray(items);
    expect(out).toContain('id: 1,');
    expect(out).toContain('sourceInFrame: 5,');
    expect(out).toContain('position: { x: 0.2, y: -0.3 },');
    expect(out).toContain('scale: 0.5,');
    expect(out).toContain('file: "a.mp4",');
  });

  it('未指定の position / scale は出力しない', () => {
    const items: VideoInsert[] = [
      { id: 1, startFrame: 0, endFrame: 10, file: 'a.mp4', sourceInFrame: 0 },
    ];
    const out = formatInsertVideoArray(items);
    expect(out).not.toContain('position');
    expect(out).not.toContain('scale');
  });
});

describe('formatInsertVideoArray enter/exit', () => {
  it('enter/exit を指定時のみ出力', () => {
    const out = formatInsertVideoArray([
      {
        id: 1, startFrame: 0, endFrame: 90, file: 'b.mp4', sourceInFrame: 0,
        enter: { kind: 'fade', frames: 8 },
      },
    ]);
    expect(out).toContain('enter: { kind: "fade", frames: 8 },');
    expect(out).not.toContain('exit:');
  });
});

describe('serializeInsertVideoData', () => {
  it('originalSource が null かつ空なら null（空ファイルを作らない）', () => {
    expect(serializeInsertVideoData(null, [])).toBeNull();
  });

  it('originalSource が null かつクリップありなら新規雛形を生成', () => {
    const items: VideoInsert[] = [
      { id: 1, startFrame: 0, endFrame: 10, file: 'a.mp4', sourceInFrame: 0 },
    ];
    const out = serializeInsertVideoData(null, items);
    expect(out).toContain("import type { VideoInsert } from './types';");
    expect(out).toContain('export const insertVideoData: VideoInsert[] = [');
    expect(out).toContain('file: "a.mp4",');
  });

  it('往復: parse(serialize(x)) === x', () => {
    const items: VideoInsert[] = [
      { id: 1, startFrame: 0, endFrame: 10, file: 'a.mp4', sourceInFrame: 0 },
      { id: 2, startFrame: 50, endFrame: 80, file: 'sub/b.mp4', sourceInFrame: 12, position: { x: 0.1, y: 0.2 }, scale: 0.4 },
    ];
    const src = serializeInsertVideoData(null, items);
    expect(src).not.toBeNull();
    expect(parseInsertVideoData(src, 60)).toEqual(items);
  });
});

test('playbackRate を serialize→parse で round-trip 保持する', () => {
  const src = serializeInsertVideoData(null, [
    { id: 1, startFrame: 0, endFrame: 240, file: 'sub/a.mp4', sourceInFrame: 0, playbackRate: 0.5 },
  ]);
  expect(src).not.toBeNull();
  const parsed = parseInsertVideoData(src, 60);
  expect(parsed[0]?.playbackRate).toBe(0.5);
});

test('playbackRate 未指定なら出力に playbackRate 行を含めない（後方互換）', () => {
  const out = formatInsertVideoArray([
    { id: 1, startFrame: 0, endFrame: 120, file: 'sub/a.mp4', sourceInFrame: 0 },
  ]);
  expect(out).not.toContain('playbackRate');
});
