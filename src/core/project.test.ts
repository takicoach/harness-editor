import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadProject, serializeProject, type ProjectFiles } from './project';
import { serializeCutData } from './cutData';
import { parseTitleData } from './titleData';
import { parseTelopData } from './telopData';
import { VIDEO_CONFIG_SOURCE } from './__fixtures__/videoConfig.fixture';
import { TELOP_DATA_SOURCE } from './__fixtures__/telopData.fixture';
import { CUT_DATA_SOURCE } from './__fixtures__/cutData.fixture';
import { buildPlaybackModel } from '../preview/playbackModel';
import { applyCuts } from './cutEngine';
import { serializeMainLayoutData } from './mainLayoutData';
import { DEFAULT_MAIN_LAYOUT } from './mainLayout';

const TRANSCRIPT = readFileSync(
  new URL('./__fixtures__/transcript.fixture.json', import.meta.url),
  'utf8',
);

const FILES = {
  videoConfigSource: VIDEO_CONFIG_SOURCE,
  telopDataSource: TELOP_DATA_SOURCE,
  cutDataSource: CUT_DATA_SOURCE,
  transcriptJson: TRANSCRIPT,
  projectConfigJson: null,
  seDataSource: null,
  insertImageDataSource: null,
  titleDataSource: null,
};

/** 指定フィールドだけを差し替えた ProjectFiles を返すヘルパ。 */
function files(overrides: Partial<ProjectFiles>): ProjectFiles {
  return { ...FILES, ...overrides };
}

const SE_DATA = `import type { SoundEffect } from './SEPlayer';
export const seData: SoundEffect[] = [
  { id: 1, startFrame: 90, file: 'ポン.mp3', volume: 0.3 },
];
`;

describe('loadProject', () => {
  it('全ファイルを EditorProject へ束ねる', () => {
    const project = loadProject(FILES);
    expect(project.videoConfig.fps).toBe(60);
    expect(project.telops).toHaveLength(2);
    expect(project.cutRegions).toEqual([{ start: 3000, end: 3600 }]);
  });

  it('mainAudioDataを完成座標設定として読込み、serialize後も往復する', () => {
    const project = loadProject(files({
      mainAudioDataSource: 'export const MAIN_AUDIO = { gainDb: 6, muted: false, fadeInFrames: 30, fadeOutFrames: 45 };',
    }));
    expect(project.mainAudio).toEqual({ gainDb: 6, muted: false, fadeInFrames: 30, fadeOutFrames: 45 });
    const sources = serializeProject(project);
    expect(sources.mainAudioDataSource).toContain('gainDb: 6');
    expect(loadProject(files({ mainAudioDataSource: sources.mainAudioDataSource })).mainAudio).toEqual(project.mainAudio);
  });

  it('テロップは原本フレームでアンカーされる', () => {
    const project = loadProject(FILES);
    // telopData の id:2 は再生 startFrame:200（カット前）→ 原本も 200
    expect(project.telops[1]!.originalStart).toBe(200);
  });

  it('cutData.ts 不在でも読める（カット無し）', () => {
    const project = loadProject({ ...FILES, cutDataSource: null });
    expect(project.cutRegions).toEqual([]);
  });

  it('全カット（cutData: []）はリロード後も保持される', () => {
    // cutData: [] を持つ cutData.ts を生成（全カット状態）
    const allCutSource = serializeCutData(CUT_DATA_SOURCE, [], 12000, 0);
    const project = loadProject({ ...FILES, cutDataSource: allCutSource });
    // cutDataSource が存在し cutData が空 → 全カット = [{start:0, end:12000}]
    expect(project.cutRegions).toEqual([{ start: 0, end: 12000 }]);
  });

  it('カット後のテロップが原本フレームへ正しくアンカーされる', () => {
    // カット区間: 原本 3000–3600（600フレーム削除）
    // 再生 4000 → 原本 4000 + 600 = 4600
    const customTelopSource = `import type { TelopSegment } from './telopTypes';
import { FPS as CONFIG_FPS, DURATION_FRAMES } from '../videoConfig';

export const FPS = CONFIG_FPS;
export const TOTAL_FRAMES = DURATION_FRAMES;

export const telopData: TelopSegment[] = [
  {
    id: 1,
    startFrame: 4000,
    endFrame: 4100,
    text: "カット後テロップ",
    style: "normal",
    template: 1,
    animation: "fadeOnly",
    highlight: "",
  },
];
`;
    const project = loadProject({
      videoConfigSource: VIDEO_CONFIG_SOURCE,
      cutDataSource: CUT_DATA_SOURCE,
      transcriptJson: TRANSCRIPT,
      projectConfigJson: null,
      telopDataSource: customTelopSource,
      seDataSource: null,
      insertImageDataSource: null,
      titleDataSource: null,
    });
    expect(project.telops[0]!.originalStart).toBe(4600);
    expect(project.telops[0]!.originalEnd).toBe(4700);
  });
});

