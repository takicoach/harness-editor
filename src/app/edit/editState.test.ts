import { describe, expect, it } from 'vitest';
import { createEditState, toEditorProject, samePersistedContent } from './editState';
import type { EditorProject } from '../../core/types';
import { DEFAULT_DUCKING } from './duckingSettings';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';

function sampleProject(): EditorProject {
  return {
    videoConfig: {
      format: 'short',
      fps: 30,
      durationFrames: 900,
      videoFile: 'main.mp4',
      resolution: { width: 1080, height: 1920 },
      orientation: 'portrait',
      titleStyle: { top: 60, left: 30, fontSize: 30 },
    },
    projectConfig: null,
    transcript: { durationMs: 30000, words: [], segments: [] },
    telops: [
      { id: 1, originalStart: 30, originalEnd: 150, text: 'ゆる素振り', style: 'emphasis' },
      { id: 2, originalStart: 200, originalEnd: 320, text: '長いアイアン2本ですね' },
    ],
    cutRegions: [],
    se: [],
    images: [],
    bgm: [],
    telopDataSource: 'export const telopData = [];\n',
    cutDataSource: null,
    seDataSource: null,
    insertImageDataSource: null,
    titles: [],
    titleDataSource: null,
    mainSpeed: 1,
    segmentSpeeds: {},
  };
}

describe('createEditState', () => {
  it('EditorProject から編集状態を作る（telops / cutRegions を複製）', () => {
    const project = sampleProject();
    const state = createEditState(project);
    expect(state.telops).toEqual(project.telops);
    expect(state.cutRegions).toEqual(project.cutRegions);
    expect(state.selection).toBeNull();
    expect(state.nextTelopId).toBe(3);
  });

  it('telops を複製する（元配列を共有しない）', () => {
    const project = sampleProject();
    const state = createEditState(project);
    expect(state.telops).not.toBe(project.telops);
    expect(state.telops[0]).not.toBe(project.telops[0]);
  });

  it('telops が空なら nextTelopId は 1', () => {
    const project = sampleProject();
    project.telops = [];
    expect(createEditState(project).nextTelopId).toBe(1);
  });

  it('mainLayout 未設定のプロジェクトは既定（全画面）になる', () => {
    expect(createEditState(sampleProject()).mainLayout).toEqual(DEFAULT_MAIN_LAYOUT);
  });
  it('mainLayout を持つプロジェクトはその値を引き取る', () => {
    const layout = { position: { x: 0.5, y: 0 }, scale: 2, background: '#ffffff', rotation: 0, flipH: false, flipV: false };
    expect(createEditState({ ...sampleProject(), mainLayout: layout }).mainLayout).toEqual(layout);
  });
});

describe('createEditState — タイトル一本化（自動変換）', () => {
  it('既存タイトルを装飾テロップへ変換し titles を空にする', () => {
    const project = sampleProject();
    project.titles = [
      { id: 1, originalStart: 60, originalEnd: 210, text: 'ゆる素振り' },
      { id: 2, originalStart: 300, originalEnd: 450, text: 'タイトル2' },
    ];
    const state = createEditState(project);
    // titles は空（テロップへ一本化）。
    expect(state.titles).toEqual([]);
    expect(state.nextTitleId).toBe(1);
    // 元 2 テロップ + 変換 2 件 = 4 件。
    expect(state.telops).toHaveLength(4);
    const converted = state.telops.filter((t) => t.manual === true);
    expect(converted).toHaveLength(2);
    // 文字・区間が保たれ、上左配置・紫シャドウ(template 5)になっている。
    const first = converted[0]!;
    expect(first.text).toBe('ゆる素振り');
    expect(first.originalStart).toBe(60);
    expect(first.originalEnd).toBe(210);
    expect(first.position).toEqual({ x: -1, y: -1 });
    expect(first.template).toBe(5);
    // id は既存テロップ(最大2)の続きで衝突しない。
    const ids = state.telops.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(state.nextTelopId).toBe(Math.max(...ids) + 1);
  });

  it('タイトルが無ければ telops はそのまま', () => {
    const project = sampleProject();
    const state = createEditState(project);
    expect(state.telops).toHaveLength(2);
    expect(state.titles).toEqual([]);
  });
});

