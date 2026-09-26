import { build, type Plugin } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 撮影ページ用のブラウザバンドル（M2b T2・設計判断1）。bundleTelop.ts の流儀に倣う
 * （esbuild・format:'esm'・write:false・external で共有インスタンスを外へ出す）。
 *
 * - runtime: captureRuntime バレル → /capture/runtime.js。撮影ページの importmap が
 *   'remotion' をここへ解決する（= real remotion を面ごと差し替える）。
 * - entry: 撮影ページのエントリ → /capture/entry.js。'remotion' は外部参照のまま残し、
 *   importmap 経由で上の runtime バンドルと**同一インスタンス**を共有させる。
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURE_RUNTIME_DIR = join(SRC_DIR, 'captureRuntime');

/**
 * M2c T2・設計点(a): runtimeFace.ts は captureRuntime バレルを `'remotion'` 経由ではなく
 * **相対 import**で読むようになった（Node 側の captureRunPlanner が layers.tsx を直接
 * require するため。Node には importmap が無く 'remotion' は real remotion package に
 * 解決されてしまう）。
 *
 * ブラウザ向け entry バンドルではこの相対 import を external `'remotion'` へ書き戻す。
 * こうしないと captureRuntime が entry.js に**インライン**され、importmap 経由で
 * TitleLayer.tsx/Telop.tsx/InsertImage.tsx が読む `/capture/runtime.js` の captureRuntime
 * と**別インスタンス**になる（React Context が一致せず
 * 「CaptureFrameProvider の内側でのみ使用できます」で throw する）。
 * bundleCaptureEntry の呼び出しにのみ適用する（bundleCaptureRuntime 自身のエントリ解決を
 * 誤って外部化しないため）。
 *
 * サブパス耐性（T2 レビュー推奨⑤）: `'../captureRuntime'` だけでなく
 * `'../captureRuntime/index'`・`'../captureRuntime/index.ts'` のような書き方も同じ
 * バレルを指すので同様に external 化する。一方 `'../captureRuntime/components'` のような
 * **バレルを経由しない部分 import**は、その部分だけがインライン化され残りは
 * 外部化されるという食い違いを生みうる（single instance 前提が静かに壊れる）ため、
 * 検出したら黙って通さず明示 throw する（将来 layers.tsx 系のどこかが
 * captureRuntime の内部モジュールを直接 import するよう変更されても、ビルド時に
 * 気づけるようにする）。
 */
const CAPTURE_RUNTIME_BARREL_FILTER = /captureRuntime(\/index(\.tsx?)?)?$/;

function stripIndexSuffix(path: string): string {
  return path.replace(/\/index(\.tsx?)?$/, '');
}

const externalizeCaptureRuntimePlugin: Plugin = {
  name: 'externalize-captureRuntime-as-remotion',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: CAPTURE_RUNTIME_BARREL_FILTER }, (args) => {
      if (args.kind === 'entry-point') return null;
      const resolved = resolve(args.resolveDir, stripIndexSuffix(args.path));
      if (resolved !== CAPTURE_RUNTIME_DIR) return null;
      return { path: 'remotion', external: true };
    });
    // バレルを経由しない captureRuntime 内部モジュールの直接 import を検出したら
    // fail-loud（部分的にしか外部化されない食い違いを黙って通さない）。
    pluginBuild.onResolve({ filter: /captureRuntime\// }, (args) => {
      if (CAPTURE_RUNTIME_BARREL_FILTER.test(args.path)) return null; // バレル自体は上のハンドラが処理する
      const resolved = resolve(args.resolveDir, args.path);
      if (!resolved.startsWith(CAPTURE_RUNTIME_DIR + '/')) return null;
      throw new Error(
        `bundleCapture: captureRuntime の内部モジュールをバレル経由せず直接 import しています ` +
          `（${args.path}）。single instance 共有はバレル（'../captureRuntime'）経由の import ` +
          `だけを想定しています。layers.tsx 系のコードをバレル経由の import に直してください。`,
      );
    });
  },
};

/**
 * 外部化するパッケージ。react 系は撮影ページの importmap（src/preview/runtime/*.ts と
 * src/capturePage/runtime/react-dom-client.ts）が解決する。'remotion' を外部化するのは
 * entry 側の要請（captureRuntime バレルと同一インスタンスを共有させる）。captureRuntime
 * 自身は 'remotion' を一切 import しないため、runtime バンドルに remotion は現れない。
 */
export const CAPTURE_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'remotion',
];

async function bundle(entryPoint: string, label: string, plugins: Plugin[] = []): Promise<string> {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: CAPTURE_EXTERNALS,
    plugins,
    logLevel: 'silent',
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`撮影ページの ${label} バンドルに失敗しました: ${message}`);
  });
  const file = result.outputFiles[0];
  if (!file) {
    throw new Error(`撮影ページの ${label} バンドル結果が空です`);
  }
  return file.text;
}

/** captureRuntime バレルをブラウザ向け ESM 1ファイルへバンドルする。 */
export function bundleCaptureRuntime(): Promise<string> {
  return bundle(join(SRC_DIR, 'captureRuntime', 'index.ts'), 'ランタイム');
}

/** 撮影ページのエントリをブラウザ向け ESM 1ファイルへバンドルする。 */
export function bundleCaptureEntry(): Promise<string> {
  return bundle(join(SRC_DIR, 'capturePage', 'entry.tsx'), 'エントリ', [externalizeCaptureRuntimePlugin]);
}
