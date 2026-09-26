import { describe, expect, it } from 'vitest';
import { samePersistedContent, type EditState } from './editState';

/**
 * dirty 判定（samePersistedContent）の網羅検査。
 *
 * この関数が「変わったのに同じ」と誤答すると、dirty=false のまま
 * ①自動保存が発火しない ②離脱ガードが警告しない ③外部変更の再読込が
 * 未保存編集を黙って捨てる（App.tsx の reloadIfSafe）——の3経路で
 * **編集が silent に消える**。ディスクへ書かれる全フィールドについて
 * 「1 つ変えたら必ず false」を機械的に固定する。
 */

const BASE: EditState = {
  telops: [
    {
      id: 1,
      originalStart: 0,
      originalEnd: 30,
      text: 'あ',
      highlight: 'x',
      style: 'emphasis',
      template: 2,
      animation: 'fadeOnly',
      position: { x: 0, y: 0 },
      scale: 1,
      motion: { preset: 'zoomIn', intensity: 0.5, from: { x: 0 }, to: { x: 1 } },
      manual: false,
    },
  ],
  cutRegions: [{ start: 100, end: 120 }],
  se: [
    { id: 1, originalStart: 10, originalEnd: 40, file: 'a.mp3', volume: 0.8, fadeInFrames: 3, fadeOutFrames: 4 },
  ],
  images: [
    {
      id: 1,
      originalStart: 5,
      originalEnd: 50,
      file: 'a.png',
      type: 'photo',
      scale: 1,
      position: { x: 0.1, y: 0.2 },
      opacity: 0.9,
      rotation: 10,
      motion: { preset: 'zoomIn' },
      enter: { kind: 'fade', frames: 8 },
      exit: { kind: 'fade', frames: 8 },
    },
  ],
  videoInserts: [
    {
      id: 1,
      originalStart: 5,
      originalEnd: 60,
      file: 'b.mp4',
      sourceInFrame: 3,
      position: { x: 0, y: 0 },
      scale: 1,
      playbackRate: 1,
      enter: { kind: 'fade', frames: 6 },
      exit: { kind: 'zoom', frames: 6 },
    },
  ],
  bgm: [
    { id: 1, originalStart: 0, originalEnd: 100, file: 'b.mp3', volume: 0.4, fadeInFrames: 10, fadeOutFrames: 10 },
  ],
  selection: null,
  multiTelopIds: [],
  nextTelopId: 2,
  nextSeId: 2,
  nextImageId: 2,
  nextVideoInsertId: 2,
  nextBgmId: 2,
  titles: [{ id: 1, originalStart: 0, originalEnd: 60, text: 'T' }],
  nextTitleId: 2,
  shapes: [
    { id: 1, originalStart: 0, originalEnd: 30, kind: 'rect', x1: 0, y1: 0, x2: 1, y2: 1, color: '#fff', thickness: 'medium', opacity: 1 },
  ],
  nextShapeId: 2,
  sceneTransitions: [{ id: 1, at: 100, kind: 'slide', durationFrames: 15, color: '#000', direction: 'left' }],
  nextTransitionId: 2,
  ducking: { enabled: true, strength: 'mid' },
  mainSpeed: 1,
  segmentSpeeds: { 1: 1.5 },
  mainLayout: { position: { x: 0, y: 0 }, scale: 1, background: '#000', rotation: 0, flipH: false, flipV: false },
  segmentLayouts: { 1: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: false, flipV: false } },
  layoutKeyframes: [{ originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 }],
};

/** BASE を構造複製したうえで mutate を当てた state を返す（BASE は不変に保つ）。 */
function mut(mutate: (s: EditState) => void): EditState {
  const clone = structuredClone(BASE) as EditState;
  mutate(clone);
  return clone;
}

