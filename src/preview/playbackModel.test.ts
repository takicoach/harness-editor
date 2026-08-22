import { describe, it, expect } from 'vitest';
import { buildPlaybackModel, applyMainSpeed, applySpeed, activeTelopAt, activeTelopsAt, activeTitlesAt } from './playbackModel';
import type { PlaybackModel } from './playbackModel';
import { computeJoins } from '../core/joinEngine';
import type { TitleSegment, SceneTransition, CutSegment } from '../core/types';
import type { EditorProject } from '../core/types';

function makeProject(overrides?: Partial<Pick<EditorProject, 'se' | 'cutRegions' | 'images' | 'videoInserts' | 'bgm' | 'shapes' | 'mainSpeed'>>): EditorProject {
  return {
    videoConfig: {
      format: 'short',
      fps: 60,
      durationFrames: 12000,
      videoFile: 'main.mp4',
      resolution: { width: 1080, height: 1920 },
      orientation: 'portrait',
      titleStyle: { top: 60, left: 30, fontSize: 30 },
    },
    projectConfig: null,
    transcript: { durationMs: 200000, words: [], segments: [] },
    telops: [
      { id: 1, originalStart: 30, originalEnd: 150, text: 'A' },
      { id: 2, originalStart: 200, originalEnd: 320, text: 'B' },
    ],
    cutRegions: overrides?.cutRegions ?? [],
    se: overrides?.se ?? [],
    images: overrides?.images ?? [],
    videoInserts: overrides?.videoInserts,
    bgm: overrides?.bgm,
    shapes: overrides?.shapes,
    telopDataSource: '',
    cutDataSource: null,
    seDataSource: null,
    insertImageDataSource: null,
    titles: [],
    titleDataSource: null,
    mainSpeed: overrides?.mainSpeed ?? 1,
    segmentSpeeds: {},
  };
}

describe('buildPlaybackModel', () => {
  it('カット無しなら原本尺がそのまま再生尺になる', () => {
    const model = buildPlaybackModel(makeProject());
    expect(model.fps).toBe(60);
    expect(model.width).toBe(1080);
    expect(model.height).toBe(1920);
    expect(model.durationInFrames).toBe(12000);
    expect(model.keptSegments.length).toBeGreaterThan(0);
    expect(model.telops).toHaveLength(2);
  });

  it('中間カットで再生尺が短くなり keptSegments が 2 になる', () => {
    // CutRegion { start: 1000, end: 3000 } は 2000 フレームを除去する（end は排他的）。
    // 12000 - 2000 = 10000 フレームが再生尺になる。
    // 先頭 [0,1000) と末尾 [3000,12000) の 2 セグメントが残る。
    const p = makeProject();
    p.cutRegions = [{ start: 1000, end: 3000 }];
    const model = buildPlaybackModel(p);
    expect(model.durationInFrames).toBe(10000);
    expect(model.keptSegments).toHaveLength(2);
    expect(model.fps).toBe(60);
    expect(model.width).toBe(1080);
    expect(model.height).toBe(1920);
  });
});

describe('activeTelopAt', () => {
  const telops = [
    { id: 1, startFrame: 30, endFrame: 150, text: 'A' },
    { id: 2, startFrame: 200, endFrame: 320, text: 'B' },
  ];
  it('範囲内のテロップを返す', () => {
    expect(activeTelopAt(telops, 100)?.id).toBe(1);
  });
  it('endFrame は排他的', () => {
    expect(activeTelopAt(telops, 150)).toBeNull();
  });
  it('どのテロップにも入らないフレームは null', () => {
    expect(activeTelopAt(telops, 170)).toBeNull();
  });
  it('startFrame は含む（inclusive）', () => {
    expect(activeTelopAt(telops, 30)?.id).toBe(1);
  });
  it('startFrame の 1 フレーム前は null', () => {
    expect(activeTelopAt(telops, 29)).toBeNull();
  });
});