describe('samePersistedContent', () => {
  it('同一内容の EditState → true', () => {
    const project = sampleProject();
    const a = createEditState(project);
    const b = createEditState(project);
    expect(samePersistedContent(a, b)).toBe(true);
  });

  it('telop の text が違う → false', () => {
    const project = sampleProject();
    const a = createEditState(project);
    const b = createEditState(project);
    b.telops = b.telops.map((t) => (t.id === 1 ? { ...t, text: '変更後' } : t));
    expect(samePersistedContent(a, b)).toBe(false);
  });

  it('cutRegions が違う → false', () => {
    const project = sampleProject();
    const a = createEditState(project);
    const b = createEditState(project);
    b.cutRegions = [{ start: 400, end: 500 }];
    expect(samePersistedContent(a, b)).toBe(false);
  });

  it('selection だけが違う → true（選択は永続化されないので内容は同一）', () => {
    const project = sampleProject();
    const a = createEditState(project);
    const b = { ...createEditState(project), selection: { kind: 'telop' as const, id: 1 } };
    expect(samePersistedContent(a, b)).toBe(true);
  });

  it('nextTelopId だけが違う → true（nextTelopId は永続化されない）', () => {
    const project = sampleProject();
    const a = createEditState(project);
    const b = { ...createEditState(project), nextTelopId: 99 };
    expect(samePersistedContent(a, b)).toBe(true);
  });

  it('position の値が違う → false', () => {
    const project = sampleProject();
    const a = createEditState(project);
    const b = createEditState(project);
    b.telops = b.telops.map((t) =>
      t.id === 1 ? { ...t, position: { x: 0.5, y: 0 } } : t,
    );
    expect(samePersistedContent(a, b)).toBe(false);
  });

  it('position が片方だけ undefined → false', () => {
    const project = sampleProject();
    const a = createEditState(project);
    const b = createEditState(project);
    b.telops = b.telops.map((t) =>
      t.id === 1 ? { ...t, position: { x: 0, y: 0 } } : t,
    );
    expect(samePersistedContent(a, b)).toBe(false);
  });

  it('telops の長さが違う → false', () => {
    const project = sampleProject();
    const a = createEditState(project);
    const b = createEditState(project);
    b.telops = [b.telops[0]!];
    expect(samePersistedContent(a, b)).toBe(false);
  });

  it('cutRegions の長さが違う → false', () => {
    const project = sampleProject();
    const a = createEditState(project);
    a.cutRegions = [{ start: 100, end: 200 }];
    const b = createEditState(project);
    b.cutRegions = [{ start: 100, end: 200 }, { start: 300, end: 400 }];
    expect(samePersistedContent(a, b)).toBe(false);
  });

  it('animation が違う → false', () => {
    const project = sampleProject();
    const a = createEditState(project);
    const b = createEditState(project);
    b.telops = b.telops.map((t) =>
      t.id === 1 ? { ...t, animation: 'fadeOnly' as const } : t,
    );
    expect(samePersistedContent(a, b)).toBe(false);
  });
});

describe('toEditorProject', () => {
  it('不変 EditorProject の編集対象だけを EditState で差し替える', () => {
    const base = sampleProject();
    const state = createEditState(base);
    state.telops = [{ id: 1, originalStart: 30, originalEnd: 150, text: '変更後' }];
    state.cutRegions = [{ start: 400, end: 500 }];
    const result = toEditorProject(state, base);
    expect(result.telops).toEqual(state.telops);
    expect(result.cutRegions).toEqual(state.cutRegions);
    // 編集されない部分は base から保たれる
    expect(result.videoConfig).toBe(base.videoConfig);
    expect(result.transcript).toBe(base.transcript);
    expect(result.telopDataSource).toBe(base.telopDataSource);
    expect(result.cutDataSource).toBe(base.cutDataSource);
  });
});

