/**
 * プロジェクト自身のオーバーレイ部品（Telop.tsx / InsertImage.tsx）を **Node** で読む。
 *
 * captureRunPlanner は撮影前のシグネチャ分類を Node 上で行うが、プロジェクトの部品は
 * remotion / @harness/frame-runtime を import する（ブラウザ側も同じ captureRuntime を使う）。
 * Node には importmap が無いので、ここで「バンドル + 解決の注入」を行う。
 *
 * ## 単一インスタンス性（本モジュールの最重要制約）
 * 部品が使う `useCurrentFrame` 等は **呼び出し側（captureRunPlanner）と同じ captureRuntime
 * インスタンス**でなければならない。React Context は「モジュールインスタンスごとに別物」
 * なので、captureRuntime が二重評価されると `CaptureFrameProvider` の frame が部品へ届かず
 * 「CaptureFrameProvider の内側でのみ使用できます」で throw する（= 静かに壊れるのではなく
 * 落ちるが、原因が読み取りにくい）。
 *
 * そこで本モジュールは**ファイルシステム経由の import を一切使わない**:
 *   1. esbuild で **CJS** 1ファイルへバンドルし、`remotion` / `react` / `react-dom` /
 *      `react/jsx-runtime` を external に置く（= バンドル結果に `require("remotion")` 等が残る）
 *   2. `node:vm` の `compileFunction` で `(require, module, exports)` を引数に持つ関数として
 *      コンパイルし、**このモジュールが静的 import 済みの実体**を返す `require` を注入する
 * これで「解決」はモジュール解決器を一切通らず、注入した値そのものになる。data: URL や
 * 一時ファイルの動的 import では (a) 相対解決の基準が壊れる (b) captureRuntime を Node が
 * .ts のまま読めない（本番はエディタごと Vite/tsx 上で走る）(c) 二重評価の余地が残る、の
 * 3点が同時に問題になるため採らない。単一インスタンス性は loadOverlayComponents.test.ts の
 * 「呼び出し側の CaptureFrameProvider の frame を部品が見る」pin が守る。
 *
 * ## 監査ゲート
 * 読み込みの**前**に auditOverlayImports（M2a）で対象 tsx の remotion / @harness/frame-runtime / @remotion/*
 * import を検査し、未登録シンボルがあればバンドルもせずに種別付きで fail する
 * （実行時エラー頼みにしない）。粒度限界（シンボル単位まで・#196）は captureRuntime 側の
 * 明示 throw が最後の網になる。監査対象は entry の2ファイルのみで、そこから import される
 * ローカルモジュールが 'remotion' を使う経路までは辿らない。その場合の実挙動は
 * 「未監査シンボルが captureRuntime に無い → undefined のまま**描画時**に落ちる」で、
 * 種別は付かず `planCaptureRuns` の throw として撮影計画の失敗（prepare ok:false →
 * Remotion 退避）に拾われる（evaluate-failed にはならない）。
 *
 * ## 信頼境界（セキュリティ判断）
 * プロジェクトの TSX は受講生の編集物＝任意コードだが、これは既に Remotion 経路
 * （`remotion render`）とプレビュー（ブラウザ）で実行される前提のコードであり、Node 評価も
 * **同一の信頼境界内**（本ツールはローカル専用・自分のプロジェクトだけを開く）。
 * したがって本モジュールはサンドボックス化を目的にしない（vm を使うのは実行のためであって
 * 隔離のためではない）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileFunction } from 'node:vm';
import { build } from 'esbuild';
import * as reactNamespace from 'react';
import * as reactDomNamespace from 'react-dom';
import * as jsxRuntimeNamespace from 'react/jsx-runtime';
import * as jsxDevRuntimeNamespace from 'react/jsx-dev-runtime';
import * as captureRuntime from '../captureRuntime';
import { auditOverlayImports } from '../captureRuntime/auditImports';
import type { LoadedComponents } from '../capturePage/layers';
import { pickTelopExport } from '../preview/loadTelopComponent';
import { pickInsertImageExport } from '../preview/loadInsertImageComponent';

const TELOP_ENTRY = ['src', 'テロップテンプレート', 'Telop.tsx'];
const INSERT_IMAGE_ENTRY = ['src', 'InsertImage', 'InsertImage.tsx'];

/** 失敗の種別（呼び出し側はどれでも Remotion 経路へ退避する。ログの切り分け用）。 */
export type OverlayLoadFailureKind =
  | 'missing-file'
  | 'unaudited-import'
  | 'bundle-failed'
  | 'evaluate-failed'
  | 'missing-export';

