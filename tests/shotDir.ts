import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 撮影 spec のスクリーンショット出力先を決める。
 *
 * 以前は出力先が `docs/reports/aaa-screenshots/<group>`（＝**コミット済みの成果物**）で
 * 固定されていたため、フルスイート e2e を回すだけで追跡ファイルが 78 件 modified になった。
 * 「テストを回すとリポジトリが汚れる」状態は、作業ツリーの差分を「何か壊したのか」と
 * 誤読させるうえ、コミット済みスクショが**いつ・どの状態で撮ったものか**分からなくなり
 * 検品の証拠として使えなくなる。
 *
 * よって置き場を 2 つに分ける:
 *   - 通常ラン … `.aaa-shots/<group>`（.gitignore 済み・作業ツリーを汚さない）
 *   - 証拠更新 … `docs/reports/aaa-screenshots/<group>`。`npm run shots:evidence`
 *     （= `AAA_UPDATE_EVIDENCE=1`）で**意図的に**回した時だけここへ書く。
 *
 * `AAA_SHOT_DIR` を渡せば任意の場所（作業ツリー外を含む）へも撮れる。
 * どの経路でも撮影自体は必ず走る（撮らなくなるのは検品能力の喪失なので不可）。
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** 検品証拠の正本（コミット対象）。 */
export const EVIDENCE_ROOT = resolve(REPO_ROOT, 'docs/reports/aaa-screenshots');

/** 通常ランの置き場（追跡しない）。 */
export const SCRATCH_ROOT = resolve(REPO_ROOT, '.aaa-shots');

export function shotRoot(): string {
  const override = process.env['AAA_SHOT_DIR'];
  if (override && override !== '') return resolve(override);
  return process.env['AAA_UPDATE_EVIDENCE'] === '1' ? EVIDENCE_ROOT : SCRATCH_ROOT;
}

/** `<root>/<group>` を作って返す。 */
export function shotDir(group: string): string {
  const dir = resolve(shotRoot(), group);
  mkdirSync(dir, { recursive: true });
  return dir;
}
