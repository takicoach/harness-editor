// ==== 動画設定（Single Source of Truth） ====
// /supermovie-init が自動設定します
// format に応じて全コンポーネントが参照する値を一元管理

export type VideoFormat = 'youtube' | 'short' | 'square';

// ---- ここを /supermovie-init が書き換える ----
export const FORMAT: VideoFormat = 'youtube';
export const FPS = 30;
export const DURATION_FRAMES = 1500; // placeholder
export const VIDEO_FILE = 'main.mp4';
// ---- ここまで ----

// フォーマット別の解像度
const RESOLUTION_MAP = {
  youtube: { width: 1920, height: 1080 },
  short: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
} as const;

// フォーマット別のテロップ設定
const TELOP_CONFIG_MAP = {
  youtube: {
    fontSize: 80,
    titleFontSize: 42,
    maxCharsPerLine: 18,
    lineBreakThreshold: 15,
    maxCharsPerTelop: 36,
    bottomOffset: 100,
    titleTop: 40,
    titleLeft: 40,
    maxWidth: '85%',
    containerPadding: '0 60px',
    readingSpeed: 5, // 文字/秒
  },
  short: {
    // ショート標準（golf-short-gold 実戦投入値）: 胸元位置 bottomOffset 540 / 84px / 1行10字
    fontSize: 84,
    titleFontSize: 30,
    maxCharsPerLine: 10,
    lineBreakThreshold: 10,
    maxCharsPerTelop: 20,
    bottomOffset: 540,
    titleTop: 220, // TikTok/IG 上部UI（タブ・検索）回避のセーフゾーン（2026-08-18 試写FB）
    titleLeft: 64,
    maxWidth: '92%',
    containerPadding: '0 30px',
    readingSpeed: 4,
  },
  square: {
    fontSize: 66,
    titleFontSize: 36,
    maxCharsPerLine: 15,
    lineBreakThreshold: 12,
    maxCharsPerTelop: 30,
    bottomOffset: 140,
    titleTop: 40,
    titleLeft: 30,
    maxWidth: '90%',
    containerPadding: '0 40px',
    readingSpeed: 4.5,
  },
} as const;

// エクスポート（全コンポーネントがこれを参照する）
export const RESOLUTION = RESOLUTION_MAP[FORMAT];
export const TELOP_CONFIG = TELOP_CONFIG_MAP[FORMAT];
