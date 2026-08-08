import { describe, it, expect } from 'vitest';
import { parseTitleData, serializeTitleData, formatTitleArray, TITLE_DATA_TEMPLATE } from './titleData';
import type { TitleSegment } from './types';

const SRC = `import type { TitleSegment } from './Title';
import { FPS } from '../videoConfig';
const toFrame = (s: number) => Math.round(s * FPS);
export const titleData: TitleSegment[] = [
  { id: 1, startFrame: toFrame(0), endFrame: toFrame(5), text: 'イントロ' },
];
`;

describe('parseTitleData', () => {
  it('titleData 配列を抽出する', () => {
    const out = parseTitleData(SRC, 30, 9000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 1, startFrame: 0, endFrame: 150, text: 'イントロ' });
  });
  it('空配列も読める', () => {
    const empty = SRC.replace(/= \[[\s\S]*\];/, '= [];');
    expect(parseTitleData(empty, 30, 9000)).toEqual([]);
  });
});

describe('formatTitleArray / serializeTitleData round-trip', () => {
  it('id/startFrame/endFrame/text が往復で一致する（I-1 修正: originalStart/End は書き出さない）', () => {
    const segs: TitleSegment[] = [
      { id: 1, startFrame: 0, endFrame: 150, text: 'A' },
      { id: 2, startFrame: 200, endFrame: 300, text: 'B' },
    ];
    const out = serializeTitleData(SRC, segs);
    const reparsed = parseTitleData(out, 30, 9000);
    // id/startFrame/endFrame/text が一致することを確認（往復の正の検証）
    expect(reparsed).toEqual(segs);
    // originalStart/End は出力されない（書き出しパスを停止した結果）
    expect(out).not.toContain('originalStart');
    expect(out).not.toContain('originalEnd');
  });
  it('originalStart/End を持つセグメントを渡しても出力には含まれない（後方互換読み込みの対称）', () => {
    // 読み込みは originalStart/End を型として受け入れる（後方互換）が、書き出しはしない。
    const segsWithOriginal: TitleSegment[] = [
      { id: 1, startFrame: 0, endFrame: 150, text: 'A', originalStart: 10, originalEnd: 200 },
    ];
    const out = serializeTitleData(SRC, segsWithOriginal);
    expect(out).not.toContain('originalStart');
    expect(out).not.toContain('originalEnd');
    // id/startFrame/endFrame/text は正しく出力される
    const reparsed = parseTitleData(out, 30, 9000);
    expect(reparsed[0]).toMatchObject({ id: 1, startFrame: 0, endFrame: 150, text: 'A' });
  });
  it('空配列は [] を出力', () => {
    expect(formatTitleArray([])).toBe('[]');
  });

  it('エスケープが必要な文字（" / バックスラッシュ / 改行）を含む text が往復で一致する', () => {
    const segs: TitleSegment[] = [
      { id: 1, startFrame: 0, endFrame: 150, text: '練習"ドリル"' }, // ダブルクオート
      { id: 2, startFrame: 200, endFrame: 300, text: 'C:\\path\\to' }, // バックスラッシュ
      { id: 3, startFrame: 400, endFrame: 500, text: '前半\n後半' }, // 改行
      { id: 4, startFrame: 600, endFrame: 700, text: 'a"b\\c\nd' }, // 複合
    ];
    const out = serializeTitleData(SRC, segs);
    // 生成ソースは有効な TS（評価して読み戻せる）であり、text が原文どおり復元される。
    const reparsed = parseTitleData(out, 30, 9000);
    expect(reparsed).toEqual(segs);
  });
});

describe('TITLE_DATA_TEMPLATE', () => {
  it('空の titleData を持つ生成可能なソース', () => {
    expect(parseTitleData(TITLE_DATA_TEMPLATE, 30, 9000)).toEqual([]);
  });
});
