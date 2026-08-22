import { describe, expect, it } from 'vitest';
import {
  addImage,
  removeImage,
  selectImage,
  moveImage,
  retimeImage,
  setImageScale,
  setImageType,
  setImageFile,
  setImagePosition,
  setImageOpacity,
  setImageRotation,
  setImageEnter,
  setImageExit,
} from './imageOps';
import type { EditState } from './editState';

function baseState(over: Partial<EditState> = {}): EditState {
  return {
    telops: [],
    cutRegions: [],
    se: [],
    images: [],
    videoInserts: [],
    bgm: [],
    selection: null,
    multiTelopIds: [],
    nextTelopId: 1,
    nextSeId: 1,
    nextImageId: 1,
    nextVideoInsertId: 1,
    nextBgmId: 1,
    titles: [],
    nextTitleId: 1,
    shapes: [],
    nextShapeId: 1,
    sceneTransitions: [],
    nextTransitionId: 1,
    ducking: { enabled: true, strength: 'mid' as const },
    mainSpeed: 1,
    segmentSpeeds: {},
    segmentLayouts: {}, layoutKeyframes: [],
    ...over,
  };
}

describe('addImage', () => {
  it('再生ヘッド位置から既定長 120 フレームの画像を追加し選択する', () => {
    const next = addImage(baseState(), 'photo1.png', 200);
    expect(next.images).toEqual([
      { id: 1, originalStart: 200, originalEnd: 320, file: 'photo1.png', type: 'photo' },
    ]);
    expect(next.nextImageId).toBe(2);
    expect(next.selection).toEqual({ kind: 'image', id: 1 });
  });

  it('originalStart は 0 以上へクランプし丸める', () => {
    const next = addImage(baseState(), 'a.png', -3.7);
    expect(next.images[0]?.originalStart).toBe(0);
    expect(next.images[0]?.originalEnd).toBe(120);
  });

  it('file が空文字なら何もしない', () => {
    const s = baseState();
    expect(addImage(s, '', 10)).toBe(s);
  });

  it('originalStart が非有限なら何もしない', () => {
    const s = baseState();
    expect(addImage(s, 'a.png', Number.NaN)).toBe(s);
  });
});

describe('removeImage', () => {
  it('指定 ID の画像を取り除く', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 10, originalEnd: 80, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    expect(removeImage(s, 1).images).toEqual([]);
  });

  it('選択中の画像を削除したら選択を外す', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 10, originalEnd: 80, file: 'a.png', type: 'photo' }],
      selection: { kind: 'image', id: 1 },
      nextImageId: 2,
    });
    expect(removeImage(s, 1).selection).toBeNull();
  });

  it('不在 ID なら state をそのまま返す', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 10, originalEnd: 80, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    expect(removeImage(s, 99)).toBe(s);
  });

  it('テロップ／SE 選択中に画像を削除しても選択は同一参照で保たれる', () => {
    const sel = { kind: 'telop' as const, id: 7 };
    const s = baseState({
      images: [{ id: 1, originalStart: 10, originalEnd: 80, file: 'a.png', type: 'photo' }],
      selection: sel,
      nextImageId: 2,
    });
    expect(removeImage(s, 1).selection).toBe(sel);
  });
});

describe('selectImage', () => {
  it('画像を選択する', () => {
    expect(selectImage(baseState(), 3).selection).toEqual({ kind: 'image', id: 3 });
  });
});

describe('moveImage', () => {
  it('画像区間の長さを保って originalStart を変える', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 100, originalEnd: 220, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    const next = moveImage(s, 1, 50);
    expect(next.images[0]).toEqual({
      id: 1, originalStart: 50, originalEnd: 170, file: 'a.png', type: 'photo',
    });
  });

  it('originalStart < 0 は 0 へクランプし、終端は長さを保つ', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 100, originalEnd: 220, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    const next = moveImage(s, 1, -10);
    expect(next.images[0]).toEqual({
      id: 1, originalStart: 0, originalEnd: 120, file: 'a.png', type: 'photo',
    });
  });

  it('非有限値・不在 ID は state をそのまま返す', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 100, originalEnd: 220, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    expect(moveImage(s, 1, Number.NaN)).toBe(s);
    expect(moveImage(s, 99, 50)).toBe(s);
  });
});

describe('retimeImage', () => {
  it('originalStart と originalEnd を直接書き換える', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 100, originalEnd: 220, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    const next = retimeImage(s, 1, 80, 300);
    expect(next.images[0]?.originalStart).toBe(80);
    expect(next.images[0]?.originalEnd).toBe(300);
  });

  it('end が start を超えなければ最小 1 フレーム差を保つよう end を後ろへずらす', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 100, originalEnd: 200, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    const next = retimeImage(s, 1, 80, 50);
    expect(next.images[0]?.originalStart).toBe(80);
    expect(next.images[0]?.originalEnd).toBe(81);
  });

  it('非有限値・不在 ID は state をそのまま返す', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 100, originalEnd: 200, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    expect(retimeImage(s, 1, Number.NaN, 200)).toBe(s);
    expect(retimeImage(s, 1, 100, Number.NaN)).toBe(s);
    expect(retimeImage(s, 99, 0, 100)).toBe(s);
  });

  it('originalStart < 0 は 0 へクランプし、終了端はその範囲で再評価される', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 100, originalEnd: 200, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    const next = retimeImage(s, 1, -5, 200);
    expect(next.images[0]?.originalStart).toBe(0);
    expect(next.images[0]?.originalEnd).toBe(200);
  });
});