describe('activeTelopsAt', () => {
  // 字幕(短)と、それに重なる長尺の装飾テロップ(旧タイトル)。
  const subtitle = { id: 1, startFrame: 90, endFrame: 120, text: '字幕' };
  const decoration = { id: 2, startFrame: 60, endFrame: 300, text: 'タイトル', manual: true };
  const telops = [subtitle, decoration];

  it('重なる全テロップを入力順で返す（字幕＋装飾を同時表示）', () => {
    expect(activeTelopsAt(telops, 100).map((t) => t.id)).toEqual([1, 2]);
  });
  it('字幕が消えても装飾は残る（長尺の装飾が一瞬で消えない）', () => {
    expect(activeTelopsAt(telops, 200).map((t) => t.id)).toEqual([2]);
  });
  it('どのテロップにも入らないフレームは空配列', () => {
    expect(activeTelopsAt(telops, 400)).toEqual([]);
  });
  it('endFrame は排他的', () => {
    expect(activeTelopsAt(telops, 300)).toEqual([]);
  });
});

describe('buildPlaybackModel — SE', () => {
  it('SE を再生フレームへ射影してモデルへ載せる', () => {
    const project = makeProject({
      se: [
        { id: 1, originalStart: 90, originalEnd: 180, file: 'ポン.mp3', volume: 0.3 },
        { id: 2, originalStart: 150, originalEnd: 240, file: 'パッ.mp3' },
      ],
    });
    const model = buildPlaybackModel(project);
    expect(model.se).toEqual([
      { id: 1, playbackFrame: 90, playbackEnd: 180, file: 'ポン.mp3', volume: 0.3, fadeInFrames: undefined, fadeOutFrames: undefined },
      // volume 未定義は 1 へフォールバック。
      { id: 2, playbackFrame: 150, playbackEnd: 240, file: 'パッ.mp3', volume: 1, fadeInFrames: undefined, fadeOutFrames: undefined },
    ]);
  });

  it('カット区間を越えた SE は再生フレームへ詰めて射影する', () => {
    // カット { start: 1000, end: 3000 } が 2000 フレーム除去する。
    const project = makeProject({
      cutRegions: [{ start: 1000, end: 3000 }],
      se: [
        // 原本 5000 はカット後 → 5000 - 2000 = 3000, 5090 - 2000 = 3090。
        { id: 1, originalStart: 5000, originalEnd: 5090, file: 'a.mp3', volume: 0.5 },
        // 原本 2000..2090 は完全にカット区間内 → clampSe で start>=end → 縮退除外される。
        { id: 2, originalStart: 2000, originalEnd: 2090, file: 'b.mp3' },
      ],
    });
    const model = buildPlaybackModel(project);
    // id:2 はカットに完全に飲まれるため clamp→filter で除外され、id:1 のみ残る。
    expect(model.se).toEqual([
      { id: 1, playbackFrame: 3000, playbackEnd: 3090, file: 'a.mp3', volume: 0.5, fadeInFrames: undefined, fadeOutFrames: undefined },
    ]);
  });

  it('SePlayback は区間終端 playbackEnd とフェード属性を持つ', () => {
    const project = makeProject({
      se: [{ id: 1, originalStart: 30, originalEnd: 120, file: 'a.mp3', volume: 0.3, fadeInFrames: 5, fadeOutFrames: 10 }],
    });
    const model = buildPlaybackModel(project);
    expect(model.se[0]).toMatchObject({ id: 1, playbackFrame: 30, playbackEnd: 120, fadeInFrames: 5, fadeOutFrames: 10 });
  });

  it('カット区間に完全に飲まれた SE はフィルタで除外する', () => {
    // SE [1200, 1500) はカット [1000, 3000) に飲まれる → clampSe で start>=end → projectSe 後 endFrame<=startFrame → 縮退除外。
    const project = makeProject({
      cutRegions: [{ start: 1000, end: 3000 }],
      se: [{ id: 1, originalStart: 1200, originalEnd: 1500, file: 'c.mp3' }],
    });
    const model = buildPlaybackModel(project);
    expect(model.se).toEqual([]);
  });
});

