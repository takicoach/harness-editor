import { describe, expect, it } from 'vitest';
import { timelineOverlaps } from './timelineCoords';
import type { SceneTransition } from '../../core/types';

describe('timelineOverlaps', () => {
  it('カット無し（区間 1 つ）＝つなぎ目なし＝overlaps 空', () => {
    const t: SceneTransition[] = [{ id: 1, at: 0, kind: 'crossfade', durationFrames: 10 }];
    expect(timelineOverlaps(t, 300, [])).toEqual([]);
  });
  it('1 カットで 2 区間＝境界の crossfade が overlap になる', () => {
    // 原本 300・カット [100,150) → 区間 [0,100)(orig0-100) と [100,250)(orig150-300)
    // つなぎ目 atOriginal=100, playbackFrame=100。crossfade dur 20 → overlap 20。
    const t: SceneTransition[] = [{ id: 1, at: 100, kind: 'crossfade', durationFrames: 20 }];
    expect(timelineOverlaps(t, 300, [{ start: 100, end: 150 }])).toEqual([{ boundary: 100, overlap: 20 }]);
  });
});