describe('setImageScale', () => {
  it('スケールを 0.1..5 へクランプして設定する', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 10, originalEnd: 80, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    expect(setImageScale(s, 1, 1.5).images[0]?.scale).toBe(1.5);
    expect(setImageScale(s, 1, 8).images[0]?.scale).toBe(5);
    expect(setImageScale(s, 1, 0.01).images[0]?.scale).toBe(0.1);
  });

  it('非有限値・不在 ID は state をそのまま返す', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 10, originalEnd: 80, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    expect(setImageScale(s, 1, Number.NaN)).toBe(s);
    expect(setImageScale(s, 99, 1)).toBe(s);
  });
});

describe('setImageType', () => {
  it('画像タイプを差し替える', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 10, originalEnd: 80, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    expect(setImageType(s, 1, 'infographic').images[0]?.type).toBe('infographic');
    expect(setImageType(s, 1, 'overlay').images[0]?.type).toBe('overlay');
  });

  it('不在 ID は state をそのまま返す', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 10, originalEnd: 80, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    expect(setImageType(s, 99, 'overlay')).toBe(s);
  });
});

describe('setImageFile', () => {
  it('画像ファイルを差し替える', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 10, originalEnd: 80, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    expect(setImageFile(s, 1, 'b.png').images[0]?.file).toBe('b.png');
  });

  it('空文字・不在 ID は state をそのまま返す', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 10, originalEnd: 80, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    expect(setImageFile(s, 1, '')).toBe(s);
    expect(setImageFile(s, 99, 'b.png')).toBe(s);
  });
});

describe('setImagePosition', () => {
  it('選択画像の position を設定し -1..1 にクランプする', () => {
    const withImg = addImage(baseState(), 'a.png', 0);
    const id = withImg.images[0]!.id;
    const moved = setImagePosition(withImg, id, -2, 0.5);
    expect(moved.images[0]?.position).toEqual({ x: -1, y: 0.5 });
  });
  it('不在 ID は state をそのまま返す', () => {
    const base = addImage(baseState(), 'a.png', 0);
    expect(setImagePosition(base, 999, 0.2, 0.2)).toBe(base);
  });
  it('非有限は無視', () => {
    const base = addImage(baseState(), 'a.png', 0);
    const id = base.images[0]!.id;
    expect(setImagePosition(base, id, Number.NaN, 0)).toBe(base);
  });
});

describe('setImageOpacity', () => {
  it('不透明度を 0..1 へクランプして設定する', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 10, originalEnd: 80, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    expect(setImageOpacity(s, 1, 0.5).images[0]?.opacity).toBe(0.5);
    expect(setImageOpacity(s, 1, 2).images[0]?.opacity).toBe(1);
    expect(setImageOpacity(s, 1, -0.3).images[0]?.opacity).toBe(0);
  });
  it('非有限値・不在 ID は state をそのまま返す', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 10, originalEnd: 80, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    expect(setImageOpacity(s, 1, Number.NaN)).toBe(s);
    expect(setImageOpacity(s, 99, 0.5)).toBe(s);
  });
});

describe('setImageRotation', () => {
  it('回転角を -180..180 へクランプして設定する', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 10, originalEnd: 80, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    expect(setImageRotation(s, 1, 30).images[0]?.rotation).toBe(30);
    expect(setImageRotation(s, 1, 500).images[0]?.rotation).toBe(180);
    expect(setImageRotation(s, 1, -500).images[0]?.rotation).toBe(-180);
  });
  it('非有限値・不在 ID は state をそのまま返す', () => {
    const s = baseState({
      images: [{ id: 1, originalStart: 10, originalEnd: 80, file: 'a.png', type: 'photo' }],
      nextImageId: 2,
    });
    expect(setImageRotation(s, 1, Number.NaN)).toBe(s);
    expect(setImageRotation(s, 99, 30)).toBe(s);
  });
});

describe('setImageEnter / setImageExit', () => {
  function stateWithImage() {
    return addImage(baseState(), 'a.png', 0);
  }
  it('登場アニメを設定する', () => {
    const s = setImageEnter(stateWithImage(), 1, { kind: 'zoom', frames: 12 });
    expect(s.images[0]!.enter).toEqual({ kind: 'zoom', frames: 12 });
  });
  it('退場アニメを設定する', () => {
    const s = setImageExit(stateWithImage(), 1, { kind: 'fade', frames: 6 });
    expect(s.images[0]!.exit).toEqual({ kind: 'fade', frames: 6 });
  });
  it('不在 ID はそのまま', () => {
    const base = stateWithImage();
    expect(setImageEnter(base, 999, { kind: 'fade', frames: 8 })).toBe(base);
  });
});