export interface OverlayLoadFailure {
  ok: false;
  kind: OverlayLoadFailureKind;
  message: string;
}

export type LoadOverlayComponentsResult =
  | { ok: true; components: LoadedComponents }
  | OverlayLoadFailure;

/** どの部品が要るか（要らない部品は読み込まない＝存在しなくても失敗にしない）。 */
export interface OverlayComponentNeeds {
  telop: boolean;
  image: boolean;
}

/** テスト用の差し替え口（監査ゲートが「バンドル前」に効くことの pin に使う）。 */
export interface LoadOverlayComponentsDeps {
  bundle?: (entry: string) => Promise<string>;
  /**
   * **テスト専用**: 部品へ渡す `'remotion'` の実体を差し替える。既定は本モジュールが静的
   * import した captureRuntime（= 呼び出し側と同一インスタンス）。単一インスタンス性の
   * pin を空振りさせないための陰性対照（別インスタンスを注入したら壊れることの観測）に
   * だけ使う。production から渡してはいけない。
   */
  remotionModuleForTest?: Record<string, unknown>;
}

/**
 * Node撮影で共有するReactと独自フレームAPIを外部化する。
 * 下の制限付き require シムが解決し、両フレーム指定子は同一 captureRuntime を指す。
 */
const OVERLAY_EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'remotion',
  '@harness/frame-runtime',
  // 未登録のサブパス（'react-dom/server' 等）は**バンドルへ巻き込ませない**（巻き込むと
  // 別の React 実体が同居して単一インスタンス性が静かに壊れる）。external のまま残し、
  // require シムが名指しで throw する（evaluate-failed → Remotion 退避）。
  'react/*',
  'react-dom/*',
  'remotion/*',
  '@harness/frame-runtime/*',
];

/**
 * 名前空間オブジェクトを CJS 相当の素のオブジェクトへ均す。
 * esbuild の `__toESM` は `__esModule` の無いオブジェクトの `default` を「そのオブジェクト自身」
 * に設定するので、`import X from 'react-dom'` と `import {createPortal} from 'react-dom'` の
 * どちらも同一の関数実体を指す（sample-project の Telop.tsx がこの一致を DOM 属性で観測する）。
 */
function flatten(namespace: object): Record<string, unknown> {
  return { ...namespace } as Record<string, unknown>;
}

const SHARED_FRAME_RUNTIME = flatten(captureRuntime);
const EXTERNAL_MODULES: Record<string, Record<string, unknown>> = {
  // 'remotion' の面 = captureRuntime バレル（呼び出し側 captureRunPlanner と同一インスタンス）。
  remotion: SHARED_FRAME_RUNTIME,
  '@harness/frame-runtime': SHARED_FRAME_RUNTIME,
  react: flatten(reactNamespace),
  'react-dom': flatten(reactDomNamespace),
  'react/jsx-runtime': flatten(jsxRuntimeNamespace),
  'react/jsx-dev-runtime': flatten(jsxDevRuntimeNamespace),
};

function requireExternal(specifier: string, remotionOverride?: Record<string, unknown>): unknown {
  if ((specifier === 'remotion' || specifier === '@harness/frame-runtime') && remotionOverride !== undefined) return remotionOverride;
  const mod = EXTERNAL_MODULES[specifier];
  if (mod === undefined) {
    throw new Error(
      `オーバーレイ部品が Node 撮影計画では解決できないモジュール '${specifier}' を読み込みました` +
        `（解決できるのは ${Object.keys(EXTERNAL_MODULES).join(' / ')} のみ）`,
    );
  }
  return mod;
}

