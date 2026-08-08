import { describe, it, expect } from 'vitest';
import {
  addKeyframeAt, punchKeyframe, removeKeyframe, clearKeyframes, setKeyframeField, applyPresetKeyframes,
} from './layoutKeyframeOps';
import type { EditState } from './editState';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';

function st(overrides: Partial<EditState> = {}): EditState {
  return {
    segmentLayouts: {},
    layoutKeyframes: [],
    mainLayout: { ...DEFAULT_MAIN_LAYOUT },
    ...overrides,
  } as unknown as EditState;
}

const kept = [
  { id: 1, originalStart: 0, playbackStart: 0, playbackEnd: 100 },
  { id: 2, originalStart: 300, playbackStart: 100, playbackEnd: 160 },
];

describe('addKeyframeAt', () => {
  it('新規フレームは追加され originalFrame 昇順を維持する', () => {
    const s = addKeyframeAt(addKeyframeAt(st(), { originalFrame: 50, x: 0, y: 0, scale: 1, rotation: 0 }), { originalFrame: 10, x: 0, y: 0, scale: 1, rotation: 0 });
    expect(s.layoutKeyframes.map((k) => k.originalFrame)).toEqual([10, 50]);
  });
  it('同じ originalFrame は置換（本数は増えない）', () => {
    const s1 = addKeyframeAt(st(), { originalFrame: 10, x: 0, y: 0, scale: 1, rotation: 0 });
    const s2 = addKeyframeAt(s1, { originalFrame: 10, x: 0.5, y: 0, scale: 2, rotation: 0 });
    expect(s2.layoutKeyframes).toHaveLength(1);
    expect(s2.layoutKeyframes[0]).toEqual({ originalFrame: 10, x: 0.5, y: 0, scale: 2, rotation: 0 });
  });
  it('クランプする（scale 上限・position 範囲）', () => {
    const s = addKeyframeAt(st(), { originalFrame: -5, x: 9, y: -9, scale: 99, rotation: 999 });
    expect(s.layoutKeyframes[0]).toEqual({ originalFrame: 0, x: 1, y: -1, scale: 8, rotation: 180 });
  });
});

describe('punchKeyframe', () => {
  it('再生ヘッドの原本フレーム位置に、現在の base 見た目でキーフレームを打つ', () => {
    const s = st({ mainLayout: { position: { x: 0.2, y: -0.1 }, scale: 1.5, background: '#000', rotation: 10, flipH: false, flipV: false } });
    const r = punchKeyframe(s, 120, kept);
    // playbackFrame=120 は kept[1](originalStart=300, playbackStart=100) の区間 → originalFrame = 300 + (120-100) = 320
    expect(r.layoutKeyframes).toEqual([{ originalFrame: 320, x: 0.2, y: -0.1, scale: 1.5, rotation: 10 }]);
  });
  it('既に大域KFが2点以上あるときは現在の実効サンプル値を打つ', () => {
    const withKf = st({
      layoutKeyframes: [
        { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
        { originalFrame: 100, x: 1, y: 0, scale: 2, rotation: 0 },
      ],
    });
    const r = punchKeyframe(withKf, 50, [{ id: 1, originalStart: 0, playbackStart: 0, playbackEnd: 200 }]);
    const added = r.layoutKeyframes.find((k) => k.originalFrame === 50);
    expect(added).toBeDefined();
    expect(added!.x).toBeCloseTo(0.5, 5);
  });
});

describe('removeKeyframe', () => {
  it('index のキーフレームを削除', () => {
    const s = addKeyframeAt(addKeyframeAt(st(), { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 }), { originalFrame: 50, x: 1, y: 0, scale: 1, rotation: 0 });
    const r = removeKeyframe(s, 0);
    expect(r.layoutKeyframes).toEqual([{ originalFrame: 50, x: 1, y: 0, scale: 1, rotation: 0 }]);
  });
  it('範囲外 index は no-op（参照不変）', () => {
    const s = st();
    expect(removeKeyframe(s, 0)).toBe(s);
    expect(removeKeyframe(s, -1)).toBe(s);
  });
});

describe('clearKeyframes', () => {
  it('全キーフレームを消す', () => {
    const s = addKeyframeAt(st(), { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 });
    expect(clearKeyframes(s).layoutKeyframes).toEqual([]);
  });
  it('空なら参照不変', () => {
    const s = st();
    expect(clearKeyframes(s)).toBe(s);
  });
});

describe('setKeyframeField', () => {
  it('originalFrame 変更で再ソートされる', () => {
    const s = addKeyframeAt(addKeyframeAt(st(), { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 }), { originalFrame: 50, x: 1, y: 0, scale: 1, rotation: 0 });
    const r = setKeyframeField(s, 0, 'originalFrame', 100);
    expect(r.layoutKeyframes.map((k) => k.originalFrame)).toEqual([50, 100]);
  });
  it('x/y/scale/rotation を更新しクランプする（scale は KF 専用レンジ 0.1..8＝clampKeyframe・プリセットと一致）', () => {
    const s = addKeyframeAt(st(), { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 });
    expect(setKeyframeField(s, 0, 'scale', 99).layoutKeyframes[0]?.scale).toBe(8);
    expect(setKeyframeField(s, 0, 'x', 9).layoutKeyframes[0]?.x).toBe(1);
  });
  it('範囲外 index・非有限値は no-op', () => {
    const s = addKeyframeAt(st(), { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 });
    expect(setKeyframeField(s, 5, 'scale', 2)).toBe(s);
    expect(setKeyframeField(s, 0, 'scale', NaN)).toBe(s);
  });
});

describe('applyPresetKeyframes', () => {
  it('panLeft: from=base.x+0.4 → to=base.x-0.4 の2点を作る', () => {
    const s = st({ mainLayout: { position: { x: 0, y: 0 }, scale: 1, background: '#000', rotation: 0, flipH: false, flipV: false } });
    const r = applyPresetKeyframes(s, 'panLeft', 0, [{ id: 1, originalStart: 0, playbackStart: 0, playbackEnd: 100 }], 60);
    expect(r.layoutKeyframes).toHaveLength(2);
    expect(r.layoutKeyframes[0]).toEqual({ originalFrame: 0, x: 0.4, y: 0, scale: 1, rotation: 0 });
    expect(r.layoutKeyframes[1]).toEqual({ originalFrame: 60, x: -0.4, y: 0, scale: 1, rotation: 0 });
  });
  it('zoomIn: base.scale → *1.8 の2点を作る', () => {
    const s = st({ mainLayout: { position: { x: 0, y: 0 }, scale: 1, background: '#000', rotation: 0, flipH: false, flipV: false } });
    const r = applyPresetKeyframes(s, 'zoomIn', 0, [{ id: 1, originalStart: 0, playbackStart: 0, playbackEnd: 100 }], 60);
    expect(r.layoutKeyframes[0]?.scale).toBe(1);
    expect(r.layoutKeyframes[1]?.scale).toBeCloseTo(1.8, 5);
  });
});
