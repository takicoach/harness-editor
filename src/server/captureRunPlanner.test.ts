/**
 * captureRunPlanner のテスト（M2c T2）。#194 準拠（恒等 fixture 禁止・境界フレーム番号は
 * 手計算 pin）。旧 InsertImage 原文は現用 loadOverlayComponentsForPlanner の監査・
 * バンドル・独自runtimeによる解決を経て読み込む。旧案件の import 指定子は保全し、
 * 製品と同じAPI面で従来の境界・性能期待を検査する。Telopは現用の配布部品を使う。
 */
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadOverlayComponentsForPlanner } from './loadOverlayComponents';



/**
 * **タイムアウトは明示する**（M3 B-5・T5 レビュー I-4）。
 * 3,000fr 級のスループット回帰（上限 10 秒の時間予算）は有料素材を使うので
 * `.product.test.ts` へ分けた。ここでも同じ上限を保つ。元の理由:
 * 既定の 5 秒タイムアウトでは**予算を測り切る前にテストが落ちる**。
 * さらに他ファイルの負荷で実測が予算を超えることがあった（T5 の `test:gate` 1 回目で
 * 10,145ms を実測）ので、重い e2e は既定の実行から分離した（`vitest.config.ts`）。
 * ここは「何秒までなら正常か」を数値で置くだけ——予算そのもの（10 秒）は緩めていない。
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const { planCaptureRuns, signatureAt, quantizePxLiterals, PX_QUANTUM } = await import('./captureRunPlanner');
const { Telop } = (await import('./telopPack/Telop')) as {
  Telop: React.ComponentType<{ segment: unknown }>;
};
const fixtureImage = await loadOverlayComponentsForPlanner(
  resolve(import.meta.dirname, '__fixtures__', 'sample-project'),
  { telop: false, image: true },
);
if (!fixtureImage.ok) throw new Error(fixtureImage.message);
const { InsertImage } = fixtureImage.components;

const VIDEO_CONFIG = { width: 1080, height: 1920, fps: 60, durationInFrames: 4000 };
const LOADED_TELOP = { Telop, InsertImage: null };
const LOADED_IMAGE = { Telop: null, InsertImage };

describe('planCaptureRuns — 境界フレーム番号の手計算 pin（フェード窓あり・image）', () => {
  it('enter/exit フェード窓（各8fr）＋中盤1本の構造になる', () => {
    // sample-project の InsertImage fixture は enter/exit 未指定時に既定 FADE(8fr) を使う
    // （src/server/__fixtures__/sample-project/src/InsertImage/InsertImage.tsx の animStyleAt）。
    // motion 未指定なので中盤（enter/exit 適用外）は opacity=1・transform='' で完全に定常。
    // duration=40 のとき: enter は local frame < 8（0..7 の8フレーム、t=frame/8 で単調増加）、
    // exit は local frame > duration-8=32（33..39 の7フレーム、t=(40-frame)/8 で単調減少）、
    // 中盤は 8..32（25フレーム）が定数。span をセグメントと同じ絶対区間 [100,140) に置く。
    const images = [{ id: 1, startFrame: 100, endFrame: 140, file: 'x.png', imageUrl: 'data:x', type: 'photo' }];
    const plan = planCaptureRuns({
      layer: 'image',
      data: { images },
      videoConfig: VIDEO_CONFIG,
      spans: [{ start: 100, end: 140 }],
      loaded: LOADED_IMAGE,
    });

    const expectedBoundaries = [100, 101, 102, 103, 104, 105, 106, 107, 108, 133, 134, 135, 136, 137, 138, 139, 140];
    const expectedRuns = expectedBoundaries.slice(0, -1).map((start, i) => ({
      representativeFrame: start,
      startFrame: start,
      endFrame: expectedBoundaries[i + 1]!,
    }));
    expect(plan.runs).toEqual(expectedRuns);
    expect(plan.runs.length).toBe(16); // 8 (enter) + 1 (中盤) + 7 (exit)
    expect(plan.totalFrames).toBe(40);
  });
});

describe('planCaptureRuns — Ken Burns（画像 motion）も全フレーム distinct（必須受入②: images カバレッジ）', () => {
  it('zoomIn 全長補間は 40fr 窓の全フレームが distinct', () => {
    const images = [
      {
        id: 1,
        startFrame: 0,
        endFrame: 40,
        file: 'x.png',
        imageUrl: 'data:x',
        type: 'photo',
        motion: { preset: 'zoomIn', intensity: 0.8 },
      },
    ];
    const plan = planCaptureRuns({
      layer: 'image',
      data: { images },
      videoConfig: VIDEO_CONFIG,
      spans: [{ start: 0, end: 40 }],
      loaded: LOADED_IMAGE,
    });
    expect(plan.runs.length).toBe(40);
    expect(plan.distinctFrames).toBe(40);
    expect(plan.totalFrames).toBe(40);
  });
});

describe('planCaptureRuns — スパン限定（対象は和集合のみ・スパン境界で run が切れる）', () => {
  const STATIC_TELOP = [
    { id: 1, startFrame: -600, endFrame: 4000, text: '定常', style: 'emphasis', template: 19 },
  ];

  it('スパン外は対象にならない（対象フレームがスパンの和集合のみ）', () => {
    const plan = planCaptureRuns({
      layer: 'telop',
      data: { telops: STATIC_TELOP },
      videoConfig: VIDEO_CONFIG,
      spans: [
        { start: 10, end: 20 },
        { start: 50, end: 55 },
      ],
      loaded: LOADED_TELOP,
    });
    // 静的スタイルなのでスパン内は各1 run。10..30・55..の間（ギャップ）は対象外。
    expect(plan.totalFrames).toBe(10 + 5); // 和集合の長さのみ（ギャップの 20 フレームは含めない）
    expect(plan.runs).toEqual([
      { representativeFrame: 10, startFrame: 10, endFrame: 20 },
      { representativeFrame: 50, startFrame: 50, endFrame: 55 },
    ]);
  });

  it('隣接する2スパンは同一シグネチャでも run が切れる（設計点: スパン境界で必ず切る）', () => {
    const plan = planCaptureRuns({
      layer: 'telop',
      data: { telops: STATIC_TELOP },
      videoConfig: VIDEO_CONFIG,
      spans: [
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ],
      loaded: LOADED_TELOP,
    });
    // 静的スタイルは frame 0..19 全域で同一シグネチャのはずだが、スパンが2本なので run も2本。
    expect(plan.runs).toEqual([
      { representativeFrame: 0, startFrame: 0, endFrame: 10 },
      { representativeFrame: 10, startFrame: 10, endFrame: 20 },
    ]);
    expect(plan.distinctFrames).toBe(1); // シグネチャの種類自体は1つ（run が切れるのとは別軸）。
  });
});

describe('planCaptureRuns — 複数スパン・複数テロップ（z 合成された1レイヤとして分類）', () => {
  it('重なり区間は単独区間と異なるシグネチャになり、スパン境界でも run が切れる', () => {
    // A: [-600,20) template1／B: [10,610) template19。startFrame に大きな負のマージンを
    // 持たせ、endFrame も窓から十分離すことで、テンプレ自体が持つ登場/退場の数フレーム
    // フェード（WhiteBlue 系は自身の局所フレーム基準で発生する・signatureRunSpike の
    // WhiteBlue 実測と同じ理屈）が観測窓 [0,30) に掛からないようにする——
    // 掛かる設計だと「絵の切り替わり」自体が数フレームに滲み、厳密な境界手計算ができない。
    // 実際の絵の切り替わりは A/B それぞれの活性区間の端（10・20）だけになる。
    // span は [0,15)/[15,30) として絵の切り替わり（10・20）に揃えないことで
    // 「span 境界での強制カット」も同時に検証する。
    const telops = [
      { id: 1, startFrame: -600, endFrame: 20, text: 'A', style: 'emphasis', template: 1 },
      { id: 2, startFrame: 10, endFrame: 610, text: 'B', style: 'emphasis', template: 19 },
    ];
    const plan = planCaptureRuns({
      layer: 'telop',
      data: { telops },
      videoConfig: VIDEO_CONFIG,
      spans: [
        { start: 0, end: 15 },
        { start: 15, end: 30 },
      ],
      loaded: LOADED_TELOP,
    });

    // 覆域と隙間なし・重複なしは他テストで既に確認済みの分類器の基本性質。ここは
    // 「z 合成が効いていること」と「span 境界が強制カットになっていること」だけを問う。
    const startFrames = plan.runs.map((r) => r.startFrame);
    expect(startFrames[0]).toBe(0);
    expect(plan.runs.at(-1)!.endFrame).toBe(30);

    // span 境界（15）は絵の切り替わりではない（A も B も 15 では活性状態が変わらない）が、
    // 設計点により run はここで必ず切れる＝15 が run の開始点として現れる。
    expect(startFrames).toContain(15);

    // z 合成: 単独区間（A のみ=frame5・B のみ=frame25）と重なり区間（frame14・span をまたいで
    // frame16）のシグネチャは互いに異なり、重なり区間どうし（14 と 16）は span が違っても
    // 絵としては同一（span 境界を挟むだけ）。
    //
    // WhiteBlue（template19）は「登場後3フレームだけ」opacity/scale がフェードする実装
    // （フレームでなく duration に対する固定 min(3,…) フェード。B の登場=10 なので
    // 13 未満はフェード中）。A（template1）は退場前3フレームだけ同様にフェードする
    // （endFrame=20 なので 17 以上はフェード中）。14/16 はどちらのフェード窓にも
    // 掛からない「重なり区間の定常部分」。
    const spec = { layer: 'telop' as const, projectId: 'x', videoConfig: VIDEO_CONFIG, data: { telops } };
    const sigAOnly = signatureAt(spec, 5, LOADED_TELOP);
    const sigOverlapSpan1 = signatureAt(spec, 14, LOADED_TELOP);
    const sigOverlapSpan2 = signatureAt(spec, 16, LOADED_TELOP);
    const sigBOnly = signatureAt(spec, 25, LOADED_TELOP);
    expect(sigOverlapSpan1).not.toBe(sigAOnly);
    expect(sigOverlapSpan1).not.toBe(sigBOnly);
    expect(sigOverlapSpan1).toBe(sigOverlapSpan2); // 絵は同じ（span をまたいだだけ）
    expect(sigAOnly).not.toBe(sigBOnly);

    // 対応する run が実際に存在すること（frame5/14/16/25 を含む run の絵が上と一致）。
    const runAt = (f: number) => plan.runs.find((r) => r.startFrame <= f && f < r.endFrame)!;
    expect(runAt(5).startFrame).toBe(0);
    expect(runAt(14).startFrame).toBe(13); // B のフェード終わり（13）で run が切り替わる
    expect(runAt(16).startFrame).toBe(15); // span 境界の強制カットで新しい run になっている
    expect(runAt(25).startFrame).toBe(20);
    // A/B それぞれの登場・退場フェード（3fr）も個別の run を作るため、単独区間×2・
    // 重なり区間の「定常」1種を含め最低4種類の絵が存在する（フェード分はこれ以上）。
    expect(plan.distinctFrames).toBeGreaterThanOrEqual(4);
    expect(plan.totalFrames).toBe(30);
  });
});

describe('planCaptureRuns — distinctFrames/totalFrames の整合・空スパン', () => {
  it('静的スタイルは distinctFrames=1・totalFrames=スパン長', () => {
    const telops = [{ id: 1, startFrame: -600, endFrame: 4000, text: '定常', style: 'emphasis', template: 19 }];
    const plan = planCaptureRuns({
      layer: 'telop',
      data: { telops },
      videoConfig: VIDEO_CONFIG,
      spans: [{ start: 0, end: 25 }],
      loaded: LOADED_TELOP,
    });
    expect(plan.distinctFrames).toBe(1);
    expect(plan.totalFrames).toBe(25);
    expect(plan.runs).toEqual([{ representativeFrame: 0, startFrame: 0, endFrame: 25 }]);
  });

  it('空スパンは空結果', () => {
    const plan = planCaptureRuns({
      layer: 'telop',
      data: { telops: [] },
      videoConfig: VIDEO_CONFIG,
      spans: [],
      loaded: LOADED_TELOP,
    });
    expect(plan).toEqual({ runs: [], distinctFrames: 0, totalFrames: 0 });
  });

  it('長さ0のスパン（start===end）は何も対象にしない', () => {
    const plan = planCaptureRuns({
      layer: 'telop',
      data: { telops: [] },
      videoConfig: VIDEO_CONFIG,
      spans: [{ start: 5, end: 5 }],
      loaded: LOADED_TELOP,
    });
    expect(plan).toEqual({ runs: [], distinctFrames: 0, totalFrames: 0 });
  });
});

describe('planCaptureRuns — spans の重複は fail-loud', () => {
  it('重複するスパンは throw する（呼び出し側で正規化する契約）', () => {
    expect(() =>
      planCaptureRuns({
        layer: 'telop',
        data: { telops: [] },
        videoConfig: VIDEO_CONFIG,
        spans: [
          { start: 0, end: 20 },
          { start: 10, end: 30 },
        ],
        loaded: LOADED_TELOP,
      }),
    ).toThrow(/重複/);
  });
});

describe('planCaptureRuns — spans の基本妥当性（T2 レビュー推奨④・T4 の密連番生成が順序前提）', () => {
  it('start の降順（未整列）は throw する', () => {
    expect(() =>
      planCaptureRuns({
        layer: 'telop',
        data: { telops: [] },
        videoConfig: VIDEO_CONFIG,
        spans: [
          { start: 20, end: 30 },
          { start: 0, end: 10 },
        ],
        loaded: LOADED_TELOP,
      }),
    ).toThrow(/昇順/);
  });

  it('videoConfig.durationInFrames を超える end は throw する', () => {
    expect(() =>
      planCaptureRuns({
        layer: 'telop',
        data: { telops: [] },
        videoConfig: VIDEO_CONFIG,
        spans: [{ start: 0, end: VIDEO_CONFIG.durationInFrames + 1 }],
        loaded: LOADED_TELOP,
      }),
    ).toThrow(/durationInFrames/);
  });

  it('負の start は throw する', () => {
    expect(() =>
      planCaptureRuns({
        layer: 'telop',
        data: { telops: [] },
        videoConfig: VIDEO_CONFIG,
        spans: [{ start: -1, end: 10 }],
        loaded: LOADED_TELOP,
      }),
    ).toThrow(/0以上/);
  });

  it('非整数フレームは throw する', () => {
    expect(() =>
      planCaptureRuns({
        layer: 'telop',
        data: { telops: [] },
        videoConfig: VIDEO_CONFIG,
        spans: [{ start: 0, end: 10.5 }],
        loaded: LOADED_TELOP,
      }),
    ).toThrow(/整数/);
  });
});

describe('planCaptureRuns — title / telop-title レイヤも分類できる（M2c T3 で解決）', () => {
  it('layer:"title" は throw せず、区間内で run を作る（登場フェード窓を含む）', () => {
    const titles = [{ id: 1, startFrame: 0, endFrame: 40, text: 'たいとる' }];
    const plan = planCaptureRuns({
      layer: 'title',
      data: { titles },
      videoConfig: VIDEO_CONFIG,
      spans: [{ start: 0, end: 40 }],
    });
    expect(plan.totalFrames).toBe(40);
    expect(plan.runs.length).toBeGreaterThan(1);
    expect(plan.runs[0]).toEqual({ representativeFrame: 0, startFrame: 0, endFrame: plan.runs[0]!.endFrame });
    const lastRun = plan.runs[plan.runs.length - 1]!;
    expect(lastRun.endFrame).toBe(40);
  });

  it('layer:"telop-title" は Telop 未ロードだと fail-loud（renderCaptureLayer の契約を継承）', () => {
    expect(() =>
      planCaptureRuns({
        layer: 'telop-title',
        data: { telops: [], titles: [] },
        videoConfig: VIDEO_CONFIG,
        spans: [{ start: 0, end: 5 }],
      }),
    ).toThrow(/^captureRuntime:/);
  });

  it('layer:"telop-title" は telop+title を統合したシグネチャで分類できる', () => {
    const telops = [
      { id: 2, startFrame: -600, endFrame: 4000, text: 'ゴールドアーチ', style: 'emphasis', template: 35 },
    ];
    const titles = [{ id: 1, startFrame: 0, endFrame: 4000, text: 'たいとる' }];
    const plan = planCaptureRuns({
      layer: 'telop-title',
      data: { telops, titles },
      videoConfig: VIDEO_CONFIG,
      spans: [{ start: 0, end: 30 }],
      loaded: LOADED_TELOP,
    });
    expect(plan.totalFrames).toBe(30);
    // template 35 の見た目は版（内部・公開）で違う（公開版の本体パックは無料3種）。この検査は
    // title（登場フェード）だけで run 数（30）に達するので、どちらの版でも同じ期待値になる
    // （title 単独の計画でも 30 run になることを実測）。telop 側の細かさはここでは測っていない。
    expect(plan.runs.length).toBe(30);
  });
});

describe('planCaptureRuns — telop レイヤ未ロードは fail-loud（renderCaptureLayer の契約を継承）', () => {
  it('loaded.Telop が null のまま telop レイヤを計画しようとすると throw する', () => {
    expect(() =>
      planCaptureRuns({
        layer: 'telop',
        data: { telops: [{ id: 1, startFrame: 0, endFrame: 10, text: 'x' }] },
        videoConfig: VIDEO_CONFIG,
        spans: [{ start: 0, end: 5 }],
      }),
    ).toThrow(/captureRuntime/);
  });
});

/**
 * px 量子化（M2c T6 追調査 → コントローラ承認）。
 *
 * 実プロジェクト（05_harness-f3）の Telop.tsx は `interpolate(spring(...),[0,1],[50,0])` を
 * inline transform に書いており、spring が漸近収束で厳密に 1 にならないため translateX が
 * `3.14154860348026e-7px → 1.681171113432356e-7px → -1.851674369390821e-11px` と
 * 永久に変化する。実 Chromium 実測では **この区間 16 フレームの画素は完全に同一**
 * （撮影＋画素比較で run 1 本）なのに、量子化前のシグネチャは 16 distinct に割れていた。
 */
