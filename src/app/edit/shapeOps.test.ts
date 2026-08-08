import { describe, it, expect } from 'vitest';
import {
  addShape,
  removeShape,
  selectShape,
  moveShape,
  setShapePoints,
  retimeShape,
  moveShapeTime,
  setShapeColor,
  setShapeThickness,
  setShapeOpacity,
} from './shapeOps';
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

const base = () => createEditState(makeProject({ shapes: [], shapeDataSource: null }));

describe('addShape', () => {
  it('既定で 120fr・赤(DEFAULT_SHAPE_COLOR)・medium・選択状態にする', () => {
    const st = addShape(base(), 'arrow', 0.1, 0.1, 0.5, 0.5, 30);
    expect(st.shapes).toHaveLength(1);
    const s = st.shapes[0]!;
    expect(s.originalEnd - s.originalStart).toBe(120);
    expect(s.color).toBe('#FF3B30');
    expect(s.thickness).toBe('medium');
    expect(s.kind).toBe('arrow');
    expect(s.x1).toBeCloseTo(0.1);
    expect(s.y1).toBeCloseTo(0.1);
    expect(s.x2).toBeCloseTo(0.5);
    expect(s.y2).toBeCloseTo(0.5);
    expect(st.selection).toEqual({ kind: 'shape', id: s.id });
    expect(st.nextShapeId).toBe(s.id + 1);
  });

  it('originalStart は 0 以上へクランプし丸める', () => {
    const st = addShape(base(), 'line', 0, 0, 1, 1, -5.7);
    expect(st.shapes[0]?.originalStart).toBe(0);
    expect(st.shapes[0]?.originalEnd).toBe(120);
  });

  it('座標は 0..1 へクランプする', () => {
    const st = addShape(base(), 'rect', -2, 0.5, 9, -0.5, 0);
    const s = st.shapes[0]!;
    expect(s.x1).toBe(0);
    expect(s.y1).toBe(0.5);
    expect(s.x2).toBe(1);
    expect(s.y2).toBe(0);
  });

  it('非有限値が含まれる場合は state をそのまま返す', () => {
    const s = base();
    expect(addShape(s, 'arrow', Number.NaN, 0, 1, 1, 0)).toBe(s);
    expect(addShape(s, 'arrow', 0, Infinity, 1, 1, 0)).toBe(s);
    expect(addShape(s, 'arrow', 0, 0, 1, 1, Number.NaN)).toBe(s);
  });
});

describe('removeShape', () => {
  it('指定 ID の図形を取り除く', () => {
    let st = addShape(base(), 'line', 0, 0, 1, 1, 0);
    const id = st.shapes[0]!.id;
    st = removeShape(st, id);
    expect(st.shapes).toHaveLength(0);
  });

  it('選択中の図形を削除したら選択を外す', () => {
    let st = addShape(base(), 'rect', 0, 0, 1, 1, 0);
    const id = st.shapes[0]!.id;
    expect(st.selection).toEqual({ kind: 'shape', id });
    st = removeShape(st, id);
    expect(st.selection).toBeNull();
  });

  it('他の種類が選択中に図形を削除しても選択は保たれる', () => {
    const initial = base();
    const withSel = { ...initial, selection: { kind: 'telop' as const, id: 7 } };
    let st = addShape(withSel, 'arrow', 0.1, 0.1, 0.5, 0.5, 0);
    // 追加した図形が選択されるので手動で元に戻す
    st = { ...st, selection: { kind: 'telop' as const, id: 7 } };
    const id = st.shapes[0]!.id;
    const after = removeShape(st, id);
    expect(after.selection).toEqual({ kind: 'telop', id: 7 });
  });

  it('不在 ID なら state をそのまま返す', () => {
    const st = addShape(base(), 'ellipse', 0, 0, 1, 1, 0);
    expect(removeShape(st, 999)).toBe(st);
  });
});

describe('selectShape', () => {
  it('指定 ID の図形を選択する', () => {
    expect(selectShape(base(), 5).selection).toEqual({ kind: 'shape', id: 5 });
  });
});

