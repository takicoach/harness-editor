import os from 'node:os';
import path from 'node:path';

/** プロジェクトの学習ディレクトリ `<root>/.learning`。 */
export function projectLearningDir(projectRoot: string): string {
  return path.join(projectRoot, '.learning');
}

/** ベースラインのスナップショット置き場 `<root>/.learning/baseline`。 */
export function baselineDir(projectRoot: string): string {
  return path.join(projectLearningDir(projectRoot), 'baseline');
}

/** 修正履歴の置き場 `<root>/.learning/history`。 */
export function historyDir(projectRoot: string): string {
  return path.join(projectLearningDir(projectRoot), 'history');
}

/**
 * グローバルストアのディレクトリ。
 * 環境変数 HARNESS_LEARNING_HOME（旧 SUPERMOVIE_LEARNING_HOME も有効）があればそれを、
 * 無ければ ~/.supermovie-learning を使う（既定パスはハーネス側スキルと共有のため据え置き）。
 */
export function globalStoreDir(): string {
  return (
    process.env.HARNESS_LEARNING_HOME ??
    process.env.SUPERMOVIE_LEARNING_HOME ??
    path.join(os.homedir(), '.supermovie-learning')
  );
}

/** グローバル語句辞書 typo_dict.json のパス。 */
export function typoDictPath(): string {
  return path.join(globalStoreDir(), 'typo_dict.json');
}

/** typo_dict のサイドカー学習メタのパス。 */
export function typoDictMetaPath(): string {
  return path.join(globalStoreDir(), 'typo_dict.meta.json');
}

/** グローバルストアのバックアップ置き場。 */
export function backupsDir(): string {
  return path.join(globalStoreDir(), 'backups');
}

/** 承認済みカット差分の生ログ cut_feedback.jsonl のパス。 */
export function cutFeedbackPath(): string {
  return path.join(globalStoreDir(), 'cut_feedback.jsonl');
}

/** 集計済みカットルール cut_rules.json のパス。 */
export function cutRulesPath(): string {
  return path.join(globalStoreDir(), 'cut_rules.json');
}

/** 蒸留消化状態 distill_state.json のパス。 */
export function distillStatePath(): string {
  return path.join(globalStoreDir(), 'distill_state.json');
}

/** 承認済みテロップ差分の生ログ telop_feedback.jsonl のパス。 */
export function telopFeedbackPath(): string {
  return path.join(globalStoreDir(), 'telop_feedback.jsonl');
}

/** 集計済みテロップルール telop_rules.json のパス。 */
export function telopRulesPath(): string {
  return path.join(globalStoreDir(), 'telop_rules.json');
}

/** 承認済み SE 差分の生ログ se_feedback.jsonl のパス。 */
export function seFeedbackPath(): string {
  return path.join(globalStoreDir(), 'se_feedback.jsonl');
}

/** 集計済み SE ルール se_rules.json のパス。 */
export function seRulesPath(): string {
  return path.join(globalStoreDir(), 'se_rules.json');
}