describe('buildPlaybackModel — 画像', () => {
  it('画像を再生フレーム区間へ射影してモデルへ載せる', () => {
    const project = makeProject({
      images: [
        { id: 1, originalStart: 100, originalEnd: 300, file: 'a.png', type: 'photo' },
        { id: 2, originalStart: 400, originalEnd: 600, file: 'b.png', type: 'overlay', scale: 1.5 },
      ],
    });
    const model = buildPlaybackModel(project);
    expect(model.images).toEqual([
      { id: 1, playbackStart: 100, playbackEnd: 300, file: 'a.png', type: 'photo', scale: 1 },
      { id: 2, playbackStart: 400, playbackEnd: 600, file: 'b.png', type: 'overlay', scale: 1.5 },
    ]);
  });

  it('カット区間を越えた画像は再生フレームへ詰めて射影する', () => {
    const project = makeProject({
      cutRegions: [{ start: 1000, end: 3000 }],
      images: [
        { id: 1, originalStart: 5000, originalEnd: 5200, file: 'a.png', type: 'photo' },
      ],
    });
    const model = buildPlaybackModel(project);
    expect(model.images).toEqual([
      { id: 1, playbackStart: 3000, playbackEnd: 3200, file: 'a.png', type: 'photo', scale: 1 },
    ]);
  });

  it('カット区間に端が入った画像は serializeProject と一致するよう clamp→project する（Codex P2 回帰）', () => {
    // 画像 [1500, 3500) と カット [1000, 3000)。開始端 1500 はカット内。
    // 期待: clampImages で開始端をカット終端 3000 へ寄せ、projectImages で
    //       原本 3000..3500 → 再生 1000..1500 へ射影する。
    // 旧バグ: clamp なしで projectImages へ渡すと、起点フォールバックが効いて
    //         playbackStart=0 になり、保存側（clamp 済み）と乖離していた。
    const project = makeProject({
      cutRegions: [{ start: 1000, end: 3000 }],
      images: [
        { id: 1, originalStart: 1500, originalEnd: 3500, file: 'a.png', type: 'photo' },
      ],
    });
    const model = buildPlaybackModel(project);
    expect(model.images).toEqual([
      { id: 1, playbackStart: 1000, playbackEnd: 1500, file: 'a.png', type: 'photo', scale: 1 },
    ]);
  });

  it('画像の enter/exit が ImagePlayback に保持される（プレビュー経路ガード）', () => {
    // tsc が optional フィールドの欠落を検出できないため、この単体テストで
    // buildPlaybackModel → ImagePlayback の全ホップを deterministic に固定する。
    const enter = { kind: 'zoom' as const, frames: 12 };
    const exit = { kind: 'fade' as const, frames: 8 };
    const project = makeProject({
      images: [
        { id: 1, originalStart: 100, originalEnd: 400, file: 'a.png', type: 'photo', enter, exit },
      ],
    });
    const model = buildPlaybackModel(project);
    expect(model.images[0]?.enter).toEqual(enter);
    expect(model.images[0]?.exit).toEqual(exit);
  });

  it('enter/exit 未指定の画像は ImagePlayback で undefined のまま', () => {
    const project = makeProject({
      images: [{ id: 1, originalStart: 100, originalEnd: 300, file: 'a.png', type: 'photo' }],
    });
    const model = buildPlaybackModel(project);
    expect(model.images[0]?.enter).toBeUndefined();
    expect(model.images[0]?.exit).toBeUndefined();
  });
});

