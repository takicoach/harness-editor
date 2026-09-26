import { describe, expect, it } from 'vitest';
import { buildCutOrdering } from '../../core/cutOrder';
import { telopFocusPlaybackFrame } from './telopFocus';

describe('telopFocusPlaybackFrame', () => {
  it('通常区間は中央、1フレーム区間は唯一の可視フレームを返す', () => {
    expect(telopFocusPlaybackFrame({ originalStart: 100, originalEnd: 200 }, [])).toBe(150);
    expect(telopFocusPlaybackFrame({ originalStart: 9, originalEnd: 10 }, [])).toBe(9);
  });

  it('カットされたフレームを数えずに可視フレーム群の中央を返す', () => {
    expect(telopFocusPlaybackFrame(
      { originalStart: 100, originalEnd: 200 },
      [{ start: 130, end: 180 }],
    )).toBe(125);
  });

  it('中央が断片の境界なら次の断片先頭を避けて内側へ寄せる', () => {
    expect(telopFocusPlaybackFrame(
      { originalStart: 0, originalEnd: 180 },
      [{ start: 60, end: 120 }],
    )).toBe(90);
  });

  it('全区間がカット済みなら移動先を作らない', () => {
    expect(telopFocusPlaybackFrame(
      { originalStart: 100, originalEnd: 200 },
      [{ start: 0, end: 300 }],
    )).toBeNull();
  });

  it('並び替え後の再生順で可視中央を選ぶ', () => {
    const cuts = [{ start: 100, end: 200 }];
    const ordering = buildCutOrdering(300, cuts, [
      { originalStart: 200, originalEnd: 300 },
      { originalStart: 0, originalEnd: 100 },
    ]);
    expect(telopFocusPlaybackFrame(
      { originalStart: 50, originalEnd: 250 },
      cuts,
      ordering,
    )).toBe(175);
  });
});
