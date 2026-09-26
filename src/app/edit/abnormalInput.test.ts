import { describe, expect, it } from 'vitest';
import type { EditState } from './editState';
import { toEditorProject } from './editState';
import { moveTelop, setTelopPosition, setTelopScale, setTelopTemplate, setTelopTiming, setTelopsScale, setAllTelopPositions } from './telopSettingsOps';
import { setTelopText } from './textOps';
import { splitTelopAt } from './cutOps';
import { addSe, fitSeToSource, moveSe, normalizeSeVolume, resizeSe, setSeFadeIn, setSeFadeOut, setSeVolume } from './seOps';
import { addBgm, moveBgm, resizeBgm, setBgmFadeIn, setBgmFadeOut, setBgmVolume } from './bgmOps';
import { addImage, moveImage, retimeImage, setImageOpacity, setImagePosition, setImageRotation, setImageScale } from './imageOps';
import { addShape, moveShape, retimeShape, setShapeOpacity, setShapePoints } from './shapeOps';
import { addVideoInsert, moveVideoInsert, retimeVideoInsert, setVideoInsertInPoint, setVideoInsertPlaybackRate, setVideoInsertPosition, setVideoInsertScale } from './videoInsertOps';
import { moveTitle, setTitleText, setTitleTiming } from './titleOps';
import { setMainSpeed, setMainVideoPosition, setMainVideoRotation, setMainVideoScale } from './mainVideoOps';
import { setSegmentSpeed } from './segmentSpeedOps';
import { setSegmentPosition, setSegmentRotation, setSegmentScale } from './segmentLayoutOps';
import { addKeyframeAt, setKeyframeField } from './layoutKeyframeOps';
import { setSceneTransition, setSceneTransitionDuration } from './transitionOps';

/**
 * 異常入力に対する耐性（G-5）。
 *
 * 数値入力欄・ドラッグ・外部データから NaN / ±Infinity / 巨大値 / 負値が
 * op へ届きうる。ここで守るべき性質は 2 つ:
 *
 * - **落ちない**（例外を投げない）
 * - **黙って壊れない**: 非有限値が state に残ると、そのまま telopData.ts 等へ
 *   `scale: NaN` として書かれ、プロジェクトが壊れる（silent corruption）。
 *   拒否（値を据え置き）でもクランプでも良いが、**非有限値が state に残ってはならない**。
 */

const ABNORMAL = [NaN, Infinity, -Infinity, -1e9, 1e12] as const;

function baseState(): EditState {
  return {
    telops: [
      { id: 1, originalStart: 0, originalEnd: 30, text: 'あいうえお', position: { x: 0, y: 0 }, scale: 1, template: 1 },
      { id: 2, originalStart: 40, originalEnd: 70, text: 'かきくけこ', position: { x: 0, y: 0 }, scale: 1, template: 1 },
    ],
    cutRegions: [],
    se: [{ id: 1, originalStart: 10, originalEnd: 40, file: 'a.mp3', volume: 0.8, fadeInFrames: 2, fadeOutFrames: 2 }],
    images: [{ id: 1, originalStart: 5, originalEnd: 50, file: 'a.png', type: 'photo', scale: 1, position: { x: 0, y: 0 }, opacity: 1, rotation: 0 }],
    videoInserts: [{ id: 1, originalStart: 100, originalEnd: 200, file: 'b.mp4', sourceInFrame: 0, position: { x: 0, y: 0 }, scale: 1, playbackRate: 1 }],
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
    shapes: [{ id: 1, originalStart: 0, originalEnd: 30, kind: 'rect', x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5, color: '#fff', thickness: 'medium', opacity: 1 }],
    nextShapeId: 2,
    sceneTransitions: [{ id: 1, at: 'head', kind: 'fadeBlack', durationFrames: 15 }],
    nextTransitionId: 2,
    ducking: { enabled: true, strength: 'mid' },
    mainSpeed: 1,
    segmentSpeeds: {},
    mainLayout: { position: { x: 0, y: 0 }, scale: 1, background: '#000', rotation: 0, flipH: false, flipV: false },
    segmentLayouts: {},
    layoutKeyframes: [{ originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 }],
  };
}

/** state のうちディスクへ書かれる数値を全て集める（非有限混入の検出用）。 */
function persistedNumbers(s: EditState): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const push = (path: string, v: unknown): void => {
    if (typeof v === 'number') out.push([path, v]);
  };
  const walk = (path: string, v: unknown): void => {
    if (typeof v === 'number') { push(path, v); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(`${path}[${i}]`, x)); return; }
    if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(`${path}.${k}`, x);
    }
  };
  for (const key of ['telops', 'cutRegions', 'se', 'images', 'videoInserts', 'bgm', 'titles', 'shapes', 'sceneTransitions', 'segmentSpeeds', 'mainLayout', 'segmentLayouts', 'layoutKeyframes'] as const) {
    walk(key, s[key]);
  }
  push('mainSpeed', s.mainSpeed);
  return out;
}

