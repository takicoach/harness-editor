import { describe, it, expect } from 'vitest';
import { parseTelopData, serializeTelopData, formatTelopArray } from './telopData';
import { TELOP_DATA_SOURCE } from './__fixtures__/telopData.fixture';
import { ProjectFileError } from './types';

describe('parseTelopData', () => {
  it('telopData 配列を TelopSegment[] として読む', () => {
    const telops = parseTelopData(TELOP_DATA_SOURCE, 60, 12000);
    expect(telops).toHaveLength(2);
    expect(telops[0]).toMatchObject({
      id: 1,
      startFrame: 30,
      endFrame: 150,
      text: 'ゆる素振り\nご紹介いたします',
      style: 'emphasis',
      template: 1,
    });
  });

  it('telopData が無いと ProjectFileError を投げる', () => {
    expect(() => parseTelopData('export const x = 1;', 60, 12000)).toThrow(ProjectFileError);
  });
});

describe('serializeTelopData', () => {
  it('読み込み→書き出しで telopData を往復できる', () => {
    const telops = parseTelopData(TELOP_DATA_SOURCE, 60, 12000);
    const out = serializeTelopData(TELOP_DATA_SOURCE, telops);
    expect(parseTelopData(out, 60, 12000)).toEqual(telops);
  });

  it('import 文とヘッダコメントを保持する', () => {
    const telops = parseTelopData(TELOP_DATA_SOURCE, 60, 12000);
    const out = serializeTelopData(TELOP_DATA_SOURCE, telops);
    expect(out).toContain("import type { TelopSegment } from './telopTypes';");
    expect(out).toContain('// ===== テロップデータ =====');
    expect(out).toContain('export const TOTAL_FRAMES = DURATION_FRAMES;');
  });

  it('position / scale を書き出せる', () => {
    const out = serializeTelopData(TELOP_DATA_SOURCE, [
      { id: 1, startFrame: 0, endFrame: 60, text: 'a', position: { x: 0.2, y: -0.3 }, scale: 1.5 },
    ]);
    expect(parseTelopData(out, 60, 12000)[0]).toMatchObject({
      position: { x: 0.2, y: -0.3 },
      scale: 1.5,
    });
  });

  it('motion（2点アニメ）を書き出して往復できる', () => {
    const out = serializeTelopData(TELOP_DATA_SOURCE, [
      {
        id: 1, startFrame: 0, endFrame: 60, text: 'a',
        motion: { preset: 'zoomIn', intensity: 0.7, to: { scale: 2 } },
      },
    ]);
    expect(parseTelopData(out, 60, 12000)[0]).toMatchObject({
      motion: { preset: 'zoomIn', intensity: 0.7, to: { scale: 2 } },
    });
  });

  it('未指定の任意フィールドは出力しない', () => {
    const out = serializeTelopData(TELOP_DATA_SOURCE, [
      { id: 1, startFrame: 0, endFrame: 60, text: 'a' },
    ]);
    expect(out).not.toContain('style:');
    expect(out).not.toContain('position:');
    expect(out).not.toContain('motion:');
  });

  it('改行コード（\\r\\n）を含むテキストを壊さず往復できる', () => {
    const out = serializeTelopData(TELOP_DATA_SOURCE, [
      { id: 1, startFrame: 0, endFrame: 60, text: 'first\r\nsecond' },
    ]);
    expect(parseTelopData(out, 60, 12000)[0]!.text).toBe('first\r\nsecond');
  });

  it('originalStart / originalEnd を持つテロップでそれらを数値リテラルとして出力する', () => {
    const out = serializeTelopData(TELOP_DATA_SOURCE, [
      {
        id: 1,
        startFrame: 0,
        endFrame: 0,
        text: 'カットされたテロップ',
        originalStart: 350,
        originalEnd: 450,
      },
    ]);
    // 数値リテラルとして出力される
    expect(out).toContain('originalStart: 350,');
    expect(out).toContain('originalEnd: 450,');
    // パース後にも値が残る
    const parsed = parseTelopData(out, 60, 12000);
    expect(parsed[0]).toMatchObject({ originalStart: 350, originalEnd: 450 });
  });

  it('originalStart / originalEnd を持たないテロップではそれらを出力しない', () => {
    const out = serializeTelopData(TELOP_DATA_SOURCE, [
      { id: 1, startFrame: 30, endFrame: 150, text: 'normal telop' },
    ]);
    expect(out).not.toContain('originalStart:');
    expect(out).not.toContain('originalEnd:');
  });
});

describe('formatTelopArray の manual 出力', () => {
  it('manual:true を書き出す', () => {
    const out = formatTelopArray([
      { id: 1, startFrame: 0, endFrame: 30, text: 'a', manual: true },
    ]);
    expect(out).toContain('manual: true');
  });
  it('manual 無しは書き出さない', () => {
    const out = formatTelopArray([
      { id: 1, startFrame: 0, endFrame: 30, text: 'a' },
    ]);
    expect(out).not.toContain('manual');
  });
});

describe('飾りテロップ規約のシリアライズ', () => {
  it('manual:true と position を出力する', () => {
    const out = formatTelopArray([
      { id: 1, startFrame: 100, endFrame: 400, text: 'ゆる素振り', manual: true, position: { x: -0.55, y: -0.85 } },
    ]);
    expect(out).toContain('manual: true,');
    expect(out).toContain('position: { x: -0.55, y: -0.85 },');
  });
});
