/**
 * @vitest-environment jsdom
 *
 * タイムラインの「見えやすさ」の回帰テスト（サイクル 4 A 節）。
 *
 * - 初期ズーム: 案件を開いた直後に完成尺全体が可視幅へ収まること／「全体を表示」ボタン
 * - カット区間: ホバーで何が起きるか分かる説明（title）が付くこと
 * - クリップのキーボード到達性（監査 interaction-10）
 * - 空トラックの畳み込みと「さらに N トラック」の手がかり
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { EditorPlaybackRef as PlayerRef } from '../preview/editorPlayback';
import type { EditorProject, EditorTelop } from '../../core/types';
import { useEditSession } from '../useEditSession';
import { Timeline } from './Timeline';
import { TRACK_LABEL_GUTTER_PX } from '../timeline/timelineGeometry';
import { buildPlaybackModel } from '../../preview/playbackModel';
import { cutOrderingOf } from '../../core/cutOrder';
import { overviewFrameToPreviewFrame } from '../timeline/overviewGeometry';

vi.mock('./TelopStyleGrid', () => ({ TelopStyleGrid: () => null }));

const FPS = 30;
/** 14 分相当。既定ズーム（1px/frame）では可視幅 1200px に全く収まらない。 */
const DURATION_FRAMES = 26000;
/** jsdom は clientWidth を 0 で返すので、可視幅を実測値の代わりに固定する。 */
const VIEW_W = 1200;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return VIEW_W;
    },
  });
});

function makeProject(overrides: Partial<EditorProject> = {}): EditorProject {
  const telops: EditorTelop[] = [
    { id: 1, originalStart: 100, originalEnd: 400, text: 'じまくA', template: 1 },
  ];
  return {
    videoConfig: {
      format: 'short',
      fps: FPS,
      durationFrames: DURATION_FRAMES,
      videoFile: 'main.mp4',
      resolution: { width: 1080, height: 1920 },
      orientation: 'portrait',
      titleStyle: { top: 100, left: 60, fontSize: 60 },
    },
    projectConfig: null,
    transcript: { durationMs: (DURATION_FRAMES / FPS) * 1000, words: [], segments: [] },
    telops,
    cutRegions: [{ start: 1000, end: 3800 }],
    se: [],
    images: [],
    telopDataSource: 'export const telopData = [];\n',
    cutDataSource: null,
    seDataSource: null,
    insertImageDataSource: null,
    titles: [],
    titleDataSource: null,
    mainSpeed: 1,
    segmentSpeeds: {},
    ...overrides,
  };
}

function makeFakePlayer(): PlayerRef {
  return {
    addEventListener() {},
    removeEventListener() {},
    seekTo: vi.fn(),
    getCurrentFrame: () => 0,
    play: vi.fn(),
    pause: vi.fn(),
    isPlaying: () => false,
  } as unknown as PlayerRef;
}

function Harness({
  project,
  view = 'detail',
  cutsBypassed = false,
  finalClock = true,
  allowRangeCut = true,
  player = makeFakePlayer(),
}: {
  project: EditorProject;
  view?: 'overview' | 'detail';
  cutsBypassed?: boolean;
  finalClock?: boolean;
  allowRangeCut?: boolean;
  player?: PlayerRef;
}) {
  const session = useEditSession('p1', project, null);
  const playerRef = useRef<PlayerRef | null>(player);
  const [playbackRate, setPlaybackRate] = useState(1);
  if (session === null) return null;
  const finalModel = buildPlaybackModel(project);
  return (
    <Timeline
      view={view}
      finalDurationFrames={finalModel.durationInFrames}
      finalPlaybackModel={finalClock ? finalModel : undefined}
      allowRangeCut={allowRangeCut}
      session={session}
      baseProject={project}
      playerRef={playerRef}
      seLibrary={[]}
      imageLibrary={[]}
      videoLibrary={[]}
      bgmLibrary={[]}
      videoUrl=""
      projectId="p1"
      highlightRange={null}
      onHighlightRange={() => {}}
      speedSegments={null}
      cutsBypassed={cutsBypassed}
      onToggleCutsBypassed={() => {}}
      playbackRate={playbackRate}
      onPlaybackRateChange={setPlaybackRate}
    />
  );
}

function setup(project = makeProject()): HTMLElement {
  // Explicitly exercise the legacy source-clock timeline. The finishing view
  // with a final model is covered separately below, through its visible lanes.
  return render(<Harness project={project} finalClock={false} />).container;
}

