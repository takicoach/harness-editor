/**
 * @vitest-environment jsdom
 *
 * status-ia-8 の穴（サイクル 3 Important）:
 * テロップの端がカット区間へ落ちると originalToPlayback が null を返し、
 * 見出しの時計に「原本フレームの開始」と「再生フレームの終了」が混ざって出ていた。
 * 基準の断りなく座標系の違う 2 値を並べない、を SettingsTab 全体で確かめる。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import type { EditorProject, EditorTelop } from '../../../core/types';
import { createEditState } from '../../edit/editState';
import { SettingsTab } from './SettingsTab';

// スタイル選択グリッドは案件部品を読み込み描画する。
// 本テストの対象（見出しの時計）とは無関係なので差し替える。
vi.mock('../TelopStyleGrid', () => ({ TelopStyleGrid: () => null }));

afterEach(cleanup);

const FPS = 30;
/** 原本 1:33 〜 1:40 のテロップ。 */
const TELOP: EditorTelop = { id: 1, originalStart: 2790, originalEnd: 3000, text: 'テスト', template: 1 };

function makeProject(cutRegions: { start: number; end: number }[]): EditorProject {
  return {
    videoConfig: {
      format: 'short',
      fps: FPS,
      durationFrames: 6000,
      videoFile: 'main.mp4',
      resolution: { width: 1080, height: 1920 },
      orientation: 'portrait',
      titleStyle: { top: 100, left: 60, fontSize: 60 },
    },
    projectConfig: null,
    transcript: { durationMs: 200000, words: [], segments: [] },
    telops: [TELOP],
    cutRegions,
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
  };
}

function renderTab(cutRegions: { start: number; end: number }[]): string {
  const state = createEditState(makeProject(cutRegions));
  render(
    <SettingsTab
      projectId="test"
      telop={state.telops[0]!}
      state={state}
      fps={FPS}
      telopPackInstalled={false}
      bgmInstalled={false}
      installing={null}
      installErrors={{}}
      dirty={false}
      componentRevision={null}
      previewWidth={1080}
      previewHeight={1920}
      onInstall={() => {}}
      onEdit={() => {}}
    />,
  );
  return screen.getByTestId('telop-clock').textContent ?? '';
}

describe('見出しの時計とカット区間（status-ia-8 / サイクル 3）', () => {
  it('開始だけがカット区間に落ちたら、再生基準の時刻を出さず理由を書く', () => {
    // 2700〜2800 をカット: 開始 2790 は区間内（射影できない）・終了 3000 は区間外。
    const text = renderTab([{ start: 2700, end: 2800 }]);
    expect(text).toContain('カット前: 1:33 〜 1:40');
    expect(text).toContain('カット区間にかかっているため再生上の時刻は確定できません');
    // 原本の開始と再生の終了が混ざった範囲（例 1:33 〜 1:36）を主表示にしない。
    expect(text).not.toContain('1:36');
  });

  it('両端ともカット区間に落ちたら、原本時刻を無表示で再生時刻として出さない', () => {
    const text = renderTab([{ start: 2700, end: 3100 }]);
    expect(text).toContain('カット前: 1:33 〜 1:40');
    expect(text).toContain('カット区間にかかっているため再生上の時刻は確定できません');
  });

  it('カットが無ければ従来どおり再生基準だけを出す', () => {
    const text = renderTab([]);
    expect(text).toContain('1:33 〜 1:40');
    expect(text).not.toContain('カット前');
    expect(text).not.toContain('確定できません');
  });
});