describe('moveShape', () => {
  it('2 点を平行移動し 0..1 へクランプする', () => {
    let st = addShape(base(), 'rect', 0.1, 0.1, 0.3, 0.3, 0);
    const id = st.shapes[0]!.id;
    st = moveShape(st, id, 0.5, 0.5);
    const s = st.shapes[0]!;
    expect(s.x1).toBeCloseTo(0.6);
    expect(s.y1).toBeCloseTo(0.6);
    expect(s.x2).toBeCloseTo(0.8);
    expect(s.y2).toBeCloseTo(0.8);
  });

  it('クランプにより 0 未満は 0 になる', () => {
    let st = addShape(base(), 'line', 0.1, 0.1, 0.5, 0.5, 0);
    const id = st.shapes[0]!.id;
    st = moveShape(st, id, -0.5, -0.5);
    const s = st.shapes[0]!;
    expect(s.x1).toBe(0);
    expect(s.y1).toBe(0);
    expect(s.x2).toBeCloseTo(0);
    expect(s.y2).toBeCloseTo(0);
  });

  it('非有限値・不在 ID は state をそのまま返す', () => {
    let st = addShape(base(), 'arrow', 0.1, 0.1, 0.5, 0.5, 0);
    const id = st.shapes[0]!.id;
    expect(moveShape(st, id, Number.NaN, 0)).toBe(st);
    expect(moveShape(st, id, 0, Number.POSITIVE_INFINITY)).toBe(st);
    expect(moveShape(st, 999, 0.1, 0.1)).toBe(st);
  });
});

describe('setShapePoints', () => {
  it('4 点を 0..1 へクランプして設定する', () => {
    let st = addShape(base(), 'line', 0, 0, 1, 1, 0);
    const id = st.shapes[0]!.id;
    st = setShapePoints(st, id, -5, 0.2, 9, 0.8);
    const s = st.shapes[0]!;
    expect(s.x1).toBe(0);
    expect(s.y1).toBeCloseTo(0.2);
    expect(s.x2).toBe(1);
    expect(s.y2).toBeCloseTo(0.8);
  });

  it('非有限値・不在 ID は state をそのまま返す', () => {
    let st = addShape(base(), 'line', 0, 0, 1, 1, 0);
    const id = st.shapes[0]!.id;
    expect(setShapePoints(st, id, Number.NaN, 0, 1, 1)).toBe(st);
    expect(setShapePoints(st, 999, 0, 0, 1, 1)).toBe(st);
  });
});

describe('retimeShape', () => {
  it('originalStart と originalEnd を直接書き換える', () => {
    let st = addShape(base(), 'rect', 0, 0, 1, 1, 100);
    const id = st.shapes[0]!.id;
    st = retimeShape(st, id, 80, 300);
    expect(st.shapes[0]?.originalStart).toBe(80);
    expect(st.shapes[0]?.originalEnd).toBe(300);
  });

  it('end <= start なら最小 1 フレーム差を強制する', () => {
    let st = addShape(base(), 'arrow', 0, 0, 1, 1, 100);
    const id = st.shapes[0]!.id;
    st = retimeShape(st, id, 80, 50);
    expect(st.shapes[0]?.originalStart).toBe(80);
    expect(st.shapes[0]?.originalEnd).toBe(81);
  });

  it('originalStart < 0 は 0 へクランプ', () => {
    let st = addShape(base(), 'line', 0, 0, 1, 1, 50);
    const id = st.shapes[0]!.id;
    st = retimeShape(st, id, -10, 200);
    expect(st.shapes[0]?.originalStart).toBe(0);
    expect(st.shapes[0]?.originalEnd).toBe(200);
  });

  it('非有限値・不在 ID は state をそのまま返す', () => {
    let st = addShape(base(), 'ellipse', 0, 0, 1, 1, 0);
    const id = st.shapes[0]!.id;
    expect(retimeShape(st, id, Number.NaN, 200)).toBe(st);
    expect(retimeShape(st, id, 0, Number.NaN)).toBe(st);
    expect(retimeShape(st, 999, 0, 100)).toBe(st);
  });
});