describe('serializeProject', () => {
  it('編集後の telopData / cutData ソースを返す', () => {
    const project = loadProject(FILES);
    const out = serializeProject(project);
    expect(out.telopDataSource).toContain('export const telopData');
    expect(out.cutDataSource).toContain('export const cutData');
  });

  it('読み込み→書き出し→再読み込みで telop が一致する', () => {
    const project = loadProject(FILES);
    const out = serializeProject(project);
    const reloaded = loadProject({
      ...FILES,
      telopDataSource: out.telopDataSource,
      cutDataSource: out.cutDataSource,
    });
    expect(reloaded.telops).toEqual(project.telops);
  });

  it('flagged テロップ（カット区間に完全に飲まれた）の出力に originalStart/originalEnd を含める', () => {
    // 原本フレーム 350–450 のテロップをカット区間 300–500 に丸ごと飲まれた状態で作る
    const project = loadProject({
      ...FILES,
      cutDataSource: null, // カット無し → cutRegions=[]
    });
    // cutRegions を手動で上書きし、テロップを flagged にする
    const telopId = 99;
    const projectWithFlagged: typeof project = {
      ...project,
      cutRegions: [{ start: 300, end: 500 }],
      telops: [
        { id: telopId, originalStart: 350, originalEnd: 450, text: 'flagged telop' },
      ],
    };
    const out = serializeProject(projectWithFlagged);
    // flagged テロップには originalStart/originalEnd が書き出される
    expect(out.telopDataSource).toContain('originalStart: 350,');
    expect(out.telopDataSource).toContain('originalEnd: 450,');
  });

  it('一意に逆変換できる非 flagged テロップには originalStart/originalEnd を含めない', () => {
    const project = loadProject({
      ...FILES,
      cutDataSource: null,
    });
    const projectWithNormalTelop: typeof project = {
      ...project,
      cutRegions: [{ start: 300, end: 500 }],
      telops: [
        { id: 1, originalStart: 100, originalEnd: 200, text: 'normal telop' },
      ],
    };
    const out = serializeProject(projectWithNormalTelop);
    expect(out.telopDataSource).not.toContain('originalStart:');
    expect(out.telopDataSource).not.toContain('originalEnd:');
  });

  it.each([126, 150])('構成カット後も字幕の原本終了位置 %i を保存・再読込で保持する', originalEnd => {
    const base = loadProject({ ...FILES, cutDataSource: null });
    const project = { ...base, cutRegions: [{ start: 0, end: 15 }, { start: 36, end: 102 }, { start: 126, end: base.videoConfig.durationFrames }],
      cutOrder: [{ originalStart: 15, originalEnd: 36 }, { originalStart: 102, originalEnd: 126 }],
      telops: [{ id: 1, text: '台本の字幕', originalStart: 30, originalEnd }] };
    const out = serializeProject(project);
    const reloaded = loadProject({ ...FILES, telopDataSource: out.telopDataSource, cutDataSource: out.cutDataSource });
    expect(reloaded.telops).toEqual(project.telops);
    expect(buildPlaybackModel(reloaded).telops).toEqual(buildPlaybackModel(project).telops);
    const ranges = (items: Array<{ startFrame: number; endFrame: number }>) => items.map(({ startFrame, endFrame }) => ({ startFrame, endFrame }));
    expect(ranges(buildPlaybackModel(project).telops)).toEqual(ranges(parseTelopData(out.telopDataSource, project.videoConfig.fps, project.videoConfig.durationFrames)));
  });

  it('ラウンドトリップ: 行削除テロップの originalStart/originalEnd が保存後再読込で元の値と一致する（バグ再現）', () => {
    // セットアップ: カット区間 300–500 にテロップ id:99（原本 350–450）が完全に飲まれている
    // cutDataSource: null でロードしてフィクスチャ由来の cutRegions([{3000–3600}]) を排除し、
    // 続く手動上書き cutRegions がテスト意図の区間だけになることを保証している。
    const project = loadProject({
      ...FILES,
      cutDataSource: null,
    });
    const telopId = 99;
    const originalStart = 350;
    const originalEnd = 450;
    const projectWithFlagged: typeof project = {
      ...project,
      cutRegions: [{ start: 300, end: 500 }],
      telops: [
        { id: telopId, originalStart, originalEnd, text: 'flagged telop' },
        // カット外のテロップも含める（非 flagged の後方互換確認）
        { id: 1, originalStart: 100, originalEnd: 200, text: 'normal telop' },
      ],
    };

    // シリアライズ
    const out = serializeProject(projectWithFlagged);

    // 再読込（cutDataSource も out.cutDataSource を使う）
    const reloaded = loadProject({
      ...FILES,
      telopDataSource: out.telopDataSource,
      cutDataSource: out.cutDataSource,
    });

    // flagged テロップの originalStart/originalEnd が元の値と一致すること
    const flaggedTelop = reloaded.telops.find((t) => t.id === telopId);
    expect(flaggedTelop).toBeDefined();
    expect(flaggedTelop!.originalStart).toBe(originalStart);
    expect(flaggedTelop!.originalEnd).toBe(originalEnd);

    // 非 flagged テロップも壊れていないこと
    const normalTelop = reloaded.telops.find((t) => t.id === 1);
    expect(normalTelop).toBeDefined();
    expect(normalTelop!.originalStart).toBe(100);
    expect(normalTelop!.originalEnd).toBe(200);
  });
});

describe('loadProject — SE', () => {
  it('seData.ts を読み、原本アンカーへ変換する', () => {
    const p = loadProject(files({ seDataSource: SE_DATA }));
    expect(p.se).toEqual([{ id: 1, originalStart: 90, originalEnd: 180, file: 'ポン.mp3', volume: 0.3 }]);
    expect(p.seDataSource).toBe(SE_DATA);
  });

  it('seData.ts 不在なら se は空・seDataSource は null', () => {
    const p = loadProject(files({ seDataSource: null }));
    expect(p.se).toEqual([]);
    expect(p.seDataSource).toBeNull();
  });

  it('カット区間を越えた SE が原本フレームへ正しくアンカーされる', () => {
    // CUT_DATA_SOURCE のカット区間: 原本 3000–3600（600フレーム削除）
    // 再生フレーム 4000 → 原本 4000 + 600 = 4600
    const seSource = `import type { SoundEffect } from './SEPlayer';
export const seData: SoundEffect[] = [
  { id: 2, startFrame: 4000, file: 'ピン.mp3', volume: 0.5 },
];
`;
    const p = loadProject(files({ seDataSource: seSource }));
    expect(p.se[0]!.originalStart).toBe(4600);
  });
});

describe('serializeProject — SE', () => {
  it('SE を seData.ts ソースへ書き戻す', () => {
    const p = loadProject(files({ seDataSource: SE_DATA }));
    const out = serializeProject(p);
    expect(out.seDataSource).not.toBeNull();
    expect(out.seDataSource).toContain('startFrame: 90,');
  });

  it('SE が無く元ソースも無いなら seDataSource は null', () => {
    const p = loadProject(files({ seDataSource: null }));
    const out = serializeProject(p);
    expect(out.seDataSource).toBeNull();
  });
});

const INSERT_IMAGE_DATA = `import { FPS } from '../videoConfig';
import type { ImageSegment } from './types';

const toFrame = (sec: number) => Math.floor(sec * FPS);

export const insertImageData: ImageSegment[] = [
  { id: 1, startFrame: toFrame(2.0), endFrame: toFrame(4.0), file: 'photo1.png', type: 'photo' },
];
`;

describe('loadProject — 画像', () => {
  it('insertImageData.ts を読み、原本アンカーへ変換する', () => {
    const p = loadProject(files({ insertImageDataSource: INSERT_IMAGE_DATA }));
    expect(p.images).toEqual([
      { id: 1, originalStart: 120, originalEnd: 240, file: 'photo1.png', type: 'photo' },
    ]);
    expect(p.insertImageDataSource).toBe(INSERT_IMAGE_DATA);
  });

  it('insertImageData.ts 不在なら images は空・insertImageDataSource は null', () => {
    const p = loadProject(files({ insertImageDataSource: null }));
    expect(p.images).toEqual([]);
    expect(p.insertImageDataSource).toBeNull();
  });

  it('カット区間を越えた画像が原本フレームへ正しくアンカーされる', () => {
    const imageSource = `import { FPS } from '../videoConfig';
import type { ImageSegment } from './types';
export const insertImageData: ImageSegment[] = [
  { id: 2, startFrame: 4000, endFrame: 4200, file: 'late.png', type: 'photo' },
];
`;
    const p = loadProject(files({ insertImageDataSource: imageSource }));
    expect(p.images[0]!.originalStart).toBe(4600);
    expect(p.images[0]!.originalEnd).toBe(4800);
  });
});

