/**
 * シグネチャ run 計画器。
 *
 * T1(b) スパイク（src/capturePage/signatureRunSpike.test.tsx）を production 化したもの。
 * 撮影ページと同じレイヤツリー（layers.tsx の renderCaptureLayer）を Node 上で
 * `renderToStaticMarkup` し、**HTML 文字列が一致するフレームを同一 run** に分類する。
 * 撮影前にこの分類が判れば、Chromium 撮影は run の代表フレームのみで済む
 * （M2b 広域 I-4 の decode+正規化+比較の支配項を丸ごと消す・設計判断1）。
 *
 * ## 「量子化シグネチャ一致 ⇒ 画素一致」の根拠（**経験的保証**・M2c T6 追調査で格下げ）
 * 1. 撮影は同一ページ・同一ブラウザインスタンスで `setFrame(n)` を撃つだけで行う。ページの
 *    DOM は `renderCaptureLayer(spec, loaded)` の出力だけで決まり、spec は撮影中不変・
 *    loaded（Telop/InsertImage 部品）も不変。
 * 2. したがってフレーム f と f' の描画差は React が produce した DOM+インライン style の差に
 *    限られる。CSS ファイル・フォント・viewport・deviceScaleFactor・背景はフレーム間で不変。
 * 3. renderToStaticMarkup の出力文字列は、その produce された DOM+style を完全に直列化した
 *    ものである。**本モジュールはさらにこの文字列の px 値を PX_QUANTUM（1/256 px）へ
 *    量子化してから比較する**（`quantizePxLiterals`）。
 * 4. ゆえに「量子化シグネチャが同一 ⇒ ブラウザが受け取る DOM+style は **1/256 px 以内で
 *    一致** ⇒ 同じ Chromium が描く画素も同一」。**最後の含意だけが構造的ではなく経験的**
 *    である（1/256 px は Chromium の LayoutUnit 1/64 px の 4 分の 1 ＝ ラスタ到達性の
 *    実用下界。それより細かい差は画素に出ない、という経験則に依拠する）。
 *    逆は成り立たない（DOM が違っても画素が同じになりうる）。つまりシグネチャ分類は
 *    **画素分割より細かくなることはあっても粗くなることはない**（安全側の片側保証）——
 *    この片側性は量子化後も維持される（量子化は分割を粗くする方向にしか働かず、
 *    粗くする幅を 1/256 px の描画差以内に限っているため）。
 *
 * ### なぜ量子化が要るのか（M2c T6 追調査・実測）
 * 量子化前は、部品の `spring()` が漸近収束して厳密に 1 にならないことで
 * `transform:translate(3.14154860348026e-7px, 0px)` → `…1.681171113432356e-7px…` のように
 * **画素に出ない指数関数の尾**が毎フレーム別文字列を作り、run が過剰分割されていた。
 * 実測（05_harness-f3・実 Chromium）: フレーム `[6285,6300]` は
 * **シグネチャ 16 distinct に対し画素比較では run 1 本**（＝全フレーム画素同一）。
 * 量子化により実プロジェクトの distinct は **8,528 → 3,515（76.3% → 31.4%）**へ縮んだ。
 *
 * ### 既知の限界
 * 単位無しの数値（`scale(1.0000001)`・`opacity` 等）は量子化しない（px への倍率が
 * 判らず 1/256 px という量子に根拠が無いため）。scale の収束尾を持つ部品では
 * 過剰分割が残る——**正しさは損なわれない**（片側保証の安全側）が、撮影枚数は増える。
 *
 * ## 限界（反例になりうる経路・T3 への申し送り）
 * - 部品が `useEffect`/`ref` で**レンダ後に** DOM を書き換える経路は SSR 文字列に現れない。
 *   現行の Telop/TitleLayer/InsertImage 部品にその経路は無い（M2a の監査済み API 範囲内）が、
 *   任意の Telop.tsx を許す以上、将来の部品では成立しなくなりうる。
 * - CSS アニメーション（`@keyframes`）で時間駆動される絵は DOM 不変のまま変化する。
 *   撮影ページは実時間を進めない（setFrame のみ）ので現状は無害。
 * - **CSS `transition` も同じ穴に属する**（signatureRunSpike の doc には無かった追記・
 *   T1 レビュー指摘）: `transition` はスタイル値が変わった**次のコミット後に実時間で**
 *   補間するブラウザの描画層の機能であり、React が produce する DOM+インライン style
 *   （= renderToStaticMarkup が直列化する対象）には最終値しか現れない。撮影は
 *   `setFrame(n)` の都度フレームを離散的に切り替えるだけで実時間を進めないため、
 *   `transition` を使う部品があると「シグネチャは変わらないが実際に撮られる画は
 *   补間の途中である」という**逆向きの破れ**（画素が違うのにシグネチャが同一）が起こりうる。
 *   これは 4 の片側保証が守る向き（シグネチャ同一 ⇒ 画素同一）を破る唯一の既知経路であり、
 *   現行部品は `transition` を使わない（inline style の即時反映のみ）ため無害だが、
 *   任意の Telop.tsx を許す設計である以上、T3 以降で部品側の `transition` 使用を
 *   禁則として明示するか、撮影契約側で無効化する対応が要る。
 *
 * ## スパン限定と run 境界（設計判断2）
 * `spans` は撮影対象の再生区間（`[start, end)` 排他・非重複前提。重複は呼び出し側の責務
 * ——正規化してから渡すこと。本関数は重複を検出したら fail-loud で throw する）。
 * スパン外のフレームは対象外（完全透明として扱い run を作らない・totalFrames/distinctFrames
 * にも算入しない）。
 *
 * **スパン境界で run は必ず切る**（設計点・T2 ブリーフ）: 隣接する2つのスパンが
 * たまたま同一シグネチャで終わる/始まっても、run は別にする。ffmpeg 側の入力生成は
 * スパン単位（撮影区間ごとの1レイヤ=1入力・T4）になるため、シグネチャの都合で
 * スパンをまたいだ run を作ると入力生成の単位と食い違う。
 *
 * ## title / telop-title レイヤも Node で計画可能（M2c T3 で解決・旧制約は撤廃）
 * T2 時点では layers.tsx が preview/TitleLayer.tsx（'remotion' を直接 import）を静的 import
 * しており、Node では real remotion に解決されて throw するため `layer:'title'` を
 * 明示的に fail-loud で弾いていた。T3 で capturePage 側に `CaptureTitleLayer` を新設し
 * （preview の TitleLayer は import しない・TitleClip と同じ数式を同順で再現）、layers.tsx の
 * title 描画も runtimeFace.ts 経由の captureRuntime だけに依存する形になったため、
 * 設計点(a)の相対 import 化がそのまま効くようになった。よって `layer:'title'` /
 * `layer:'telop-title'`（T3 で追加した telop+title 統合レイヤ）も他レイヤと同じ経路で分類できる
 * （captureRunPlanner.nodeResolution.test.ts が vi.mock なしでの成立を pin）。
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CaptureFrameProvider } from '../captureRuntime';
import { renderCaptureLayer, type LoadedComponents } from '../capturePage/layers';
import type { CaptureLayerKind, CaptureSpec, CaptureVideoConfigSpec } from '../capturePage/protocol';

export type { CaptureLayerKind } from '../capturePage/protocol';

/** 撮影対象の再生区間（`[start, end)` 排他）。 */
export interface CaptureRunSpan {
  start: number;
  end: number;
}

