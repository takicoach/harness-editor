import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  backupsDir,
  globalStoreDir,
  historyDir,
  typoDictMetaPath,
  typoDictPath,
} from './paths';
import { emptyTypoDict, parseTypoDict, serializeTypoDict } from './typoDict';
import type { HistoryRecord, StoreSnapshot, TypoDictMeta } from './types';

function emptyMeta(): TypoDictMeta {
  return { observations: {}, lastSeen: {} };
}

/** グローバルストアを読む。未作成なら空のスナップショットを返す。 */
export function loadStore(): StoreSnapshot {
  const dictPath = typoDictPath();
  const metaPath = typoDictMetaPath();
  const typoDict = existsSync(dictPath)
    ? parseTypoDict(readFileSync(dictPath, 'utf8'))
    : emptyTypoDict();
  const typoDictMeta = existsSync(metaPath)
    ? (JSON.parse(readFileSync(metaPath, 'utf8')) as TypoDictMeta)
    : emptyMeta();
  return { typoDict, typoDictMeta };
}

/** グローバルストアを保存する。既存ストアがあれば backups/ へタイムスタンプ付きで退避する。 */
export function saveStore(snapshot: StoreSnapshot): void {
  const dir = globalStoreDir();
  mkdirSync(dir, { recursive: true });

  const dictPath = typoDictPath();
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const backupDir = join(backupsDir(), stamp);
  mkdirSync(backupDir, { recursive: true });
  if (existsSync(dictPath)) {
    cpSync(dictPath, join(backupDir, 'typo_dict.json'));
    if (existsSync(typoDictMetaPath())) {
      cpSync(typoDictMetaPath(), join(backupDir, 'typo_dict.meta.json'));
    }
  } else {
    // 初回保存時: undo で空ストアに戻せるよう空の状態をバックアップに書く
    writeFileSync(join(backupDir, 'typo_dict.json'), serializeTypoDict(emptyTypoDict()));
    writeFileSync(
      join(backupDir, 'typo_dict.meta.json'),
      `${JSON.stringify({ observations: {}, lastSeen: {} }, null, 2)}\n`,
    );
  }

  writeFileSync(dictPath, serializeTypoDict(snapshot.typoDict));
  writeFileSync(typoDictMetaPath(), `${JSON.stringify(snapshot.typoDictMeta, null, 2)}\n`);
}

/** 修正履歴の 1 レコードを <root>/.learning/history へ JSON で追記する。 */
export function appendHistory(projectRoot: string, record: HistoryRecord): void {
  const dir = historyDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const fileName = `${record.timestamp.replace(/[:.]/g, '-')}-${record.videoId}.json`;
  writeFileSync(join(dir, fileName), `${JSON.stringify(record, null, 2)}\n`);
}