function scrollWidth(c: HTMLElement): number {
  const el = c.querySelector<HTMLElement>('.tl-scroll');
  return Number.parseFloat(el?.style.width ?? '0');
}

afterEach(cleanup);

describe('仕上げの完成順タイムライン', () => {
  it('並び替え・倍速・重なりがあるシーン転換を完成位置へ置き、元の転換を選択する', () => {
    const project = makeProject({
      videoConfig: { ...makeProject().videoConfig, durationFrames: 300 },
      cutRegions: [{ start: 100, end: 150 }],
      cutOrder: [{ originalStart: 150, originalEnd: 300 }, { originalStart: 0, originalEnd: 100 }],
      mainSpeed: 2,
      sceneTransitions: [{ id: 1, at: 300, kind: 'crossfade', durationFrames: 20 }],
    });
    const model = buildPlaybackModel(project);
    // 150 + 100 source frames, minus a 20-frame overlap, at 2x.
    expect(model.durationInFrames).toBe(115);
    const { container } = render(<Harness project={project} allowRangeCut={false} />);
    const marker = container.querySelector('[data-join-at="300"]') as HTMLButtonElement;
    expect(marker).not.toBeNull();
    const tail = container.querySelector('[data-join-at="tail"]') as HTMLButtonElement;
    const pixelsPerFrame = (Number.parseFloat(tail.style.left) - TRACK_LABEL_GUTTER_PX) / 115;
    // The incoming clip begins at (150 - 20) / 2 = 65 final frames.
    expect(Number.parseFloat(marker.style.left)).toBeCloseTo(TRACK_LABEL_GUTTER_PX + 65 * pixelsPerFrame, 5);
    fireEvent.click(marker);
    expect(marker.className).toContain('selected');
  });

  it('完成位置の素材を選択でき、主映像の並べ替えは編集ページに限定する', () => {
    const player = makeFakePlayer();
    const project = makeProject({ images: [{ id: 1, originalStart: 100, originalEnd: 200,
      file: 'overlay.png', type: 'photo', timelinePlacement: { startFrame: 4500, endFrame: 7500 } }] });
    const { getByTestId } = render(<Harness project={project} player={player} allowRangeCut={false} />);
    expect(getByTestId('timeline-shell').className).toContain('is-cut-sequence');
    const clip = getByTestId('sequence-asset-image-1');
    fireEvent.click(clip);
    // End is exclusive: select the middle of the actual visible frames.
    expect(player.seekTo).toHaveBeenCalledWith(5999);
    expect(clip.getAttribute('aria-pressed')).toBe('true');
    expect(getByTestId('cut-sequence-clip-1').getAttribute('draggable')).toBe('false');
    expect(getByTestId('timeline-cut').hidden).toBe(true);
  });
});

describe('初期ズーム（ベースライン §初期ズーム）', () => {
  it('開いた直後にタイムライン全体が可視幅へ収まる', () => {
    const c = setup();
    // 既定の 1px/frame なら 26000+88px。収まっていれば可視幅以下。
    expect(scrollWidth(c)).toBeLessThanOrEqual(VIEW_W);
    // ガターを除いた領域をほぼ使い切っている（極端に縮み過ぎていない）。
    expect(scrollWidth(c)).toBeGreaterThan(VIEW_W * 0.8);
  });

  it('「全体を表示」ボタンがある（± の隣・data-testid=timeline-zoom-fit）', () => {
    const c = setup();
    const fit = c.querySelector<HTMLElement>('[data-testid="timeline-zoom-fit"]');
    expect(fit).not.toBeNull();
    expect(fit?.getAttribute('aria-label')).toBe('全体を表示');
    expect(c.querySelector('[data-testid="timeline-zoom-in"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="timeline-zoom-out"]')).not.toBeNull();
  });

  it('ズームインしたあと「全体を表示」で全体へ戻せる', () => {
    const c = setup();
    const fitted = scrollWidth(c);
    fireEvent.click(c.querySelector('[data-testid="timeline-zoom-in"]') as HTMLElement);
    expect(scrollWidth(c)).toBeGreaterThan(fitted);
    fireEvent.click(c.querySelector('[data-testid="timeline-zoom-fit"]') as HTMLElement);
    expect(scrollWidth(c)).toBeCloseTo(fitted, 5);
    expect(scrollWidth(c)).toBeLessThanOrEqual(VIEW_W);
  });

  it('全体表示の幅はガターを含めて可視幅以内（見出しの裏に押し出さない）', () => {
    const c = setup();
    expect(scrollWidth(c)).toBeGreaterThanOrEqual(TRACK_LABEL_GUTTER_PX);
  });
});

