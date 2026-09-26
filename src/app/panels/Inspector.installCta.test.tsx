/**
 * @vitest-environment jsdom
 *
 * B-3 (R-5): 「サブ動画機能を導入」CTA の発見性と state 分離の回帰テスト。
 *
 * 受け入れ基準:
 * 1. テロップを選択していなくても導入 CTA に到達できる
 *    （従来はテロップ設定タブ内にしか無く、テロップ非選択時は表示不能だった）。
 * 2. 片方の導入が失敗しても、もう片方の CTA にエラーが出ない（kind 別 state 分離）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import { useRef } from 'react';
import type { EditorPlaybackRef as PlayerRef } from '../preview/editorPlayback';
import type { EditorProject } from '../../core/types';
import { createEditState } from '../edit/editState';
import { Inspector } from './Inspector';
import type { InstallErrors } from '../install';

function makeProject(over: Partial<EditorProject> = {}): EditorProject {
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
    telops: [{ id: 1, originalStart: 0, originalEnd: 90, text: 'じまく', template: 1 }],
    cutRegions: [],
    se: [],
    images: [],
    videoInserts: [],
    bgm: [{ id: 1, originalStart: 0, originalEnd: 90, file: 'bgm.mp3', volume: 1, fadeInFrames: 0, fadeOutFrames: 0 }],
    shapes: [],
    telopDataSource: 'export const telopData = [];\n',
    cutDataSource: null,
    seDataSource: null,
    insertImageDataSource: null,
    titles: [],
    titleDataSource: null,
    shapeDataSource: null,
    mainSpeed: 1,
    segmentSpeeds: {},
    ...over,
  };
}

function renderInspector(opts: {
  selection?: ReturnType<typeof createEditState>['selection'];
  installErrors?: InstallErrors;
  videoInsertInstalled?: boolean;
  bgmInstalled?: boolean;
}) {
  const project = makeProject();
  const state = createEditState(project);
  state.selection = opts.selection ?? null;

  function Harness() {
    const playerRef = useRef<PlayerRef | null>(null);
    return (
      <Inspector
        state={state}
        fps={30}
        seLibrary={[]}
        imageLibrary={[]}
        videoLibrary={[]}
        projectId="p1"
        telopPackInstalled={true}
        videoInsertInstalled={opts.videoInsertInstalled ?? false}
        bgmInstalled={opts.bgmInstalled ?? true}
        installing={null}
        installErrors={opts.installErrors ?? {}}
        dirty={false}
        componentRevision={null}
        previewWidth={1080}
        previewHeight={1920}
        onInstall={() => {}}
        onLive={() => {}}
        onEdit={() => {}}
        playerRef={playerRef}
      />
    );
  }
  return render(<Harness />);
}

afterEach(cleanup);

describe('サブ動画機能導入 CTA の発見性（選択非依存）', () => {
  it('何も選択していなくても「サブ動画機能を導入」に到達できる', () => {
    renderInspector({ selection: null });
    expect(screen.getByText('サブ動画機能を導入')).toBeTruthy();
  });

  it('テロップ以外（BGM）を選択していても到達できる', () => {
    renderInspector({ selection: { kind: 'bgm', id: 1 } });
    expect(screen.getByText('サブ動画機能を導入')).toBeTruthy();
  });

  it('導入済みなら CTA は出ない', () => {
    renderInspector({ selection: null, videoInsertInstalled: true });
    expect(screen.queryByText('サブ動画機能を導入')).toBeNull();
  });
});

describe('導入エラーの kind 別分離', () => {
  it('BGM の導入失敗はサブ動画 CTA に出ない', () => {
    renderInspector({
      selection: null,
      installErrors: { bgm: 'BGM機能の導入に失敗しました（テスト）' },
    });
    expect(screen.queryByText('BGM機能の導入に失敗しました（テスト）')).toBeNull();
    expect(screen.getByText('サブ動画機能を導入')).toBeTruthy();
  });

  it('サブ動画の導入失敗は BGM 設定タブの CTA に出ない', () => {
    renderInspector({
      selection: { kind: 'bgm', id: 1 },
      bgmInstalled: false,
      installErrors: { videoInsert: 'サブ動画機能の導入に失敗しました（テスト）' },
    });
    // BGM 設定タブ自体のエラー表示領域にサブ動画側のエラー文言が漏れていないこと。
    const bgmSection = screen.getByText('BGM 機能').closest('.ins-section');
    expect(bgmSection).not.toBeNull();
    expect(within(bgmSection as HTMLElement).queryByText('サブ動画機能の導入に失敗しました（テスト）')).toBeNull();
  });
});
