import { describe, it, expect } from 'vitest';
import {
  setSegmentScale, setSegmentPosition, setSegmentRotation, setSegmentFlipH, clearSegmentLayout,
} from './segmentLayoutOps';
import type { EditState } from './editState';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';

function st(): EditState {
  // segmentLayoutOps が参照するのは mainLayout と segmentLayouts のみ。最小 state を組む。
  return { segmentLayouts: {}, layoutKeyframes: [], mainLayout: { ...DEFAULT_MAIN_LAYOUT } } as unknown as EditState;
}

describe('setSegmentScale', () => {
  it('個別指定が無ければ全体ベースを種に作る', () => {
    const r = setSegmentScale(st(), 3, 2);
    expect(r.segmentLayouts[3]).toEqual({ position: { x: 0, y: 0 }, scale: 2, rotation: 0, flipH: false, flipV: false });
  });
  it('クランプ(上限)', () => { expect(setSegmentScale(st(), 3, 99).segmentLayouts[3]?.scale).toBe(5); });
  it('クランプ(下限)', () => { expect(setSegmentScale(st(), 3, -5).segmentLayouts[3]?.scale).toBe(0.1); });
  it('非有限は no-op', () => { const s = st(); expect(setSegmentScale(s, 3, NaN)).toBe(s); });
  it('同値再設定は参照不変・異値は新規参照', () => {
    const s = st();
    const r1 = setSegmentScale(s, 3, 2);
    const r2 = setSegmentScale(r1, 3, 2);
    expect(r2).toBe(r1);
    const r3 = setSegmentScale(r1, 3, 3);
    expect(r3).not.toBe(r1);
  });
});
describe('setSegmentPosition/Rotation/Flip', () => {
  it('位置・回転・反転を個別に設定', () => {
    let r = setSegmentPosition(st(), 1, 0.5, -0.5);
    r = setSegmentRotation(r, 1, 90);
    r = setSegmentFlipH(r, 1, true);
    expect(r.segmentLayouts[1]).toEqual({ position: { x: 0.5, y: -0.5 }, scale: 1, rotation: 90, flipH: true, flipV: false });
  });
  it('setSegmentPosition クランプ(両方向)', () => {
    const r = setSegmentPosition(st(), 1, 5, -5);
    expect(r.segmentLayouts[1]?.position).toEqual({ x: 1, y: -1 });
  });
  it('setSegmentPosition 非有限は no-op(同一参照)', () => {
    const s = st();
    expect(setSegmentPosition(s, 1, NaN, 0)).toBe(s);
  });
  it('setSegmentRotation クランプ(両方向)', () => {
    expect(setSegmentRotation(st(), 1, 300).segmentLayouts[1]?.rotation).toBe(180);
    expect(setSegmentRotation(st(), 1, -300).segmentLayouts[1]?.rotation).toBe(-180);
  });
  it('setSegmentRotation 非有限は no-op(同一参照)', () => {
    const s = st();
    expect(setSegmentRotation(s, 1, Infinity)).toBe(s);
  });
  it('setSegmentRotation 同値再設定は参照不変・異値は新規参照', () => {
    const s = st();
    const r1 = setSegmentRotation(s, 1, 90);
    const r2 = setSegmentRotation(r1, 1, 90);
    expect(r2).toBe(r1);
    const r3 = setSegmentRotation(r1, 1, 45);
    expect(r3).not.toBe(r1);
  });
  it('setSegmentFlipH 同値再設定は参照不変・異値は新規参照', () => {
    const s = st();
    const r1 = setSegmentFlipH(s, 1, true);
    const r2 = setSegmentFlipH(r1, 1, true);
    expect(r2).toBe(r1);
    const r3 = setSegmentFlipH(r1, 1, false);
    expect(r3).not.toBe(r1);
  });
});
describe('clearSegmentLayout', () => {
  it('個別指定を削除', () => {
    const r = clearSegmentLayout(setSegmentScale(st(), 3, 2), 3);
    expect(r.segmentLayouts[3]).toBeUndefined();
  });
  it('無い id は no-op', () => { const s = st(); expect(clearSegmentLayout(s, 9)).toBe(s); });
  it('大域キーフレームは区間解除で消さない', () => {
    const withKf = { ...setSegmentScale(st(), 3, 2), layoutKeyframes: [{ originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 }, { originalFrame: 10, x: 1, y: 0, scale: 1, rotation: 0 }] };
    const r = clearSegmentLayout(withKf, 3);
    expect(r.segmentLayouts[3]).toBeUndefined();
    expect(r.layoutKeyframes).toEqual(withKf.layoutKeyframes);
  });
});