/** 非有限な永続化数値の一覧（空であるべき）。 */
function nonFinitePersisted(s: EditState): string[] {
  return persistedNumbers(s).filter(([, v]) => !Number.isFinite(v)).map(([p, v]) => `${p}=${v}`);
}

/** [操作名, 異常値 1 つを受けて state を返す関数]。 */
const OPS: Array<[string, (s: EditState, v: number) => EditState]> = [
  ['setTelopScale', (s, v) => setTelopScale(s, 1, v)],
  ['setTelopPosition.x', (s, v) => setTelopPosition(s, 1, v, 0)],
  ['setTelopPosition.y', (s, v) => setTelopPosition(s, 1, 0, v)],
  ['setTelopTiming.start', (s, v) => setTelopTiming(s, 1, v, 30)],
  ['setTelopTiming.end', (s, v) => setTelopTiming(s, 1, 0, v)],
  ['moveTelop', (s, v) => moveTelop(s, 1, v)],
  ['setTelopTemplate', (s, v) => setTelopTemplate(s, 1, v)],
  ['setTelopsScale', (s, v) => setTelopsScale(s, [1, 2], v)],
  ['setAllTelopPositions', (s, v) => setAllTelopPositions(s, { x: v, y: v }, v)],
  ['splitTelopAt', (s, v) => splitTelopAt(s, 1, v, 'あ', 'い')],
  ['addSe', (s, v) => addSe(s, 'x.mp3', v)],
  ['moveSe', (s, v) => moveSe(s, 1, v)],
  ['resizeSe.start', (s, v) => resizeSe(s, 1, v, 40)],
  ['resizeSe.end', (s, v) => resizeSe(s, 1, 10, v)],
  ['setSeVolume', (s, v) => setSeVolume(s, 1, v)],
  ['setSeFadeIn', (s, v) => setSeFadeIn(s, 1, v)],
  ['setSeFadeOut', (s, v) => setSeFadeOut(s, 1, v)],
  ['fitSeToSource', (s, v) => fitSeToSource(s, 1, v)],
  ['normalizeSeVolume', (s, v) => normalizeSeVolume(s, 1, v)],
  ['addBgm', (s, v) => addBgm(s, 'x.mp3', v)],
  ['moveBgm', (s, v) => moveBgm(s, 1, v)],
  ['resizeBgm.start', (s, v) => resizeBgm(s, 1, v, 300)],
  ['resizeBgm.end', (s, v) => resizeBgm(s, 1, 0, v)],
  ['setBgmVolume', (s, v) => setBgmVolume(s, 1, v)],
  ['setBgmFadeIn', (s, v) => setBgmFadeIn(s, 1, v)],
  ['setBgmFadeOut', (s, v) => setBgmFadeOut(s, 1, v)],
  ['addImage', (s, v) => addImage(s, 'x.png', v)],
  ['moveImage', (s, v) => moveImage(s, 1, v)],
  ['retimeImage.start', (s, v) => retimeImage(s, 1, v, 50)],
  ['retimeImage.end', (s, v) => retimeImage(s, 1, 5, v)],
  ['setImageScale', (s, v) => setImageScale(s, 1, v)],
  ['setImagePosition', (s, v) => setImagePosition(s, 1, v, v)],
  ['setImageOpacity', (s, v) => setImageOpacity(s, 1, v)],
  ['setImageRotation', (s, v) => setImageRotation(s, 1, v)],
  ['addShape', (s, v) => addShape(s, 'rect', v, v, v, v, v)],
  ['moveShape', (s, v) => moveShape(s, 1, v, v)],
  ['setShapePoints', (s, v) => setShapePoints(s, 1, v, v, v, v)],
  ['retimeShape.start', (s, v) => retimeShape(s, 1, v, 30)],
  ['retimeShape.end', (s, v) => retimeShape(s, 1, 0, v)],
  ['setShapeOpacity', (s, v) => setShapeOpacity(s, 1, v)],
  ['addVideoInsert', (s, v) => addVideoInsert(s, 'x.mp4', v)],
  ['moveVideoInsert', (s, v) => moveVideoInsert(s, 1, v)],
  ['retimeVideoInsert.start', (s, v) => retimeVideoInsert(s, 1, v, 200)],
  ['retimeVideoInsert.end', (s, v) => retimeVideoInsert(s, 1, 100, v)],
  ['setVideoInsertInPoint', (s, v) => setVideoInsertInPoint(s, 1, v)],
  ['setVideoInsertPosition', (s, v) => setVideoInsertPosition(s, 1, v, v)],
  ['setVideoInsertScale', (s, v) => setVideoInsertScale(s, 1, v)],
  ['setVideoInsertPlaybackRate', (s, v) => setVideoInsertPlaybackRate(s, 1, v)],
  ['moveTitle', (s, v) => moveTitle(s, 1, v)],
  ['setTitleTiming.start', (s, v) => setTitleTiming(s, 1, v, 60)],
  ['setTitleTiming.end', (s, v) => setTitleTiming(s, 1, 0, v)],
  ['setMainSpeed', (s, v) => setMainSpeed(s, v)],
  ['setMainVideoPosition', (s, v) => setMainVideoPosition(s, v, v)],
  ['setMainVideoScale', (s, v) => setMainVideoScale(s, v)],
  ['setMainVideoRotation', (s, v) => setMainVideoRotation(s, v)],
  ['setSegmentSpeed', (s, v) => setSegmentSpeed(s, 1, v)],
  ['setSegmentPosition', (s, v) => setSegmentPosition(s, 1, v, v)],
  ['setSegmentScale', (s, v) => setSegmentScale(s, 1, v)],
  ['setSegmentRotation', (s, v) => setSegmentRotation(s, 1, v)],
  ['addKeyframeAt', (s, v) => addKeyframeAt(s, { originalFrame: v, x: v, y: v, scale: v, rotation: v })],
  ['setKeyframeField.scale', (s, v) => setKeyframeField(s, 0, 'scale', v)],
  ['setKeyframeField.originalFrame', (s, v) => setKeyframeField(s, 0, 'originalFrame', v)],
  ['setSceneTransition.duration', (s, v) => setSceneTransition(s, 'head', 'fadeBlack', { durationFrames: v })],
  ['setSceneTransitionDuration', (s, v) => setSceneTransitionDuration(s, 'head', v)],
];

