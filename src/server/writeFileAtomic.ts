/**
 * 原子的なファイル書き込み（監査 data-safety-7）。
 *
 * 保存は 11 個のデータファイルを書き戻す。従来は `writeFileSync` で 1 つずつ直接
 * 上書きしていたため、途中で失敗（容量・権限・プロセス終了）すると
 * 「テロップだけ新しくカットは古い」プロジェクトが残り、開き直しても不整合のままだった。
 *
 * ここでは 2 段階にする:
 *   1. すべての内容を `<path>.tmp` へ書き切る（この段で失敗したら tmp を消し、対象は無傷）
 *   2. 書き切れたものだけを順に `renameSync` で本体へ差し替える
 *
 * rename は同一ファイルシステム内では単一ファイル単位で原子的なので、
 * 「書きかけの半端な内容を他プロセスが読む」ことが無くなる。
 * さらに tmp は rename の前に fsync してからディスクへ落とす（サイクル 2 Minor）。
 * fsync 無しで rename すると、電源断・強制終了の際に「rename は済んでいるのに
 * 中身がまだ届いていない」空ファイルが本体の位置に残りうる。
 * 2 段目（rename 列）の途中失敗まで完全に防ぐことはファイルシステムの機能上できないが、
 * rename は I/O をほぼ伴わないため、実質的な失敗窓は 1 段目に集約される。
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** 1 ファイル分の書き込み指示。 */
export interface AtomicWrite {
  /** 書き込み先の絶対パス。 */
  path: string;
  /** 書き込む内容（UTF-8）。 */
  source: string;
}

/** `<path>.tmp` へ書いてから rename する。単発の書き込み用。 */
export function writeFileAtomic(path: string, source: string): void {
  writeFilesAtomic([{ path, source }]);
}

/**
 * 複数ファイルをまとめて原子的に書く。
 * 全件を `.tmp` へ書き終えてから順に rename するため、1 段目で失敗した場合は
 * どの対象ファイルも変更されず、`.tmp` も残らない。
 */
export function writeFilesAtomic(writes: readonly AtomicWrite[]): void {
  const staged: { tmp: string; path: string }[] = [];
  try {
    for (const w of writes) {
      const tmp = `${w.path}.tmp`;
      mkdirSync(dirname(w.path), { recursive: true });
      // writeFileSync + 別途 open では「書いた実体」と fsync 対象がずれうるので、
      // 同じ fd で書き切ってから fsync する。
      const fd = openSync(tmp, 'w');
      try {
        // write(2) は 1 回で全量書けるとは限らない（戻り値は書けたバイト数）。
        // 1 回で済ませると部分書込みのまま rename され、保存ファイルが黙って切り詰められる。
        // 書けたバイト数だけ進めて残りが 0 になるまで繰り返す。
        const buf = Buffer.from(w.source, 'utf8');
        let written = 0;
        while (written < buf.length) {
          const n = writeSync(fd, buf, written, buf.length - written);
          if (n <= 0) throw new Error(`書き込みが進みませんでした: ${tmp}`);
          written += n;
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      staged.push({ tmp, path: w.path });
    }
  } catch (err) {
    // 書けた分の tmp を片付ける。片付け自体の失敗で元の例外を隠さない。
    for (const s of staged) {
      try {
        unlinkSync(s.tmp);
      } catch {
        // 消せなくても本体は無傷。次回の保存で上書きされる。
      }
    }
    throw err;
  }
  for (const s of staged) {
    renameSync(s.tmp, s.path);
  }
}
