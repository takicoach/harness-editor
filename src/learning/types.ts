// ハーネス形式学習ループの型定義。LL Phase A は transcript-fix 段階のみ扱う。
// telop-fix / se-fix は Phase B（テロップ・SE 差分レビュー）で追加（ベースライン自動退避の対象追跡用）。

/** 学習が追跡するハーネス形式パイプラインの段階。 */
export type LearningStage = 'transcript-fix' | 'telop-fix' | 'se-fix';

/** 追跡ファイルの定義。 */
export interface TrackedFile {
  stage: LearningStage;
  /** プロジェクトルートからの相対パス。 */
  relPath: string;
}

/** transcript_fixed.json のうち学習が必要とする部分。 */
export interface TranscriptFixed {
  segments: TranscriptFixedSegment[];
}

export interface TranscriptFixedSegment {
  text: string;
  start: number;
  end: number;
}

/** 語句置換ルール（差分から蒸留した「誤→正」）。 */
export interface WordReplacement {
  before: string;
  after: string;
}

/** ハーネス形式の typo_dict.json 形式（transcript-fix スキルが読む形式）。 */
export interface TypoDict {
  replace: Record<string, string>;
  fillers: { remove: string[]; keep_in_context: string[] };
  preserve: string[];
}

/** typo_dict のサイドカー学習メタ（観測回数・由来）。 */
export interface TypoDictMeta {
  /** replace の各 before キーの観測回数。 */
  observations: Record<string, number>;
  /** replace の各 before キーを最後に観測した動画 ID。 */
  lastSeen: Record<string, string>;
}

/** learn finish が出力する 1 段階ぶんの差分。 */
export interface StageDiff {
  stage: LearningStage;
  wordReplacements: WordReplacement[];
}

/** 修正履歴の 1 レコード（learn finish ごとにプロジェクトへ追記）。 */
export interface HistoryRecord {
  videoId: string;
  timestamp: string;
  diffs: StageDiff[];
}

/** learn finish が返す昇格サマリー。 */
export interface PromotionSummary {
  videoId: string;
  /** 自動昇格された語句ルール。 */
  autoPromoted: WordReplacement[];
  /** 競合（同じ before に別の after）のため自動辞書へ昇格しなかったルール。 */
  skippedConflicts: WordReplacement[];
}

/** グローバルストアのスナップショット（バックアップ・復元の単位）。 */
export interface StoreSnapshot {
  typoDict: TypoDict;
  typoDictMeta: TypoDictMeta;
}
