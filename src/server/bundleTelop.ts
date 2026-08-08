import { build } from 'esbuild';
import { join } from 'node:path';

const TELOP_DIR = 'テロップテンプレート';

// エディタ本体と同一インスタンスを共有する必要があるパッケージだけ外部化する。
// ブラウザ側は index.html の import map で解決する。@remotion/* ヘルパ
// （@remotion/shapes 等）は外部化せずバンドルへ取り込む。取り込んでも内部の
// `remotion` 参照は外部化されるため、エディタ本体と同一インスタンスを共有する。
export const TELOP_EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'remotion',
];

/**
 * 対象プロジェクトの Telop.tsx を、ローカル依存だけ取り込んだ ESM 1 ファイルへ
 * バンドルして返す。react / remotion は外部化したまま。
 */
export async function bundleTelopComponent(dir: string): Promise<string> {
  const entry = join(dir, 'src', TELOP_DIR, 'Telop.tsx');
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: TELOP_EXTERNALS,
    logLevel: 'silent',
  }).catch((err: unknown) => {
    // esbuild は構文エラー・import 解決失敗などで throw する。非エンジニアが
    // どのファイルを直せばよいか分かるよう、日本語の文脈を付けて投げ直す。
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`テロップ部品 Telop.tsx のビルドに失敗しました: ${message}`);
  });
  const file = result.outputFiles[0];
  if (!file) {
    throw new Error('テロップ部品のバンドル結果が空です');
  }
  return file.text;
}
