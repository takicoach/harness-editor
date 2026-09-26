import { describe, expect, it } from 'vitest';
import { createHistory, current, pushState, redo, undo } from './history';
import type { EditState } from './editState';
import { samePersistedContent } from './editState';
import { moveTelop, removeTelop, setTelopPosition, setTelopScale, setTelopTemplate, setTelopTiming, setTelopMotion } from './telopSettingsOps';
import { setTelopText } from './textOps';
import { splitTelopAt, toggleSegmentCut } from './cutOps';
import { addSe, moveSe, removeSe, resizeSe, setSeFadeIn, setSeFadeOut, setSeVolume } from './seOps';
import { addBgm, moveBgm, removeBgm, resizeBgm, setBgmFadeIn, setBgmVolume } from './bgmOps';
import { addImage, moveImage, removeImage, retimeImage, setImageEnter, setImageMotion, setImageOpacity, setImagePosition, setImageRotation, setImageScale } from './imageOps';
import { addShape, moveShape, removeShape, retimeShape, setShapeColor, setShapeOpacity, setShapePoints, setShapeThickness } from './shapeOps';
import { addVideoInsert, moveVideoInsert, removeVideoInsert, retimeVideoInsert, setVideoInsertEnter, setVideoInsertInPoint, setVideoInsertPlaybackRate, setVideoInsertPosition, setVideoInsertScale } from './videoInsertOps';
import { moveTitle, removeTitle, setTitleText, setTitleTiming } from './titleOps';
import { setMainSpeed, setMainVideoFlipH, setMainVideoPosition, setMainVideoRotation, setMainVideoScale, setColorGradeField, resetColorGrade } from './mainVideoOps';
import { clearSegmentSpeed, setSegmentSpeed } from './segmentSpeedOps';
import { setSegmentPosition, setSegmentScale, clearSegmentLayout } from './segmentLayoutOps';
import { addKeyframeAt, clearKeyframes, removeKeyframe, setKeyframeField } from './layoutKeyframeOps';
import { clearSceneTransition, setSceneTransition, setSceneTransitionDirection, setSceneTransitionDuration } from './transitionOps';
import { setDucking } from './duckingOps';

/**
 * Undo/Redo の往復同一性（G-5）。
 *
 * 履歴はスナップショット方式なので、往復が壊れるとしたら原因は 1 つ——
 * **op が入力 state の入れ子オブジェクトを破壊的に書き換えている**場合。
 * createEditState は 1 段スプレッドしかしないため（position / motion / enter などは
 * 参照共有）、op が `telop.position.x = …` のように書けば過去のスナップショットまで
 * 巻き添えで変わり、Undo しても戻らない＝データ損失になる。
 *
 * そこで各 op について
 *   1. 適用前 state の深い複製を取る（op が入力を壊していないかの照合用）
 *   2. op が**実際に永続内容を変えた**ことを確認する（存在検査。何もしない op は
 *      往復テストを素通りしてしまう）
 *   3. undo で適用前と完全一致、redo で適用後と完全一致
 * を機械的に確認する。
 */

const KF = { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 } as const;

function baseState(): EditState {
  return {
    telops: [
      { id: 1, originalStart: 0, originalEnd: 30, text: 'あいうえお', position: { x: 0, y: 0 }, scale: 1, template: 1 },
      { id: 2, originalStart: 40, originalEnd: 70, text: 'かきくけこ', position: { x: 0, y: 0 }, scale: 1, template: 1 },
    ],
    cutRegions: [],
    se: [{ id: 1, originalStart: 10, originalEnd: 40, file: 'a.mp3', volume: 0.8, fadeInFrames: 2, fadeOutFrames: 2 }],
    images: [
      {
        id: 1, originalStart: 5, originalEnd: 50, file: 'a.png', type: 'photo', scale: 1,
        position: { x: 0, y: 0 }, opacity: 1, rotation: 0,
        motion: { preset: 'zoomIn', from: { x: 0 }, to: { x: 1 } },
        enter: { kind: 'fade', frames: 8 }, exit: { kind: 'fade', frames: 8 },
      },
    ],
    videoInserts: [
      {
        id: 1, originalStart: 100, originalEnd: 200, file: 'b.mp4', sourceInFrame: 0,
        position: { x: 0, y: 0 }, scale: 1, playbackRate: 1,
        enter: { kind: 'fade', frames: 6 }, exit: { kind: 'fade', frames: 6 },
      },
    ],
    bgm: [{ id: 1, originalStart: 0, originalEnd: 300, file: 'b.mp3', volume: 0.4, fadeInFrames: 10, fadeOutFrames: 10 }],
    selection: null,
    multiTelopIds: [],
    nextTelopId: 3,
    nextSeId: 2,
    nextImageId: 2,
    nextVideoInsertId: 2,
    nextBgmId: 2,
    titles: [{ id: 1, originalStart: 0, originalEnd: 60, text: 'タイトル' }],
    nextTitleId: 2,
    shapes: [
      { id: 1, originalStart: 0, originalEnd: 30, kind: 'rect', x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5, color: '#fff', thickness: 'medium', opacity: 1 },
    ],
    nextShapeId: 2,
    sceneTransitions: [{ id: 1, at: 'head', kind: 'fadeBlack', durationFrames: 15 }],
    nextTransitionId: 2,
    ducking: { enabled: true, strength: 'mid' },
    mainSpeed: 1,
    segmentSpeeds: { 1: 1.5 },
    mainLayout: { position: { x: 0, y: 0 }, scale: 1, background: '#000', rotation: 0, flipH: false, flipV: false },
    segmentLayouts: { 1: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: false, flipV: false } },
    layoutKeyframes: [KF, { originalFrame: 60, x: 0.2, y: 0, scale: 1.2, rotation: 0 }],
    colorGrade: { brightness: 5, contrast: 0, saturation: 0, temperature: 0 },
  };
}

