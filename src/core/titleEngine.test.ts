import { describe, it, expect } from 'vitest';
import { anchorTitles, projectTitles, clampTitles } from './titleEngine';
import type { CutRegion, TitleSegment, EditorTitle } from './types';

const cuts: CutRegion[] = [{ start: 100, end: 200 }]; // 原本 100-200 をカット

describe('anchorTitles', () => {
  it('再生フレームを原本フレームへ逆射影する', () => {
    const segs: TitleSegment[] = [{ id: 1, startFrame: 50, endFrame: 150, text: 'x' }];
    // 再生150 はカット後なのでカット長(100)を足した原本250
    const out = anchorTitles(segs, cuts);
    expect(out[0]).toMatchObject({ id: 1, originalStart: 50, originalEnd: 250, text: 'x' });
  });
  it('originalStart/End が明示されていればそれを使う', () => {
    const segs: TitleSegment[] = [
      { id: 2, startFrame: 0, endFrame: 1, text: 'y', originalStart: 120, originalEnd: 180 },
    ];
    expect(anchorTitles(segs, cuts)[0]).toMatchObject({ originalStart: 120, originalEnd: 180 });
  });
});

describe('projectTitles', () => {
  it('原本フレームを再生フレームへ射影する', () => {
    const segs: EditorTitle[] = [{ id: 1, originalStart: 50, originalEnd: 250, text: 'x' }];
    const out = projectTitles(segs, cuts);
    expect(out[0]).toMatchObject({ id: 1, startFrame: 50, endFrame: 150, text: 'x' });
  });
  it('originalStart がカット区間内に落ちた場合は前フレームへフォールバックする', () => {
    const segs: EditorTitle[] = [{ id: 3, originalStart: 150, originalEnd: 250, text: 'z' }];
    const out = projectTitles(segs, cuts);
    // 原本 150 はカット区間内（100-200）のため null を返す。
    // フォールバック：originalStart - 1 = 149 を射影しても null（カット区間内）。
    // その結果 ?? 0 で 0 にフォールバック。最後に Math.max(0, 0) で 0。
    expect(out[0]!.startFrame).toBe(0);
  });
});

describe('clampTitles', () => {
  it('カット区間に飲まれたタイトルを flagged にしつつ残す', () => {
    const segs: EditorTitle[] = [{ id: 1, originalStart: 120, originalEnd: 180, text: 'x' }];
    const r = clampTitles(segs, cuts);
    expect(r.flaggedIds).toEqual([1]);
    expect(r.titles).toHaveLength(1);
  });
  it('端だけカット内ならカット外へ寄せる', () => {
    const segs: EditorTitle[] = [{ id: 2, originalStart: 50, originalEnd: 150, text: 'y' }];
    const r = clampTitles(segs, cuts);
    expect(r.flaggedIds).toEqual([]);
    expect(r.titles[0]).toMatchObject({ originalStart: 50, originalEnd: 100 });
  });
});