describe('buildPlaybackModel — サブ動画', () => {
  it('サブ動画を clamp→project で再生フレームへ射影する', () => {
    const project = makeProject({
      videoInserts: [{ id: 1, originalStart: 100, originalEnd: 200, file: 'sub/c.mp4', sourceInFrame: 7 }],
    });
    const m = buildPlaybackModel(project);
    expect(m.videoInserts).toEqual([
      { id: 1, playbackStart: 100, playbackEnd: 200, file: 'sub/c.mp4', sourceInFrame: 7, position: undefined, scale: 1 },
    ]);
  });

  it('カット区間を越えたサブ動画は再生フレームへ詰めて射影する', () => {
    // カット { start: 1000, end: 3000 } が 2000 フレーム除去する。
    // 原本 5000..5200 → 再生 3000..3200。
    const project = makeProject({
      cutRegions: [{ start: 1000, end: 3000 }],
      videoInserts: [
        { id: 1, originalStart: 5000, originalEnd: 5200, file: 'sub/c.mp4', sourceInFrame: 0 },
      ],
    });
    const m = buildPlaybackModel(project);
    expect(m.videoInserts).toEqual([
      { id: 1, playbackStart: 3000, playbackEnd: 3200, file: 'sub/c.mp4', sourceInFrame: 0, position: undefined, scale: 1 },
    ]);
  });

  it('videoInserts が未定義（空プロジェクト）のときは空配列を返す', () => {
    const project = makeProject();
    const m = buildPlaybackModel(project);
    expect(m.videoInserts).toEqual([]);
  });

  it('サブ動画の enter/exit が VideoInsertPlayback に保持される（プレビュー経路ガード）', () => {
    // buildPlaybackModel → VideoInsertPlayback の全ホップを deterministic に固定する。
    const enter = { kind: 'slideIn' as const, frames: 10, direction: 'left' as const };
    const exit = { kind: 'none' as const, frames: 8 };
    const project = makeProject({
      videoInserts: [
        { id: 1, originalStart: 100, originalEnd: 300, file: 'sub/c.mp4', sourceInFrame: 0, enter, exit },
      ],
    });
    const m = buildPlaybackModel(project);
    expect(m.videoInserts[0]?.enter).toEqual(enter);
    expect(m.videoInserts[0]?.exit).toEqual(exit);
  });

  it('enter/exit 未指定のサブ動画は VideoInsertPlayback で undefined のまま', () => {
    const project = makeProject({
      videoInserts: [{ id: 1, originalStart: 100, originalEnd: 200, file: 'sub/c.mp4', sourceInFrame: 0 }],
    });
    const m = buildPlaybackModel(project);
    expect(m.videoInserts[0]?.enter).toBeUndefined();
    expect(m.videoInserts[0]?.exit).toBeUndefined();
  });
});

describe('buildPlaybackModel — BGM', () => {
  it('BGM を clamp→project で再生フレームへ射影する', () => {
    const project = makeProject({
      bgm: [
        { id: 1, originalStart: 100, originalEnd: 600, file: 'bgm1.mp3', volume: 0.8, fadeInFrames: 30, fadeOutFrames: 30 },
      ],
    });
    const m = buildPlaybackModel(project);
    expect(m.bgm).toEqual([
      { id: 1, startFrame: 100, endFrame: 600, file: 'bgm1.mp3', volume: 0.8, fadeInFrames: 30, fadeOutFrames: 30 },
    ]);
  });

  it('カット区間を越えた BGM は再生フレームへ詰めて射影する', () => {
    // カット { start: 1000, end: 3000 } が 2000 フレーム除去する。
    // 原本 5000..5600 → 再生 3000..3600。
    const project = makeProject({
      cutRegions: [{ start: 1000, end: 3000 }],
      bgm: [
        { id: 1, originalStart: 5000, originalEnd: 5600, file: 'bgm1.mp3', volume: 0.5, fadeInFrames: 0, fadeOutFrames: 0 },
      ],
    });
    const m = buildPlaybackModel(project);
    expect(m.bgm).toEqual([
      { id: 1, startFrame: 3000, endFrame: 3600, file: 'bgm1.mp3', volume: 0.5, fadeInFrames: 0, fadeOutFrames: 0 },
    ]);
  });

  it('カット区間に完全に飲まれた BGM クリップ（縮退区間）は除外する', () => {
    // BGM [1200, 2800) は カット [1000, 3000) に完全に飲まれる。
    // clampBgm で start >= end になるため、projectBgm 後も endFrame <= startFrame。
    // filter で除外されるため bgm は空配列になる。
    const project = makeProject({
      cutRegions: [{ start: 1000, end: 3000 }],
      bgm: [
        { id: 1, originalStart: 1200, originalEnd: 2800, file: 'bgm1.mp3', volume: 1, fadeInFrames: 0, fadeOutFrames: 0 },
      ],
    });
    const m = buildPlaybackModel(project);
    expect(m.bgm).toEqual([]);
  });

  it('bgm が未定義（空プロジェクト）のときは空配列を返す', () => {
    const project = makeProject();
    const m = buildPlaybackModel(project);
    expect(m.bgm).toEqual([]);
  });
});

