import { existsSync } from 'node:fs';
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

/** 新名（2026-09-06〜）。旧名 `.supermovie-learning` は fallback で読む。 */
export const LEARNING_HOME_DIRNAME = '.video-harness-learning';
export const LEGACY_LEARNING_HOME_DIRNAME = '.supermovie-learning';

/** withLearningHome の実行中だけ使う固定の保存先（null なら通常の解決順）。 */
let pinnedStoreDir: string | null = null;

/**
 * action の実行中、globalStoreDir() を dir に固定する（設計書 D12: 承認の開始時に1回決め、
 * 記録・昇格・台帳の全部で同じ場所を使う）。action は同期処理だけを受け付ける
 * （await をまたぐと固定が外れた後に書き込みが走るため、Promise を返したら例外にする）。
 */
export function withLearningHome<T>(dir: string, action: () => T): T {
  const previous = pinnedStoreDir;
  pinnedStoreDir = dir;
  try {
    const result = action();
    if (result instanceof Promise) {
      // 例外で呼び出し側へ知らせる。捨てる Promise が後で失敗しても未処理の reject にしない。
      result.catch(() => {});
      throw new TypeError('withLearningHome は同期処理だけを受け付けます');
    }
    return result;
  } finally {
    pinnedStoreDir = previous;
  }
}

/**
 * グローバルストアのディレクトリ。解決順（withLearningHome の実行中はその dir が最優先）:
 * （固定中は引数の env・home を明示しても固定値を返す）
 * 1. 環境変数 HARNESS_LEARNING_HOME
 * 2. 環境変数 SUPERMOVIE_LEARNING_HOME（旧名・製品スキルとの互換）
 * 3. 既存の ~/.video-harness-learning
 * 4. 既存の ~/.supermovie-learning（旧名 fallback。製品スキルはここへ書く）
 * 5. 既定 ~/.video-harness-learning（作らない）
 */
export function globalStoreDir(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  if (pinnedStoreDir !== null) return pinnedStoreDir;
  const fromEnv = env.HARNESS_LEARNING_HOME ?? env.SUPERMOVIE_LEARNING_HOME;
  if (fromEnv) return fromEnv;
  const modern = path.join(home, LEARNING_HOME_DIRNAME);
  if (existsSync(modern)) return modern;
  const legacy = path.join(home, LEGACY_LEARNING_HOME_DIRNAME);
  if (existsSync(legacy)) return legacy;
  return modern;
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
