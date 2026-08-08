import { describe, it, expect } from 'vitest';
import { setDucking } from './duckingOps';
import type { EditState } from './editState';

function baseState(): EditState {
  return {
    telops: [], cutRegions: [], se: [], images: [], videoInserts: [], bgm: [],
    selection: null, nextTelopId: 1, nextSeId: 1, nextImageId: 1, nextVideoInsertId: 1, nextBgmId: 1,
    titles: [], nextTitleId: 1, shapes: [], nextShapeId: 1, sceneTransitions: [], nextTransitionId: 1, ducking: { enabled: true, strength: 'mid' }, mainSpeed: 1, segmentSpeeds: {}, segmentLayouts: {}, layoutKeyframes: [],
  };
}

describe('setDucking', () => {
  it('ducking を差し替えた新 state を返す（元を変えない）', () => {
    const s = baseState();
    const next = setDucking(s, { enabled: false, strength: 'strong' });
    expect(next.ducking).toEqual({ enabled: false, strength: 'strong' });
    expect(s.ducking).toEqual({ enabled: true, strength: 'mid' });
    expect(next).not.toBe(s);
  });
});