describe('buildPlaybackModel — ducking', () => {
  // fps=60 のため 0..1000ms = 0..60 フレーム。bgm [0,100) は喋り区間 [0,60) と交差する。
  const bgm = [{ id: 1, originalStart: 0, originalEnd: 100, file: 'a.mp3', volume: 0.5, fadeInFrames: 0, fadeOutFrames: 0 }];
  const transcript = { durationMs: 200000, words: [{ text: 'x', start: 0, end: 1000 }], segments: [] };

  it('ducking ON で model.bgm[].ducking が付く', () => {
    const project = { ...makeProject({ bgm }), transcript, ducking: { enabled: true as const, strength: 'mid' as const } };
    const model = buildPlaybackModel(project);
    expect(model.bgm[0]?.ducking).toBeDefined();
    expect(model.bgm[0]?.ducking?.gain).toBe(0.5);
  });
  it('ducking 未設定では付かない', () => {
    const project = { ...makeProject({ bgm }), transcript };
    const model = buildPlaybackModel(project);
    expect(model.bgm[0]?.ducking).toBeUndefined();
  });
});

describe('buildPlaybackModel — 図形オーバーレイ', () => {
  it('図形を clamp→project で再生フレームへ射影する', () => {
    const project = makeProject({
      shapes: [
        { id: 1, originalStart: 100, originalEnd: 300, kind: 'rect', x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6, color: '#ff0000', thickness: 'medium' },
        { id: 2, originalStart: 400, originalEnd: 600, kind: 'arrow', x1: 0.0, y1: 0.0, x2: 1.0, y2: 1.0, color: '#00ff00', thickness: 'thin' },
      ],
    });
    const m = buildPlaybackModel(project);
    expect(m.shapes).toEqual([
      { id: 1, startFrame: 100, endFrame: 300, kind: 'rect', x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6, color: '#ff0000', thickness: 'medium', opacity: undefined },
      { id: 2, startFrame: 400, endFrame: 600, kind: 'arrow', x1: 0.0, y1: 0.0, x2: 1.0, y2: 1.0, color: '#00ff00', thickness: 'thin', opacity: undefined },
    ]);
  });

  it('カット区間を越えた図形は再生フレームへ詰めて射影する', () => {
    // カット { start: 1000, end: 3000 } が 2000 フレーム除去。
    // 原本 5000..5200 → 再生 3000..3200。
    const project = makeProject({
      cutRegions: [{ start: 1000, end: 3000 }],
      shapes: [
        { id: 1, originalStart: 5000, originalEnd: 5200, kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1, color: '#fff', thickness: 'thick' },
      ],
    });
    const m = buildPlaybackModel(project);
    expect(m.shapes).toEqual([
      { id: 1, startFrame: 3000, endFrame: 3200, kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1, color: '#fff', thickness: 'thick', opacity: undefined },
    ]);
  });

  it('shapes が未定義のときは空配列を返す', () => {
    const project = makeProject();
    const m = buildPlaybackModel(project);
    expect(m.shapes).toEqual([]);
  });

  it('opacity フィールドが保持される', () => {
    const project = makeProject({
      shapes: [
        { id: 1, originalStart: 0, originalEnd: 100, kind: 'ellipse', x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9, color: '#blue', thickness: 'medium', opacity: 0.7 },
      ],
    });
    const m = buildPlaybackModel(project);
    expect(m.shapes[0]?.opacity).toBe(0.7);
  });
});

describe('activeTitlesAt', () => {
  const titles: TitleSegment[] = [
    { id: 1, startFrame: 0, endFrame: 100, text: 'a' },
    { id: 2, startFrame: 50, endFrame: 200, text: 'b' },
  ];
  it('再生フレームで可視の全件を返す', () => {
    expect(activeTitlesAt(titles, 60).map((t) => t.id)).toEqual([1, 2]);
  });
  it('endFrame は排他・該当なしは空', () => {
    expect(activeTitlesAt(titles, 100).map((t) => t.id)).toEqual([2]);
    expect(activeTitlesAt(titles, 300)).toEqual([]);
  });
});