describe('完成後の全体帯', () => {
  it('素材確認中も完成尺を表示し、クリックをカット・並び替え・速度前の原本座標へ戻す', () => {
    const project = makeProject({
      cutRegions: [{ start: 1000, end: 3800 }, { start: 9000, end: 10000 }],
      cutOrder: [
        { originalStart: 10000, originalEnd: DURATION_FRAMES },
        { originalStart: 0, originalEnd: 1000 },
        { originalStart: 3800, originalEnd: 9000 },
      ],
      mainSpeed: 1,
      segmentSpeeds: { 1: 2, 2: 0.5 },
    });
    const finalModel = buildPlaybackModel(project);
    const player = makeFakePlayer();
    const c = render(
      <Harness project={project} view="overview" cutsBypassed player={player} />,
    ).container;
    const expectedSeconds = Math.round(finalModel.durationInFrames / FPS);
    const expectedClock = `${Math.floor(expectedSeconds / 60)}:${String(expectedSeconds % 60).padStart(2, '0')}`;
    expect(c.querySelector('.tl-overview-end')?.textContent).toBe(`完成 ${expectedClock}`);

    const track = c.querySelector('[data-testid="timeline-overview"] .tl-overview-track') as HTMLButtonElement;
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 24, width: 1000, height: 24,
      toJSON: () => ({}),
    });
    fireEvent.click(track, { clientX: 500, detail: 1 });

    const overviewFrame = Math.round(finalModel.durationInFrames * 0.5);
    const expectedPreviewFrame = overviewFrameToPreviewFrame(overviewFrame, {
      originalTotalFrames: DURATION_FRAMES,
      cutRegions: project.cutRegions,
      ordering: cutOrderingOf(project),
      finalModel,
    });
    expect(player.seekTo).toHaveBeenCalledWith(expectedPreviewFrame);
    expect(expectedPreviewFrame).not.toBe(overviewFrame);
  });
});

describe('カット区間のホバー（ベースライン §カット区間ホバー）', () => {
  it('赤い斜線の帯に説明が付く（何が起きたか・どう戻すか）', () => {
    const c = setup();
    const cut = c.querySelector<HTMLElement>('.tl-cut');
    expect(cut).not.toBeNull();
    // cutRegions: [1000, 3800) / 30fps → 0:33〜2:07
    expect(cut?.title).toBe('カット済み 0:33〜2:07（クリックで選択 → Delete で元に戻す）');
    expect(cut?.getAttribute('aria-label')).toBe(cut?.title);
  });

  it('クリックでその区間が範囲選択になる（Delete で開けられる状態）', () => {
    const c = setup();
    const cut = c.querySelector<HTMLElement>('.tl-cut') as HTMLElement;
    fireEvent.pointerDown(cut, { clientX: 100, clientY: 0, button: 0 });
    fireEvent.click(cut, { clientX: 100, clientY: 0, button: 0 });
    // 選択帯が出て、カットボタンが「開ける」表示へ変わる。
    expect(c.querySelector('.tl-cut-selection')).not.toBeNull();
    expect(c.querySelector('[data-testid="timeline-cut"]')?.textContent).toBe('カットを開ける');
  });
});

describe('空トラックの畳み込み（ベースライン §トラック画面外）', () => {
  it('中身が無いトラックには tl-track-empty が付く', () => {
    const c = setup();
    // 字幕 1 件のみの案件。じまく以外（テロップ・画像・サブ動画・BGM・効果音・図形）は空。
    expect(c.querySelector('.tl-track-jimaku')?.className).not.toContain('tl-track-empty');
    for (const cls of [
      '.tl-track-telop',
      '.tl-track-image',
      '.tl-track-vi',
      '.tl-track-bgm',
      '.tl-track-se',
      '.tl-track-shape',
    ]) {
      expect(c.querySelector(cls)?.className, cls).toContain('tl-track-empty');
    }
  });

  it('中身が入ると通常高さへ戻る（効果音を 1 件持つ案件）', () => {
    const c = setup(
      makeProject({ se: [{ id: 1, originalStart: 200, originalEnd: 290, file: 'pop.mp3' }] }),
    );
    expect(c.querySelector('.tl-track-se')?.className).not.toContain('tl-track-empty');
  });

  it('空でも見出しは残る（何のレーンかが分かる）', () => {
    const c = setup();
    expect(c.querySelector('.tl-track-image .tl-track-name')?.textContent).toBe('画像');
  });
});

