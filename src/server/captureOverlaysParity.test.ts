// src/server/captureOverlaysParity.test.ts
/**
 * サーバ側 hasCaptureOverlays 採用のパリティテスト（M2d T2 修正ラウンド2・M-1）。
 *
 * 同一 EditorProject fixture から
 *   (a) buildPlaybackModel（プレビュー・クライアント needsCapture の入力）
 *   (b) fastCutPlan.ts が **planFastCut 本体でも呼んでいる** projectCaptureOverlays
 * を組み、hasCaptureOverlays の結果が一致することを assert する。
 * planFastCut そのものは実行しない（ディスク I/O・Chromium 解決を伴う重い経路のため）。
 *
 * M-5: 以前はここに射影列を**手写し**していた。手写しだと本体の射影を変えてもテストは
 * 古い列のまま緑になり、パリティ検査そのものが形骸化する（比べているのは本体ではなく写し）。
 * 本体から export した同一関数を呼ぶ。
 */
import { describe, it, expect } from 'vitest';
import { hasCaptureOverlays, type CaptureOverlaySets } from '../shared/captureOverlays';
import { buildPlaybackModel } from '../preview/playbackModel';
import { buildCutOrdering } from '../core/cutOrder';
import { projectCaptureOverlays, projectVideoInsertPlayback } from './fastCutPlan';
import type { EditorProject } from '../core/types';

/** サーバ側の射影（planFastCut が同じ関数を呼ぶ・手写しをしない）。 */
function serverProjectedTimeline(project: EditorProject): CaptureOverlaySets {
  const ordering = buildCutOrdering(project.videoConfig.durationFrames, project.cutRegions, project.cutOrder);
  return projectCaptureOverlays(project, ordering);
}

function baseProject(): EditorProject {
  return {
    videoConfig: {
      format: 'short',
      fps: 30,
      durationFrames: 300,
      videoFile: 'main.mp4',
      resolution: { width: 1080, height: 1920 },
      orientation: 'portrait',
      titleStyle: { top: 60, left: 30, fontSize: 30 },
    },
    projectConfig: null,
    transcript: { durationMs: 10000, words: [], segments: [] },
    telops: [],
    cutRegions: [{ start: 100, end: 200 }],
    se: [],
    images: [],
    videoInserts: [],
    bgm: [],
    shapes: [],
    telopDataSource: '',
    cutDataSource: null,
    seDataSource: null,
    insertImageDataSource: null,
    titles: [],
    titleDataSource: null,
    mainSpeed: 1,
    segmentSpeeds: {},
  };
}

describe('hasCaptureOverlays — サーバ射影とプレビュー射影のパリティ（M-1）', () => {
  it('縮退ケース: テロップが丸ごとカット区間内 → サーバ側・クライアント側とも false', () => {
    const project = baseProject();
    project.telops = [{ id: 1, originalStart: 120, originalEnd: 180, text: 'あ' }];
    const clientResult = hasCaptureOverlays(buildPlaybackModel(project));
    const serverResult = hasCaptureOverlays(serverProjectedTimeline(project));
    expect(clientResult).toBe(false);
    expect(serverResult).toBe(false);
    expect(serverResult).toBe(clientResult);
  });

  it('通常ケース: カット区間の外にテロップが残る → サーバ側・クライアント側とも true', () => {
    const project = baseProject();
    project.telops = [{ id: 1, originalStart: 10, originalEnd: 50, text: 'あ' }];
    const clientResult = hasCaptureOverlays(buildPlaybackModel(project));
    const serverResult = hasCaptureOverlays(serverProjectedTimeline(project));
    expect(clientResult).toBe(true);
    expect(serverResult).toBe(true);
    expect(serverResult).toBe(clientResult);
  });
});

/**
 * **I-3（中間レビュー）: サブ動画（videoInserts）の射影パリティ。**
 *
 * 書き出し（`fastCutPlan.projectVideoInsertPlayback`）とプレビュー（`preview/playbackModel.ts`）は
 * **別々に同じ列を書いている**（`clampVideoInserts` → `projectVideoInserts` → `reorderStartEnd` →
 * 既定解決）。ここが食い違うと「プレビューと違う座標・別の絵で書き出される」——しかも
 * どちらも単体では正しく見えるので気づけない。
 *
 * どちらも**本体を import して呼ぶ**（列を手写ししない・M-5 と同じ規律）。
 * 転換を持たない fixture では `collapseVideoInserts` が恒等なので、プレビューの
 * `model.videoInserts` と書き出しの射影は**そのまま突き合わせられる**。
 */
describe('videoInserts — サーバ射影とプレビュー射影のパリティ（I-3）', () => {
  const ordering = (project: EditorProject): ReturnType<typeof buildCutOrdering> =>
    buildCutOrdering(project.videoConfig.durationFrames, project.cutRegions, project.cutOrder);

  it('カット区間をまたぐ・端が飲まれる列で、両者の再生座標が完全一致する（比較件数 > 0）', () => {
    const project = baseProject();
    project.videoInserts = [
      // (a) カット [100,200) の手前 → そのまま
      { id: 1, originalStart: 10, originalEnd: 60, file: 'a.mp4', sourceInFrame: 0 },
      // (b) 開始がカット区間の中に落ちる → clamp で区間の外へ寄る
      { id: 2, originalStart: 150, originalEnd: 260, file: 'b.mp4', sourceInFrame: 4, playbackRate: 0.7 },
      // (c) カット区間より後ろ → 100 フレーム前へ詰まる
      { id: 3, originalStart: 220, originalEnd: 280, file: 'c.mp4', sourceInFrame: 9, scale: 0.5, position: { x: 0.4, y: -0.25 } },
    ];
    const client = buildPlaybackModel(project).videoInserts;
    const server = projectVideoInsertPlayback(project, ordering(project));
    // 恒等・ゼロ件の vacuous PASS 封じ: 3 件が残り、かつ原本座標と**違う**再生座標になっている。
    expect(server).toHaveLength(3);
    expect(client).toHaveLength(3);
    expect(server.map((v) => v.playbackStart)).not.toEqual([10, 150, 220]);
    expect(server).toEqual(client);
  });

  it('既知の差異（縮退）: サーバは 0 長を列から落とし、プレビューは 0 長のまま残す＝どちらも描かれない', () => {
    const project = baseProject();
    project.videoInserts = [
      { id: 1, originalStart: 120, originalEnd: 180, file: 'dead.mp4', sourceInFrame: 0 }, // カット [100,200) に丸ごと飲まれる
      { id: 2, originalStart: 10, originalEnd: 60, file: 'alive.mp4', sourceInFrame: 0 },
    ];
    const client = buildPlaybackModel(project).videoInserts;
    const server = projectVideoInsertPlayback(project, ordering(project));
    // 書き出し側は縮退を除外する（`filter(playbackEnd > playbackStart)`）。
    expect(server.map((v) => v.id)).toEqual([2]);
    // プレビュー側は列に残すが**尺 0**（= 1 フレームも描かれない）。
    const dead = client.find((v) => v.id === 1)!;
    expect(dead.playbackEnd - dead.playbackStart).toBe(0);
    // 生きている側は完全一致（差異は縮退の扱いだけ）。
    expect(server).toEqual(client.filter((v) => v.playbackEnd > v.playbackStart));
  });
});