describe('moveShapeTime', () => {
  it('区間の長さを保って originalStart を変える', () => {
    let st = addShape(base(), 'rect', 0, 0, 1, 1, 100);
    const id = st.shapes[0]!.id;
    // addShape: originalStart=100, originalEnd=220
    st = moveShapeTime(st, id, 50);
    expect(st.shapes[0]?.originalStart).toBe(50);
    expect(st.shapes[0]?.originalEnd).toBe(170);
  });

  it('originalStart < 0 は 0 へクランプし長さは保つ', () => {
    let st = addShape(base(), 'arrow', 0, 0, 1, 1, 100);
    const id = st.shapes[0]!.id;
    st = moveShapeTime(st, id, -10);
    expect(st.shapes[0]?.originalStart).toBe(0);
    expect(st.shapes[0]?.originalEnd).toBe(120);
  });

  it('非有限値・不在 ID は state をそのまま返す', () => {
    let st = addShape(base(), 'line', 0, 0, 1, 1, 0);
    const id = st.shapes[0]!.id;
    expect(moveShapeTime(st, id, Number.NaN)).toBe(st);
    expect(moveShapeTime(st, 999, 10)).toBe(st);
  });
});

describe('setShapeColor', () => {
  it('色を設定する', () => {
    let st = addShape(base(), 'ellipse', 0, 0, 1, 1, 0);
    const id = st.shapes[0]!.id;
    st = setShapeColor(st, id, '#0A84FF');
    expect(st.shapes[0]?.color).toBe('#0A84FF');
  });

  it('空文字・不在 ID は state をそのまま返す', () => {
    let st = addShape(base(), 'rect', 0, 0, 1, 1, 0);
    const id = st.shapes[0]!.id;
    expect(setShapeColor(st, id, '')).toBe(st);
    expect(setShapeColor(st, 999, '#0A84FF')).toBe(st);
  });
});

describe('setShapeThickness', () => {
  it('太さを設定する（thin / medium / thick）', () => {
    let st = addShape(base(), 'arrow', 0, 0, 1, 1, 0);
    const id = st.shapes[0]!.id;
    st = setShapeThickness(st, id, 'thick');
    expect(st.shapes[0]?.thickness).toBe('thick');
    st = setShapeThickness(st, id, 'thin');
    expect(st.shapes[0]?.thickness).toBe('thin');
  });

  it('不在 ID は state をそのまま返す', () => {
    const st = addShape(base(), 'line', 0, 0, 1, 1, 0);
    expect(setShapeThickness(st, 999, 'thick')).toBe(st);
  });
});

describe('setShapeOpacity', () => {
  it('不透明度を 0..1 へクランプして設定する', () => {
    let st = addShape(base(), 'ellipse', 0, 0, 1, 1, 0);
    const id = st.shapes[0]!.id;
    st = setShapeOpacity(st, id, 0.5);
    expect(st.shapes[0]?.opacity).toBe(0.5);
    st = setShapeOpacity(st, id, 2);
    expect(st.shapes[0]?.opacity).toBe(1);
    st = setShapeOpacity(st, id, -0.3);
    expect(st.shapes[0]?.opacity).toBe(0);
  });

  it('非有限値・不在 ID は state をそのまま返す', () => {
    let st = addShape(base(), 'rect', 0, 0, 1, 1, 0);
    const id = st.shapes[0]!.id;
    expect(setShapeOpacity(st, id, Number.NaN)).toBe(st);
    expect(setShapeOpacity(st, 999, 0.5)).toBe(st);
  });
});

describe('addShape + setShapeColor + setShapeThickness + setShapeOpacity (combined)', () => {
  it('図形を追加して色・太さ・不透明度を設定する', () => {
    let st = addShape(base(), 'ellipse', 0, 0, 1, 1, 0);
    const id = st.shapes[0]!.id;
    st = setShapeColor(st, id, '#0A84FF');
    st = setShapeThickness(st, id, 'thick');
    st = setShapeOpacity(st, id, 2); // クランプ → 1
    const s = st.shapes[0]!;
    expect(s.color).toBe('#0A84FF');
    expect(s.thickness).toBe('thick');
    expect(s.opacity).toBe(1);
  });
});
