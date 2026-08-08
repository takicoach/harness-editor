import { describe, it, expect } from 'vitest';
import { computeJoins, resolveSceneTransitions, projectSceneTransitions, anchorSceneTransitions } from './joinEngine';
import type { SceneTransition } from './types';

describe('computeJoins', () => {
  it('カット無しならつなぎ目なし', () => {
    expect(computeJoins(300, [])).toEqual([]);
  });
  it('中央 1 カットで 1 つのつなぎ目（atOriginal=削除開始・playbackFrame=前区間長）', () => {
    // 原本 300、削除 [100,150) → kept [0,100)+[150,300)。再生 [0,100)+[100,250)。
    const joins = computeJoins(300, [{ start: 100, end: 150 }]);
    expect(joins).toEqual([{ atOriginal: 100, playbackFrame: 100 }]);
  });
  it('2 カットで 2 つのつなぎ目', () => {
    const joins = computeJoins(400, [{ start: 100, end: 150 }, { start: 250, end: 300 }]);
    // kept [0,100)+[150,250)+[300,400) → 再生境界 100, 200
    expect(joins).toEqual([
      { atOriginal: 100, playbackFrame: 100 },
      { atOriginal: 250, playbackFrame: 200 },
    ]);
  });
});

describe('resolveSceneTransitions', () => {
  const joins = [
    { atOriginal: 100, playbackFrame: 100 },
    { atOriginal: 250, playbackFrame: 200 },
  ];
  it('at=原本フレームを現つなぎ目の playbackFrame へ解決', () => {
    const tr: SceneTransition[] = [{ id: 1, at: 100, kind: 'fadeBlack', durationFrames: 20 }];
    expect(resolveSceneTransitions(tr, joins)).toEqual([
      { transition: tr[0], playbackFrame: 100 },
    ]);
  });
  it('消えたつなぎ目（一致する join 無し）はドロップ', () => {
    const tr: SceneTransition[] = [{ id: 1, at: 999, kind: 'fadeBlack', durationFrames: 20 }];
    expect(resolveSceneTransitions(tr, joins)).toEqual([]);
  });
  it('head/tail は number でないので無視（呼び出し側が別処理）', () => {
    const tr: SceneTransition[] = [{ id: 1, at: 'head', kind: 'fadeBlack', durationFrames: 20 }];
    expect(resolveSceneTransitions(tr, joins)).toEqual([]);
  });
});

describe('projectSceneTransitions', () => {
  const joins = [
    { atOriginal: 100, playbackFrame: 100 },
    { atOriginal: 250, playbackFrame: 200 },
  ];
  it('at(原本) を at(再生フレーム) へ射影する', () => {
    const tr: SceneTransition[] = [
      { id: 1, at: 100, kind: 'fadeBlack', durationFrames: 20 },
      { id: 2, at: 250, kind: 'fadeWhite', durationFrames: 10 },
    ];
    expect(projectSceneTransitions(tr, joins)).toEqual([
      { id: 1, at: 100, kind: 'fadeBlack', durationFrames: 20 },
      { id: 2, at: 200, kind: 'fadeWhite', durationFrames: 10 },
    ]);
  });
  it('一致する join が無い at はドロップ', () => {
    const tr: SceneTransition[] = [{ id: 1, at: 999, kind: 'fadeBlack', durationFrames: 20 }];
    expect(projectSceneTransitions(tr, joins)).toEqual([]);
  });
  it('head/tail は pass-through（number でない）', () => {
    const tr: SceneTransition[] = [{ id: 1, at: 'head', kind: 'fadeBlack', durationFrames: 20 }];
    expect(projectSceneTransitions(tr, joins)).toEqual([
      { id: 1, at: 'head', kind: 'fadeBlack', durationFrames: 20 },
    ]);
  });
  it('空配列は空配列', () => {
    expect(projectSceneTransitions([], joins)).toEqual([]);
  });
});

describe('anchorSceneTransitions', () => {
  const joins = [
    { atOriginal: 100, playbackFrame: 100 },
    { atOriginal: 250, playbackFrame: 200 },
  ];
  it('at(再生フレーム) を at(原本) へ逆射影する', () => {
    const tr: SceneTransition[] = [
      { id: 1, at: 100, kind: 'fadeBlack', durationFrames: 20 },
      { id: 2, at: 200, kind: 'fadeWhite', durationFrames: 10 },
    ];
    expect(anchorSceneTransitions(tr, joins)).toEqual([
      { id: 1, at: 100, kind: 'fadeBlack', durationFrames: 20 },
      { id: 2, at: 250, kind: 'fadeWhite', durationFrames: 10 },
    ]);
  });
  it('一致する join が無い at はドロップ', () => {
    const tr: SceneTransition[] = [{ id: 1, at: 999, kind: 'fadeBlack', durationFrames: 20 }];
    expect(anchorSceneTransitions(tr, joins)).toEqual([]);
  });
  it('head/tail は pass-through（number でない）', () => {
    const tr: SceneTransition[] = [{ id: 1, at: 'tail', kind: 'fadeBlack', durationFrames: 20 }];
    expect(anchorSceneTransitions(tr, joins)).toEqual([
      { id: 1, at: 'tail', kind: 'fadeBlack', durationFrames: 20 },
    ]);
  });
  it('往復テスト: project → anchor で元の at に戻る', () => {
    const original: SceneTransition[] = [
      { id: 1, at: 100, kind: 'fadeBlack', durationFrames: 20 },
      { id: 2, at: 250, kind: 'fadeWhite', durationFrames: 10 },
      { id: 3, at: 'head', kind: 'fadeBlack', durationFrames: 8 },
    ];
    const projected = projectSceneTransitions(original, joins);
    const anchored = anchorSceneTransitions(projected, joins);
    expect(anchored).toEqual(original);
  });
});
