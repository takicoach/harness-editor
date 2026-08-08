import { describe, it, expect } from 'vitest';
import { parseCutData, serializeCutData } from './cutData';
import { CUT_DATA_SOURCE } from './__fixtures__/cutData.fixture';
import { ProjectFileError } from './types';

describe('parseCutData', () => {
  it('cutData 配列を CutSegment[] として読む（toFrame 呼び出しも評価）', () => {
    const cuts = parseCutData(CUT_DATA_SOURCE);
    expect(cuts).toHaveLength(2);
    expect(cuts[0]).toEqual({
      id: 1, originalStart: 0, originalEnd: 3000, playbackStart: 0, playbackEnd: 3000,
    });
    expect(cuts[1]!.originalStart).toBe(3600); // toFrame(60000) = 3600
  });

  it('null（cutData.ts 不在）は空配列を返す', () => {
    expect(parseCutData(null)).toEqual([]);
  });

  it('cutData が無いソースは ProjectFileError を投げる', () => {
    expect(() => parseCutData('export const x = 1;')).toThrow(ProjectFileError);
  });
});

describe('serializeCutData', () => {
  const cuts = [
    { id: 1, originalStart: 0, originalEnd: 3000, playbackStart: 0, playbackEnd: 3000 },
    { id: 2, originalStart: 3600, originalEnd: 12000, playbackStart: 3000, playbackEnd: 11400 },
  ];

  it('既存ソースがあれば配列だけ差し替える', () => {
    const out = serializeCutData(CUT_DATA_SOURCE, cuts, 12000, 11400);
    expect(parseCutData(out)).toEqual(cuts);
    expect(out).toContain('export interface CutSegment');
  });

  it('既存ソースが null なら新規 cutData.ts を生成する', () => {
    const out = serializeCutData(null, cuts, 12000, 11400);
    expect(out).toContain('export const cutData: CutSegment[]');
    expect(out).toContain('export const ORIGINAL_DURATION_FRAMES = 12000;');
    expect(out).toContain('export const CUT_DURATION_FRAMES = 11400;');
    expect(parseCutData(out)).toEqual(cuts);
  });
});
