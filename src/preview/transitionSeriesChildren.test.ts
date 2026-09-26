import { describe, it, expect } from 'vitest';
import { buildTransitionSeriesChildren } from './transitionSeriesChildren';
import type { CutSegment, SceneTransition } from '../core/types';
import type { Join } from '../core/joinEngine';

const segsForTSC: CutSegment[] = [
  { id: 1, originalStart: 0, originalEnd: 100, playbackStart: 0, playbackEnd: 100 },
  { id: 2, originalStart: 150, originalEnd: 250, playbackStart: 100, playbackEnd: 200 },
];
const joinsForTSC: Join[] = [{ atOriginal: 100, playbackFrame: 100 }];

describe('buildTransitionSeriesChildren', () => {
  it('重なる系なし＝Sequence 2 つ・Transition なし', () => {
    const ch = buildTransitionSeriesChildren(segsForTSC, [], joinsForTSC);
    expect(ch.filter((c) => c.type === 'sequence')).toHaveLength(2);
    expect(ch.filter((c) => c.type === 'transition')).toHaveLength(0);
  });

  it('クロスフェード＝間に Transition 1 つ・overlap クランプ済み', () => {
    const t: SceneTransition[] = [{ id: 9, at: 100, kind: 'crossfade', durationFrames: 20 }];
    const ch = buildTransitionSeriesChildren(segsForTSC, t, joinsForTSC);
    const trans = ch.filter((c) => c.type === 'transition');
    expect(trans).toHaveLength(1);
    expect(trans[0]!.overlap).toBe(20);
  });

  it('クロスフェード＝Sequence/Transition/Sequence の順', () => {
    const t: SceneTransition[] = [{ id: 9, at: 100, kind: 'crossfade', durationFrames: 20 }];
    const ch = buildTransitionSeriesChildren(segsForTSC, t, joinsForTSC);
    expect(ch[0]!.type).toBe('sequence');
    expect(ch[1]!.type).toBe('transition');
    expect(ch[2]!.type).toBe('sequence');
  });

  it('クロスフェードの overlap は buildOverlaps と同じクランプ（隣接区間の短い方の半分）', () => {
    // 区間長 100/100 → 上限 50。durationFrames 80 → 50 へクランプ
    const t: SceneTransition[] = [{ id: 1, at: 100, kind: 'slide', durationFrames: 80 }];
    const ch = buildTransitionSeriesChildren(segsForTSC, t, joinsForTSC);
    const trans = ch.filter((c) => c.type === 'transition');
    expect(trans[0]!.overlap).toBe(50);
  });

  it('fade 系は Transition を差し込まない（重なる系でない）', () => {
    const t: SceneTransition[] = [{ id: 9, at: 100, kind: 'fadeBlack', durationFrames: 20 }];
    const ch = buildTransitionSeriesChildren(segsForTSC, t, joinsForTSC);
    expect(ch.filter((c) => c.type === 'transition')).toHaveLength(0);
  });

  it('重なる系でも head/tail は Transition に変換しない', () => {
    const t: SceneTransition[] = [{ id: 9, at: 'head', kind: 'crossfade', durationFrames: 20 }];
    const ch = buildTransitionSeriesChildren(segsForTSC, t, joinsForTSC);
    expect(ch.filter((c) => c.type === 'transition')).toHaveLength(0);
  });

  it('各 sequence の seg は元の CutSegment と一致する', () => {
    const ch = buildTransitionSeriesChildren(segsForTSC, [], joinsForTSC);
    const seqs = ch.filter((c) => c.type === 'sequence');
    expect(seqs[0]!.seg.id).toBe(1);
    expect(seqs[1]!.seg.id).toBe(2);
  });

  it('joins に対応する at がない場合は Transition なし', () => {
    // joins は atOriginal=100 だが sceneTransitions は at=999 で一致しない
    const t: SceneTransition[] = [{ id: 9, at: 999, kind: 'crossfade', durationFrames: 20 }];
    const ch = buildTransitionSeriesChildren(segsForTSC, t, joinsForTSC);
    expect(ch.filter((c) => c.type === 'transition')).toHaveLength(0);
  });
});
