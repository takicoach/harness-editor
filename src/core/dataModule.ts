import vm from 'node:vm';
import { transformSync } from 'esbuild';

/**
 * セキュリティ上の注記（脅威モデル）:
 * Node の `vm` はセキュリティサンドボックスではない。悪意あるプロジェクトデータファイルは
 * 理論上ホストの `process` 等へ到達しうる。これは Harness Editor の脅威モデルでは
 * 許容範囲とする — ハーネス形式プロジェクトは元々 Remotion / npm プロジェクトであり、
 * ユーザーは `npm install` や `remotion render` でそのプロジェクトのコードを実行する
 * 前提だからである。エディタが telopData.ts 等を vm 評価することは、その既存ワークフロー
 * （プロジェクト全体を信頼して実行する）より攻撃面を拡大しない。信頼できないプロジェクトは
 * そもそも開かない、というプロジェクト単位の信頼境界に依拠する。
 * 将来の堅牢化: vm 評価を AST ベースの構造パーサ（コードを実行せずリテラルを抽出）へ
 * 置換する案がある。
 */

/**
 * ハーネス形式の .ts データファイルを安全に評価し、export 値の集合を返す。
 * - esbuild で型を剥がし CommonJS へ変換する。
 * - import は require へ変換され、importStubs で解決する（未登録は空オブジェクト）。
 * - ファイル内で完結する関数（cutData.ts の toFrame 等）はそのまま動作する。
 *
 * @param source 評価対象の .ts ソース
 * @param importStubs import 指定子 → モジュール内容 のマップ
 */
export function evalDataModule(
  source: string,
  importStubs: Record<string, Record<string, unknown>> = {},
): Record<string, unknown> {
  const js = transformSync(source, {
    loader: 'ts',
    format: 'cjs',
  }).code;

  const moduleObj = { exports: {} as Record<string, unknown> };
  const fakeRequire = (id: string): Record<string, unknown> => importStubs[id] ?? {};

  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: fakeRequire,
  });

  vm.runInContext(js, context, { timeout: 1000 });
  return moduleObj.exports;
}
