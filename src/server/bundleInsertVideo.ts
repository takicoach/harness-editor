import { build } from 'esbuild';
import { join } from 'node:path';

const INSERT_VIDEO_DIR = 'InsertVideo';

// エディタ本体と同一インスタンスを共有する必要があるパッケージだけ外部化する。
// ブラウザ側は index.html の import map で解決する。@remotion/* ヘルパは
// 外部化せずバンドルへ取り込む（取り込んでも内部の `remotion` 参照は外部化される）。
export const INSERT_VIDEO_EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'remotion',
];

/** 対象プロジェクトの InsertVideo.tsx を ESM 1 ファイルへバンドルして返す。 */
export async function bundleInsertVideoComponent(dir: string): Promise<string> {
  const entry = join(dir, 'src', INSERT_VIDEO_DIR, 'InsertVideo.tsx');
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: INSERT_VIDEO_EXTERNALS,
    logLevel: 'silent',
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`サブ動画部品 InsertVideo.tsx のビルドに失敗しました: ${message}`);
  });
  const file = result.outputFiles[0];
  if (!file) {
    throw new Error('サブ動画部品のバンドル結果が空です');
  }
  return file.text;
}