describe('buildPlaybackModel — sceneTransitions/joins carry ガード（Plan 2 T7 再発防止）', () => {
  // playbackModel → PlaybackModel の全ホップで sceneTransitions/joins が欠落しないことを
  // deterministic に固定する。tsc は optional フィールドの渡し漏れを検出できないため単体テストで守る。

  it('sceneTransitions を持つ project を渡すと PlaybackModel に保持される', () => {
    const transitions: SceneTransition[] = [
      { id: 1, at: 'head', kind: 'fadeBlack', durationFrames: 30 },
      { id: 2, at: 'tail', kind: 'fadeWhite', durationFrames: 20 },
    ];
    const project = makeProject();
    // EditorProject.sceneTransitions は optional なのでスプレッドで付与する。
    const withTransitions = { ...project, sceneTransitions: transitions };
    const model = buildPlaybackModel(withTransitions);
    expect(model.sceneTransitions).toEqual(transitions);
  });

  it('sceneTransitions が未定義のプロジェクトでは空配列を返す', () => {
    const model = buildPlaybackModel(makeProject());
    expect(model.sceneTransitions).toEqual([]);
  });

  it('joins が computeJoins と一致する（カット無し＝空）', () => {
    const model = buildPlaybackModel(makeProject());
    expect(model.joins).toEqual(computeJoins(12000, []));
    expect(model.joins).toEqual([]);
  });

  it('joins が computeJoins と一致する（1 カット＝1 つなぎ目）', () => {
    const project = makeProject();
    // カット { start: 1000, end: 3000 } → つなぎ目は atOriginal=1000, playbackFrame=1000。
    const withCut = { ...project, cutRegions: [{ start: 1000, end: 3000 }] };
    const model = buildPlaybackModel(withCut);
    const expected = computeJoins(12000, [{ start: 1000, end: 3000 }]);
    expect(model.joins).toEqual(expected);
    expect(model.joins).toHaveLength(1);
    expect(model.joins[0]).toEqual({ atOriginal: 1000, playbackFrame: 1000 });
  });

  it('joins が computeJoins と一致する（2 カット＝2 つなぎ目）', () => {
    const project = makeProject();
    const cutRegions = [{ start: 1000, end: 2000 }, { start: 5000, end: 6000 }];
    const withCuts = { ...project, cutRegions };
    const model = buildPlaybackModel(withCuts);
    const expected = computeJoins(12000, cutRegions);
    expect(model.joins).toEqual(expected);
    expect(model.joins).toHaveLength(2);
  });
});

describe('buildPlaybackModel × overlaps（Task 4）', () => {
  it('重なる系トランジションなし＝overlaps 空・durationInFrames は playbackDurationInFrames と一致', () => {
    const m = buildPlaybackModel(makeProject());
    expect(m.overlaps).toEqual([]);
    expect(m.durationInFrames).toBe(m.playbackDurationInFrames);
  });
});

describe('buildPlaybackModel — サブ動画 速度変更（Task 3）', () => {
  it('videoInserts の playbackRate が再生モデルへ載る', () => {
    const project = makeProject({
      videoInserts: [{ id: 1, originalStart: 0, originalEnd: 120, file: 'sub/a.mp4', sourceInFrame: 0, playbackRate: 0.5 }],
    });
    const model = buildPlaybackModel(project);
    expect(model.videoInserts[0]?.playbackRate).toBe(0.5);
  });
});