/** シグネチャ分類が確定した1本の run。 */
export interface PlannedCaptureRun {
  /** 撮影すべき代表フレーム（run の先頭フレーム）。 */
  representativeFrame: number;
  /** run の開始フレーム（inclusive）。 */
  startFrame: number;
  /** run の終了フレーム（exclusive）。 */
  endFrame: number;
}

export interface PlanCaptureRunsOptions {
  layer: CaptureLayerKind;
  /** レイヤ種別ごとの撮影データ。正本は layers.tsx の TelopLayerData/TitleLayerData/ImageLayerData。 */
  data: unknown;
  videoConfig: CaptureVideoConfigSpec;
  spans: CaptureRunSpan[];
  /**
   * telop/image/telop-title レイヤの分類に要る部品（renderCaptureLayer の契約と同じ）。
   * title レイヤは使わない（CaptureTitleLayer は runtimeFace.ts 経由の captureRuntime のみに
   * 依存し、部品ロードを要らない）。省略時は telop/image/telop-title を分類しようとすると
   * renderCaptureLayer が fail-loud で throw する（未ロードのまま黙って空分類にしない）。
   *
   * 前提（T2 レビュー推奨⑥）: 注入する InsertImage 部品が `staticFile()`（captureRuntime 経由）
   * を使う場合、呼び出し側が事前に `setStaticFileResolver()`（../captureRuntime）を設定して
   * いなければ throw する（撮影ページの browserDeps.tsx が prepare 段で行っているのと同じ
   * 契約）。テスト・本関数の呼び出し側では `imageUrl` を直接渡して staticFile() 解決自体を
   * 回避する手もある（captureRunPlanner.test.ts / boundaryInclusion e2e が採る方式）。
   */
  loaded?: LoadedComponents;
}