describe('createEditState — SE', () => {
  it('se を取り込み nextSeId を採番する', () => {
    const p = sampleProject();
    p.se = [
      { id: 2, originalStart: 30, originalEnd: 120, file: 'a.mp3', volume: 0.3 },
      { id: 5, originalStart: 90, originalEnd: 180, file: 'b.mp3' },
    ];
    const s = createEditState(p);
    expect(s.se).toEqual(p.se);
    expect(s.se).not.toBe(p.se); // 1 段コピー
    expect(s.nextSeId).toBe(6);
  });

  it('se が空なら nextSeId は 1', () => {
    expect(createEditState(sampleProject()).nextSeId).toBe(1);
  });
});

describe('samePersistedContent — SE', () => {
  it('SE の永続化フィールドが違えば false', () => {
    const p = sampleProject();
    p.se = [{ id: 1, originalStart: 10, originalEnd: 100, file: 'a.mp3' }];
    const q = sampleProject();
    q.se = [{ id: 1, originalStart: 20, originalEnd: 110, file: 'a.mp3' }];
    const a = createEditState(p);
    const b = createEditState(q);
    expect(samePersistedContent(a, b)).toBe(false);
  });

  it('SE が同一なら true', () => {
    const p = sampleProject();
    p.se = [{ id: 1, originalStart: 10, originalEnd: 100, file: 'a.mp3', volume: 0.3 }];
    const q = sampleProject();
    q.se = [{ id: 1, originalStart: 10, originalEnd: 100, file: 'a.mp3', volume: 0.3 }];
    const a = createEditState(p);
    const b = createEditState(q);
    expect(samePersistedContent(a, b)).toBe(true);
  });
});

describe('toEditorProject — SE', () => {
  it('se と seDataSource を引き継ぐ', () => {
    const base = sampleProject();
    base.seDataSource = 'export const seData = [];';
    const s = createEditState(base);
    const withSe = { ...s, se: [{ id: 1, originalStart: 5, originalEnd: 95, file: 'a.mp3' }] };
    const ep = toEditorProject(withSe, base);
    expect(ep.se).toEqual(withSe.se);
    expect(ep.seDataSource).toBe('export const seData = [];');
  });
});

describe('createEditState — 画像', () => {
  it('images を取り込み nextImageId を採番する', () => {
    const p = sampleProject();
    p.images = [
      { id: 3, originalStart: 30, originalEnd: 150, file: 'a.png', type: 'photo' },
      { id: 8, originalStart: 200, originalEnd: 320, file: 'b.png', type: 'overlay', scale: 1.2 },
    ];
    const s = createEditState(p);
    expect(s.images).toEqual(p.images);
    expect(s.images).not.toBe(p.images);
    expect(s.nextImageId).toBe(9);
  });

  it('images が空なら nextImageId は 1', () => {
    expect(createEditState(sampleProject()).nextImageId).toBe(1);
  });
});

describe('samePersistedContent — 画像', () => {
  it('画像の永続化フィールドが違えば false', () => {
    const p = sampleProject();
    p.images = [{ id: 1, originalStart: 10, originalEnd: 50, file: 'a.png', type: 'photo' }];
    const q = sampleProject();
    q.images = [{ id: 1, originalStart: 20, originalEnd: 50, file: 'a.png', type: 'photo' }];
    const a = createEditState(p);
    const b = createEditState(q);
    expect(samePersistedContent(a, b)).toBe(false);
  });

  it('画像が同一なら true', () => {
    const p = sampleProject();
    p.images = [{ id: 1, originalStart: 10, originalEnd: 50, file: 'a.png', type: 'photo', scale: 1.5 }];
    const q = sampleProject();
    q.images = [{ id: 1, originalStart: 10, originalEnd: 50, file: 'a.png', type: 'photo', scale: 1.5 }];
    expect(samePersistedContent(createEditState(p), createEditState(q))).toBe(true);
  });
});

describe('toEditorProject — 画像', () => {
  it('images と insertImageDataSource を引き継ぐ', () => {
    const base = sampleProject();
    base.insertImageDataSource = 'export const insertImageData = [];';
    const s = createEditState(base);
    const withImages = {
      ...s,
      images: [{ id: 1, originalStart: 5, originalEnd: 60, file: 'a.png', type: 'photo' as const }],
    };
    const ep = toEditorProject(withImages, base);
    expect(ep.images).toEqual(withImages.images);
    expect(ep.insertImageDataSource).toBe('export const insertImageData = [];');
  });
});

