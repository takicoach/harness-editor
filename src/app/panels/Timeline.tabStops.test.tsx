/**
 * @vitest-environment jsdom
 *
 * タイムライン全体のタブ停止数のガード（サイクル 4 レビュー Important）。
 *
 * 旧実装は 6 トラック全部が全クリップに `tabIndex={0}`、つなぎ目マークは素の `<button>`。
 * 案件 2026-09-04-C0123 ではクリップ 120 個超＋マーク約 45 個＝160 超のタブ停止が並び、
 * キーボード利用者と AI エージェントはタイムラインを前方へ抜けるのに 100 回超の Tab を要した。
 * ここでは「クリップを大量に置いても `.tl-scroll` 内のタブ停止はトラック数程度に収まる」ことを見る。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { EditorPlaybackRef as PlayerRef } from '../preview/editorPlayback';
import type { EditorProject, EditorTelop, EditorImage, EditorSe } from '../../core/types';
import { useEditSession } from '../useEditSession';
import { Timeline } from './Timeline';

vi.mock('./TelopStyleGrid', () => ({ TelopStyleGrid: () => null }));

const FPS = 30;
const DURATION_FRAMES = 27_000; // 15 分ぶん（実案件と同じくらいの尺）

function makeProject(): EditorProject {
  const telops: EditorTelop[] = Array.from({ length: 82 }, (_, i) => ({
    id: i + 1,
    originalStart: i * 300,
    originalEnd: i * 300 + 200,
    text: `じまく${i + 1}`,
    template: 1,
  }));
  const manual: EditorTelop[] = Array.from({ length: 8 }, (_, i) => ({
    id: 200 + i,
    originalStart: i * 3000,
    originalEnd: i * 3000 + 400,
    text: `テロップ${i + 1}`,
    template: 5,
    manual: true,
  }));
  const images: EditorImage[] = Array.from({ length: 15 }, (_, i) => ({
    id: i + 1,
    originalStart: i * 1500,
    originalEnd: i * 1500 + 300,
    file: `img${i + 1}.png`,
    type: 'photo',
  }));
  const se: EditorSe[] = Array.from({ length: 14 }, (_, i) => ({
    id: i + 1,
    originalStart: i * 1700,
    originalEnd: i * 1700 + 90,
    file: `se${i + 1}.mp3`,
  }));
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
    telops: [...telops, ...manual],
    cutRegions: [],
    se,
    images,
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

function Harness({ project }: { project: EditorProject }) {
  const session = useEditSession('p1', project, null);
  const playerRef = useRef<PlayerRef | null>({
    addEventListener() {},
    removeEventListener() {},
    seekTo() {},
    getCurrentFrame: () => 0,
    play() {},
    pause() {},
    isPlaying: () => false,
  } as unknown as PlayerRef);
  const [playbackRate, setPlaybackRate] = useState(1);
  if (session === null) return null;
  return (
    <Timeline
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
      cutsBypassed={false}
      onToggleCutsBypassed={() => {}}
      playbackRate={playbackRate}
      onPlaybackRateChange={setPlaybackRate}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe('.tl-scroll のタブ停止数', () => {
  it('クリップ 119 個でもタブ停止は 1 桁に収まる', () => {
    const { container } = render(<Harness project={makeProject()} />);
    const scroll = container.querySelector('.tl-scroll') as HTMLElement;
    expect(scroll, '.tl-scroll が描かれていること（空の画面で緑にしない）').not.toBeNull();
    // 存在検査: クリップは実際に大量に描かれている（数えている対象がそこに在る）。
    const clips = scroll.querySelectorAll('[data-clip-nav]');
    expect(clips.length).toBeGreaterThan(100);

    // Tab で止まる要素＝tabindex="0" と、tabindex を持たない（＝既定 0 の）ボタン。
    const stops = Array.from(
      scroll.querySelectorAll<HTMLElement>('[tabindex="0"], button:not([tabindex])'),
    );
    expect(stops.length, `タブ停止が多すぎる: ${stops.length}`).toBeLessThan(10);
  });

  it('各トラックのタブ停止は 1 個ずつ（ロービング）', () => {
    const { container } = render(<Harness project={makeProject()} />);
    for (const track of Array.from(container.querySelectorAll('.tl-track'))) {
      const clips = track.querySelectorAll('[data-clip-nav]');
      if (clips.length === 0) continue;
      expect(track.querySelectorAll('[data-clip-nav][tabindex="0"]')).toHaveLength(1);
    }
    // つなぎ目マーク層も 1 個（マークは <button> なので素だと全部が停止になる）。
    const marks = container.querySelectorAll('.tl-join-markers [data-clip-nav]');
    if (marks.length > 0) {
      expect(container.querySelectorAll('.tl-join-markers [tabindex="0"]')).toHaveLength(1);
    }
  });
});
