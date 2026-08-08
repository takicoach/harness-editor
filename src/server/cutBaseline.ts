import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CutRegion } from '../core/types';
import type { LearningVideoInfo } from '../core/cutLearning';

const BASELINE_FILE = 'cut-baseline.json';

/** 文字起こしドリフト検知用の軽い指紋。 */
export interface TranscriptDigest {
  durationMs: number;
  wordCount: number;
}

/** cut-baseline.json の内容。 */
export interface CutBaseline {
  schemaVersion: 1;
  capturedAt: string;
  video: LearningVideoInfo;
  autoCutRegions: CutRegion[];
  transcriptDigest: TranscriptDigest;
}

function baselinePath(dir: string): string {
  return join(dir, BASELINE_FILE);
}

/**
 * baseline が無い場合のみ、自動カットの初期状態を書き込む。
 * 既に存在すれば何もしない（自動カットの真の初期状態を守る）。
 * 書込失敗はログに残し例外を投げない（編集を止めない）。
 */
export function snapshotBaselineIfAbsent(
  dir: string,
  autoCutRegions: CutRegion[],
  video: LearningVideoInfo,
  transcriptDigest: TranscriptDigest,
): void {
  const path = baselinePath(dir);
  if (existsSync(path)) return;
  const baseline: CutBaseline = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    video,
    autoCutRegions,
    transcriptDigest,
  };
  try {
    writeFileSync(path, JSON.stringify(baseline, null, 2), 'utf8');
    console.log(`[sme] cut-baseline.json を作成: ${dir}`);
  } catch (err) {
    console.warn('[sme] cut-baseline.json の書込に失敗:', err);
  }
}

function isTranscriptDigest(v: unknown): v is TranscriptDigest {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return typeof d['durationMs'] === 'number' && typeof d['wordCount'] === 'number';
}

function isCutBaseline(v: unknown): v is CutBaseline {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    b['schemaVersion'] === 1 &&
    Array.isArray(b['autoCutRegions']) &&
    isTranscriptDigest(b['transcriptDigest'])
  );
}

/** baseline を読む。不在・壊れている場合は null。 */
export function readCutBaseline(dir: string): CutBaseline | null {
  const path = baselinePath(dir);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isCutBaseline(parsed)) {
      console.warn('[sme] cut-baseline.json のスキーマが不正: 無視します');
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn('[sme] cut-baseline.json の読込に失敗:', err);
    return null;
  }
}