describe('project: サブ動画インサート配線', () => {
  it('videoInsertDataSource 未指定なら videoInserts は空', () => {
    const p = loadProject(files({}));
    expect(p.videoInserts).toEqual([]);
  });

  it('insertVideoData.ts を読み込んで原本アンカーへ変換（カット無し）', () => {
    const src = `import type { VideoInsert } from './types';
export const insertVideoData: VideoInsert[] = [
  { id: 1, startFrame: 100, endFrame: 200, file: "sub/cam2.mp4", sourceInFrame: 30 },
];
`;
    const p = loadProject(files({ videoInsertDataSource: src }));
    expect(p.videoInserts).toEqual([
      { id: 1, originalStart: 100, originalEnd: 200, file: 'sub/cam2.mp4', sourceInFrame: 30 },
    ]);
  });

  it('serializeProject がサブ動画を再生フレームで書き戻す（往復）', () => {
    const src = `import type { VideoInsert } from './types';
export const insertVideoData: VideoInsert[] = [
  { id: 1, startFrame: 100, endFrame: 200, file: "sub/cam2.mp4", sourceInFrame: 30 },
];
`;
    const p = loadProject(files({ videoInsertDataSource: src }));
    const out = serializeProject(p);
    expect(out.videoInsertDataSource).not.toBeNull();
    expect(out.videoInsertDataSource).toContain('startFrame: 100,');
    expect(out.videoInsertDataSource).toContain('sourceInFrame: 30,');
  });

  it('サブ動画が無ければ videoInsertDataSource は null（空ファイルを作らない）', () => {
    const p = loadProject(files({}));
    const out = serializeProject(p);
    expect(out.videoInsertDataSource).toBeNull();
  });
});

describe('project: BGM 配線', () => {
  it('bgmDataSource 未指定なら bgm は空', () => {
    const p = loadProject(files({}));
    expect(p.bgm).toEqual([]);
  });

  it('bgmData.ts を読み込んで原本アンカーへ変換（カット無し）', () => {
    const src = `import type { BgmClip } from './types';
export const bgmData: BgmClip[] = [
  { id: 1, startFrame: 100, endFrame: 200, file: "bgm.mp3", volume: 0.8, fadeInFrames: 10, fadeOutFrames: 10 },
];
`;
    const p = loadProject(files({ bgmDataSource: src }));
    expect(p.bgm).toEqual([
      { id: 1, originalStart: 100, originalEnd: 200, file: 'bgm.mp3', volume: 0.8, fadeInFrames: 10, fadeOutFrames: 10 },
    ]);
  });

  it('serializeProject が BGM を再生フレームで書き戻す（往復）', () => {
    const src = `import type { BgmClip } from './types';
export const bgmData: BgmClip[] = [
  { id: 1, startFrame: 100, endFrame: 200, file: "bgm.mp3", volume: 0.8, fadeInFrames: 10, fadeOutFrames: 10 },
];
`;
    const p = loadProject(files({ bgmDataSource: src }));
    const out = serializeProject(p);
    expect(out.bgmDataSource).not.toBeNull();
    expect(out.bgmDataSource).toContain('startFrame: 100,');
    expect(out.bgmDataSource).toContain('volume: 0.8,');
  });

  it('BGM が無ければ bgmDataSource は null（空ファイルを作らない）', () => {
    const p = loadProject(files({}));
    const out = serializeProject(p);
    expect(out.bgmDataSource).toBeNull();
  });
});

// ===== タイトル層テスト =====

const TITLE_DATA_SOURCE = `import type { TitleSegment } from './Title';
import { FPS } from '../videoConfig';

export const titleData: TitleSegment[] = [
  { id: 1, startFrame: 0, endFrame: 150, text: "A" },
];
`;

describe('loadProject — タイトル', () => {
  it('titleDataSource が存在すれば titles に 1 件読み込まれる', () => {
    const p = loadProject(files({ titleDataSource: TITLE_DATA_SOURCE }));
    expect(p.titles).toHaveLength(1);
    expect(p.titles[0]!.id).toBe(1);
    expect(p.titles[0]!.originalStart).toBe(0);
    expect(p.titles[0]!.originalEnd).toBe(150);
    expect(p.titles[0]!.text).toBe('A');
    expect(p.titleDataSource).toBe(TITLE_DATA_SOURCE);
  });

  it('titleDataSource が null なら titles は空・titleDataSource は null', () => {
    const p = loadProject(files({ titleDataSource: null }));
    expect(p.titles).toEqual([]);
    expect(p.titleDataSource).toBeNull();
  });
});

describe('serializeProject — タイトル', () => {
  it('タイトルを titleDataSource に書き戻す（往復一致）', () => {
    const p = loadProject(files({ titleDataSource: TITLE_DATA_SOURCE }));
    const out = serializeProject(p);
    expect(out.titleDataSource).toBeTruthy();
    // 再 parseTitleData して元の TitleSegment と一致することを確認
    const reparsed = parseTitleData(out.titleDataSource!, 60, 12000);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]!.id).toBe(1);
    expect(reparsed[0]!.startFrame).toBe(0);
    expect(reparsed[0]!.endFrame).toBe(150);
    expect(reparsed[0]!.text).toBe('A');
  });

  it('titleDataSource が null かつタイトル 0 件なら null を返す（孤立ファイル防止・bgm と対称）', () => {
    // I-2 修正後の挙動: 元ファイル不在 + タイトル 0 件 → 書き込まない = null。
    const p = loadProject(files({ titleDataSource: null }));
    const out = serializeProject(p);
    expect(out.titleDataSource).toBeNull();
  });

  it('flagged タイトル（カットに飲まれた）でも titleData に originalStart/originalEnd を書き出さない（I-1 修正）', () => {
    // TitleSegment は下流の { id, startFrame, endFrame, text } のみ。
    // telop と違い title は標準型を維持し、originalStart/End を書き出さない。
    const p = loadProject(files({ titleDataSource: null, cutDataSource: null }));
    const projectWithFlagged = {
      ...p,
      titles: [{ id: 1, originalStart: 350, originalEnd: 450, text: 'flagged title' }],
      titleDataSource: null,
      cutRegions: [{ start: 300, end: 500 }],
    };
    const out = serializeProject(projectWithFlagged);
    // id/startFrame/endFrame/text は出力されるが originalStart/End は書かれない
    expect(out.titleDataSource).toBeTruthy();
    expect(out.titleDataSource).not.toContain('originalStart');
    expect(out.titleDataSource).not.toContain('originalEnd');
    // id と text は正しく出力されていること（出力が骨抜きでないことを確認）
    expect(out.titleDataSource).toContain('id: 1,');
    expect(out.titleDataSource).toContain('text: "flagged title",');
  });
});