/** 各エントリ: [説明, 1 フィールドだけ変えた state を作る関数]。 */
const MUTATIONS: Array<[string, () => EditState]> = [
  // --- テロップ ---
  ['telop.text', () => mut((s) => { s.telops[0]!.text = 'い'; })],
  ['telop.originalStart', () => mut((s) => { s.telops[0]!.originalStart = 1; })],
  ['telop.originalEnd', () => mut((s) => { s.telops[0]!.originalEnd = 31; })],
  ['telop.position', () => mut((s) => { s.telops[0]!.position = { x: 0.5, y: 0 }; })],
  ['telop.scale', () => mut((s) => { s.telops[0]!.scale = 1.2; })],
  ['telop.template', () => mut((s) => { s.telops[0]!.template = 3; })],
  ['telop.motion', () => mut((s) => { s.telops[0]!.motion = { preset: 'zoomOut' }; })],
  // キーフレーム（F-1）。preset/from/to が同じままキーだけ動かす編集は
  // 「1つ変えたら必ず false」の対象。ここが漏れると、キーを打った・動かした・消したが
  // dirty にならず、離脱・再読込で黙って消える（Codex レビュー P1）。
  ['telop.motion.keys（キーを足す）', () => mut((s) => {
    s.telops[0]!.motion = { preset: 'custom', keys: [{ t: 0, scale: 1 }] };
  })],
  ['image.motion.keys（キーを足す）', () => mut((s) => {
    s.images[0]!.motion = { preset: 'custom', keys: [{ t: 0.3, opacity: 0.5 }] };
  })],
  ['telop.manual', () => mut((s) => { s.telops[0]!.manual = true; })],
  // --- カット ---
  ['cutRegion.start', () => mut((s) => { s.cutRegions[0]!.start = 101; })],
  ['cutRegion.end', () => mut((s) => { s.cutRegions[0]!.end = 121; })],
  // --- SE ---
  ['se.originalStart', () => mut((s) => { s.se[0]!.originalStart = 11; })],
  ['se.originalEnd（区間の伸縮）', () => mut((s) => { s.se[0]!.originalEnd = 41; })],
  ['se.file', () => mut((s) => { s.se[0]!.file = 'z.mp3'; })],
  ['se.volume', () => mut((s) => { s.se[0]!.volume = 0.5; })],
  ['se.fadeInFrames', () => mut((s) => { s.se[0]!.fadeInFrames = 9; })],
  ['se.fadeOutFrames', () => mut((s) => { s.se[0]!.fadeOutFrames = 9; })],
  // --- 画像 ---
  ['image.originalStart', () => mut((s) => { s.images[0]!.originalStart = 6; })],
  ['image.scale', () => mut((s) => { s.images[0]!.scale = 1.4; })],
  ['image.position', () => mut((s) => { s.images[0]!.position = { x: 0.9, y: 0.2 }; })],
  ['image.opacity', () => mut((s) => { s.images[0]!.opacity = 0.3; })],
  ['image.rotation', () => mut((s) => { s.images[0]!.rotation = 45; })],
  ['image.enter', () => mut((s) => { s.images[0]!.enter = { kind: 'zoom', frames: 12 }; })],
  ['image.exit', () => mut((s) => { s.images[0]!.exit = { kind: 'none', frames: 0 }; })],
  ['image.motion', () => mut((s) => { s.images[0]!.motion = { preset: 'panLeft' }; })],
  // --- サブ動画 ---
  ['videoInsert.sourceInFrame', () => mut((s) => { s.videoInserts[0]!.sourceInFrame = 9; })],
  ['videoInsert.scale', () => mut((s) => { s.videoInserts[0]!.scale = 0.5; })],
  ['videoInsert.position', () => mut((s) => { s.videoInserts[0]!.position = { x: 0.4, y: 0 }; })],
  ['videoInsert.playbackRate', () => mut((s) => { s.videoInserts[0]!.playbackRate = 2; })],
  ['videoInsert.enter', () => mut((s) => { s.videoInserts[0]!.enter = { kind: 'slideIn', frames: 6 }; })],
  ['videoInsert.exit', () => mut((s) => { s.videoInserts[0]!.exit = { kind: 'none', frames: 0 }; })],
  // --- BGM ---
  ['bgm.volume', () => mut((s) => { s.bgm[0]!.volume = 0.9; })],
  ['bgm.fadeInFrames', () => mut((s) => { s.bgm[0]!.fadeInFrames = 20; })],
  ['bgm.originalEnd', () => mut((s) => { s.bgm[0]!.originalEnd = 200; })],
  // --- タイトル ---
  ['title.text', () => mut((s) => { s.titles[0]!.text = 'U'; })],
  ['title.originalEnd', () => mut((s) => { s.titles[0]!.originalEnd = 61; })],
  // --- 図形 ---
  ['shape.x2', () => mut((s) => { s.shapes[0]!.x2 = 0.5; })],
  ['shape.color', () => mut((s) => { s.shapes[0]!.color = '#f00'; })],
  ['shape.opacity', () => mut((s) => { s.shapes[0]!.opacity = 0.2; })],
  ['shape.thickness', () => mut((s) => { s.shapes[0]!.thickness = 'thick'; })],
  // --- シーン転換 ---
  ['sceneTransition.kind', () => mut((s) => { s.sceneTransitions[0]!.kind = 'fadeBlack'; })],
  ['sceneTransition.durationFrames', () => mut((s) => { s.sceneTransitions[0]!.durationFrames = 30; })],
  ['sceneTransition.color', () => mut((s) => { s.sceneTransitions[0]!.color = '#fff'; })],
  ['sceneTransition.direction', () => mut((s) => { s.sceneTransitions[0]!.direction = 'right'; })],
  // --- 全体設定 ---
  ['ducking.enabled', () => mut((s) => { s.ducking = { ...s.ducking, enabled: false }; })],
  ['mainSpeed', () => mut((s) => { s.mainSpeed = 2; })],
  ['segmentSpeeds', () => mut((s) => { s.segmentSpeeds[1] = 2; })],
  ['mainLayout.scale', () => mut((s) => { s.mainLayout = { ...s.mainLayout!, scale: 0.5 }; })],
  ['segmentLayouts', () => mut((s) => { s.segmentLayouts[1] = { ...s.segmentLayouts[1]!, scale: 0.5 }; })],
  ['layoutKeyframes', () => mut((s) => { s.layoutKeyframes[0]!.scale = 2; })],
  // --- 追加・削除 ---
  ['テロップ追加', () => mut((s) => { s.telops.push({ ...s.telops[0]!, id: 2 }); })],
  ['SE 削除', () => mut((s) => { s.se = []; })],
];

