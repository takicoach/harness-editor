import { describe, expect, it, test } from 'vitest';
import { addSe, removeSe, selectSe, moveSe, setSeVolume, setSeFile, resizeSe, setSeFadeIn, setSeFadeOut, fitSeToSource, normalizeSeVolume, finalizeAddedSe } from './seOps';
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

describe('addSe', () => {
  it('再生ヘッド位置に SE を追加し選択する', () => {
    const next = addSe(baseState(), 'ポン.mp3', 120);
    expect(next.se).toEqual([{
      id: 1,
      originalStart: 120,
      originalEnd: 210,
      file: 'ポン.mp3',
      volume: 0.3,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      autoLength: true,
      autoVolume: true,
    }]);
    expect(next.nextSeId).toBe(2);
    expect(next.selection).toEqual({ kind: 'se', id: 1 });
  });

  it('既存 SE がある配列の末尾へ追加し既存 SE を保つ', () => {
    const s = baseState({ se: [{ id: 1, originalStart: 10, originalEnd: 100, file: 'a.mp3' }], nextSeId: 2 });
    const next = addSe(s, 'b.mp3', 50);
    expect(next.se[0]).toEqual({ id: 1, originalStart: 10, originalEnd: 100, file: 'a.mp3' });
    expect(next.se[1]?.originalStart).toBe(50);
    expect(next.se[1]?.originalEnd).toBe(140);
    expect(next.nextSeId).toBe(3);
  });

  it('originalStart は 0 以上へクランプし丸める', () => {
    const next = addSe(baseState(), 'a.mp3', -3.7);
    expect(next.se[0]?.originalStart).toBe(0);
  });

  it('file が空文字なら何もしない', () => {
    const s = baseState();
    expect(addSe(s, '', 10)).toBe(s);
  });

  it('originalStart が非有限なら何もしない', () => {
    const s = baseState();
    expect(addSe(s, 'a.mp3', Number.NaN)).toBe(s);
  });
});

describe('removeSe', () => {
  it('指定 ID の SE を取り除く', () => {
    const s = baseState({ se: [{ id: 1, originalStart: 10, originalEnd: 100, file: 'a.mp3' }], nextSeId: 2 });
    expect(removeSe(s, 1).se).toEqual([]);
  });

  it('選択中の SE を削除したら選択を外す', () => {
    const s = baseState({
      se: [{ id: 1, originalStart: 10, originalEnd: 100, file: 'a.mp3' }],
      selection: { kind: 'se', id: 1 },
      nextSeId: 2,
    });
    expect(removeSe(s, 1).selection).toBeNull();
  });

  it('不在 ID なら state をそのまま返す', () => {
    const s = baseState({ se: [{ id: 1, originalStart: 10, originalEnd: 100, file: 'a.mp3' }], nextSeId: 2 });
    expect(removeSe(s, 99)).toBe(s);
  });

  it('テロップを選択中に SE を削除しても選択は同一参照で保たれる', () => {
    const sel = { kind: 'telop' as const, id: 7 };
    const s = baseState({
      se: [{ id: 1, originalStart: 10, originalEnd: 100, file: 'a.mp3' }],
      selection: sel,
      nextSeId: 2,
    });
    expect(removeSe(s, 1).selection).toBe(sel);
  });
});

describe('selectSe', () => {
  it('SE を選択する', () => {
    expect(selectSe(baseState(), 3).selection).toEqual({ kind: 'se', id: 3 });
  });
});

describe('moveSe', () => {
  it('指定 SE の originalStart を変える（0 以上クランプ・丸め）', () => {
    const s = baseState({ se: [{ id: 1, originalStart: 10, originalEnd: 100, file: 'a.mp3' }], nextSeId: 2 });
    expect(moveSe(s, 1, 88.6).se[0]?.originalStart).toBe(89);
    expect(moveSe(s, 1, -5).se[0]?.originalStart).toBe(0);
  });

  it('非有限値・不在 ID は state をそのまま返す', () => {
    const s = baseState({ se: [{ id: 1, originalStart: 10, originalEnd: 100, file: 'a.mp3' }], nextSeId: 2 });
    expect(moveSe(s, 1, Number.NaN)).toBe(s);
    expect(moveSe(s, 99, 50)).toBe(s);
  });
});

describe('setSeVolume', () => {
  it('音量を 0..1 へクランプして設定する', () => {
    const s = baseState({ se: [{ id: 1, originalStart: 10, originalEnd: 100, file: 'a.mp3' }], nextSeId: 2 });
    expect(setSeVolume(s, 1, 0.5).se[0]?.volume).toBe(0.5);
    expect(setSeVolume(s, 1, 1.8).se[0]?.volume).toBe(1);
    expect(setSeVolume(s, 1, -1).se[0]?.volume).toBe(0);
  });

  it('非有限値・不在 ID は state をそのまま返す', () => {
    const s = baseState({ se: [{ id: 1, originalStart: 10, originalEnd: 100, file: 'a.mp3' }], nextSeId: 2 });
    expect(setSeVolume(s, 1, Number.NaN)).toBe(s);
    expect(setSeVolume(s, 99, 0.5)).toBe(s);
  });
});