describe('main speed in playback model (Plan 1 修正: フレームスケール方式)', () => {
  it('applyMainSpeed(model, 1) は同一参照を返す（無回帰）', () => {
    const m1 = buildPlaybackModel(makeProject({ mainSpeed: 1 }));
    expect(applyMainSpeed(m1, 1)).toBe(m1);
  });

  it('mainSpeed=0.5 で durationInFrames と要素位置が 2 倍にスケールする', () => {
    const project = makeProject({
      mainSpeed: 0.5,
      se: [{ id: 1, originalStart: 90, originalEnd: 180, file: 'a.mp3', volume: 0.3 }],
      images: [{ id: 1, originalStart: 100, originalEnd: 300, file: 'a.png', type: 'photo' }],
      videoInserts: [{ id: 1, originalStart: 200, originalEnd: 320, file: 'sub/c.mp4', sourceInFrame: 0, playbackRate: 0.5 }],
      bgm: [{ id: 1, originalStart: 100, originalEnd: 600, file: 'b.mp3', volume: 0.8, fadeInFrames: 0, fadeOutFrames: 0 }],
      shapes: [{ id: 1, originalStart: 100, originalEnd: 300, kind: 'rect', x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6, color: '#f00', thickness: 'medium' }],
    });
    const m05 = buildPlaybackModel(project);
    const m1 = buildPlaybackModel({ ...project, mainSpeed: 1 });

    expect(m05.mainSpeed).toBe(0.5);
    // 速度後の総尺は速度前の 2 倍。
    expect(m05.durationInFrames).toBe(m1.durationInFrames * 2);
    // playbackDurationInFrames は速度前のまま不変（橋渡し基準）。
    expect(m05.playbackDurationInFrames).toBe(m1.playbackDurationInFrames);

    // テロップ start/end が 2 倍（telops[0] は originalStart 30→playback 30→sped 60）。
    expect(m05.telops[0]?.startFrame).toBe((m1.telops[0]?.startFrame ?? 0) * 2);
    expect(m05.telops[0]?.endFrame).toBe((m1.telops[0]?.endFrame ?? 0) * 2);

    // keptSegments: playbackStart/End は 2 倍、originalStart/End は不変（ソースフレーム）。
    expect(m05.keptSegments[0]?.playbackStart).toBe((m1.keptSegments[0]?.playbackStart ?? 0) * 2);
    expect(m05.keptSegments[0]?.playbackEnd).toBe((m1.keptSegments[0]?.playbackEnd ?? 0) * 2);
    expect(m05.keptSegments[0]?.originalStart).toBe(m1.keptSegments[0]?.originalStart);
    expect(m05.keptSegments[0]?.originalEnd).toBe(m1.keptSegments[0]?.originalEnd);

    // 各要素のフレームが 2 倍。
    expect(m05.se[0]?.playbackFrame).toBe((m1.se[0]?.playbackFrame ?? 0) * 2);
    expect(m05.se[0]?.playbackEnd).toBe((m1.se[0]?.playbackEnd ?? 0) * 2);
    expect(m05.images[0]?.playbackStart).toBe((m1.images[0]?.playbackStart ?? 0) * 2);
    expect(m05.images[0]?.playbackEnd).toBe((m1.images[0]?.playbackEnd ?? 0) * 2);
    expect(m05.videoInserts[0]?.playbackStart).toBe((m1.videoInserts[0]?.playbackStart ?? 0) * 2);
    expect(m05.videoInserts[0]?.playbackEnd).toBe((m1.videoInserts[0]?.playbackEnd ?? 0) * 2);
    expect(m05.bgm[0]?.startFrame).toBe((m1.bgm[0]?.startFrame ?? 0) * 2);
    expect(m05.bgm[0]?.endFrame).toBe((m1.bgm[0]?.endFrame ?? 0) * 2);
    expect(m05.shapes[0]?.startFrame).toBe((m1.shapes[0]?.startFrame ?? 0) * 2);
    expect(m05.shapes[0]?.endFrame).toBe((m1.shapes[0]?.endFrame ?? 0) * 2);

    // サブ動画の playbackRate は own(0.5) × mainSpeed(0.5) = 0.25。
    expect(m05.videoInserts[0]?.playbackRate).toBe(0.25);
  });

  it('mainSpeed=0.5 で overlaps はスケール・playbackOverlaps は速度前のまま', () => {
    // カット {1000,3000} で join(atOriginal=1000, playbackFrame=1000)。
    // crossfade(at=1000, durationFrames=60) で overlap=60, boundary=1000。
    const transitions: SceneTransition[] = [
      { id: 1, at: 1000, kind: 'crossfade', durationFrames: 60 },
    ];
    const project = { ...makeProject({ cutRegions: [{ start: 1000, end: 3000 }] }), sceneTransitions: transitions };
    const m1 = buildPlaybackModel({ ...project, mainSpeed: 1 });
    const m05 = buildPlaybackModel({ ...project, mainSpeed: 0.5 });

    // 速度前の確認: overlap が 1 件できている。
    expect(m1.overlaps).toEqual([{ boundary: 1000, overlap: 60 }]);

    // 速度後 overlaps は 2 倍。
    expect(m05.overlaps).toEqual([{ boundary: 2000, overlap: 120 }]);
    // playbackOverlaps は速度前のまま（橋渡し用）。
    expect(m05.playbackOverlaps).toEqual([{ boundary: 1000, overlap: 60 }]);

    // joins.playbackFrame は 2 倍、atOriginal は不変。
    expect(m05.joins[0]?.playbackFrame).toBe((m1.joins[0]?.playbackFrame ?? 0) * 2);
    expect(m05.joins[0]?.atOriginal).toBe(1000);

    // sceneTransitions.durationFrames は 2 倍、at（キー）は不変。
    expect(m05.sceneTransitions[0]?.durationFrames).toBe(120);
    expect(m05.sceneTransitions[0]?.at).toBe(1000);
  });

  // 3 ホップ配線（videoConfig → PlaybackModel → Preview → PreviewOverlay）の 1 段目。
  // ここが落ちるとプレビューの枠アンカーが黙って標準値へ戻る（silent OFF）。
  it('videoConfig.telopBottomOffset を carry する（未指定は null）', () => {
    const base = makeProject();
    const gold = {
      ...base,
      videoConfig: { ...base.videoConfig, telopBottomOffset: 540 },
    };
    expect(buildPlaybackModel(gold).telopBottomOffset).toBe(540);
    expect(buildPlaybackModel(base).telopBottomOffset).toBeNull();
  });

  it('mainSpeed=1 では playbackOverlaps と overlaps が一致する', () => {
    const m1 = buildPlaybackModel(makeProject({ mainSpeed: 1, cutRegions: [] }));
    expect(m1.playbackOverlaps).toEqual(m1.overlaps);
  });
});

