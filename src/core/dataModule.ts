import vm from 'node:vm';
import { ProjectFileError } from './types';
import { transformSync } from 'esbuild';

/**
 * セキュリティ上の注記（脅威モデル）:
 * Node の `vm` はセキュリティサンドボックスではない。悪意あるプロジェクトデータファイルは
 * 理論上ホストの `process` 等へ到達しうる。これは Harness Editor の脅威モデルでは
 * 許容範囲とする — ハーネス形式の案件は元々 Remotion / npm プロジェクトであり、
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

/**
 * 読み込んだデータに **非有限数（NaN・±Infinity）** が混ざっていないか再帰的に検査する。
 *
 * これらは評価は通るが、そのまま編集状態へ流れ込み、保存時に `startFrame: NaN` として
 * 書き戻される（＝壊れたまま静かに往復する）。タイムラインの座標計算も全て NaN へ
 * 伝播して「テロップが消える／位置が飛ぶ」といった原因不明の不具合になるため、
 * 読み込みの時点で**どのファイルのどの値か**を示して止める。
 *
 * `null` は**弾かない**。これは「フィールドごとに型検査して既定へフォールバックする」
 * パーサ（mainLayoutData / speedData）向けの版で、そこでは null は既に安全に処理される。
 * 生の配列をそのまま編集状態へ通すファイルは `assertNoNullOrNonFinite` を使う。
 * 省略（undefined）は正常値なので通す。文字列・真偽値は対象外。
 *
 * @param fileName エラー表示に使うファイル名（例 'mainLayoutData.ts'）
 * @param path 値の表示パス（例 'MAIN_LAYOUT'）
 * @param value 検査対象（配列・オブジェクト・スカラーいずれも可）
 */
export function assertFiniteNumbers(fileName: string, path: string, value: unknown): void {
  walkNumbers(fileName, path, value, false);
}

/**
 * `assertFiniteNumbers` に加えて **あらゆる型の `null`** も弾く。
 *
 * 名前のとおり「null と非有限数を許さない」検査であり、数値フィールドに限らない。
 * 文字列フィールドの null まで弾くのは意図的で、理由は2つある（どちらも実測）:
 *
 * 1. **保存側と対称にするため**。`saveProject.ts` の `assertFiniteEditData` は
 *    null を 400 で断る（クライアント→サーバは JSON なので `NaN` は必ず `null` に化ける）。
 *    読み込みで通してしまうと、開けはするのに**無関係な編集まで保存できない**
 *    プロジェクトが出来上がる。
 * 2. **保存が TypeError で落ちるため**。生成器は文字列を `jsString(value)` で埋めるので、
 *    `highlight: null` のようなファイルは `formatTelopArray` の中で
 *    `Cannot read properties of null (reading 'replace')` を投げる。
 *    読み込み時に「どのファイルのどの要素か」を示して止めるほうが、保存時の
 *    素の TypeError より遥かに直しやすい。
 *
 * 残存リスク: 生成器は未設定フィールドを出力しない（`!== undefined` で分岐する）ため
 * null を含むファイルは通常できないが、手書き・外部ツール由来のプロジェクトが
 * 文字列フィールドに null を持っていた場合、そのプロジェクトは開けなくなる。
 * その場合は該当行を消す（＝未設定に戻す）ことで開ける。
 */
export function assertNoNullOrNonFinite(fileName: string, path: string, value: unknown): void {
  walkNumbers(fileName, path, value, true);
}

function walkNumbers(fileName: string, path: string, value: unknown, rejectNull: boolean): void {
  if (value === null) {
    if (rejectNull) {
      throw new ProjectFileError(fileName, `${path} が null です（値が壊れています。未設定にしたい場合はその行を消してください）`);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ProjectFileError(fileName, `${path} が数値として不正です: ${String(value)}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkNumbers(fileName, `${path}[${i}]`, v, rejectNull));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkNumbers(fileName, `${path}.${k}`, v, rejectNull);
    }
  }
}
