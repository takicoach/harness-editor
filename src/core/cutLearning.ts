import { normalizeCutRegions } from './cutEngine';
import type { CutRegion, Transcript } from './types';

/** minuend の各区間から subtrahend に重なる部分を削った区間集合を返す（入出力とも正規化）。 */
export function subtractRegions(minuend: CutRegion[], subtrahend: CutRegion[]): CutRegion[] {
  const subs = normalizeCutRegions(subtrahend);
  let pieces = normalizeCutRegions(minuend);
  for (const s of subs) {
    const next: CutRegion[] = [];
    for (const r of pieces) {
      if (s.end <= r.start || s.start >= r.end) { next.push(r); continue; }
      if (s.start > r.start) next.push({ start: r.start, end: s.start });
      if (s.end < r.end) next.push({ start: s.end, end: r.end });
    }
    pieces = next;
  }
  return pieces;
}

export interface CutDelta { addedRegions: CutRegion[]; restoredRegions: CutRegion[]; }
export function computeCutDelta(auto: CutRegion[], final: CutRegion[]): CutDelta {
  return { addedRegions: subtractRegions(final, auto), restoredRegions: subtractRegions(auto, final) };
}

export interface WordLabel {
  text: string; startFrame: number; endFrame: number; autoCut: boolean; finalCut: boolean;
}
// ms→原本フレーム。sourceOffsetMs は transcript 原点とプロジェクト原点のズレ補正。
// buildWordChips（src/core/wordChips.ts）と同式に揃える。現状の全呼び出しは offset 未指定＝0。
function msToFrame(ms: number, fps: number, sourceOffsetMs: number): number {
  return Math.round(((ms - sourceOffsetMs) / 1000) * fps);
}
function isContained(startFrame: number, endFrame: number, regions: CutRegion[]): boolean {
  for (const r of normalizeCutRegions(regions)) {
    if (startFrame >= r.start && endFrame <= r.end) return true;
  }
  return false;
}
export function labelWords(
  transcript: Transcript,
  fps: number,
  auto: CutRegion[],
  final: CutRegion[],
  sourceOffsetMs = 0,
): WordLabel[] {
  return transcript.words.map((w) => {
    const startFrame = msToFrame(w.start, fps, sourceOffsetMs);
    const endFrame = msToFrame(w.end, fps, sourceOffsetMs);
    return { text: w.text, startFrame, endFrame, autoCut: isContained(startFrame, endFrame, auto), finalCut: isContained(startFrame, endFrame, final) };
  });
}

export interface WordCount { text: string; count: number; }
export interface RuleSummary { keptByAutoCutByHuman: WordCount[]; cutByAutoKeptByHuman: WordCount[]; }
function countByText(words: WordLabel[]): WordCount[] {
  const map = new Map<string, number>();
  for (const w of words) map.set(w.text, (map.get(w.text) ?? 0) + 1);
  return [...map.entries()].map(([text, count]) => ({ text, count }))
    .sort((a, b) => (b.count - a.count) || a.text.localeCompare(b.text, 'ja'));
}
export function summarizeForRules(words: WordLabel[]): RuleSummary {
  return {
    keptByAutoCutByHuman: countByText(words.filter((w) => !w.autoCut && w.finalCut)),
    cutByAutoKeptByHuman: countByText(words.filter((w) => w.autoCut && !w.finalCut)),
  };
}

export interface LearningVideoInfo { file: string; fps: number; durationFrames: number; }

/** transcript ドリフト判定の許容比（10%）。durationMs / wordCount のいずれかがこれを超えたら drift。 */
export const TRANSCRIPT_DRIFT_TOLERANCE = 0.1;

/** transcript 指紋の比較用（baseline の transcriptDigest と同形）。 */
export interface TranscriptMetrics {
  durationMs: number;
  wordCount: number;
}

/** baseline 取得時の指紋と現在値を比べ、durationMs か wordCount のどちらかが許容比超なら true。 */
export function isTranscriptDrifted(
  baseline: TranscriptMetrics,
  current: TranscriptMetrics,
  tolerance: number = TRANSCRIPT_DRIFT_TOLERANCE,
): boolean {
  const relDiff = (a: number, b: number): number => Math.abs(a - b) / Math.max(a, b, 1);
  return (
    relDiff(baseline.durationMs, current.durationMs) > tolerance ||
    relDiff(baseline.wordCount, current.wordCount) > tolerance
  );
}