/** [操作名, op]。op は state を受けて次の state を返す純関数であること。 */
const OPS: Array<[string, (s: EditState) => EditState]> = [
  // テロップ
  ['テロップ文言の変更', (s) => setTelopText(s, 1, 'さしすせそ')],
  ['テロップの移動', (s) => moveTelop(s, 1, 5)],
  ['テロップの尺変更', (s) => setTelopTiming(s, 1, 2, 28)],
  ['テロップ位置の変更', (s) => setTelopPosition(s, 1, 0.3, -0.4)],
  ['テロップ拡大率の変更', (s) => setTelopScale(s, 1, 1.4)],
  ['テロップテンプレの変更', (s) => setTelopTemplate(s, 1, 3)],
  ['テロップ 2 点アニメの設定', (s) => setTelopMotion(s, 1, { preset: 'panLeft', intensity: 0.7 })],
  ['テロップの分割', (s) => splitTelopAt(s, 1, 15, 'あい', 'うえお')],
  ['テロップの削除', (s) => removeTelop(s, 1)],
  // カット
  ['区間カットのトグル', (s) => toggleSegmentCut(s, 2)],
  // SE
  ['SE の追加', (s) => addSe(s, 'new.mp3', 200)],
  ['SE の移動', (s) => moveSe(s, 1, 25)],
  ['SE の伸縮', (s) => resizeSe(s, 1, 12, 60)],
  ['SE 音量の変更', (s) => setSeVolume(s, 1, 0.3)],
  ['SE フェードインの変更', (s) => setSeFadeIn(s, 1, 12)],
  ['SE フェードアウトの変更', (s) => setSeFadeOut(s, 1, 12)],
  ['SE の削除', (s) => removeSe(s, 1)],
  // BGM
  ['BGM の追加', (s) => addBgm(s, 'new.mp3', 400)],
  ['BGM の移動', (s) => moveBgm(s, 1, 20)],
  ['BGM の伸縮', (s) => resizeBgm(s, 1, 10, 250)],
  ['BGM 音量の変更', (s) => setBgmVolume(s, 1, 0.9)],
  ['BGM フェードインの変更', (s) => setBgmFadeIn(s, 1, 30)],
  ['BGM の削除', (s) => removeBgm(s, 1)],
  // 画像
  ['画像の追加', (s) => addImage(s, 'new.png', 300)],
  ['画像の移動', (s) => moveImage(s, 1, 20)],
  ['画像の尺変更', (s) => retimeImage(s, 1, 8, 40)],
  ['画像拡大率の変更', (s) => setImageScale(s, 1, 1.5)],
  ['画像位置の変更', (s) => setImagePosition(s, 1, 0.4, -0.2)],
  ['画像不透明度の変更', (s) => setImageOpacity(s, 1, 0.5)],
  ['画像回転の変更', (s) => setImageRotation(s, 1, 30)],
  ['画像 2 点アニメの変更', (s) => setImageMotion(s, 1, { preset: 'zoomOut' })],
  ['画像の登場アニメの変更', (s) => setImageEnter(s, 1, { kind: 'zoom', frames: 12 })],
  ['画像の削除', (s) => removeImage(s, 1)],
  // 図形
  ['図形の追加', (s) => addShape(s, 'ellipse', 0.2, 0.2, 0.6, 0.6, 10)],
  ['図形の平行移動', (s) => moveShape(s, 1, 0.05, 0.05)],
  ['図形の頂点変更', (s) => setShapePoints(s, 1, 0.2, 0.2, 0.7, 0.7)],
  ['図形の尺変更', (s) => retimeShape(s, 1, 3, 33)],
  ['図形色の変更', (s) => setShapeColor(s, 1, '#ff0000')],
  ['図形の太さの変更', (s) => setShapeThickness(s, 1, 'thick')],
  ['図形不透明度の変更', (s) => setShapeOpacity(s, 1, 0.4)],
  ['図形の削除', (s) => removeShape(s, 1)],
  // サブ動画
  ['サブ動画の追加', (s) => addVideoInsert(s, 'c.mp4', 500)],
  ['サブ動画の移動', (s) => moveVideoInsert(s, 1, 120)],
  ['サブ動画の尺変更', (s) => retimeVideoInsert(s, 1, 110, 190)],
  ['サブ動画のイン点変更', (s) => setVideoInsertInPoint(s, 1, 24)],
  ['サブ動画位置の変更', (s) => setVideoInsertPosition(s, 1, 0.3, 0.3)],
  ['サブ動画拡大率の変更', (s) => setVideoInsertScale(s, 1, 0.6)],
  ['サブ動画再生速度の変更', (s) => setVideoInsertPlaybackRate(s, 1, 2)],
  ['サブ動画の登場アニメの変更', (s) => setVideoInsertEnter(s, 1, { kind: 'slideIn', frames: 10 })],
  ['サブ動画の削除', (s) => removeVideoInsert(s, 1)],
  // タイトル
  ['タイトル文言の変更', (s) => setTitleText(s, 1, '新タイトル')],
  ['タイトルの移動', (s) => moveTitle(s, 1, 10)],
  ['タイトルの尺変更', (s) => setTitleTiming(s, 1, 5, 55)],
  ['タイトルの削除', (s) => removeTitle(s, 1)],
  // 速度・レイアウト
  ['メイン速度の変更', (s) => setMainSpeed(s, 1.5)],
  ['メイン動画位置の変更', (s) => setMainVideoPosition(s, 0.2, 0.1)],
  ['メイン動画拡大率の変更', (s) => setMainVideoScale(s, 1.3)],
  ['メイン動画回転の変更', (s) => setMainVideoRotation(s, 15)],
  ['メイン動画左右反転', (s) => setMainVideoFlipH(s, true)],
  // カラー補正（F-2）。EditState に載っているので undo/redo も往復同一でなければならない。
  ['カラー補正 明るさの変更', (s) => setColorGradeField(s, 'brightness', 25)],
  ['カラー補正 色温度の変更', (s) => setColorGradeField(s, 'temperature', -40)],
  ['カラー補正のリセット', (s) => resetColorGrade(setColorGradeField(s, 'saturation', 60))],
  ['区間速度の設定', (s) => setSegmentSpeed(s, 2, 2)],
  ['区間速度の解除', (s) => clearSegmentSpeed(s, 1)],
  ['区間レイアウト位置の変更', (s) => setSegmentPosition(s, 1, 0.3, 0.3)],
  ['区間レイアウト拡大率の変更', (s) => setSegmentScale(s, 1, 1.6)],
  ['区間レイアウトの解除', (s) => clearSegmentLayout(s, 1)],
  // キーフレーム
  ['キーフレームの追加', (s) => addKeyframeAt(s, { originalFrame: 120, x: 0.3, y: 0, scale: 1.4, rotation: 0 })],
  ['キーフレーム値の変更', (s) => setKeyframeField(s, 1, 'scale', 2)],
  ['キーフレームの削除', (s) => removeKeyframe(s, 1)],
  ['キーフレームの全解除', (s) => clearKeyframes(s)],
  // トランジション
  ['シーン転換の設定', (s) => setSceneTransition(s, 'tail', 'slide', { durationFrames: 20 })],
  ['シーン転換の尺変更', (s) => setSceneTransitionDuration(s, 'head', 30)],
  ['シーン転換色の変更', (s) => setSceneTransition(s, 'head', 'fadeColor', { color: '#00ff00' })],
  ['シーン転換方向の変更', (s) => setSceneTransitionDirection(setSceneTransition(s, 'head', 'slide'), 'head', 'right')],
  ['シーン転換の解除', (s) => clearSceneTransition(s, 'head')],
  // ダッキング
  ['ダッキング設定の変更', (s) => setDucking(s, { enabled: false, strength: 'strong' })],
];

