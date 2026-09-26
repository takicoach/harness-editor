/**
 * @vitest-environment jsdom
 *
 * R-1 レビュー差し戻し対応: 音声トラックの無いサブ動画（本リポジトリの標準フィクスチャ
 * cam2.mp4 相当）でも、ソース長超過時に Inspector へ警告が実際に描画されることを固定する。
 * 差し戻し前は useSourceDurationFrames が音声デコード専用で、この典型ケースでは常に null
 * を返し、overflowSec の分岐（警告 <p>）が到達不能だった。
 *
 * useSourceDurationFrames はフック単体で ./audio/useSourceDurationFrames.test.tsx により
 * フォールバック経路が検証済みなので、ここでは「hook が返した値が UI 描画に反映される」
 * 到達性だけを、hook をモックして分離検証する。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { EditorProject, EditorVideoInsert } from '../../../core/types';
import { createEditState } from '../../edit/editState';
import { VideoInsertSettingsTab } from './VideoInsertSettingsTab';

vi.mock('../../audio/useSourceDurationFrames', () => ({
  useSourceDurationFrames: vi.fn(),
}));
// 波形描画は本テストの対象外（音声取得の非同期を持ち込まない）。
vi.mock('../VideoSyncWaveform', () => ({
  VideoSyncWaveform: () => null,
}));

import { useSourceDurationFrames } from '../../audio/useSourceDurationFrames';

function makeProject(videoInsert: EditorVideoInsert): EditorProject {
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
    telops: [],
    cutRegions: [],
    se: [],
    images: [],
    videoInserts: [videoInsert],
    bgm: [],
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
  };
}

afterEach(() => {
  cleanup();
  vi.mocked(useSourceDurationFrames).mockReset();
});

describe('VideoInsertSettingsTab のソース長超過警告（video-only ソース想定）', () => {
  it('音声を持たないサブ動画でも、hook がソース長を返せば超過警告が実際に描画される', () => {
    // cam2.mp4 のような video-only ソース: フォールバック（video メタデータ）で 90 フレームと分かった想定。
    vi.mocked(useSourceDurationFrames).mockReturnValue(90);
    const videoInsert: EditorVideoInsert = {
      id: 1,
      originalStart: 0,
      originalEnd: 300, // 表示長 300f、rate=1 → 消費 300f
      file: 'cam2.mp4',
      sourceInFrame: 0, // 0 + 300 = 300 > 90 → 210f 超過
    };
    const project = makeProject(videoInsert);
    const state = createEditState(project);

    render(
      <VideoInsertSettingsTab
        videoInsert={videoInsert}
        state={state}
        fps={30}
        videoLibrary={['cam2.mp4']}
        projectId="sample-project"
        onLive={() => {}}
        onEdit={() => {}}
      />,
    );

    expect(screen.getByText(/ソースの実長を約.+秒超えています/)).toBeTruthy();
  });

  /**
   * X-2(a): イン点がソース終端より後だと、末尾を詰めても再生できるフレームが1枚も残らない。
   * 従来の文言「保存時に終了位置が自動調整されます」はこの場合**嘘**で（クランプでは直せない）、
   * 利用者は放置してよいと誤解する。再生不能であることと取るべき行動を出す。
   */
  it('再生可能フレームが残っていない場合は「自動調整されます」ではなく再生不能を伝える', () => {
    vi.mocked(useSourceDurationFrames).mockReturnValue(90);
    const videoInsert: EditorVideoInsert = {
      id: 1,
      originalStart: 0,
      originalEnd: 300,
      file: 'cam2.mp4',
      sourceInFrame: 120, // ソース長 90f の終端より後 → 再生できるフレームがゼロ
    };
    const project = makeProject(videoInsert);
    const state = createEditState(project);

    render(
      <VideoInsertSettingsTab
        videoInsert={videoInsert}
        state={state}
        fps={30}
        videoLibrary={['cam2.mp4']}
        projectId="sample-project"
        onLive={() => {}}
        onEdit={() => {}}
      />,
    );

    expect(screen.getByText(/再生できる範囲が残っていません/)).toBeTruthy();
    // クランプで直るという誤った案内を出さない。
    expect(screen.queryByText(/保存時に終了位置が自動調整されます/)).toBeNull();
  });

  it('超過していなければ警告は出ない', () => {
    vi.mocked(useSourceDurationFrames).mockReturnValue(600); // 十分に長い
    const videoInsert: EditorVideoInsert = {
      id: 1,
      originalStart: 0,
      originalEnd: 300,
      file: 'cam2.mp4',
      sourceInFrame: 0,
    };
    const project = makeProject(videoInsert);
    const state = createEditState(project);

    render(
      <VideoInsertSettingsTab
        videoInsert={videoInsert}
        state={state}
        fps={30}
        videoLibrary={['cam2.mp4']}
        projectId="sample-project"
        onLive={() => {}}
        onEdit={() => {}}
      />,
    );

    expect(screen.queryByText(/ソースの実長を約.+秒超えています/)).toBeNull();
  });

  it('hook が null（長さ不明）を返す間は警告を出さない（安全側・既存仕様）', () => {
    vi.mocked(useSourceDurationFrames).mockReturnValue(null);
    const videoInsert: EditorVideoInsert = {
      id: 1,
      originalStart: 0,
      originalEnd: 300,
      file: 'cam2.mp4',
      sourceInFrame: 0,
    };
    const project = makeProject(videoInsert);
    const state = createEditState(project);

    render(
      <VideoInsertSettingsTab
        videoInsert={videoInsert}
        state={state}
        fps={30}
        videoLibrary={['cam2.mp4']}
        projectId="sample-project"
        onLive={() => {}}
        onEdit={() => {}}
      />,
    );

    expect(screen.queryByText(/ソースの実長を約.+秒超えています/)).toBeNull();
  });
});