describe('samePersistedContent は永続化フィールドの変化を必ず検出する', () => {
  it('同一内容の複製は等しいと判定する', () => {
    expect(samePersistedContent(BASE, structuredClone(BASE) as EditState)).toBe(true);
  });

  it('選択・採番カウンタの違いは無視する（履歴・dirty の対象外）', () => {
    const s = mut((x) => {
      x.selection = { kind: 'telop', id: 1 };
      x.nextTelopId = 99;
      x.multiTelopIds = [];
    });
    expect(samePersistedContent(BASE, s)).toBe(true);
  });

  for (const [label, make] of MUTATIONS) {
    it(`${label} の変更を検出する`, () => {
      expect(samePersistedContent(BASE, make())).toBe(false);
      // 対称性: 引数の順序を入れ替えても同じ判定でなければならない。
      expect(samePersistedContent(make(), BASE)).toBe(false);
    });
  }
});


/**
 * キーフレーム同士の比較（F-1・Codex レビュー P1）。
 * 上の表は BASE（キー無し）との比較なので「キーを足した」しか見られない。
 * 実利用でいちばん多いのは「打ったキーを動かす・値を変える・消す」で、
 * これが dirty にならないと保存済み表示のまま編集が消える。
 */
describe('キーフレームの編集は必ず dirty になる', () => {
  const withKeys = (keys: Array<{ t: number; scale?: number; opacity?: number }>): EditState => {
    const s = structuredClone(BASE) as EditState;
    s.telops[0]!.motion = { preset: 'custom', keys };
    return s;
  };

  it('キーの時刻を動かしたら別内容とみなす', () => {
    expect(samePersistedContent(withKeys([{ t: 0.5, scale: 1 }]), withKeys([{ t: 0.9, scale: 1 }]))).toBe(false);
  });

  it('キーの値を変えたら別内容とみなす', () => {
    expect(samePersistedContent(withKeys([{ t: 0.5, scale: 1 }]), withKeys([{ t: 0.5, scale: 2 }]))).toBe(false);
  });

  it('キーを消したら別内容とみなす', () => {
    expect(samePersistedContent(
      withKeys([{ t: 0, scale: 1 }, { t: 1, scale: 2 }]),
      withKeys([{ t: 0, scale: 1 }]),
    )).toBe(false);
  });

  it('同じキー列なら同一内容とみなす（過剰な dirty を出さない）', () => {
    expect(samePersistedContent(withKeys([{ t: 0.25, opacity: 0.5 }]), withKeys([{ t: 0.25, opacity: 0.5 }]))).toBe(true);
  });
});