describe('serializeProject — 画像', () => {
  it('画像を insertImageData.ts ソースへ書き戻す', () => {
    const p = loadProject(files({ insertImageDataSource: INSERT_IMAGE_DATA }));
    const out = serializeProject(p);
    expect(out.insertImageDataSource).not.toBeNull();
    expect(out.insertImageDataSource).toContain('startFrame: 120,');
    expect(out.insertImageDataSource).toContain('endFrame: 240,');
    expect(out.insertImageDataSource).toContain('type: "photo",');
  });

  it('画像が無く元ソースも無いなら insertImageDataSource は null', () => {
    const p = loadProject(files({ insertImageDataSource: null }));
    const out = serializeProject(p);
    expect(out.insertImageDataSource).toBeNull();
  });

  it('カット区間に完全に飲まれた画像は startFrame === endFrame の縮退区間として出力される（既知挙動）', () => {
    // ImageSegment スキーマには originalStart 退避フィールドが無いため、SE と同様に
    // flagged 画像も保存時にカット端へ寄せて出力する（spec §9・plan 既知挙動）。
    // ここでは「再生フレーム上で縮退する」現挙動を明示テストで固定する。
    // CUT_DATA_SOURCE のカット区間は原本 [3000, 3600)。画像 [3100, 3500) は完全に飲まれる。
    const swallowed = `import { FPS } from '../videoConfig';
import type { ImageSegment } from './types';
export const insertImageData: ImageSegment[] = [
  { id: 1, startFrame: 3100, endFrame: 3500, file: 'lost.png', type: 'photo' },
];
`;
    // 上記は再生フレームで書かれている。loadProject は anchorImages で原本フレームへ逆射影
    // するが、カット区間内にある再生フレームは playbackToOriginal の挙動により
    // カット終端の原本フレームへ寄る。結果として EditorImage は原本 [3600, 4000) になる
    // → これはカット区間外なので flagged 判定にはならない。
    //
    // 明示的に「原本フレーム＝カット区間内」の状態を作るには、loadProject の anchor を
    // 経由しない構築が必要。ここではビルダーで EditorImage を直接設定して serialize する。
    const base = loadProject(files({ insertImageDataSource: swallowed }));
    const swallowedProject = {
      ...base,
      images: [
        { id: 1, originalStart: 3100, originalEnd: 3500, file: 'lost.png', type: 'photo' as const },
      ],
    };
    const out = serializeProject(swallowedProject);
    // serializeInsertImageData は配列を出力しているが、startFrame と endFrame は同じ値
    // （projectImages のフォールバックで両端ともカット終端 → 再生フレーム同一値へ）。
    expect(out.insertImageDataSource).not.toBeNull();
    const match = out.insertImageDataSource!.match(
      /startFrame:\s*(\d+),\s*endFrame:\s*(\d+),/,
    );
    expect(match).not.toBeNull();
    if (match) {
      const startFrame = Number(match[1]);
      const endFrame = Number(match[2]);
      // 既知挙動: 完全にカット区間に飲まれた画像は縮退（startFrame === endFrame）。
      // この状態をハーネス形式側のレンダラが「不可視区間」として扱う。
      // 将来のリファクタで「flagged 画像は serialize 出力から省略する」へ変更する場合、
      // このテストは更新が必要。
      expect(startFrame).toBe(endFrame);
    }
  });
});

// ── Task 4: serializeProject — ducking ────────────────────────────────────────

function projectWithBgm(ducking: import('./types').EditorProject['ducking']): import('./types').EditorProject {
  return {
    videoConfig: { format: 'youtube', fps: 30, durationFrames: 300, videoFile: 'v.mp4', resolution: { width: 1920, height: 1080 }, orientation: 'landscape', titleStyle: { top: 0, left: 0, fontSize: 40 } },
    projectConfig: null,
    transcript: { durationMs: 10000, words: [{ text: 'x', start: 0, end: 1000 }], segments: [] },
    telops: [], cutRegions: [], se: [], images: [],
    telopDataSource: 'export const telopData = [];', cutDataSource: null,
    seDataSource: null, insertImageDataSource: null,
    bgm: [{ id: 1, originalStart: 0, originalEnd: 100, file: 'a.mp3', volume: 0.5, fadeInFrames: 0, fadeOutFrames: 0 }],
    bgmDataSource: "import type { BgmClip } from './types';\nexport const bgmData: BgmClip[] = [];\n",
    titles: [], titleDataSource: null,
    ducking,
    mainSpeed: 1,
    segmentSpeeds: {},
  };
}

describe('serializeProject — ducking', () => {
  it('ducking ON で bgmData 出力にダッキングが載る', () => {
    const out = serializeProject(projectWithBgm({ enabled: true, strength: 'mid' }));
    expect(out.bgmDataSource).toContain('ducking:');
    expect(out.bgmDataSource).toContain('gain: 0.5');
  });
  it('ducking OFF/未設定では載らない', () => {
    expect(serializeProject(projectWithBgm({ enabled: false, strength: 'mid' })).bgmDataSource).not.toContain('ducking');
    expect(serializeProject(projectWithBgm(undefined)).bgmDataSource).not.toContain('ducking');
  });
});

// ===== 図形オーバーレイ配線テスト =====

const SHAPE_DATA_SOURCE = `import type { ShapeSegment } from './types';

// Harness Editor が生成・更新します

export const shapeData: ShapeSegment[] = [
  {
    id: 1,
    startFrame: 100,
    endFrame: 200,
    kind: "arrow",
    x1: 0.1,
    y1: 0.2,
    x2: 0.8,
    y2: 0.7,
    color: "#ff0000",
    thickness: "medium",
  },
];
`;

describe('loadProject — 図形（shapes）', () => {
  it('shapeDataSource が存在すれば shapes に anchorShapes された結果が入る', () => {
    const p = loadProject(files({ shapeDataSource: SHAPE_DATA_SOURCE }));
    expect(p.shapes).toHaveLength(1);
    // カット無しなら originalStart == startFrame
    expect(p.shapes![0]!.id).toBe(1);
    expect(p.shapes![0]!.originalStart).toBe(100);
    expect(p.shapes![0]!.originalEnd).toBe(200);
    expect(p.shapes![0]!.kind).toBe('arrow');
    expect(p.shapes![0]!.x1).toBe(0.1);
    expect(p.shapeDataSource).toBe(SHAPE_DATA_SOURCE);
  });

  it('shapeDataSource が null なら shapes は空・shapeDataSource は null', () => {
    const p = loadProject(files({ shapeDataSource: null }));
    expect(p.shapes ?? []).toEqual([]);
    expect(p.shapeDataSource ?? null).toBeNull();
  });
});

describe('serializeProject — 図形（shapes）', () => {
  it('図形を shapeDataSource に書き戻す（kind/x1 を含み originalStart を含まない）', () => {
    const p = loadProject(files({ shapeDataSource: SHAPE_DATA_SOURCE }));
    const out = serializeProject(p);
    expect(out.shapeDataSource).not.toBeNull();
    expect(out.shapeDataSource).toContain('kind: "arrow",');
    expect(out.shapeDataSource).toContain('x1: 0.1,');
    // originalStart/originalEnd は ShapeSegment スキーマ外 → 出力しない
    expect(out.shapeDataSource).not.toContain('originalStart');
    expect(out.shapeDataSource).not.toContain('originalEnd');
  });

  it('図形が無く元ソースも無いなら shapeDataSource は null（空ファイルを作らない）', () => {
    const p = loadProject(files({ shapeDataSource: null }));
    const out = serializeProject(p);
    expect(out.shapeDataSource ?? null).toBeNull();
  });
});