describe('EditState: BGM', () => {
  it('createEditState が bgm を取り込み nextBgmId を最大+1 にする', () => {
    const p = sampleProject();
    p.bgm = [
      { id: 3, originalStart: 0, originalEnd: 90, file: 'bgm.mp3', volume: 0.8, fadeInFrames: 10, fadeOutFrames: 10 },
    ];
    const s = createEditState(p);
    expect(s.bgm).toHaveLength(1);
    expect(s.nextBgmId).toBe(4);
  });

  it('bgm 未指定なら空・nextBgmId は 1', () => {
    const s = createEditState(sampleProject());
    expect(s.bgm).toEqual([]);
    expect(s.nextBgmId).toBe(1);
  });

  it('samePersistedContent は bgm の差を検出する', () => {
    const p = sampleProject();
    p.bgm = [{ id: 1, originalStart: 0, originalEnd: 90, file: 'bgm.mp3', volume: 0.8, fadeInFrames: 5, fadeOutFrames: 5 }];
    const q = sampleProject();
    q.bgm = [{ id: 1, originalStart: 0, originalEnd: 90, file: 'bgm.mp3', volume: 0.5, fadeInFrames: 5, fadeOutFrames: 5 }];
    const a = createEditState(p);
    const b = createEditState(q);
    expect(samePersistedContent(a, a)).toBe(true);
    expect(samePersistedContent(a, b)).toBe(false);
  });

  it('toEditorProject が bgm と bgmDataSource を引き継ぐ', () => {
    const p = sampleProject();
    p.bgmDataSource = 'SRC_BGM';
    p.bgm = [{ id: 1, originalStart: 0, originalEnd: 90, file: 'bgm.mp3', volume: 0.8, fadeInFrames: 5, fadeOutFrames: 5 }];
    const s = createEditState(p);
    const out = toEditorProject(s, p);
    expect(out.bgm).toEqual(s.bgm);
    expect(out.bgmDataSource).toBe('SRC_BGM');
  });
});

describe('EditState: サブ動画インサート', () => {
  it('createEditState がサブ動画を取り込み nextVideoInsertId を最大+1 にする', () => {
    const p = sampleProject();
    p.videoInserts = [
      { id: 3, originalStart: 0, originalEnd: 10, file: 'a.mp4', sourceInFrame: 0 },
    ];
    const s = createEditState(p);
    expect(s.videoInserts).toHaveLength(1);
    expect(s.nextVideoInsertId).toBe(4);
  });

  it('videoInserts 未指定なら空・nextVideoInsertId は 1', () => {
    const s = createEditState(sampleProject());
    expect(s.videoInserts).toEqual([]);
    expect(s.nextVideoInsertId).toBe(1);
  });

  it('samePersistedContent はサブ動画の差を検出する', () => {
    const p = sampleProject();
    p.videoInserts = [{ id: 1, originalStart: 0, originalEnd: 10, file: 'a.mp4', sourceInFrame: 0 }];
    const q = sampleProject();
    q.videoInserts = [{ id: 1, originalStart: 0, originalEnd: 10, file: 'a.mp4', sourceInFrame: 5 }];
    const a = createEditState(p);
    const b = createEditState(q);
    expect(samePersistedContent(a, a)).toBe(true);
    expect(samePersistedContent(a, b)).toBe(false);
  });

  it('samePersistedContent は playbackRate の差を検出する', () => {
    const p = sampleProject();
    p.videoInserts = [{ id: 1, originalStart: 0, originalEnd: 10, file: 'a.mp4', sourceInFrame: 0 }];
    const q = sampleProject();
    q.videoInserts = [{ id: 1, originalStart: 0, originalEnd: 10, file: 'a.mp4', sourceInFrame: 0, playbackRate: 0.5 }];
    const a = createEditState(p);
    const b = createEditState(q);
    expect(samePersistedContent(a, a)).toBe(true);
    expect(samePersistedContent(a, b)).toBe(false);
  });

  it('toEditorProject がサブ動画と source を引き継ぐ', () => {
    const p = sampleProject();
    p.videoInsertDataSource = 'SRC';
    p.videoInserts = [{ id: 1, originalStart: 0, originalEnd: 10, file: 'a.mp4', sourceInFrame: 0 }];
    const s = createEditState(p);
    const out = toEditorProject(s, p);
    expect(out.videoInserts).toEqual(s.videoInserts);
    expect(out.videoInsertDataSource).toBe('SRC');
  });
});

