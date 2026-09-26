import { describe, expect, it } from 'vitest';
import { samePersistedContent, toEditorProject, type EditState } from './editState';
import { createHistory, current, pushState, undo } from './history';
import { moveTelop, removeTelops, setAllTelopTemplates } from './telopSettingsOps';
import { setTelopText } from './textOps';
import { toggleSegmentCut } from '../edit/cutOps';
import { buildDisplayMap } from '../../core/timelineDisplayMap';
import { cutOrderingOf } from '../../core/cutOrder';
import { originalToPlayback, playbackTotalFrames } from '../../core/cutEngine';
import type { EditorProject } from '../../core/types';

/**
 * 巨大プロジェクトでの操作（G-5）。
 *
 * 数千件のテロップ／カット区間があっても、編集 1 回・dirty 判定 1 回・
 * タイムラインの写像構築 1 回が「人間が待てる時間」で終わることを固定する。
 * ここが 2 乗オーダーだと、実案件（長尺講義の全文字幕）で操作のたびに固まる。
 *
 * 閾値は「明らかな計算量事故だけを捕まえる」ためのもので、実機の速さの保証ではない
 * （CI の負荷で数倍ぶれても落ちない余裕を持たせてある）。
 */

const N = 5000;
/** 1 操作あたりの上限（ms）。2 乗オーダーなら N=5000 で軽く超える。 */
const BUDGET_MS = 2000;

function hugeState(): EditState {
  const telops = Array.from({ length: N }, (_, i) => ({
    id: i + 1,
    originalStart: i * 20,
    originalEnd: i * 20 + 15,
    text: `テロップ ${i}`,
    position: { x: 0, y: 0 },
    scale: 1,
    template: 1,
  }));
  return {
    telops,
    // 100 件おきに 1 区間カットする（実案件の「言い直しカット」相当の密度）。
    cutRegions: Array.from({ length: N / 10 }, (_, i) => ({ start: i * 200 + 16, end: i * 200 + 19 })),
    se: [],
    images: [],
    videoInserts: [],
    bgm: [],
    selection: null,
    multiTelopIds: [],
    nextTelopId: N + 1,
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
    ducking: { enabled: true, strength: 'mid' },
    mainSpeed: 1,
    segmentSpeeds: {},
    segmentLayouts: {},
    layoutKeyframes: [],
    originalTotalFrames: N * 20,
  };
}

/** fn の所要時間（ms）を測って返す。 */
function timed<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const out = fn();
  return [out, performance.now() - t0];
}

describe(`巨大プロジェクト（テロップ ${N} 件）でも操作が現実的な時間で終わる`, () => {
  it('本文編集・移動・一括テンプレ変更が 1 操作ずつ完了する', () => {
    const s = hugeState();
    const [a, t1] = timed(() => setTelopText(s, N / 2, '書き換え'));
    expect(a.telops[N / 2 - 1]!.text).toBe('書き換え');
    const [b, t2] = timed(() => moveTelop(a, 1, 5));
    expect(b.telops[0]!.originalStart).toBe(5);
    const [c, t3] = timed(() => setAllTelopTemplates(b, 3));
    expect(c.telops.every((t) => t.template === 3)).toBe(true);
    for (const t of [t1, t2, t3]) expect(t).toBeLessThan(BUDGET_MS);
  });

  it('dirty 判定（samePersistedContent）が全件比較でも収まる', () => {
    const s = hugeState();
    const edited = setTelopText(s, 1, 'x');
    const [same, t1] = timed(() => samePersistedContent(s, s));
    const [diff, t2] = timed(() => samePersistedContent(s, edited));
    expect(same).toBe(true);
    expect(diff).toBe(false);
    for (const t of [t1, t2]) expect(t).toBeLessThan(BUDGET_MS);
  });

  it('タイムラインの表示写像・再生順写像が構築できる', () => {
    const s = hugeState();
    const [ordering, t1] = timed(() => cutOrderingOf(s));
    const [map, t2] = timed(() => buildDisplayMap(s.originalTotalFrames!, s.cutRegions, ordering.segments, s.segmentSpeeds, s.mainSpeed));
    // 存在検査: 写像が空でない（空なら「速い」は無意味）。
    expect(playbackTotalFrames(s.originalTotalFrames!, s.cutRegions)).toBeGreaterThan(0);
    expect(originalToPlayback(N * 10, s.cutRegions, ordering)).toBeGreaterThan(0);
    expect(map).toBeTruthy();
    for (const t of [t1, t2]) expect(t).toBeLessThan(BUDGET_MS);
  });

  it('区間カットの連続トグルと Undo が積み上がっても壊れない', () => {
    const s = hugeState();
    let h = createHistory(s);
    // 履歴上限（HISTORY_LIMIT=100）の内側で回す。上限を超えた分は設計どおり切り捨てられ、
    // 初期状態へは戻れない（history.test.ts で別途固定済み）。
    const rounds = 50;
    const [, t] = timed(() => {
      for (let i = 1; i <= rounds; i++) h = pushState(h, toggleSegmentCut(current(h), i));
      // 存在検査: トグルが実際にカット区間を増やしている（0 件なら往復検査は無意味）。
      expect(current(h).cutRegions.length).toBeGreaterThan(s.cutRegions.length);
      for (let i = 0; i < rounds; i++) h = undo(h);
    });
    expect(current(h).cutRegions).toEqual(s.cutRegions);
    expect(t).toBeLessThan(BUDGET_MS * 3);
  });

  it('一括削除と保存用プロジェクトの合成が完了する', () => {
    const s = hugeState();
    // 字幕（manual でないテロップ）は removeTelops の対象外＝件数は変わらない契約。
    const [kept, t1] = timed(() => removeTelops(s, s.telops.map((t) => t.id)));
    expect(kept.telops).toHaveLength(N);
    const base = { videoConfig: { fps: 30, durationFrames: N * 20, resolution: { width: 1920, height: 1080 } } } as unknown as EditorProject;
    const [proj, t2] = timed(() => toEditorProject(s, base));
    expect(proj.telops).toHaveLength(N);
    for (const t of [t1, t2]) expect(t).toBeLessThan(BUDGET_MS);
  });
});
