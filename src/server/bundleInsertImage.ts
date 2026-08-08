import { build } from 'esbuild';
import { join } from 'node:path';

const INSERT_IMAGE_DIR = 'InsertImage';

// エディタ本体と同一インスタンスを共有する必要があるパッケージだけ外部化する。
// ブラウザ側は index.html の import map で解決する。@remotion/* ヘルパは
// 外部化せずバンドルへ取り込む（取り込んでも内部の `remotion` 参照は外部化される）。
export const INSERT_IMAGE_EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'remotion',
];

/**
 * 対象プロジェクトの InsertImage.tsx を、ローカル依存だけ取り込んだ ESM 1 ファイルへ
 * バンドルして返す。react / remotion は外部化したまま。
 */
export async function bundleInsertImageComponent(dir: string): Promise<string> {
  const entry = join(dir, 'src', INSERT_IMAGE_DIR, 'InsertImage.tsx');
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: INSERT_IMAGE_EXTERNALS,
    logLevel: 'silent',
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`挿入画像部品 InsertImage.tsx のビルドに失敗しました: ${message}`);
  });
  const file = result.outputFiles[0];
  if (!file) {
    throw new Error('挿入画像部品のバンドル結果が空です');
  }
  return file.text;
}