/** 対象 tsx を CJS 1ファイルへバンドルする（react / remotion は external のまま）。 */
async function bundleForNode(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    // **撮影ページ側（bundleCapture / bundleTelop）と同じ 'browser'**（M2c T5b 修正2）。
    // 'node' にすると条件付き exports や `typeof window` 分岐で別のコードが選ばれ、
    // 「分類に使う DOM と撮る DOM が別物」になってシグネチャの片側保証が破れる。
    // 出力形式だけ cjs にして評価時に実体を注入する（解決器を通さないため）。
    // 副作用として node builtins（'node:fs' 等）は解決できず bundle-failed になるが、
    // 撮影ページで動かない部品を分類だけ通すほうが危険なので、この向きで正しい。
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: OVERLAY_EXTERNALS,
    logLevel: 'silent',
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error('バンドル結果が空です');
  return file.text;
}

/** バンドル済み CJS を評価して module.exports を返す。 */
function evaluateBundle(
  code: string,
  filename: string,
  remotionOverride?: Record<string, unknown>,
): Record<string, unknown> {
  const fn = compileFunction(code, ['require', 'module', 'exports'], { filename }) as (
    req: (specifier: string) => unknown,
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
  ) => void;
  const moduleObject = { exports: {} as Record<string, unknown> };
  fn((specifier) => requireExternal(specifier, remotionOverride), moduleObject, moduleObject.exports);
  return moduleObject.exports;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 1部品ぶんの読み込み。監査 → バンドル → 評価 → export 取り出しの順で、
 * どこで落ちても種別付きの失敗を返す。
 */
async function loadOne<T>(
  entry: string,
  label: string,
  pick: (mod: Record<string, unknown>) => T,
  deps: LoadOverlayComponentsDeps,
): Promise<{ ok: true; component: T } | OverlayLoadFailure> {
  if (!existsSync(entry)) {
    return { ok: false, kind: 'missing-file', message: `${label}（${entry}）が見つかりません` };
  }

  // 監査ゲート: バンドルの前に必ず通す（未登録 API は読み込まずに退避する）。
  let source: string;
  try {
    source = readFileSync(entry, 'utf8');
  } catch (err) {
    return { ok: false, kind: 'missing-file', message: `${label} を読めません: ${messageOf(err)}` };
  }
  const unaudited = auditOverlayImports([{ path: entry, source }]);
  if (unaudited.length > 0) {
    return {
      ok: false,
      kind: 'unaudited-import',
      message:
        `${label} が撮影で未監査の API を使っています（${unaudited[0]!.unaudited.join(', ')}）。` +
        '撮影経路は使わず Remotion 経路で書き出します。',
    };
  }

  let code: string;
  try {
    code = await (deps.bundle ?? bundleForNode)(entry);
  } catch (err) {
    return { ok: false, kind: 'bundle-failed', message: `${label} のビルドに失敗しました: ${messageOf(err)}` };
  }

  let mod: Record<string, unknown>;
  try {
    mod = evaluateBundle(code, entry, deps.remotionModuleForTest);
  } catch (err) {
    return { ok: false, kind: 'evaluate-failed', message: `${label} の評価に失敗しました: ${messageOf(err)}` };
  }

  try {
    return { ok: true, component: pick(mod) };
  } catch (err) {
    return { ok: false, kind: 'missing-export', message: messageOf(err) };
  }
}

/**
 * プロジェクトの Telop / InsertImage 部品を Node 上で解決する
 * （captureRunPlanner の `loaded` へそのまま渡せる形）。
 *
 * `needs` で要らない部品は読み込まない（ファイルが無くても失敗にしない）。
 */
export async function loadOverlayComponentsForPlanner(
  projectDir: string,
  needs: OverlayComponentNeeds = { telop: true, image: true },
  deps: LoadOverlayComponentsDeps = {},
): Promise<LoadOverlayComponentsResult> {
  const components: LoadedComponents = { Telop: null, InsertImage: null };

  if (needs.telop) {
    const loaded = await loadOne(
      join(projectDir, ...TELOP_ENTRY),
      'テロップ部品 Telop.tsx',
      pickTelopExport,
      deps,
    );
    if (!loaded.ok) return loaded;
    components.Telop = loaded.component;
  }

  if (needs.image) {
    const loaded = await loadOne(
      join(projectDir, ...INSERT_IMAGE_ENTRY),
      '挿入画像部品 InsertImage.tsx',
      pickInsertImageExport,
      deps,
    );
    if (!loaded.ok) return loaded;
    components.InsertImage = loaded.component;
  }

  return { ok: true, components };
}