// ===== Task 9: save→load 往復不変（overlaps あり） =====
//
// crossfade(dur=20) のつなぎ目が存在するとき:
//   serializeProject → 最終座標で出力
//   loadProject      → 最終→再生→原本 と逆射影
//   結果: originalStart/End は往復で不変
//
// CUT_DATA_SOURCE のカット区間: 原本 [0,3000)＋[3600,12000) を残す
//   → 再生フレーム境界 = 3000
// crossfade(dur=20) at=3000(再生フレーム)
//   → overlaps=[{boundary:3000, overlap:20}]
//   → テロップ startFrame=3100(再生) → 最終 = 3080
// 読み込み時: 最終 3080 → 逆射影 → 再生 3100 → 原本アンカー（カット分加算）

const TRANSITION_CROSSFADE_SRC = `import type { SceneTransition } from './types';
export const transitionData: SceneTransition[] = [
  { id: 1, at: 3000, kind: "crossfade", durationFrames: 20 },
];
`;

// Task 9 実装後のデータモデル:
//   telopData.ts の startFrame = 最終座標（overlap 分前詰め済み）
//   loadProject はその最終座標を逆射影して再生座標へ戻してから anchorTelops へ渡す
//
// 往復テストのシナリオ:
//   1. 原本アンカー済みの P（テロップ originalStart=3700）から serializeProject
//      → 最終座標 3080 が telopData.ts に書かれる
//   2. その telopData.ts を loadProject で読込
//      → 最終 3080 → 逆射影 → 再生 3100 → anchorTelops → 原本 3700
//   3. P.telops[0].originalStart === P2.telops[0].originalStart = 3700（不変）
//
// この P を作る最も簡潔な方法:
//   直接 EditorProject を構築して serializeProject → そのファイルを loadProject

describe('save→load 往復不変（overlaps あり）', () => {
  it('crossfade を置いてもテロップの originalStart/End が往復で不変', () => {
    // 1. crossfade あり の EditorProject P を直接構築する
    //    CUT_DATA_SOURCE: カット 600fr（原本3000〜3600）→ join at=原本3000=再生3000
    //    crossfade at=原本3000 → anchorSceneTransitions で at=原本3000 として保持
    const base = loadProject(files({
      transitionDataSource: TRANSITION_CROSSFADE_SRC,
    }));
    const P = {
      ...base,
      telops: [
        // 原本フレーム 3700〜3800（再生フレーム 3100〜3200。カット 600fr を跨ぐ）
        { id: 99, originalStart: 3700, originalEnd: 3800, text: 'after join' },
      ],
    };

    // 期待する originalStart/End を記録
    const expectedOriginalStart = 3700;
    const expectedOriginalEnd = 3800;

    // 2. serializeProject → 最終座標で出力（overlap=20 → 3100-20=3080）
    const out = serializeProject(P);

    // 保存ファイルに最終座標 3080 が書かれていることを確認（serializeProject の正しさ）
    const serializedTelops = parseTelopData(out.telopDataSource, 60, 12000);
    const serializedTelop = serializedTelops.find((t) => t.id === 99);
    expect(serializedTelop!.startFrame).toBe(3080);
    expect(serializedTelop!.endFrame).toBe(3180);

    // 3. loadProject で再読込（最終 3080 → 逆射影 → 再生 3100 → 原本 3700）
    const P2 = loadProject(files({
      telopDataSource: out.telopDataSource,
      cutDataSource: out.cutDataSource,
      transitionDataSource: out.transitionDataSource ?? undefined,
    }));

    // 4. 往復不変：originalStart/End が元と一致すること
    const reloadedTelop = P2.telops.find((t) => t.id === 99);
    expect(reloadedTelop!.originalStart).toBe(expectedOriginalStart);
    expect(reloadedTelop!.originalEnd).toBe(expectedOriginalEnd);

    // sceneTransitions も往復不変（at=原本フレーム）
    expect(P2.sceneTransitions).toEqual(P.sceneTransitions);
  });
});

// ===== Plan 1: mainSpeed 配線テスト =====

describe('project mainSpeed (Plan 1)', () => {
  it('speedDataSource 不在なら mainSpeed=1', () => {
    const p = loadProject(files({}));
    expect(p.mainSpeed).toBe(1);
  });
  it('speedDataSource から mainSpeed を読む', () => {
    const p = loadProject(files({ speedDataSource: 'export const MAIN_SPEED = 0.5;\n' }));
    expect(p.mainSpeed).toBe(0.5);
  });
  it('serializeProject は mainSpeed=1 で speedDataSource=null', () => {
    expect(serializeProject(loadProject(files({}))).speedDataSource).toBeNull();
  });
  it('serializeProject は mainSpeed≠1 で speedDataSource を出力', () => {
    const p = { ...loadProject(files({})), mainSpeed: 0.5 };
    const out = serializeProject(p);
    expect(out.speedDataSource).not.toBeNull();
    expect(out.speedDataSource).toContain('MAIN_SPEED');
  });
});

// ===== Plan 2a: mainLayout 永続化テスト =====

