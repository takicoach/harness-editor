// 並び替え編集を含む実プロジェクト（projects/04_golf-short-0811）の cutData.ts を
// そのまま写した回帰フィクスチャ。id 6 は原素材 602-1383 なのに再生順は 6 番目
// （＝再生順と原素材順が一致しない）。案A の写像・往復保存の正しさをここで固定する。
export const CUT_DATA_REORDERED_SOURCE = `// src/cutData.ts
// SuperMovie Cut (retake 2/2): 音声スパイク検出+ffmpegフレーム目視検証で実演スイング3箇所を保護。
export interface CutSegment {
  id: number;
  originalStart: number;
  originalEnd: number;
  playbackStart: number;
  playbackEnd: number;
}

export const cutData: CutSegment[] = [
  { id: 1, originalStart: 378, originalEnd: 589, playbackStart: 0, playbackEnd: 211 },
  { id: 2, originalStart: 1756, originalEnd: 1917, playbackStart: 211, playbackEnd: 372 },
  { id: 3, originalStart: 1929, originalEnd: 2187, playbackStart: 372, playbackEnd: 630 },
  { id: 4, originalStart: 2187, originalEnd: 2305, playbackStart: 630, playbackEnd: 748 },
  { id: 5, originalStart: 2661, originalEnd: 2788, playbackStart: 748, playbackEnd: 875 },
  { id: 6, originalStart: 602, originalEnd: 1383, playbackStart: 875, playbackEnd: 1656 },
  { id: 7, originalStart: 4517, originalEnd: 4999, playbackStart: 1656, playbackEnd: 2138 },
  { id: 8, originalStart: 4999, originalEnd: 5133, playbackStart: 2138, playbackEnd: 2272 },
  { id: 9, originalStart: 5133, originalEnd: 5275, playbackStart: 2272, playbackEnd: 2414 },
  { id: 10, originalStart: 5299, originalEnd: 5576, playbackStart: 2414, playbackEnd: 2691 },
  { id: 11, originalStart: 5576, originalEnd: 5691, playbackStart: 2691, playbackEnd: 2806 },
  { id: 12, originalStart: 8629, originalEnd: 8922, playbackStart: 2806, playbackEnd: 3099 },
  { id: 13, originalStart: 10836, originalEnd: 10943, playbackStart: 3099, playbackEnd: 3206 },
  { id: 14, originalStart: 10959, originalEnd: 11025, playbackStart: 3206, playbackEnd: 3272 },
];

export const ORIGINAL_DURATION_FRAMES = 11228;
export const CUT_DURATION_FRAMES = 3272;
`;

/** 04_golf-short-0811 の videoConfig.ts（原本 11228 フレーム）。 */
export const VIDEO_CONFIG_REORDERED_SOURCE = `export type VideoFormat = 'youtube' | 'short' | 'square';
export const FORMAT: VideoFormat = 'short';
export const FPS = 59.94005994005994;
export const DURATION_FRAMES = 11228;
export const VIDEO_FILE = 'main.mp4';
const RESOLUTION_MAP = {
  youtube: { width: 1920, height: 1080 },
  short: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
} as const;
export const RESOLUTION = RESOLUTION_MAP[FORMAT];
`;

/**
 * 04 のカット結果を「隣接区間マージ後」で表した期待値（原素材順）。
 * cutData.ts の 14 区間のうち 3-4 / 7-8-9 / 10-11 は原素材上で隣接しているため、
 * 削除区間モデル（CutRegion[]）へ落とすと 1 区間へ融合する（本変更以前からの仕様）。
 */
export const EXPECTED_MERGED_ORIGINAL_RANGES = [
  { originalStart: 378, originalEnd: 589 },
  { originalStart: 602, originalEnd: 1383 },
  { originalStart: 1756, originalEnd: 1917 },
  { originalStart: 1929, originalEnd: 2305 },
  { originalStart: 2661, originalEnd: 2788 },
  { originalStart: 4517, originalEnd: 5275 },
  { originalStart: 5299, originalEnd: 5691 },
  { originalStart: 8629, originalEnd: 8922 },
  { originalStart: 10836, originalEnd: 10943 },
  { originalStart: 10959, originalEnd: 11025 },
];

/** 上記マージ後の区間を「再生順」に並べたもの（cutData.ts の配列順に一致）。 */
export const EXPECTED_PLAYBACK_ORDER = [
  { originalStart: 378, originalEnd: 589, playbackStart: 0, playbackEnd: 211 },
  { originalStart: 1756, originalEnd: 1917, playbackStart: 211, playbackEnd: 372 },
  { originalStart: 1929, originalEnd: 2305, playbackStart: 372, playbackEnd: 748 },
  { originalStart: 2661, originalEnd: 2788, playbackStart: 748, playbackEnd: 875 },
  { originalStart: 602, originalEnd: 1383, playbackStart: 875, playbackEnd: 1656 },
  { originalStart: 4517, originalEnd: 5275, playbackStart: 1656, playbackEnd: 2414 },
  { originalStart: 5299, originalEnd: 5691, playbackStart: 2414, playbackEnd: 2806 },
  { originalStart: 8629, originalEnd: 8922, playbackStart: 2806, playbackEnd: 3099 },
  { originalStart: 10836, originalEnd: 10943, playbackStart: 3099, playbackEnd: 3206 },
  { originalStart: 10959, originalEnd: 11025, playbackStart: 3206, playbackEnd: 3272 },
];