describe('異常な数値入力でも落ちず、非有限値を永続状態へ残さない', () => {
  for (const [label, op] of OPS) {
    for (const v of ABNORMAL) {
      it(`${label}(${String(v)})`, () => {
        const s = baseState();
        let next: EditState;
        expect(() => { next = op(s, v); }).not.toThrow();
        expect(nonFinitePersisted(next!)).toEqual([]);
      });
    }
  }
});

describe('異常な文字列入力でも落ちない', () => {
  const TEXTS = ['', ' '.repeat(1000), 'あ'.repeat(20000), ' ￿', '`${evil}`', '</script>'];
  for (const t of TEXTS) {
    it(`テロップ本文 (${t.length} 文字)`, () => {
      const s = baseState();
      expect(() => setTelopText(s, 1, t)).not.toThrow();
      expect(setTelopText(s, 1, t).telops[0]!.text).toBe(t);
    });
    it(`タイトル本文 (${t.length} 文字)`, () => {
      const s = baseState();
      expect(() => setTitleText(s, 1, t)).not.toThrow();
    });
  }
});

describe('0 長・逆転区間を与えても保存用プロジェクトを合成できる', () => {
  it('start === end / start > end のクリップがあっても toEditorProject が落ちない', () => {
    const s = baseState();
    const broken: EditState = {
      ...s,
      telops: [{ id: 1, originalStart: 30, originalEnd: 30, text: 'ゼロ長' }],
      se: [{ id: 1, originalStart: 50, originalEnd: 10, file: 'a.mp3' }],
      images: [{ id: 1, originalStart: 0, originalEnd: 0, file: 'a.png', type: 'photo' }],
    };
    const base = {
      videoConfig: { fps: 30, durationFrames: 300, resolution: { width: 1920, height: 1080 } },
      projectConfig: null,
      transcript: { segments: [] },
      telops: [], cutRegions: [], se: [], images: [], videoInserts: [], bgm: [],
      telopDataSource: '', cutDataSource: null, seDataSource: null, insertImageDataSource: null,
      titles: [], titleDataSource: null,
      mainSpeed: 1, segmentSpeeds: {}, segmentLayouts: {}, layoutKeyframes: [],
      sceneTransitions: [], shapes: [], ducking: { enabled: true, strength: 'mid' as const },
    };
    expect(() => toEditorProject(broken, base as never)).not.toThrow();
  });
});
