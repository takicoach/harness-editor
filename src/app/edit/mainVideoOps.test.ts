import { describe, it, expect } from 'vitest';
import { setMainSpeed } from './mainVideoOps';
import type { EditState } from './editState';
import {
  setMainVideoPosition,
  setMainVideoScale,
  setMainVideoBackground,
  setMainVideoRotation,
  setMainVideoFlipH,
  setMainVideoFlipV,
  resetMainLayout,
} from './mainVideoOps';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';

function st(over: Partial<EditState> = {}): EditState {
  return {
    telops: [], cutRegions: [], se: [], images: [], videoInserts: [], bgm: [],
    selection: null, multiTelopIds: [], nextTelopId: 1, nextSeId: 1, nextImageId: 1, nextVideoInsertId: 1, nextBgmId: 1,
    titles: [], nextTitleId: 1,
    shapes: [], nextShapeId: 1,
    sceneTransitions: [], nextTransitionId: 1,
    ducking: { enabled: true, strength: 'mid' as const },
    mainSpeed: 1,
    segmentSpeeds: {},
    segmentLayouts: {}, layoutKeyframes: [],
    ...over,
  };
}

describe('setMainSpeed', () => {
  it('速度を設定する', () => {
    expect(setMainSpeed(st(), 0.5).mainSpeed).toBe(0.5);
  });
  it('範囲外はクランプ', () => {
    expect(setMainSpeed(st(), 99).mainSpeed).toBe(16);
    expect(setMainSpeed(st(), 0.01).mainSpeed).toBe(0.1);
  });
  it('同値は no-op（参照不変・履歴を汚さない）', () => {
    const s = st({ mainSpeed: 0.5 });
    expect(setMainSpeed(s, 0.5)).toBe(s);
  });
  it('非有限は no-op', () => {
    const s = st();
    expect(setMainSpeed(s, Number.NaN)).toBe(s);
  });
});

describe('setMainVideoScale', () => {
  it('スケールを設定する', () => {
    expect(setMainVideoScale(st(), 1.5).mainLayout?.scale).toBe(1.5);
  });
  it('範囲外はクランプ（0.1..5）', () => {
    expect(setMainVideoScale(st(), 99).mainLayout?.scale).toBe(5);
    expect(setMainVideoScale(st(), 0.01).mainLayout?.scale).toBe(0.1);
  });
  it('同値は no-op（参照不変）', () => {
    const s = st({ mainLayout: { ...DEFAULT_MAIN_LAYOUT, scale: 1.5 } });
    expect(setMainVideoScale(s, 1.5)).toBe(s);
  });
  it('非有限は no-op', () => {
    const s = st();
    expect(setMainVideoScale(s, Number.NaN)).toBe(s);
  });
});

describe('setMainVideoPosition', () => {
  it('位置を設定・クランプ（-1..1）', () => {
    expect(setMainVideoPosition(st(), 2, -2).mainLayout?.position).toEqual({ x: 1, y: -1 });
  });
  it('同値は no-op', () => {
    const s = st({ mainLayout: { ...DEFAULT_MAIN_LAYOUT, position: { x: 0.5, y: 0.5 } } });
    expect(setMainVideoPosition(s, 0.5, 0.5)).toBe(s);
  });
  it('非有限は no-op', () => {
    const s = st();
    expect(setMainVideoPosition(s, Number.NaN, 0)).toBe(s);
  });
});

describe('setMainVideoBackground', () => {
  it('背景色を設定', () => {
    expect(setMainVideoBackground(st(), '#ffffff').mainLayout?.background).toBe('#ffffff');
  });
  it('空文字は no-op', () => {
    const s = st();
    expect(setMainVideoBackground(s, '')).toBe(s);
  });
  it('同値は no-op（参照不変）', () => {
    const s = st({ mainLayout: { ...DEFAULT_MAIN_LAYOUT, background: '#123456' } });
    expect(setMainVideoBackground(s, '#123456')).toBe(s);
  });
});

describe('resetMainLayout', () => {
  it('既定へ戻す', () => {
    const s = st({ mainLayout: { ...DEFAULT_MAIN_LAYOUT, position: { x: 0.5, y: 0.5 }, scale: 2, background: '#ffffff' } });
    expect(resetMainLayout(s).mainLayout).toEqual(DEFAULT_MAIN_LAYOUT);
  });
  it('既に既定（未設定）なら no-op', () => {
    const s = st();
    expect(resetMainLayout(s)).toBe(s);
  });
});

describe('setMainVideoRotation', () => {
  it('範囲内は設定', () => { expect(setMainVideoRotation(st(), 90).mainLayout?.rotation).toBe(90); });
  it('範囲外はクランプ', () => { expect(setMainVideoRotation(st(), 999).mainLayout?.rotation).toBe(180); });
  it('非有限は no-op(参照不変)', () => { const s = st(); expect(setMainVideoRotation(s, NaN)).toBe(s); });
});
describe('setMainVideoFlip', () => {
  it('水平反転 ON/OFF', () => {
    expect(setMainVideoFlipH(st(), true).mainLayout?.flipH).toBe(true);
    expect(setMainVideoFlipV(st(), true).mainLayout?.flipV).toBe(true);
  });
  it('同値は no-op', () => { const s = setMainVideoFlipH(st(), true); expect(setMainVideoFlipH(s, true)).toBe(s); });
});
describe('resetMainLayout 回転・反転', () => {
  it('回転・反転も既定へ戻る', () => {
    let s = setMainVideoRotation(st(), 45); s = setMainVideoFlipH(s, true);
    const r = resetMainLayout(s);
    expect(r.mainLayout?.rotation).toBe(0);
    expect(r.mainLayout?.flipH).toBe(false);
    expect(r.mainLayout?.flipV).toBe(false);
  });
});
