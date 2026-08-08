import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { learnStart, learnFinish } from './learn';
import { loadStore, saveStore } from './store';
import { unlearnWord } from './promote';
import { backupsDir, globalStoreDir, typoDictMetaPath, typoDictPath } from './paths';

export interface CliResult {
  code: number;
  message: string;
}

/** `--key value` 形式の引数を取り出す。 */
function getOption(args: string[], key: string): string | undefined {
  const i = args.indexOf(`--${key}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * learn CLI 本体。args は `process.argv.slice(2)` 相当。
 * 戻り値の code を呼び出し側が process.exit へ渡す。
 */
export function runCli(args: string[]): CliResult {
  const command = args[0];
  const projectRoot = getOption(args, 'project') ?? process.cwd();

  if (command === 'start') {
    learnStart(projectRoot);
    return { code: 0, message: 'ベースラインを保存しました' };
  }

  if (command === 'finish') {
    const videoId = getOption(args, 'video') ?? 'unknown';
    const summary = learnFinish(projectRoot, videoId);
    const skipped = summary.skippedConflicts.length;
    return {
      code: 0,
      message:
        `学習完了: ${summary.autoPromoted.length} 件を語句辞書へ昇格しました` +
        (skipped > 0 ? `（競合 ${skipped} 件は曖昧なため見送り）` : ''),
    };
  }

  if (command === 'unlearn') {
    const word = args[1];
    if (!word) return { code: 1, message: 'unlearn には語句を指定してください' };
    saveStore(unlearnWord(loadStore(), word));
    return { code: 0, message: `「${word}」を取り消しました` };
  }

  if (command === 'undo') {
    const dir = backupsDir();
    const entries = existsSync(dir) ? readdirSync(dir) : [];
    if (entries.length === 0) {
      return { code: 1, message: 'バックアップがありません' };
    }
    const latest = entries.sort().at(-1)!;
    mkdirSync(globalStoreDir(), { recursive: true });
    cpSync(join(dir, latest, 'typo_dict.json'), typoDictPath());
    const metaBackup = join(dir, latest, 'typo_dict.meta.json');
    if (existsSync(metaBackup)) cpSync(metaBackup, typoDictMetaPath());
    return { code: 0, message: `直前の状態（${latest}）へ戻しました` };
  }

  return { code: 1, message: `不明なコマンド: ${command ?? '(なし)'}` };
}