describe('samePersistedContent — タイトル一本化後', () => {
  // タイトルは読み込み時に装飾テロップへ変換される。変換後も内容差は telop 比較で検知される。
  it('変換後のタイトル(テロップ)の文字差を検知する', () => {
    const p = sampleProject();
    p.titles = [{ id: 1, originalStart: 0, originalEnd: 100, text: 'A' }];
    const q = sampleProject();
    q.titles = [{ id: 1, originalStart: 0, originalEnd: 100, text: 'B' }];
    expect(samePersistedContent(createEditState(p), createEditState(q))).toBe(false);
  });

  it('変換後のタイトル(テロップ)が同一なら true', () => {
    const p = sampleProject();
    p.titles = [{ id: 1, originalStart: 0, originalEnd: 100, text: 'Title' }];
    const q = sampleProject();
    q.titles = [{ id: 1, originalStart: 0, originalEnd: 100, text: 'Title' }];
    expect(samePersistedContent(createEditState(p), createEditState(q))).toBe(true);
  });

  it('タイトルの有無で長さが変わると false', () => {
    const p = sampleProject();
    p.titles = [{ id: 1, originalStart: 0, originalEnd: 100, text: 'Title' }];
    const q = sampleProject();
    q.titles = [];
    expect(samePersistedContent(createEditState(p), createEditState(q))).toBe(false);
  });
});

describe('createEditState — ducking', () => {
  it('既定は enabled:true / strength:mid', () => {
    const state = createEditState(sampleProject());
    expect(state.ducking).toEqual(DEFAULT_DUCKING);
  });
  it('seed 値を反映する', () => {
    const state = createEditState(sampleProject(), { enabled: false, strength: 'weak' });
    expect(state.ducking).toEqual({ enabled: false, strength: 'weak' });
  });
});

describe('samePersistedContent — ducking', () => {
  it('ducking 差を検出する', () => {
    const a = createEditState(sampleProject());
    const b = { ...a, ducking: { enabled: false, strength: 'mid' as const } };
    expect(samePersistedContent(a, b)).toBe(false);
  });
});

describe('toEditorProject — ducking', () => {
  it('ducking を carry する', () => {
    const project = sampleProject();
    const state = { ...createEditState(project), ducking: { enabled: true as const, strength: 'strong' as const } };
    expect(toEditorProject(state, project).ducking).toEqual({ enabled: true, strength: 'strong' });
  });
});

describe('editState mainSpeed (Plan 1)', () => {
  it('toEditorProject は state.mainSpeed を反映する', () => {
    const base = sampleProject();
    const st = { ...createEditState(base), mainSpeed: 0.5 };
    expect(toEditorProject(st, base).mainSpeed).toBe(0.5);
  });
  it('samePersistedContent は mainSpeed の差を検知する', () => {
    const a = createEditState(sampleProject());
    expect(samePersistedContent(a, { ...a, mainSpeed: 0.5 })).toBe(false);
    expect(samePersistedContent(a, { ...a })).toBe(true);
  });
});