describe('Undo/Redo の往復同一性', () => {
  for (const [label, op] of OPS) {
    it(`${label}: 操作 → undo → redo で状態が完全に戻る`, () => {
      const before = baseState();
      const beforeCopy = structuredClone(before) as EditState;
      let h = createHistory(before);

      const after = op(current(h));
      h = pushState(h, after);
      const afterCopy = structuredClone(current(h)) as EditState;

      // 存在検査: op が本当に永続内容を変えたか（何もしない op は往復検査を素通りする）。
      expect(samePersistedContent(beforeCopy, afterCopy)).toBe(false);

      // op は入力 state を破壊的に変更してはならない（入れ子は履歴と参照共有のため）。
      expect(before).toEqual(beforeCopy);

      h = undo(h);
      expect(current(h)).toEqual(beforeCopy);

      h = redo(h);
      expect(current(h)).toEqual(afterCopy);
    });
  }

  it('連続 10 操作 → 10 回 undo で初期状態へ完全復帰する', () => {
    const before = baseState();
    const beforeCopy = structuredClone(before) as EditState;
    let h = createHistory(before);
    const seq = OPS.slice(0, 10);
    for (const [, op] of seq) h = pushState(h, op(current(h)));
    for (let i = 0; i < seq.length; i++) h = undo(h);
    expect(current(h)).toEqual(beforeCopy);
  });
});