describe('project mainLayout (Plan 2a)', () => {
  it('mainLayoutDataSource 不在なら既定（全画面）', () => {
    const p = loadProject(files({}));
    expect(p.mainLayout).toEqual({
      position: { x: 0, y: 0 },
      scale: 1,
      background: '#000000',
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  });
  it('mainLayoutDataSource から読む', () => {
    const p = loadProject(
      files({
        mainLayoutDataSource:
          'export const MAIN_LAYOUT = { position: { x: 0.5, y: 0 }, scale: 2, background: "#ffffff" };\n',
      }),
    );
    expect(p.mainLayout).toEqual({
      position: { x: 0.5, y: 0 },
      scale: 2,
      background: '#ffffff',
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  });
  it('serializeProject は既定で mainLayoutDataSource=null', () => {
    expect(serializeProject(loadProject(files({}))).mainLayoutDataSource).toBeNull();
  });
  it('serializeProject は非既定で mainLayoutDataSource を出力', () => {
    const p = {
      ...loadProject(files({})),
      mainLayout: {
        position: { x: 0.3, y: 0 },
        scale: 1.5,
        background: '#000000',
        rotation: 0,
        flipH: false,
        flipV: false,
      },
    };
    const out = serializeProject(p);
    expect(out.mainLayoutDataSource).not.toBeNull();
    expect(out.mainLayoutDataSource).toContain('MAIN_LAYOUT');
  });
  it('serialize → load 往復で position/scale/background を保持', () => {
    const layout = {
      position: { x: -0.4, y: 0.2 },
      scale: 1.25,
      background: '#123456',
      rotation: 0,
      flipH: false,
      flipV: false,
    };
    const p = { ...loadProject(files({})), mainLayout: layout };
    const out = serializeProject(p);
    const reloaded = loadProject(files({ mainLayoutDataSource: out.mainLayoutDataSource }));
    expect(reloaded.mainLayout).toEqual(layout);
  });
});

// ===== Task 8: serializeProject — 最終座標化（overlaps 適用） =====
//
// CUT_DATA_SOURCE のカット区間: 原本 3000〜3600（600fr 削除）
// カット後再生タイムライン: [0,3000)＋[3600,12000) → 再生フレーム境界 = 3000
// crossfade(dur=20) をつなぎ目(at=原本3000)に置くと:
//   overlaps = [{ boundary: 3000(再生), overlap: 20 }]
//   つなぎ目より後の再生フレーム F → 最終フレーム = F - 20

describe('serializeProject — 最終座標化（overlaps）', () => {
  it('overlap なし（通常）では既存挙動と一致する（回帰）', () => {
    // transitionData 無し → overlaps = [] → collapseStartEnd は恒等
    const p = loadProject(files({}));
    const out = serializeProject(p);
    // フィクスチャのテロップ id:1 は再生 startFrame:30, endFrame:150
    // overlap なしなら最終フレームも 30/150 のまま
    const reparsed = parseTelopData(out.telopDataSource, 60, 12000);
    const t1 = reparsed.find((t) => t.id === 1);
    expect(t1!.startFrame).toBe(30);
    expect(t1!.endFrame).toBe(150);
  });

  it('crossfade(dur=20) でつなぎ目より後のテロップが overlap 分（20fr）前へ詰む（一回目の保存）', () => {
    // Task 8 確認: serializeProject が最終座標で出力する。
    // Task 9 実装後は loadProject が telopData の値を「最終座標」として読む。
    //
    // 「一回目の保存」シナリオ（Task 9 実装後の正しい表現）:
    //   EditorProject を直接構築（anchorTelops 済みの原本アンカー）して serializeProject に渡す。
    //   原本アンカーからシリアライズすると最終座標が出力される。
    //
    // CUT_DATA_SOURCE: 原本 [0,3000)＋[3600,12000) を残す → join at=原本3000
    // crossfade at=3000(原本フレーム＝join) → 再生フレーム 3000 → overlaps=[{boundary:3000, overlap:20}]
    // テロップ: originalStart=3700(原本)・再生 3100(原本3700-600カット長=3100) → 最終 3100-20=3080

    const transitionSrc = `import type { SceneTransition } from './types';
export const transitionData: SceneTransition[] = [
  { id: 1, at: 3000, kind: "crossfade", durationFrames: 20 },
];
`;

    // CUT_DATA_SOURCE でカット有り・crossfade あり のプロジェクトを構築
    // loadProject で anchorSceneTransitions が at=再生3000→原本3000 へ変換する
    const base = loadProject(files({ transitionDataSource: transitionSrc }));
    const projectWithTelop = {
      ...base,
      telops: [
        // 原本フレーム 3700〜3800 = 再生フレーム 3100〜3200（カット 600fr を跨ぐ）
        { id: 10, originalStart: 3700, originalEnd: 3800, text: 'after join' },
      ],
    };

    const out = serializeProject(projectWithTelop);

    // telopDataSource を再パースして最終フレームを確認
    const reparsed = parseTelopData(out.telopDataSource, 60, 12000);
    const t = reparsed.find((t) => t.id === 10);
    expect(t).toBeDefined();
    // 再生 3100 → 最終 3100-20=3080（overlap=20 分だけ前へ詰まる）
    expect(t!.startFrame).toBe(3080);
    expect(t!.endFrame).toBe(3180);
  });
});

// ===== Plan 2: 速度焼き込み配線（project speed baking） =====

describe('project speed baking (Plan 2)', () => {
  /** telopDataSource の startFrame 値を全部取り出す */
  const extractStartFrames = (src: string): number[] =>
    Array.from(src.matchAll(/startFrame:\s*(\d+)/g)).map((m) => Number(m[1] ?? '0'));

  it('mainSpeed=0.5 で telopData の座標が 1x の約 2 倍で直列化される', () => {
    const p1 = loadProject(FILES);
    const p05 = { ...p1, mainSpeed: 0.5 };
    const s1 = serializeProject(p1);
    const s05 = serializeProject(p05);

    const a = extractStartFrames(s1.telopDataSource);
    const b = extractStartFrames(s05.telopDataSource);

    // テロップ件数は変わらない
    expect(b.length).toBe(a.length);
    // 0.5x なら各座標は 1x の 2 倍（丸め ±1 許容）
    a.forEach((v, i) => {
      expect(Math.abs((b[i] ?? 0) - v * 2)).toBeLessThanOrEqual(1);
    });
    // cutData は速度に依らず不変
    expect(s05.cutDataSource).toBe(s1.cutDataSource);
  });

  it('無損失往復: serialize(0.5x)→load(0.5x) で telopData 座標がべき等（±1）・mainSpeed 保持', () => {
    const p = { ...loadProject(FILES), mainSpeed: 0.5 };
    const out = serializeProject(p);

    const reloaded = loadProject({
      ...FILES,
      telopDataSource: out.telopDataSource,
      cutDataSource: out.cutDataSource,
      speedDataSource: 'export const MAIN_SPEED = 0.5;\n',
    });

    expect(reloaded.mainSpeed).toBe(0.5);

    // 再 serialize した値は 1 回目と ±1 以内で一致（べき等）
    const out2 = serializeProject(reloaded);
    const a = extractStartFrames(out.telopDataSource);
    const b = extractStartFrames(out2.telopDataSource);
    a.forEach((v, i) => {
      expect(Math.abs((b[i] ?? 0) - v)).toBeLessThanOrEqual(1);
    });
  });

  it('mainSpeed=1 は焼き込み無し（telopData が速度なしと同一）', () => {
    const p = loadProject(FILES);
    const sNoSpeed = serializeProject(p);           // mainSpeed === 1
    const sExplicit = serializeProject({ ...p, mainSpeed: 1 });
    expect(sExplicit.telopDataSource).toBe(sNoSpeed.telopDataSource);
  });
});

describe('loadProject — 区間速度', () => {
  it('speedData の SEGMENT_SPEEDS を取り込む（現存区間のみ）', () => {
    // CUT_DATA_SOURCE fixture の cutData は id 1, 2 の 2 区間。id 99 は存在しない。
    const speedSrc =
      'export const MAIN_SPEED = 1;\nexport const SEGMENT_SPEEDS = { 1: 0.5, 99: 2 };';
    const p = loadProject(files({ speedDataSource: speedSrc }));
    // id 99 は cutData に存在しないので破棄され、1 のみ残る
    expect(p.segmentSpeeds).toEqual({ 1: 0.5 });
  });

  it('speedData 不在なら空マップ', () => {
    const p = loadProject(files({ speedDataSource: null }));
    expect(p.segmentSpeeds).toEqual({});
  });
});

describe('serializeProject — 区間速度 round-trip', () => {
  it('segmentSpeeds が speedData.ts に出る', () => {
    const base = loadProject(FILES);
    const project = { ...base, mainSpeed: 1, segmentSpeeds: { 1: 0.5 } };
    const out = serializeProject(project);
    expect(out.speedDataSource).toContain('SEGMENT_SPEEDS');
    expect(out.speedDataSource).toContain('1: 0.5');
  });

  it('serialize → load で segmentSpeeds が生き残る（end-to-end）', () => {
    // serialize した speedDataSource を loadProject に戻したとき、
    // id 1 の速度が保持されることを確認する（真の往復テスト）。
    // CUT_DATA_SOURCE の cutData は id 1, 2 の 2 区間。id 1 は applyCuts でも id 1 として生成される。
    const base = loadProject(FILES);
    const project = { ...base, mainSpeed: 1, segmentSpeeds: { 1: 0.5 } };
    const out = serializeProject(project);
    const loaded = loadProject(
      files({ speedDataSource: out.speedDataSource, cutDataSource: CUT_DATA_SOURCE }),
    );
    expect(loaded.segmentSpeeds).toEqual({ 1: 0.5 });
  });
});

// ===== Plan 2 Task 2: per-segment speed baking in project serialize/load =====
//
// applyCuts(12000, [{start:3000, end:3600}]) の付番:
//   segment id=1: playback 0–3000 (原本 0–3000)
//   segment id=2: playback 3000–11400 (原本 3600–12000)
// → firstId = 1（先頭区間）は常に 1。
//
// テロップフィクスチャ (TELOP_DATA_SOURCE) の各座標は再生座標:
//   id:1 startFrame=30, id:2 startFrame=200（どちらも segment 1 内）
// firstId=1 の速度を 2x にすると piecewise scale:
//   playbackToSpeed(30, segs)  = round(30/2) = 15
//   playbackToSpeed(200, segs) = round(200/2) = 100

describe('project per-segment speed baking (Plan 2)', () => {
  /** telopDataSource の startFrame 値を正規表現で全取り出す */
  const nums = (src: string): number[] =>
    Array.from(src.matchAll(/startFrame:\s*(\d+)/g)).map((m) => Number(m[1] ?? '0'));

  // cutSegs の先頭 id（applyCuts は常に 1 から採番）
  const firstId = 1;

  it('個別指定ゼロは uniform 経路とバイト同値（telopData が segmentSpeeds 空と一致）', () => {
    const p = loadProject(FILES);
    const sUniform = serializeProject({ ...p, mainSpeed: 0.5, segmentSpeeds: {} });
    const sEmpty   = serializeProject({ ...p, mainSpeed: 0.5 }); // segmentSpeeds は既定 {}
    expect(sEmpty.telopDataSource).toBe(sUniform.telopDataSource);
  });

  it('全エントリが mainSpeed と一致（冗長）でも uniform 経路（hasPerSegmentSpeed=false）', () => {
    const p = loadProject(FILES);
    // cutRegions が 1 件 → applyCuts で segment id は 1 始まり連番。
    // cutRegions の個数分だけ id を列挙しても、全エントリが mainSpeed=0.5 と一致 → false。
    const ids = p.cutRegions.map((_, i) => i + 1);
    const redundant = Object.fromEntries(ids.map((id) => [id, 0.5]));
    const sRedundant = serializeProject({ ...p, mainSpeed: 0.5, segmentSpeeds: redundant });
    const sUniform   = serializeProject({ ...p, mainSpeed: 0.5, segmentSpeeds: {} });
    expect(sRedundant.telopDataSource).toBe(sUniform.telopDataSource);
  });

  it('プレビュー一致: 個別指定ありの直列化座標が buildPlaybackModel の要素座標と一致', () => {
    const p = loadProject(FILES);
    // 先頭区間 (id=1) だけ 2x、残りは mainSpeed=1
    const proj = { ...p, mainSpeed: 1, segmentSpeeds: { [firstId]: 2 } };
    const out   = serializeProject(proj);
    // buildPlaybackModel は内部で applySpeed(base, proj.mainSpeed, proj.segmentSpeeds) を呼ぶ。
    // 二重適用を避けるため直接 buildPlaybackModel(proj) を使う（applySpeed でラップしない）。
    const model = buildPlaybackModel(proj);
    // M-4: vacuous pass 防止 — テロップが 0 件だとループが空振りしてテストが常に緑になる。
    expect(model.telops.length).toBeGreaterThan(0);
    // telopDataSource の startFrame 一覧が model.telops の startFrame と ±1 以内で一致すること
    const a = nums(out.telopDataSource);
    model.telops.forEach((t, i) => {
      if (a[i] !== undefined) expect(Math.abs(a[i]! - t.startFrame)).toBeLessThanOrEqual(1);
    });
  });

  it('無損失往復: serialize(個別指定)→load で mainSpeed/segmentSpeeds と要素座標が ±1 復元', () => {
    const p = loadProject(FILES);
    const proj = { ...p, mainSpeed: 1, segmentSpeeds: { [firstId]: 2 } };
    const out  = serializeProject(proj);
    const reloaded = loadProject({
      ...FILES,
      telopDataSource:  out.telopDataSource,
      cutDataSource:    out.cutDataSource,
      speedDataSource:  out.speedDataSource,
    });
    expect(reloaded.mainSpeed).toBe(1);
    expect(reloaded.segmentSpeeds).toEqual({ [firstId]: 2 });
    // 再 serialize した値が 1 回目と ±1 以内（べき等）
    const out2 = serializeProject(reloaded);
    const a = nums(out.telopDataSource);
    const b = nums(out2.telopDataSource);
    a.forEach((v, i) => expect(Math.abs((b[i] ?? 0) - v)).toBeLessThanOrEqual(1));
  });

  // ===== I-2: トランジション×区間速度のミスアライン暫定ガード =====
  it('I-2: 有効トランジション（join 一致）ありの場合は区間速度が指定されていても uniform で書き出す', () => {
    const p = loadProject(FILES);
    // at:3000 はフィクスチャの join (atOriginal=3000, playbackFrame=3000) と一致する有効トランジション
    // 修正後: projectedTransitions=[{at:3000(playback)}] → hasTransitions=true → uniform ガード発動
    const withTransition = {
      ...p,
      mainSpeed: 1,
      segmentSpeeds: { [firstId]: 2 },
      sceneTransitions: [{ id: 1, at: 3000, kind: 'crossfade' as const, durationFrames: 60 }],
      transitionDataSource: null,
    };
    // トランジション無しの uniform 基準（区間速度なし・rate=1 → identity）
    const uniformBase = serializeProject({ ...p, mainSpeed: 1, segmentSpeeds: {} });
    const withTrans   = serializeProject(withTransition);
    // I-2 ガード: 有効トランジションがあれば区間速度は無視されて uniform と同じ telopData になる
    expect(withTrans.telopDataSource).toBe(uniformBase.telopDataSource);
  });

  it('I-2: トランジション無しなら区間速度は通常通り区分線形で書き出す（ガード不発）', () => {
    const p = loadProject(FILES);
    const withPerSeg = serializeProject({ ...p, mainSpeed: 1, segmentSpeeds: { [firstId]: 2 } });
    const uniform    = serializeProject({ ...p, mainSpeed: 1, segmentSpeeds: {} });
    // トランジション無し → 区間速度ありは uniform と異なるはず
    expect(withPerSeg.telopDataSource).not.toBe(uniform.telopDataSource);
  });

  // ===== M-1: phantom id（cutData に存在しない区間 id）は uniform 扱いになる =====
  it('M-1: cutData に存在しない phantom id だけの segmentSpeeds は uniform 経路とバイト同値', () => {
    const p = loadProject(FILES);
    // 9999 は applyCuts の付番に絶対現れない id
    const sPhantom  = serializeProject({ ...p, mainSpeed: 1, segmentSpeeds: { 9999: 2 } });
    const sUniform  = serializeProject({ ...p, mainSpeed: 1, segmentSpeeds: {} });
    expect(sPhantom.telopDataSource).toBe(sUniform.telopDataSource);
  });

  // ===== I-2 round-trip 対称性: 孤立トランジション＋区間速度で originalStart 破損を暴く =====
  //
  // バグ: serializeProject の hasTransitions が生の sceneTransitions.length を見るため、
  // join に一致しない「孤立」トランジション（at:1500 はフィクスチャの join=3000 に不一致）でも
  // hasTransitions=true → uniform で焼く。
  // しかし書き出し transitionData は projectedTransitions=[]（孤立ドロップ）→ null。
  // load: parsedTransitions=[] → hasTransitionsLoad=false → piecewise で逆射影。
  // → uniform で焼いた座標を piecewise で戻す = originalStart が倍化して破損する。
  it('I-2 round-trip: 孤立トランジション＋per-seg → originalStart が ±1 復元（修正前 FAIL・修正後 GREEN）', () => {
    const p = loadProject(FILES);
    // at:1500 は join (atOriginal=3000) と一致しない孤立トランジション
    const proj = {
      ...p,
      mainSpeed: 1,
      segmentSpeeds: { [firstId]: 2 },
      sceneTransitions: [{ id: 1, at: 1500, kind: 'crossfade' as const, durationFrames: 60 }],
    };
    const out1 = serializeProject(proj);
    const loaded = loadProject(files({
      telopDataSource: out1.telopDataSource,
      cutDataSource: out1.cutDataSource,
      speedDataSource: out1.speedDataSource ?? undefined,
      transitionDataSource: out1.transitionDataSource ?? undefined,
    }));
    // round-trip: proj の originalStart が loaded で ±1 以内に復元されること
    // 修正前: uniform で焼いた 30 を piecewise で戻すと 60 に倍化（|60-30|=30 > 1 → FAIL）
    // 修正後: 孤立ドロップ後 projectedTransitions=[] → piecewise で焼き → ±1 復元（PASS）
    expect(proj.telops.length).toBeGreaterThan(0);
    proj.telops.forEach((t, i) => {
      const lt = loaded.telops[i]!;
      expect(Math.abs(lt.originalStart - t.originalStart)).toBeLessThanOrEqual(1);
    });
  });

  // ===== I-2 補足: 有効トランジション＋per-seg → uniform 経路でも round-trip 対称 =====
  it('I-2 round-trip: 有効トランジション（at:3000=join）＋per-seg → originalStart が ±1 復元（両サイド uniform で対称）', () => {
    const p = loadProject(FILES);
    // at:3000 は computeJoins の join (atOriginal=3000) と一致する有効トランジション
    // projectedTransitions.length=1 → hasTransitions=true → serialize/load ともに uniform で対称
    const proj = {
      ...p,
      mainSpeed: 1,
      segmentSpeeds: { [firstId]: 2 },
      sceneTransitions: [{ id: 1, at: 3000, kind: 'crossfade' as const, durationFrames: 60 }],
      transitionDataSource: null,
    };
    const out1 = serializeProject(proj);
    const loaded = loadProject(files({
      telopDataSource: out1.telopDataSource,
      cutDataSource: out1.cutDataSource,
      speedDataSource: out1.speedDataSource ?? undefined,
      transitionDataSource: out1.transitionDataSource ?? undefined,
    }));
    expect(proj.telops.length).toBeGreaterThan(0);
    proj.telops.forEach((t, i) => {
      const lt = loaded.telops[i]!;
      expect(Math.abs(lt.originalStart - t.originalStart)).toBeLessThanOrEqual(1);
    });
  });
});

describe('project segmentLayouts 往復', () => {
  it('serialize→loadProject で segmentLayouts を往復（実在する区間 id）', () => {
    const project = loadProject(FILES);
    const keptId = applyCuts(project.videoConfig.durationFrames, project.cutRegions)[0]!.id;
    const withSeg = { ...project, segmentLayouts: { [keptId]: { position: { x: 0.5, y: 0 }, scale: 2, rotation: 0, flipH: false, flipV: false } } };
    const sources = serializeProject(withSeg);
    const loaded = loadProject(files({ mainLayoutDataSource: sources.mainLayoutDataSource }));
    expect(loaded.segmentLayouts).toEqual(withSeg.segmentLayouts);
  });
  it('現在のカット区間に存在しない id は build で破棄', () => {
    const src = serializeMainLayoutData(DEFAULT_MAIN_LAYOUT, { 99999: { position: { x: 0.3, y: 0 }, scale: 1.5, rotation: 0, flipH: false, flipV: false } });
    const loaded = loadProject(files({ mainLayoutDataSource: src }));
    expect(loaded.segmentLayouts).toEqual({});
  });
});

describe('project layoutKeyframes 往復（大域配列・originalFrame アンカー）', () => {
  it('serialize→loadProject で layoutKeyframes を往復（カット区間 id に非依存）', () => {
    const project = loadProject(FILES);
    const kf = [
      { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
      { originalFrame: 20, x: 0.5, y: 0.2, scale: 1.5, rotation: 10 },
    ];
    const withKf = { ...project, layoutKeyframes: kf };
    const sources = serializeProject(withKf);
    expect(sources.mainLayoutDataSource).toContain('LAYOUT_KEYFRAMES');
    const loaded = loadProject(files({ mainLayoutDataSource: sources.mainLayoutDataSource }));
    expect(loaded.layoutKeyframes).toEqual(withKf.layoutKeyframes);
  });
  it('動画尺を超える originalFrame は尺内へクランプする', () => {
    const project = loadProject(FILES);
    const huge = project.videoConfig.durationFrames + 99999;
    const src = serializeMainLayoutData(DEFAULT_MAIN_LAYOUT, {}, [
      { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
      { originalFrame: huge, x: 0.3, y: 0, scale: 1.5, rotation: 0 },
    ]);
    const loaded = loadProject(files({ mainLayoutDataSource: src }));
    expect(loaded.layoutKeyframes?.[1]?.originalFrame).toBe(project.videoConfig.durationFrames);
  });
});