// ── applySpeed テスト用ヘルパ ───────────────────────────────────────────
const TITLE_STYLE = { top: 60, left: 30, fontSize: 30 };

function makeMinimalModel(overrides?: Partial<PlaybackModel>): PlaybackModel {
  return {
    fps: 60,
    width: 1080,
    height: 1920,
    durationInFrames: 200,
    playbackDurationInFrames: 200,
    overlaps: [],
    playbackOverlaps: [],
    keptSegments: [
      { id: 1, originalStart: 0, originalEnd: 200, playbackStart: 0, playbackEnd: 200 },
    ],
    telops: [],
    titles: [],
    titleStyle: TITLE_STYLE,
    telopBottomOffset: null,
    se: [],
    images: [],
    videoInserts: [],
    bgm: [],
    shapes: [],
    sceneTransitions: [],
    joins: [],
    mainSpeed: 1,
    speedSegments: null,
    ...overrides,
  };
}

function makeBaseModel(): PlaybackModel {
  return makeMinimalModel();
}

function makeBaseModelWithSegments(keptSegments: CutSegment[]): PlaybackModel {
  const dur = keptSegments.at(-1)?.playbackEnd ?? 200;
  return makeMinimalModel({ keptSegments, durationInFrames: dur, playbackDurationInFrames: dur });
}

describe('applySpeed', () => {
  it('個別指定ゼロは applyMainSpeed と完全一致（後方互換・同一参照経路）', () => {
    const base = makeBaseModel();
    expect(applySpeed(base, 0.5, {})).toEqual(applyMainSpeed(base, 0.5));
    expect(applySpeed(base, 1, {})).toBe(base); // rate=1 は applyMainSpeed が同一参照を返す
  });

  it('個別指定ありは区間ごとに尺をスケール', () => {
    const base = makeBaseModelWithSegments([
      { id: 1, originalStart: 0, originalEnd: 100, playbackStart: 0, playbackEnd: 100 },
      { id: 2, originalStart: 100, originalEnd: 200, playbackStart: 100, playbackEnd: 200 },
    ]);
    const out = applySpeed(base, 1, { 2: 0.5 }); // 区間2を 0.5x
    expect(out.durationInFrames).toBe(100 + 200); // 区間2が 2 倍尺
    expect(out.speedSegments).not.toBeNull();
    // speedSegments は PRE-scale 再生座標（keptSegments の playbackStart/End をそのまま使う）。
    // この assertion が失敗する場合、速度後フレームで構築している可能性あり（Task 6 契約違反）。
    expect(out.speedSegments).toEqual([
      { id: 1, start: 0, end: 100, rate: 1 },
      { id: 2, start: 100, end: 200, rate: 0.5 },
    ]);
    // keptSegments の playback 位置が速度後へ写っている
    expect(out.keptSegments[1]?.playbackStart).toBe(100);
    expect(out.keptSegments[1]?.playbackEnd).toBe(300);
  });

  it('buildPlaybackModel で segmentSpeeds={}（空）は mainSpeed のみの経路と同値', () => {
    const p1 = makeProject({ mainSpeed: 0.5 });
    const p2 = { ...makeProject({ mainSpeed: 0.5 }), segmentSpeeds: {} };
    expect(buildPlaybackModel(p1)).toEqual(buildPlaybackModel(p2));
  });
});