describe('quantizePxLiterals — px 量子化（1/256px・コントローラ承認済み閾値）', () => {
  it('(a) 画素に出ない spring の収束尾（実測値そのもの）は同一シグネチャへ潰れる', () => {
    // 値は T6 追調査で実際に観測された 3 フレーム分の translateX（丸めずそのまま使う）。
    const at = (tx: string): string =>
      quantizePxLiterals(`<div style="opacity:1;transform:translate(${tx}, 0px);z-index:200"></div>`);
    const f6290 = at('3.14154860348026e-7px');
    const f6291 = at('1.681171113432356e-7px');
    const f6310 = at('-1.851674369390821e-11px');
    expect(f6290).toBe(f6291);
    expect(f6290).toBe(f6310);
    // 対照: 量子化しなければ 3 つとも別物（＝この pin が空振りでないことの証拠）。
    const raw = ['3.14154860348026e-7px', '1.681171113432356e-7px', '-1.851674369390821e-11px'].map(
      (tx) => `<div style="opacity:1;transform:translate(${tx}, 0px);z-index:200"></div>`,
    );
    expect(new Set(raw).size).toBe(3);
    expect(new Set([f6290, f6291, f6310]).size).toBe(1);
    // -0 が 0 へ潰れる（Object.is(-0,0) が false なので文字列側で吸収する契約）。
    expect(quantizePxLiterals('translate(-0.0001px)')).toBe(quantizePxLiterals('translate(0.0001px)'));
  });

  it('(b) 可視差（0.5px 級）と量子1つぶんの差は潰れない', () => {
    const at = (tx: string): string => quantizePxLiterals(`transform:translate(${tx}, 0px)`);
    // 0.5px は明確に可視。潰れたら過剰併合＝絵の欠落になる。
    expect(at('0px')).not.toBe(at('0.5px'));
    expect(at('-50px')).not.toBe(at('-45.1953125px'));
    // 量子（1/256=0.00390625px）ちょうど1つぶんの差も別物のまま（併合幅の上限 pin）。
    expect(at('0px')).not.toBe(at('0.00390625px'));
    // 量子の半分**未満**は同じ側へ丸まる（併合幅の下限 pin）。ちょうど半分
    // （1/512=0.001953125）は Math.round が上へ倒すので**潰れない**——境界の実挙動を pin する。
    expect(at('0px')).toBe(at('0.0019px'));
    expect(at('0px')).not.toBe(at('0.001953125px'));
  });

  it('(c) px を持たない数値（scale / opacity / z-index）は丸めない＝既知の限界どおり', () => {
    expect(quantizePxLiterals('transform:scale(1.0000001)')).toBe('transform:scale(1.0000001)');
    expect(quantizePxLiterals('opacity:0.9999999')).toBe('opacity:0.9999999');
    expect(quantizePxLiterals('z-index:200')).toBe('z-index:200');
  });

  it('(d) 整数 px と大きな px 値は書式が安定し、値としては不変（回帰ガード）', () => {
    expect(quantizePxLiterals('font-size:44px')).toBe('font-size:44.0000px');
    expect(quantizePxLiterals('width:1920px;height:1080px')).toBe('width:1920.0000px;height:1080.0000px');
  });

  it('(f) PX_QUANTUM は 1/256px に pin されている（変更はコントローラ承認事項・I-1c）', () => {
    // 数値そのものを書き下して pin する（1/256 の計算式に頼らない）。
    expect(PX_QUANTUM).toBe(0.00390625);
    expect(PX_QUANTUM).toBe(1 / 256);
  });
});