describe('EditState: 図形オーバーレイ（shapes）', () => {
  it('createEditState が shapes を取り込み nextShapeId を最大+1 にする', () => {
    const p = sampleProject();
    p.shapes = [
      { id: 3, originalStart: 0, originalEnd: 90, kind: 'arrow', x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5, color: '#ff0000', thickness: 'medium' },
      { id: 7, originalStart: 100, originalEnd: 200, kind: 'rect', x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.8, color: '#00ff00', thickness: 'thin' },
    ];
    const s = createEditState(p);
    expect(s.shapes).toHaveLength(2);
    expect(s.shapes).not.toBe(p.shapes);
    expect(s.nextShapeId).toBe(8);
  });

  it('shapes 未指定なら空・nextShapeId は 1', () => {
    const s = createEditState(sampleProject());
    expect(s.shapes).toEqual([]);
    expect(s.nextShapeId).toBe(1);
  });

  it('shapes が空配列なら nextShapeId は 1', () => {
    const p = sampleProject();
    p.shapes = [];
    const s = createEditState(p);
    expect(s.shapes).toEqual([]);
    expect(s.nextShapeId).toBe(1);
  });

  it('samePersistedContent は shapes の差を検出する', () => {
    const p = sampleProject();
    p.shapes = [{ id: 1, originalStart: 0, originalEnd: 90, kind: 'arrow', x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5, color: '#ff0000', thickness: 'medium' }];
    const q = sampleProject();
    q.shapes = [{ id: 1, originalStart: 0, originalEnd: 90, kind: 'arrow', x1: 0.2, y1: 0.1, x2: 0.5, y2: 0.5, color: '#ff0000', thickness: 'medium' }];
    const a = createEditState(p);
    const b = createEditState(q);
    expect(samePersistedContent(a, a)).toBe(true);
    expect(samePersistedContent(a, b)).toBe(false);
  });

  it('samePersistedContent は shapes が同一なら true', () => {
    const p = sampleProject();
    p.shapes = [{ id: 1, originalStart: 0, originalEnd: 90, kind: 'rect', x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9, color: '#0000ff', thickness: 'thick' }];
    const q = sampleProject();
    q.shapes = [{ id: 1, originalStart: 0, originalEnd: 90, kind: 'rect', x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9, color: '#0000ff', thickness: 'thick' }];
    expect(samePersistedContent(createEditState(p), createEditState(q))).toBe(true);
  });

  it('samePersistedContent は shapes の長さが違えば false', () => {
    const p = sampleProject();
    p.shapes = [{ id: 1, originalStart: 0, originalEnd: 90, kind: 'arrow', x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5, color: '#ff0000', thickness: 'medium' }];
    const q = sampleProject();
    q.shapes = [];
    expect(samePersistedContent(createEditState(p), createEditState(q))).toBe(false);
  });

  it('toEditorProject が shapes と shapeDataSource を引き継ぐ', () => {
    const base = sampleProject();
    base.shapeDataSource = 'export const shapeData = [];';
    base.shapes = [{ id: 1, originalStart: 0, originalEnd: 90, kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1, color: '#ffffff', thickness: 'thin' }];
    const s = createEditState(base);
    const out = toEditorProject(s, base);
    expect(out.shapes).toEqual(s.shapes);
    expect(out.shapeDataSource).toBe('export const shapeData = [];');
  });

  it('Selection union に shape が追加されている', () => {
    const project = sampleProject();
    project.shapes = [{ id: 5, originalStart: 0, originalEnd: 60, kind: 'ellipse', x1: 0.3, y1: 0.3, x2: 0.7, y2: 0.7, color: '#123456', thickness: 'medium' }];
    const s = createEditState(project);
    const sel: import('./editState').Selection = { kind: 'shape', id: 5 };
    s.selection = sel;
    expect(s.selection).toEqual({ kind: 'shape', id: 5 });
  });
});

describe('samePersistedContent — mainLayout', () => {
  it('mainLayout の scale 変更は永続内容の差分として検知される', () => {
    const base = createEditState(sampleProject());
    const changed = { ...base, mainLayout: { ...DEFAULT_MAIN_LAYOUT, scale: 1.5 } };
    expect(samePersistedContent(base, changed)).toBe(false);
  });
  it('mainLayout の background 変更も検知される', () => {
    const base = createEditState(sampleProject());
    const changed = { ...base, mainLayout: { ...DEFAULT_MAIN_LAYOUT, background: '#ffffff' } };
    expect(samePersistedContent(base, changed)).toBe(false);
  });
  it('mainLayout の position.x のみの変更も検知される（横移動の取りこぼし防止）', () => {
    const base = createEditState(sampleProject());
    const changed = { ...base, mainLayout: { ...DEFAULT_MAIN_LAYOUT, position: { x: 0.5, y: 0 } } };
    expect(samePersistedContent(base, changed)).toBe(false);
  });
  it('mainLayout の position.y のみの変更も検知される', () => {
    const base = createEditState(sampleProject());
    const changed = { ...base, mainLayout: { ...DEFAULT_MAIN_LAYOUT, position: { x: 0, y: 0.5 } } };
    expect(samePersistedContent(base, changed)).toBe(false);
  });
  it('別オブジェクトの同値 mainLayout は差分なし（値等価）', () => {
    const base = createEditState(sampleProject());
    const same = { ...base, mainLayout: { position: { x: 0, y: 0 }, scale: 1, background: '#000000', rotation: 0, flipH: false, flipV: false } };
    expect(samePersistedContent(base, same)).toBe(true);
  });
  it('同一 mainLayout は差分なし', () => {
    const base = createEditState(sampleProject());
    expect(samePersistedContent(base, { ...base })).toBe(true);
  });
});

