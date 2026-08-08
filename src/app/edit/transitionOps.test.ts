import { describe, it, expect } from 'vitest';
import {
  setSceneTransition, clearSceneTransition, setSceneTransitionDuration,
  setSceneTransitionColor, setSceneTransitionDirection, applyTransitionToAllJoins, selectJoin,
} from './transitionOps';
import { createEditState } from './editState';
import type { EditorProject } from '../../core/types';

/** テスト用の最小 EditorProject を生成する。 */
function makeProject(over: Partial<EditorProject> = {}): EditorProject {
  return {
    videoConfig: {
      format: 'short',
      fps: 60,
      durationFrames: 1800,
      videoFile: 'main.mp4',
      resolution: { width: 1080, height: 1920 },
      orientation: 'portrait',
      titleStyle: { top: 60, left: 30, fontSize: 30 },
    },
    projectConfig: null,
    transcript: { durationMs: 30000, words: [], segments: [] },
    telops: [],
    cutRegions: [],
    se: [],
    images: [],
    videoInserts: [],
    bgm: [],
    shapes: [],
    telopDataSource: 'export const telopData = [];\n',
    cutDataSource: null,
    seDataSource: null,
    insertImageDataSource: null,
    titles: [],
    titleDataSource: null,
    shapeDataSource: null,
    mainSpeed: 1,
    segmentSpeeds: {},
    ...over,
  };
}

function baseState() {
  return createEditState(makeProject({ sceneTransitions: [] }));
}

describe('setSceneTransition', () => {
  it('つなぎ目に転換を追加（既定長は opts で渡す）', () => {
    const s = setSceneTransition(baseState(), 100, 'fadeBlack', { durationFrames: 20 });
    expect(s.sceneTransitions).toHaveLength(1);
    expect(s.sceneTransitions[0]).toMatchObject({ at: 100, kind: 'fadeBlack', durationFrames: 20 });
  });
  it('同じ at は差し替え（重複しない）', () => {
    let s = setSceneTransition(baseState(), 100, 'fadeBlack', { durationFrames: 20 });
    s = setSceneTransition(s, 100, 'fadeWhite', { durationFrames: 30 });
    expect(s.sceneTransitions).toHaveLength(1);
    expect(s.sceneTransitions[0]).toMatchObject({ at: 100, kind: 'fadeWhite', durationFrames: 30 });
  });
  it('head/tail も at として使える', () => {
    const s = setSceneTransition(baseState(), 'head', 'fadeBlack', { durationFrames: 20 });
    expect(s.sceneTransitions[0]!.at).toBe('head');
  });
});

describe('clearSceneTransition', () => {
  it('指定 at の転換を消す', () => {
    let s = setSceneTransition(baseState(), 100, 'fadeBlack', { durationFrames: 20 });
    s = clearSceneTransition(s, 100);
    expect(s.sceneTransitions).toHaveLength(0);
  });
});

describe('setSceneTransitionDuration / Color', () => {
  it('長さを最小 2 でクランプ', () => {
    let s = setSceneTransition(baseState(), 100, 'fadeBlack', { durationFrames: 20 });
    s = setSceneTransitionDuration(s, 100, 0);
    expect(s.sceneTransitions[0]!.durationFrames).toBe(2);
  });
  it('色を設定（fadeColor 用）', () => {
    let s = setSceneTransition(baseState(), 100, 'fadeColor', { durationFrames: 20 });
    s = setSceneTransitionColor(s, 100, '#0A84FF');
    expect(s.sceneTransitions[0]!.color).toBe('#0A84FF');
  });
});

describe('applyTransitionToAllJoins', () => {
  it('全 join に転換を設定（頭尾は対象外）', () => {
    const s = applyTransitionToAllJoins(baseState(),
      [{ atOriginal: 100 }, { atOriginal: 250 }], 'fadeBlack', { durationFrames: 20 });
    expect(s.sceneTransitions.map((t) => t.at).sort()).toEqual([100, 250]);
  });
});

describe('selectJoin', () => {
  it('selection を join に設定する', () => {
    const s = selectJoin(baseState(), 100);
    expect(s.selection).toEqual({ kind: 'join', at: 100 });
  });
  it('head を選択できる', () => {
    const s = selectJoin(baseState(), 'head');
    expect(s.selection).toEqual({ kind: 'join', at: 'head' });
  });
});

describe('setSceneTransition × 重なる系', () => {
  it('slide＋direction を載せる', () => {
    const s = setSceneTransition(baseState(), 100, 'slide', { durationFrames: 30, direction: 'up' });
    const t = s.sceneTransitions.find((x) => x.at === 100);
    expect(t?.kind).toBe('slide');
    expect(t?.direction).toBe('up');
    expect(t?.durationFrames).toBe(30);
  });
  it('wipe＋direction=right を載せる', () => {
    const s = setSceneTransition(baseState(), 200, 'wipe', { durationFrames: 20, direction: 'right' });
    const t = s.sceneTransitions.find((x) => x.at === 200);
    expect(t?.direction).toBe('right');
  });
  it('crossfade は direction なし', () => {
    const s = setSceneTransition(baseState(), 100, 'crossfade', { durationFrames: 20 });
    const t = s.sceneTransitions.find((x) => x.at === 100);
    expect(t?.direction).toBeUndefined();
  });
  it('fade 系は direction を載せない（既存動作保護）', () => {
    const s = setSceneTransition(baseState(), 100, 'fadeBlack', { durationFrames: 20, direction: 'left' });
    const t = s.sceneTransitions.find((x) => x.at === 100);
    expect(t?.direction).toBeUndefined();
  });
  it('slide に既存 direction がある場合、opts 無しで維持', () => {
    let s = setSceneTransition(baseState(), 100, 'slide', { durationFrames: 20, direction: 'left' });
    s = setSceneTransition(s, 100, 'slide', { durationFrames: 25 });
    const t = s.sceneTransitions.find((x) => x.at === 100);
    expect(t?.direction).toBe('left');
  });
});

describe('setSceneTransitionDirection', () => {
  it('存在する at の direction を更新する', () => {
    let s = setSceneTransition(baseState(), 100, 'slide', { durationFrames: 20, direction: 'left' });
    s = setSceneTransitionDirection(s, 100, 'right');
    const t = s.sceneTransitions.find((x) => x.at === 100);
    expect(t?.direction).toBe('right');
  });
  it('存在しない at はそのまま', () => {
    const s0 = baseState();
    const s1 = setSceneTransitionDirection(s0, 999, 'down');
    expect(s1).toBe(s0);
  });
});

describe('applyTransitionToAllJoins × direction', () => {
  it('slide＋direction を全 join に適用', () => {
    const s = applyTransitionToAllJoins(
      baseState(),
      [{ atOriginal: 100 }, { atOriginal: 200 }],
      'slide',
      { durationFrames: 20, direction: 'up' },
    );
    for (const t of s.sceneTransitions) {
      expect(t.kind).toBe('slide');
      expect(t.direction).toBe('up');
    }
  });
});
