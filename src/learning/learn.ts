import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotBaseline } from './baseline';
import { baselineDir } from './paths';
import { parseTranscriptFixed } from './transcriptFixed';
import { diffTranscriptFixed } from './segmentDiff';
import { distillWordRules } from './distill';
import { loadStore, saveStore, appendHistory } from './store';
import { promoteWordRules, partitionByConflict } from './promote';
import type { HistoryRecord, PromotionSummary, TrackedFile, TranscriptFixed } from './types';

/** ファイルを読み込んでパースする。失敗時はファイルパスを含むエラーを投げる。 */
function parseTrackedFile(filePath: string): TranscriptFixed {
  try {
    return parseTranscriptFixed(readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`learnFinish: ${filePath} を読み込めません: ${(e as Error).message}`);
  }
}

/**
 * 読込時に自動でベースライン退避する追跡ファイル。
 * telopData.ts / seData.ts の relPath は src/server/loadProjectFiles.ts の
 * TELOP_DATA_REL / SE_DATA_REL と同じ値（サーバ層と学習層の独立を保つため意図的に文字列を複製）。
 */
export const TRACKED_FILES: TrackedFile[] = [
  { stage: 'transcript-fix', relPath: 'transcript_fixed.json' },
  { stage: 'telop-fix', relPath: 'src/テロップテンプレート/telopData.ts' },
  { stage: 'se-fix', relPath: 'src/SoundEffects/seData.ts' },
];

/** 学習開始: 追跡ファイルのベースラインをスナップショットする。 */
export function learnStart(projectRoot: string): void {
  snapshotBaseline(projectRoot, TRACKED_FILES);
}

/**
 * 学習完了: ベースラインと最終ファイルを差分し、語句ルールを蒸留・自動昇格し、
 * 修正履歴を残して昇格サマリーを返す。ベースライン未取得の段階はスキップする。
 */
export function learnFinish(projectRoot: string, videoId: string): PromotionSummary {
  const baseFile = join(baselineDir(projectRoot), 'transcript_fixed.json');
  const finalFile = join(projectRoot, 'transcript_fixed.json');

  // baseFile がない = learnStart 未実行、finalFile がない = 差分対象なし。どちらも空サマリーで即返す。
  if (!existsSync(baseFile) || !existsSync(finalFile)) {
    return { videoId, autoPromoted: [], skippedConflicts: [] };
  }

  const baseline = parseTrackedFile(baseFile);
  const final = parseTrackedFile(finalFile);
  const rules = distillWordRules(diffTranscriptFixed(baseline, final));

  const record: HistoryRecord = {
    videoId,
    timestamp: new Date().toISOString(),
    diffs: [{ stage: 'transcript-fix', wordReplacements: rules }],
  };
  appendHistory(projectRoot, record);

  const { promotable, conflicts } = partitionByConflict(loadStore(), rules);
  if (promotable.length > 0) {
    saveStore(promoteWordRules(loadStore(), promotable, videoId));
  }

  return { videoId, autoPromoted: promotable, skippedConflicts: conflicts };
}