export interface CutLearningRecord {
  schemaVersion: 1; savedAt: string; video: LearningVideoInfo;
  autoCutRegions: CutRegion[]; finalCutRegions: CutRegion[];
  delta: CutDelta; words: WordLabel[]; ruleSummary: RuleSummary;
  /** 保存時 transcript が baseline 取得時から大きくズレていたか（再 transcribe 検知）。 */
  transcriptDrifted: boolean;
}
export interface BuildLearningRecordInput {
  auto: CutRegion[]; final: CutRegion[]; transcript: Transcript; video: LearningVideoInfo; savedAt: string;
  /** transcript 原点ズレ補正（既定 0＝補正なし）。labelWords へ素通しする。 */
  sourceOffsetMs?: number;
  /** baseline 取得時の transcript 指紋。渡すと現 transcript と比較し transcriptDrifted を立てる。 */
  transcriptDigest?: TranscriptMetrics;
}
export function buildLearningRecord(input: BuildLearningRecordInput): CutLearningRecord {
  const { auto, final, transcript, video, savedAt, sourceOffsetMs = 0, transcriptDigest } = input;
  const words = labelWords(transcript, video.fps, auto, final, sourceOffsetMs);
  const transcriptDrifted =
    transcriptDigest !== undefined &&
    isTranscriptDrifted(transcriptDigest, { durationMs: transcript.durationMs, wordCount: transcript.words.length });
  return {
    schemaVersion: 1, savedAt, video,
    autoCutRegions: normalizeCutRegions(auto), finalCutRegions: normalizeCutRegions(final),
    delta: computeCutDelta(auto, final), words, ruleSummary: summarizeForRules(words),
    transcriptDrifted,
  };
}

/** 複数の WordCount[] をテキストごとに合算し、件数降順（同数はテキスト昇順）で返す。 */
export function mergeWordCounts(lists: WordCount[][]): WordCount[] {
  const map = new Map<string, number>();
  for (const list of lists) {
    for (const wc of list) map.set(wc.text, (map.get(wc.text) ?? 0) + wc.count);
  }
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => (b.count - a.count) || a.text.localeCompare(b.text, 'ja'));
}

/** 集約結果に載せる各プロジェクトの軽いメタ。 */
export interface AggregatedProjectInfo {
  path: string;
  video: LearningVideoInfo;
  savedAt: string;
  transcriptDrifted: boolean;
}

/** cutLearning-aggregated.json の本体（generatedAt は呼び出し側で付与）。 */
export interface AggregatedCutLearning {
  schemaVersion: 1;
  projectCount: number;
  ruleSummary: RuleSummary;
  projects: AggregatedProjectInfo[];
  records: CutLearningRecord[];
}

/** path 付きレコード列を集約オブジェクトへ畳み込む純関数。 */
export function aggregateRecords(items: { path: string; record: CutLearningRecord }[]): AggregatedCutLearning {
  // ①導入前に書かれた古い cutLearning.json は transcriptDrifted を持たない。
  // 出力 records[] は CutLearningRecord[] 契約なので、欠落を false で補完して型と実体を揃える。
  const records = items.map((i) => ({ ...i.record, transcriptDrifted: i.record.transcriptDrifted ?? false }));
  return {
    schemaVersion: 1,
    projectCount: items.length,
    ruleSummary: {
      keptByAutoCutByHuman: mergeWordCounts(records.map((r) => r.ruleSummary.keptByAutoCutByHuman)),
      cutByAutoKeptByHuman: mergeWordCounts(records.map((r) => r.ruleSummary.cutByAutoKeptByHuman)),
    },
    projects: items.map((i) => ({
      path: i.path,
      video: i.record.video,
      savedAt: i.record.savedAt,
      transcriptDrifted: i.record.transcriptDrifted ?? false,
    })),
    records,
  };
}