describe('ドラッグツールチップの縦位置（監査 interaction-9）', () => {
  /** jsdom は offsetTop を常に 0 で返すので、トラック種別ごとの上端を差し込む。 */
  function stubOffsetTop(): () => void {
    const tops: [string, number][] = [
      ['tl-track-cut', 0],
      ['tl-track-jimaku', 58],
      ['tl-track-telop', 94],
    ];
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        for (const [cls, top] of tops) if (this.classList.contains(cls)) return top;
        return 0;
      },
    });
    return () => {
      Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
        configurable: true,
        get: () => 0,
      });
    };
  }

  it('掴んだトラックの上端に出る（最下段に固定されない）', () => {
    const restore = stubOffsetTop();
    try {
      const c = setup();
      const handle = c.querySelector('.tl-track-jimaku .tl-handle.start') as HTMLElement;
      expect(handle).not.toBeNull();
      fireEvent.pointerDown(handle, { clientX: 100, clientY: 10, button: 0 });
      fireEvent.pointerMove(window, { clientX: 160, clientY: 10 });
      const tip = c.querySelector('.tl-tooltip') as HTMLElement;
      expect(tip).not.toBeNull();
      expect(tip.style.top).toBe('58px');
      fireEvent.pointerUp(window, { clientX: 160, clientY: 10 });
    } finally {
      restore();
    }
  });
});

describe('クリップのキーボード到達性（監査 interaction-10）', () => {
  it('じまくクリップに tabIndex / role / aria-label が付く', () => {
    const c = setup();
    const clip = c.querySelector<HTMLElement>('.tl-track-jimaku .tl-telop');
    expect(clip).not.toBeNull();
    expect(clip?.getAttribute('tabindex')).toBe('0');
    expect(clip?.getAttribute('role')).toBe('button');
    // 100..400 / 30fps → 0:03〜0:13
    expect(clip?.getAttribute('aria-label')).toBe('じまく 0:03〜0:13 じまくA');
  });

  it('data-testid でクリップを名前で指名できる', () => {
    const c = setup();
    expect(c.querySelector('[data-testid="clip-telop-1"]')).not.toBeNull();
  });

  it('Enter でそのクリップが選択され、←/→ の対象つまみが立つ', () => {
    const c = setup();
    const clip = c.querySelector<HTMLElement>('[data-testid="clip-telop-1"]') as HTMLElement;
    expect(clip.className).not.toContain('selected');
    fireEvent.keyDown(clip, { key: 'Enter' });
    const after = c.querySelector<HTMLElement>('[data-testid="clip-telop-1"]');
    expect(after?.className).toContain('selected');
    // つまみ選択（selectedHandle）が立つと本体つまみに selected が付く。
    expect(c.querySelector('.tl-handle.selected')).toBeNull(); // body なので端つまみは光らない
  });

  it('Space でも選択できる（ページスクロールへ流さない）', () => {
    const c = setup();
    const clip = c.querySelector<HTMLElement>('[data-testid="clip-telop-1"]') as HTMLElement;
    // fireEvent は preventDefault されると false を返す（Space をページスクロールへ流さない）。
    expect(fireEvent.keyDown(clip, { key: ' ' })).toBe(false);
    expect(c.querySelector<HTMLElement>('[data-testid="clip-telop-1"]')?.className).toContain(
      'selected',
    );
  });

  it('他のトラックのクリップにも同じ到達性がある（効果音）', () => {
    const c = setup(
      makeProject({ se: [{ id: 7, originalStart: 200, originalEnd: 290, file: 'pop.mp3' }] }),
    );
    const clip = c.querySelector<HTMLElement>('[data-testid="clip-se-7"]');
    expect(clip?.getAttribute('tabindex')).toBe('0');
    expect(clip?.getAttribute('role')).toBe('button');
    expect(clip?.getAttribute('aria-label')).toBe('効果音 0:07〜0:10 pop.mp3');
  });
});