describe('setSeFile', () => {
  it('効果音ファイルを差し替える', () => {
    const s = baseState({ se: [{ id: 1, originalStart: 10, originalEnd: 100, file: 'a.mp3' }], nextSeId: 2 });
    expect(setSeFile(s, 1, 'b.mp3').se[0]?.file).toBe('b.mp3');
  });

  it('空文字・不在 ID は state をそのまま返す', () => {
    const s = baseState({ se: [{ id: 1, originalStart: 10, originalEnd: 100, file: 'a.mp3' }], nextSeId: 2 });
    expect(setSeFile(s, 1, '')).toBe(s);
    expect(setSeFile(s, 99, 'b.mp3')).toBe(s);
  });
});

test('addSe は既定 90 フレームの区間と autoLength を立てる', () => {
  const s = addSe(baseState(), 'a.mp3', 30);
  const se = s.se[0];
  expect(se?.originalStart).toBe(30);
  expect(se?.originalEnd).toBe(120);
  expect(se?.autoLength).toBe(true);
});

test('addSe は durationFrames 指定で区間長を決める', () => {
  const s = addSe(baseState(), 'a.mp3', 30, 45);
  expect(s.se[0]?.originalEnd).toBe(75);
});

test('resizeSe は end >= start+1 をクランプする', () => {
  const s = addSe(baseState(), 'a.mp3', 30);
  const id = s.se[0]!.id;
  const r = resizeSe(s, id, 30, 10); // end < start
  expect(r.se[0]?.originalEnd).toBe(31);
});

test('setSeFadeIn / setSeFadeOut は 0 以上へ丸める', () => {
  const s = addSe(baseState(), 'a.mp3', 30);
  const id = s.se[0]!.id;
  expect(setSeFadeIn(s, id, 7.6).se[0]?.fadeInFrames).toBe(8);
  expect(setSeFadeOut(s, id, -3).se[0]?.fadeOutFrames).toBe(0);
});

test('moveSe は区間長を保つ', () => {
  const s = addSe(baseState(), 'a.mp3', 30, 60); // [30,90)
  const id = s.se[0]!.id;
  const m = moveSe(s, id, 100);
  expect(m.se[0]?.originalStart).toBe(100);
  expect(m.se[0]?.originalEnd).toBe(160);
});

test('fitSeToSource は自然長へ合わせ autoLength を外す', () => {
  const s = addSe(baseState(), 'a.mp3', 30); // autoLength true, [30,120)
  const id = s.se[0]!.id;
  const f = fitSeToSource(s, id, 45);
  expect(f.se[0]?.originalEnd).toBe(75);
  expect(f.se[0]?.autoLength).toBeUndefined();
});

test('addSe は autoVolume を立てる', () => {
  expect(addSe(baseState(), 'a.mp3', 30).se[0]?.autoVolume).toBe(true);
});

test('normalizeSeVolume は volume を確定し autoVolume を外す', () => {
  const s = addSe(baseState(), 'a.mp3', 30);
  const id = s.se[0]!.id;
  const n = normalizeSeVolume(s, id, 0.55);
  expect(n.se[0]?.volume).toBeCloseTo(0.55, 6);
  expect(n.se[0]?.autoVolume).toBeUndefined();
});

test('setSeVolume（手動）は autoVolume を外す', () => {
  const s = addSe(baseState(), 'a.mp3', 30);
  const id = s.se[0]!.id;
  expect(setSeVolume(s, id, 0.7).se[0]?.autoVolume).toBeUndefined();
});

test('normalizeSeVolume は volume を 0..1 にクランプ', () => {
  const s = addSe(baseState(), 'a.mp3', 30);
  const id = s.se[0]!.id;
  expect(normalizeSeVolume(s, id, 5).se[0]?.volume).toBe(1);
});

test('finalizeAddedSe は長さと音量を1回で確定し両フラグを外す（C-1回帰）', () => {
  const s = addSe(baseState(), 'a.mp3', 30); // autoLength:true, autoVolume:true, originalEnd=120
  const id = s.se[0]!.id;
  const f = finalizeAddedSe(s, id, 45, 0.6);
  expect(f.se[0]?.originalEnd).toBe(75);   // 30 + 45（fit が反映）
  expect(f.se[0]?.volume).toBeCloseTo(0.6, 6); // 正規化音量も反映
  expect(f.se[0]?.autoLength).toBeUndefined();
  expect(f.se[0]?.autoVolume).toBeUndefined();
});

test('finalizeAddedSe は手動で音量済み(autoVolume無)なら音量を上書きしない', () => {
  let s = addSe(baseState(), 'a.mp3', 30);
  const id = s.se[0]!.id;
  s = setSeVolume(s, id, 0.9); // 手動 → autoVolume 解除、autoLength は残る
  const f = finalizeAddedSe(s, id, 45, 0.2);
  expect(f.se[0]?.originalEnd).toBe(75);     // 長さは fit される
  expect(f.se[0]?.volume).toBeCloseTo(0.9, 6); // 手動音量は維持（0.2 で上書きしない）
});