describe('segmentLayouts 伝播', () => {
  it('samePersistedContent は segmentLayouts の違いを検出する', () => {
    const a = createEditState(sampleProject());
    const b = { ...a, segmentLayouts: { 3: { position: { x: 0.5, y: 0 }, scale: 2, rotation: 0, flipH: false, flipV: false } } };
    expect(samePersistedContent(a, b)).toBe(false);
    expect(samePersistedContent(a, { ...a })).toBe(true);
  });
  it('samePersistedContent は mainLayout の rotation/flip 差を検出する', () => {
    const a = createEditState(sampleProject());
    const b = { ...a, mainLayout: { ...(a.mainLayout ?? DEFAULT_MAIN_LAYOUT), rotation: 45 } };
    expect(samePersistedContent(a, b)).toBe(false);
    const flipH = { ...a, mainLayout: { ...(a.mainLayout ?? DEFAULT_MAIN_LAYOUT), flipH: true } };
    expect(samePersistedContent(a, flipH)).toBe(false);
    const flipV = { ...a, mainLayout: { ...(a.mainLayout ?? DEFAULT_MAIN_LAYOUT), flipV: true } };
    expect(samePersistedContent(a, flipV)).toBe(false);
  });
  it('samePersistedContent は同一キー・同値の segmentLayouts を差分なしと判定する', () => {
    const a = createEditState(sampleProject());
    const layout = { position: { x: 0.5, y: 0 }, scale: 2, rotation: 0, flipH: false, flipV: false };
    const withSeg = { ...a, segmentLayouts: { 3: { ...layout } } };
    const sameSeg = { ...a, segmentLayouts: { 3: { ...layout } } };
    expect(samePersistedContent(withSeg, sameSeg)).toBe(true);
  });
  it('samePersistedContent は同一キーの segmentLayouts の scale 差分を検出する', () => {
    const a = createEditState(sampleProject());
    const base = { position: { x: 0.5, y: 0 }, scale: 2, rotation: 0, flipH: false, flipV: false };
    const withSeg = { ...a, segmentLayouts: { 3: { ...base } } };
    const scaledSeg = { ...a, segmentLayouts: { 3: { ...base, scale: 3 } } };
    expect(samePersistedContent(withSeg, scaledSeg)).toBe(false);
  });
  it('samePersistedContent は同一キーの segmentLayouts の flipV 差分を検出する', () => {
    const a = createEditState(sampleProject());
    const base = { position: { x: 0.5, y: 0 }, scale: 2, rotation: 0, flipH: false, flipV: false };
    const withSeg = { ...a, segmentLayouts: { 3: { ...base } } };
    const flippedSeg = { ...a, segmentLayouts: { 3: { ...base, flipV: true } } };
    expect(samePersistedContent(withSeg, flippedSeg)).toBe(false);
  });
  it('toEditorProject は segmentLayouts を引き継ぐ', () => {
    const a = createEditState(sampleProject());
    const withSeg = { ...a, segmentLayouts: { 3: { position: { x: 0, y: 0 }, scale: 1.5, rotation: 0, flipH: false, flipV: false } } };
    expect(toEditorProject(withSeg, sampleProject()).segmentLayouts).toEqual(withSeg.segmentLayouts);
  });
});