export interface CaptureRunPlan {
  runs: PlannedCaptureRun[];
  /** スパン内で相異なる HTML シグネチャの種類数。 */
  distinctFrames: number;
  /** スパン内の対象フレーム総数（スパン長の和）。 */
  totalFrames: number;
}

const NO_COMPONENTS: LoadedComponents = { Telop: null, InsertImage: null };

/**
 * px 値の量子（1/256 px）。**コントローラ承認済みの閾値**（M2c T6 追調査 → 承認）。
 *
 * 根拠: Chromium のレイアウト量子 `LayoutUnit` は **1/64 px**。ここはその **4分の1** を
 * 採り、「ラスタが到達しうる粒度の実用下界」より一段細かい側に置く（安全余裕を4倍取る）。
 * 1/256 px より細かい差はブラウザのラスタ結果に現れないという経験則に依拠する。
 */
export const PX_QUANTUM = 1 / 256;

/**
 * シグネチャ文字列中の **px 付き数値だけ**を PX_QUANTUM 刻みへ丸める。
 *
 * 方式の選定（T6 追調査の report に根拠）: 「style 値の正規化」（React 要素ツリーを走査して
 * style オブジェクトを書き換える）ではなく **文字列生成後の数値パターン置換**を採る。
 * 理由は、対象が `transform:translate(3.14e-7px, 0px)` のように **1つの style 値の内側に
 * 埋まった数値**であり、値の構文（translate/translateX/matrix/box-shadow/text-shadow…）を
 * 網羅的に解釈する必要があるのに対し、文字列側なら「px が付いた数値」という**1つの規則**で
 * 全構文を一律に捉えられるため。走査対象が確実（生成された最終文字列そのもの）で、
 * 実装も1つの正規表現で済む。
 *
 * **単位無しの数値（`scale(1.0000001)` / `opacity` / `z-index` 等）は丸めない**。
 * 単位が無い値は px へ写す倍率（要素の実寸）が判らず、1/256 px という量子に**根拠が無い**
 * ため（scale の収束尾が残る部品では過剰分割が残る。既知の限界として doc 化）。
 */
export function quantizePxLiterals(html: string): string {
  return html.replace(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?px/g, (literal) => {
    const value = Number(literal.slice(0, -2));
    if (!Number.isFinite(value)) return literal;
    const snapped = Math.round(value / PX_QUANTUM) * PX_QUANTUM;
    // -0 を 0 に潰す（`Object.is(-0,0)` は false なので文字列側で吸収する）。
    return `${(snapped === 0 ? 0 : snapped).toFixed(4)}px`;
  });
}

