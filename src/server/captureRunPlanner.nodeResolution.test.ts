/**
 * M2c T2・設計点(a) の存在検査（vi.mock('remotion', ...) を使わない）。
 *
 * captureRunPlanner.test.ts は `vi.mock('remotion', ...)` を使うが、それはテロップパック
 * （telopPack/Telop.tsx）等が**直接** 'remotion' を import しているのを Node で解決するため
 * であって、captureRunPlanner.ts 自身（layers.tsx → runtimeFace.ts 経由の
 * CaptureFrameProvider/AbsoluteFill/Sequence/useCurrentFrame/useVideoConfig）が動くために
 * vi.mock が要るわけではない——というのが設計点(a)の主張（runtimeFace.ts を相対 import に
 * 変えたので Node でもそのまま captureRuntime に解決される）。
 *
 * vi.mock はファイル全体（モジュール解決グラフ全体）に効くため、同じファイル内では
 * 「vi.mock が無くても動く」ことを証明できない。本ファイルは vi.mock を一切使わず、
 * 'remotion' を一切 import しない自前の最小 Telop/InsertImage コンポーネントで
 * planCaptureRuns を通し、layers.tsx 自身の Node 解決が設計点(a)だけで足りていることを pin する。
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { planCaptureRuns } from './captureRunPlanner';

// 'remotion' を一切 import しない（= real remotion にも captureRuntime にも依存しない）
// 最小テロップ部品。renderCaptureLayer/CaptureTelopLayer 側の AbsoluteFill・useCurrentFrame
// （runtimeFace 経由）だけが動けば、この部品自体は素の React で足りる。
const PlainTelop: React.ComponentType<{ segment: unknown }> = ({ segment }) =>
  React.createElement('span', null, (segment as { text: string }).text);

const VIDEO_CONFIG = { width: 100, height: 100, fps: 30, durationInFrames: 100 };

describe('captureRunPlanner — vi.mock なしでも Node で正しく解決する（設計点(a)の存在検査）', () => {
  it('telop レイヤ（アクティブなセグメントあり）を vi.mock なしで分類できる', () => {
    const telops = [{ id: 1, startFrame: 0, endFrame: 10, text: 'hello' }];
    const plan = planCaptureRuns({
      layer: 'telop',
      data: { telops },
      videoConfig: VIDEO_CONFIG,
      spans: [{ start: 0, end: 10 }],
      loaded: { Telop: PlainTelop, InsertImage: null },
    });
    // PlainTelop は frame に依存しないので窓全体が1 run。
    expect(plan.runs).toEqual([{ representativeFrame: 0, startFrame: 0, endFrame: 10 }]);
    expect(plan.totalFrames).toBe(10);
  });

  it('アクティブなセグメントが無い区間は空描画として1 runにまとまる', () => {
    const plan = planCaptureRuns({
      layer: 'telop',
      data: { telops: [] },
      videoConfig: VIDEO_CONFIG,
      spans: [{ start: 0, end: 5 }],
      loaded: { Telop: PlainTelop, InsertImage: null },
    });
    expect(plan.runs).toEqual([{ representativeFrame: 0, startFrame: 0, endFrame: 5 }]);
    expect(plan.distinctFrames).toBe(1);
  });

  // M2c T3: CaptureTitleLayer は preview/TitleLayer.tsx（real remotion 直接 import）を
  // import しない capturePage 側の独立実装なので、title レイヤも vi.mock なしで Node 解決する
  // （T2 時点は layer:'title' を明示 throw していた制約の解消そのものの存在検査）。
  it('title レイヤを vi.mock なしで分類できる（preview/TitleLayer.tsx への依存が無いことの証拠）', () => {
    const titles = [{ id: 1, startFrame: 0, endFrame: 20, text: 'たいとる' }];
    const plan = planCaptureRuns({
      layer: 'title',
      data: { titles },
      videoConfig: VIDEO_CONFIG,
      spans: [{ start: 0, end: 20 }],
    });
    expect(plan.totalFrames).toBe(20);
    expect(plan.runs.length).toBeGreaterThan(0);
  });

  it('telop-title 統合レイヤを vi.mock なしで分類できる', () => {
    const telops = [{ id: 1, startFrame: 0, endFrame: 20, text: 'hello' }];
    // タイトルの opacity は [0, 8, duration-8, duration] を入力域にするため、
    // duration-8 > 8（= duration > 16）が必要（#194: 恒等 fixture 禁止・境界を素通ししない）。
    const titles = [{ id: 2, startFrame: 0, endFrame: 20, text: 'たいとる' }];
    const plan = planCaptureRuns({
      layer: 'telop-title',
      data: { telops, titles },
      videoConfig: VIDEO_CONFIG,
      spans: [{ start: 0, end: 20 }],
      loaded: { Telop: PlainTelop, InsertImage: null },
    });
    expect(plan.totalFrames).toBe(20);
    expect(plan.runs.length).toBeGreaterThan(0);
  });
});