/**
 * 1フレームぶんのシグネチャ（撮影ページ本体と同じ renderCaptureLayer を通し、
 * px 値を PX_QUANTUM へ量子化したもの）。テスト（境界の直接検査）向けに export する。
 */
export function signatureAt(spec: CaptureSpec, frame: number, loaded: LoadedComponents = NO_COMPONENTS): string {
  return quantizePxLiterals(
    renderToStaticMarkup(
      React.createElement(
        CaptureFrameProvider,
        { frame, videoConfig: spec.videoConfig },
        renderCaptureLayer(spec, loaded),
      ),
    ),
  );
}

/**
 * spans の基本妥当性を検証する（T2 レビュー推奨④）: T4 の密連番生成（run 代表 PNG を
 * ハードリンクで連番化）は spans が呼び出し順=昇順であることを前提にするため、
 * 未整列・durationInFrames 超過・負フレーム・非整数フレームは黙って正規化せず fail-loud にする。
 */
function assertValidSpans(spans: CaptureRunSpan[], durationInFrames: number): void {
  let prevStart = -Infinity;
  for (const span of spans) {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end)) {
      throw new Error(
        `captureRunPlanner: spans は整数フレームのみです（受け取った値: ${JSON.stringify(span)}）`,
      );
    }
    if (span.start < 0) {
      throw new Error(`captureRunPlanner: spans.start は0以上のみです（受け取った値: ${span.start}）`);
    }
    if (span.end < span.start) {
      throw new Error(
        `captureRunPlanner: spans.end は start 以上のみです（受け取った値: [${span.start},${span.end})）`,
      );
    }
    if (span.end > durationInFrames) {
      throw new Error(
        `captureRunPlanner: spans.end（${span.end}）が videoConfig.durationInFrames（${durationInFrames}）を超えています`,
      );
    }
    if (span.start < prevStart) {
      throw new Error(
        'captureRunPlanner: spans は start の昇順で渡してください（T4 の密連番生成が順序前提のため）: ' +
          `${JSON.stringify(spans)}`,
      );
    }
    prevStart = span.start;
  }
}

/** スパンが非重複であることを検証する（重複の正規化は呼び出し側の責務・doc 参照）。 */
function assertNonOverlappingSpans(spans: CaptureRunSpan[]): void {
  const sorted = [...spans]
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.start < prev.end) {
      throw new Error(
        `captureRunPlanner: spans が重複しています（呼び出し側で正規化してください）: ` +
          `[${prev.start},${prev.end}) と [${cur.start},${cur.end})`,
      );
    }
  }
}

/**
 * レイヤの HTML シグネチャを撮影前に分類し、撮影すべき run（代表フレーム＋区間）を求める。
 * スパン外は完全に対象外（run を作らない）。
 */
export function planCaptureRuns(opts: PlanCaptureRunsOptions): CaptureRunPlan {
  const { layer, data, videoConfig, spans } = opts;
  const loaded = opts.loaded ?? NO_COMPONENTS;
  assertValidSpans(spans, videoConfig.durationInFrames);
  assertNonOverlappingSpans(spans);

  const spec: CaptureSpec = { layer, projectId: 'capture-run-planner', videoConfig, data };

  const runs: PlannedCaptureRun[] = [];
  const distinct = new Set<string>();
  let totalFrames = 0;

  for (const span of spans) {
    if (span.end <= span.start) continue;
    let runStart = span.start;
    let prevSignature: string | null = null;
    for (let frame = span.start; frame < span.end; frame++) {
      const signature = signatureAt(spec, frame, loaded);
      distinct.add(signature);
      totalFrames += 1;
      if (prevSignature !== null && signature !== prevSignature) {
        runs.push({ representativeFrame: runStart, startFrame: runStart, endFrame: frame });
        runStart = frame;
      }
      prevSignature = signature;
    }
    // 設計点: スパン境界で run は必ず切る（隣接スパンが同一シグネチャでも別 run）。
    runs.push({ representativeFrame: runStart, startFrame: runStart, endFrame: span.end });
  }

  return { runs, distinctFrames: distinct.size, totalFrames };
}
