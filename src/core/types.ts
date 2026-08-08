// Harness Editor コアの型定義。
// TelopSegment / CutSegment は ハーネス本体のデータ形式に対応する。

import type { LayoutKeyframe } from './layoutKeyframes';

/** テロップのスタイル（ハーネス形式の TelopSegment.style と一致）。 */
export type TelopStyle = 'normal' | 'emphasis' | 'warning' | 'success';

/** テロップテンプレート番号（テロップパック導入時は 1..TELOP_PACK_COUNT。ハーネス既定は 1..6）。 */
export type TelopTemplate = number;

/** テロップアニメーション（ハーネス形式の TelopSegment.animation と一致）。 */
export type TelopAnimation =
  | 'none' | 'slideIn' | 'fadeOnly' | 'slideFromLeft' | 'fadeBlurFromBottom'
  | 'slideLeftFadeBlur' | 'fadeFromRight' | 'fadeFromLeft' | 'charByChar';

/** テロップ位置。フレーム中心を原点とした正規化オフセット（-1..1）。 */
export interface TelopPosition {
  x: number;
  y: number;
}

/**
 * メイン動画の自由レイアウト（全区間共通・静的な空間変形・PiP 風）。
 * position は中心原点の正規化オフセット -1..1、scale は 0.1..5、background は CSS カラー。
 * 恒等（scale 1・position {0,0}）は「レイアウトなし」＝全画面（背景は見えない）。
 */
export interface MainLayout {
  position: TelopPosition;
  scale: number;
  background: string;
  /** ユーザー回転(度・-180..180、既定 0)。 */
  rotation: number;
  /** 水平反転(左右・既定 false)。 */
  flipH: boolean;
  /** 垂直反転(上下・既定 false)。 */
  flipV: boolean;
}

/** 区間ごとレイアウト上書き。背景は持たない(全体共通)。motion は 2点アニメ（任意）。 */
export type SegmentLayout = Omit<MainLayout, 'background'> & {
  /** 2点アニメ（区間の頭→終わりで補間・任意）。 */
  motion?: import('./motion').Motion;
};

/**
 * ハーネス形式の telopData.ts が持つ TelopSegment。
 * position / scale は上流拡張（Task 2 契約）。startFrame/endFrame はカット後（再生）タイムライン。
 */
export interface TelopSegment {
  id: number;
  startFrame: number;
  endFrame: number;
  text: string;
  highlight?: string;
  style?: TelopStyle;
  template?: TelopTemplate;
  animation?: TelopAnimation;
  position?: TelopPosition;
  scale?: number;
  /** エディタ拡張（任意）: 2点アニメ（開始→終了の補間）。ハーネス本体のレンダラは無視する。 */
  motion?: import('./motion').Motion;
  /**
   * エディタ拡張（任意）: 完全にカットされたテロップの原本タイムライン区間。
   * 行削除されたテロップは startFrame/endFrame だけでは原本区間を復元できないため、
   * エディタが原本フレームをここへ書き出す。ハーネス本体のレンダラはこのフィールドを無視する。
   */
  originalStart?: number;
  originalEnd?: number;
  /**
   * エディタ拡張（任意）: true なら「手動追加（装飾）テロップ」を表す。
   * タイムライン上で字幕（印なし）と別段・別色にするためのフラグ。
   * ハーネス本体のレンダラはこのフィールドを無視する。
   */
  manual?: boolean;
}

/** ハーネス形式の cutData.ts が持つ CutSegment（残す＝再生する区間）。 */
export interface CutSegment {
  id: number;
  originalStart: number;
  originalEnd: number;
  playbackStart: number;
  playbackEnd: number;
}

/** エディタ内部のカット表現: 原本タイムラインから削除する区間（end は排他的）。 */
export interface CutRegion {
  start: number;
  end: number;
}

/**
 * ハーネス形式の seData.ts が持つ SoundEffect。
 * startFrame はカット後（再生）タイムラインのフレーム。エディタ外では ハーネス側が直接使う。
 */
export interface SoundEffect {
  id: number;
  startFrame: number;
  /** 区間の終端（再生フレーム）。未指定は従来の固定 90 扱い（後方互換）。 */
  endFrame?: number;
  file: string;
  volume?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

/**
 * エディタ内部の SE 表現。
 * originalStart は原本タイムラインのフレーム（内部の正）。
 * 再生フレームは projectSe() で都度算出する。
 */
export interface EditorSe {
  id: number;
  originalStart: number;
  /** 区間の終端（原本フレーム・内部は常に持つ）。 */
  originalEnd: number;
  file: string;
  volume?: number;
  /** フェードイン長（フレーム・未指定 0）。 */
  fadeInFrames?: number;
  /** フェードアウト長（フレーム・未指定 0）。 */
  fadeOutFrames?: number;
  /** セッション専用: 新規挿入直後で長さ未確定（音源デコード後に自然長へ合わせる）。保存しない。 */
  autoLength?: boolean;
  /** セッション専用: 挿入直後で音量未確定（音源デコード後にラウドネス正規化）。保存しない。 */
  autoVolume?: boolean;
}

/** 挿入要素の出入りアニメ種別。 */
export type ElementAnimKind = 'none' | 'fade' | 'zoom' | 'pop' | 'slideIn';

/** スライド/ワイプの方向（要素は slideIn で使用）。 */
export type SlideDirection = 'left' | 'right' | 'up' | 'down';

/** 挿入要素の出入りアニメ 1 つぶん。frames はアニメ長（フレーム）。 */
export interface ElementAnim {
  kind: ElementAnimKind;
  frames: number;
  /** slideIn のときの入ってくる方向（未指定＝left）。 */
  direction?: SlideDirection;
}

/**
 * シーン転換の種別。fade 系（尺不変・オーバーレイ）と重なる系（尺が縮む・Plan 3）。
 * 本計画（Plan 2）では fade 系のみ描画・UI 提供する。
 */
export type SceneTransitionKind =
  | 'fadeBlack' | 'fadeWhite' | 'fadeColor'
  | 'crossfade' | 'slide' | 'wipe';

/**
 * シーン転換 1 件。at でつなぎ目（削除カット区間の原本開始フレーム）か頭尾を指す。
 * durationFrames はまたぐ長さ（fade 系では山なりオーバーレイの全長）。
 */
export interface SceneTransition {
  id: number;
  at: 'head' | 'tail' | number;
  kind: SceneTransitionKind;
  durationFrames: number;
  /** fadeColor のときの色（CSS 色）。他 kind では未指定。 */
  color?: string;
  /** slide/wipe（Plan 3）の方向。本計画では未使用。 */
  direction?: SlideDirection;
}

/**
 * ハーネス形式の insertImageData.ts が持つ ImageSegment。
 * startFrame / endFrame はカット後（再生）タイムラインのフレーム。エディタ外では ハーネス側が直接使う。
 */
export interface ImageSegment {
  id: number;
  startFrame: number;
  endFrame: number;
  file: string;
  type: ImageType;
  scale?: number;
  /** 中心からの正規化オフセット（x:-1..1, y:-1..1）。未指定＝中央。サブ動画と同じ意味論。 */
  position?: TelopPosition;
  /** ユーザー不透明度（0..1、未指定＝1）。フェード opacity に乗算される。 */
  opacity?: number;
  /** ユーザー回転（度、-180..180、未指定＝0）。配置 transform に rotate() で適用。 */
  rotation?: number;
  /** 2点アニメ（開始→終了の補間・任意）。 */
  motion?: import('./motion').Motion;
  /** 登場アニメ（未指定時の既定は呼び出し側が供給：画像=フェード8fr / サブ動画=なし）。 */
  enter?: ElementAnim;
  /** 退場アニメ（未指定時の既定は呼び出し側が供給）。 */
  exit?: ElementAnim;
}

/** 挿入画像のタイプ。ハーネス形式の ImageSegment.type と一致。 */
export type ImageType = 'photo' | 'infographic' | 'overlay';

/**
 * エディタ内部の画像表現。
 * originalStart / originalEnd は原本タイムラインのフレーム（内部の正）。
 * 再生フレームは projectImages() で都度算出する。
 */
export interface EditorImage {
  id: number;
  originalStart: number;
  originalEnd: number;
  file: string;
  type: ImageType;
  scale?: number;
  /** 中心からの正規化オフセット（x:-1..1, y:-1..1）。未指定＝中央。サブ動画と同じ意味論。 */
  position?: TelopPosition;
  /** ユーザー不透明度（0..1、未指定＝1）。フェード opacity に乗算される。 */
  opacity?: number;
  /** ユーザー回転（度、-180..180、未指定＝0）。配置 transform に rotate() で適用。 */
  rotation?: number;
  /** 2点アニメ（開始→終了の補間・任意）。 */
  motion?: import('./motion').Motion;
  /** 登場アニメ（未指定時の既定は呼び出し側が供給：画像=フェード8fr / サブ動画=なし）。 */
  enter?: ElementAnim;
  /** 退場アニメ（未指定時の既定は呼び出し側が供給）。 */
  exit?: ElementAnim;
}

/**
 * ハーネス形式の insertVideoData.ts が持つ VideoInsert（サブ動画インサート＝Bロール）。
 * startFrame / endFrame はカット後（再生）タイムラインのフレーム。エディタ外では ハーネス側が直接使う。
 * sourceInFrame はサブ動画ソース内のイン点（startFrame 時点で再生するサブ動画のフレーム＝同期）。
 * position / scale は上流拡張（任意・未指定なら全画面中央。ImageSegment には無い VideoInsert 固有の拡張）。
 */
export interface VideoInsert {
  id: number;
  startFrame: number;
  endFrame: number;
  file: string;
  sourceInFrame: number;
  position?: TelopPosition;
  scale?: number;
  /** 登場アニメ（未指定時の既定は呼び出し側が供給：画像=フェード8fr / サブ動画=なし）。 */
  enter?: ElementAnim;
  /** 退場アニメ（未指定時の既定は呼び出し側が供給）。 */
  exit?: ElementAnim;
  /** 再生速度（倍率・未指定＝1.0）。0.1〜16。D_source = (endFrame-startFrame)×playbackRate を保つ。 */
  playbackRate?: number;
}

/**
 * エディタ内部のサブ動画インサート表現。
 * originalStart / originalEnd は原本（カット前）タイムラインのフレーム（内部の正）。
 * 再生フレームは projectVideoInserts() で都度算出する。
 * sourceInFrame はサブ動画ソース自身のフレームなのでメインのカット射影では不変。
 */
export interface EditorVideoInsert {
  id: number;
  originalStart: number;
  originalEnd: number;
  file: string;
  sourceInFrame: number;
  position?: TelopPosition;
  scale?: number;
  /** 登場アニメ（未指定時の既定は呼び出し側が供給：画像=フェード8fr / サブ動画=なし）。 */
  enter?: ElementAnim;
  /** 退場アニメ（未指定時の既定は呼び出し側が供給）。 */
  exit?: ElementAnim;
  /** 再生速度（倍率・未指定＝1.0）。0.1〜16。D_source = (endFrame-startFrame)×playbackRate を保つ。 */
  playbackRate?: number;
}

/** ダッキングの強さ（弱/中/強）。 */
export type DuckingStrength = 'weak' | 'mid' | 'strong';

/** ダッキングのグローバル設定（プロジェクト単位）。 */
export interface DuckingSettings {
  enabled: boolean;
  strength: DuckingStrength;
}

/** ダッキングの焼き込み結果（クリップ内相対フレーム）。BgmClip と一緒に書き出す派生データ。 */
export interface DuckEnvelope {
  /** 下げる中核区間（クリップ内相対フレーム・[start,end) 排他・昇順・非重複）。 */
  regions: Array<{ start: number; end: number }>;
  /** 区間内で基準音量へ掛ける係数（0..1）。 */
  gain: number;
  /** 下げ始めの線形ランプ長（フレーム・>=1）。 */
  attackFrames: number;
  /** 戻りの線形ランプ長（フレーム・>=1）。 */
  releaseFrames: number;
}

/** BGM クリップ（区間で配置する背景音楽）。startFrame/endFrame は再生（カット後）フレーム。 */
export interface BgmClip {
  id: number;
  file: string;
  startFrame: number;
  endFrame: number;
  volume: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  /** ダッキング焼き込み（未設定＝ダッキング無し・後方互換）。派生のため読み戻さない。 */
  ducking?: DuckEnvelope;
}

/**
 * 編集中の BGM クリップ（原本フレームでアンカー＝カット追従）。
 * EditorVideoInsert と同型で startFrame/endFrame（再生フレーム）は持たず、
 * 再生フレームは projectBgm で都度算出する（stale な再生フレームを持たない）。
 */
export interface EditorBgmClip {
  id: number;
  originalStart: number;
  originalEnd: number;
  file: string;
  volume: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  /** セッション専用: 挿入直後で音量未確定（音源デコード後にラウドネス正規化）。保存しない。 */
  autoVolume?: boolean;
}

export type VideoFormat = 'youtube' | 'short' | 'square';
export type Orientation = 'landscape' | 'portrait' | 'square';

/**
 * タイトル帯の標準スタイル値（合成座標＝原本解像度のピクセル）。
 * ハーネス形式の videoConfig.ts の TELOP_CONFIG から読み取り、プレビューの TitleLayer が
 * 最終書き出しの Title.tsx と同じ位置・フォントで描くために使う。
 */
export interface TitleStyle {
  /** 上端からのオフセット（px）。Title.tsx の TELOP_CONFIG.titleTop。 */
  top: number;
  /** 左端からのオフセット（px）。Title.tsx の TELOP_CONFIG.titleLeft。 */
  left: number;
  /** フォントサイズ（px）。Title.tsx の TELOP_CONFIG.titleFontSize。 */
  fontSize: number;
}

/** videoConfig.ts から読み取る動画設定。 */
export interface VideoConfig {
  format: VideoFormat;
  fps: number;
  /** 原本動画の総フレーム数。 */
  durationFrames: number;
  videoFile: string;
  resolution: { width: number; height: number };
  orientation: Orientation;
  /** タイトル帯の標準スタイル（TELOP_CONFIG 由来・プレビュー忠実描画用）。 */
  titleStyle: TitleStyle;
}

/** project-config.json（任意・参考情報）。 */
export interface ProjectConfig {
  format?: string;
  resolution?: { width: number; height: number };
  fps?: number;
  durationSeconds?: number;
  durationFrames?: number;
  sourceVideo?: string;
  [key: string]: unknown;
}

/** transcript.json の単語（時刻は ms）。 */
export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
  confidence?: number;
}

/** transcript.json のセグメント（時刻は ms）。 */
export interface TranscriptSegment {
  text: string;
  start: number;
  end: number;
}

export interface Transcript {
  durationMs: number;
  words: TranscriptWord[];
  segments: TranscriptSegment[];
}

/**
 * エディタ内部のテロップ表現。
 * originalStart/originalEnd は原本タイムラインのフレーム（内部の正）。
 * 再生フレームは projectTelops() で都度算出する。
 */
export interface EditorTelop {
  id: number;
  originalStart: number;
  originalEnd: number;
  text: string;
  highlight?: string;
  style?: TelopStyle;
  template?: TelopTemplate;
  animation?: TelopAnimation;
  position?: TelopPosition;
  scale?: number;
  /** 2点アニメ（開始→終了の補間・任意）。 */
  motion?: import('./motion').Motion;
  /** true なら手動追加（装飾）テロップ。字幕（印なし）と別段・別色にする。 */
  manual?: boolean;
}

/** タイトル層の永続化セグメント（src/Title/titleData.ts の配列要素）。 */
export interface TitleSegment {
  id: number;
  startFrame: number;
  endFrame: number;
  text: string;
  /** カット区間に飲まれた場合のみ保存される原本フレーム（復元用）。 */
  originalStart?: number;
  originalEnd?: number;
}

/** エディタ内部のタイトル（原本フレームアンカー）。 */
export interface EditorTitle {
  id: number;
  originalStart: number;
  originalEnd: number;
  text: string;
}

/** 単語チップ（テキストベース編集の最小単位、時刻はフレーム）。 */
export interface WordChip {
  text: string;
  originalStart: number;
  originalEnd: number;
}

/** 読み込んだプロジェクト一式（エディタの編集対象）。 */
export interface EditorProject {
  videoConfig: VideoConfig;
  projectConfig: ProjectConfig | null;
  transcript: Transcript;
  telops: EditorTelop[];
  cutRegions: CutRegion[];
  /** 原本フレームアンカーの効果音（編集の正）。seData.ts 不在なら空配列。 */
  se: EditorSe[];
  /** 原本フレームアンカーの挿入画像（編集の正）。insertImageData.ts 不在なら空配列。 */
  images: EditorImage[];
  /** 再生成時にヘッダ・import を保つため原本ソースを保持。 */
  telopDataSource: string;
  cutDataSource: string | null;
  /** seData.ts の原本ソース。ファイル不在なら null。 */
  seDataSource: string | null;
  /** insertImageData.ts の原本ソース。ファイル不在なら null。 */
  insertImageDataSource: string | null;
  /** 原本フレームアンカーのサブ動画インサート（編集の正）。insertVideoData.ts 不在なら未設定/空。 */
  videoInserts?: EditorVideoInsert[];
  /** insertVideoData.ts の原本ソース。ファイル不在なら null。任意（Plan 2 で必須化検討）。 */
  videoInsertDataSource?: string | null;
  /** 原本フレームアンカーの BGM クリップ（編集の正）。bgmData.ts 不在なら空配列。 */
  bgm?: EditorBgmClip[];
  /** bgmData.ts の原本ソース。ファイル不在なら null。 */
  bgmDataSource?: string | null;
  /** ダッキングのグローバル設定（プロジェクト単位・未設定＝OFF扱い）。 */
  ducking?: DuckingSettings;
  /** 原本フレームアンカーのタイトル（編集の正）。titleData.ts 不在なら空配列。 */
  titles: EditorTitle[];
  /** titleData.ts の原本ソース。ファイル不在なら null。 */
  titleDataSource: string | null;
  /** 原本フレームアンカーの図形オーバーレイ（編集の正）。shapeData.ts 不在なら未設定/空。 */
  shapes?: EditorShape[];
  /** shapeData.ts の原本ソース。ファイル不在なら null。 */
  shapeDataSource?: string | null;
  /** シーン転換設定（編集の正）。未設定なら空扱い。 */
  sceneTransitions?: SceneTransition[];
  /** transitionData.ts の原本ソース。ファイル不在なら null。 */
  transitionDataSource?: string | null;
  /** メイン動画の自由レイアウト（全区間共通・未設定＝全画面）。Plan 2 で永続化。 */
  mainLayout?: MainLayout;
  /** 区間 id → レイアウト上書き(個別指定のみ)。未設定・空なら全区間が全体レイアウトに従う。Plan 2 で永続化。 */
  segmentLayouts?: Record<number, SegmentLayout>;
  /**
   * メイン動画の大域キーフレーム列（カット非依存・原本フレームアンカー・originalFrame 昇順）。
   * 2 点以上あればカット区間に縛られずメイン動画レイアウトをこれで連続補間駆動する（区間ごと個別指定・区間 motion は無視）。
   * 未設定・空/1点なら未使用（従来どおり区間ごと個別指定→区間 motion→base）。
   */
  layoutKeyframes?: LayoutKeyframe[];
  /** メイン動画 全体一律の速度（倍率・1.0=速度なし）。 */
  mainSpeed: number;
  /** 区間 id → 倍率（個別指定のみ・全体速度に従う区間は載らない）。 */
  segmentSpeeds: Record<number, number>;
}

// ---------------------------------------------------------------------------
// 図形オーバーレイ型（shapeData.ts 用）
// ---------------------------------------------------------------------------

/** 図形注釈の種類。 */
export type ShapeKind = 'arrow' | 'line' | 'rect' | 'ellipse';

/** 図形の線の太さ（描画時にフレーム高さ比へ換算）。 */
export type ShapeThickness = 'thin' | 'medium' | 'thick';

/**
 * 図形注釈（再生フレーム基準・プロジェクトの shapeData.ts に出力）。
 * 4 種すべてを 2 点 (x1,y1)-(x2,y2)（正規化 0..1・左上原点）で表す。
 * line/arrow=p1→p2 の線分、rect=2点を対角とする矩形、ellipse=2点の枠に内接する楕円。
 */
export interface ShapeSegment {
  id: number;
  startFrame: number;
  endFrame: number;
  kind: ShapeKind;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  thickness: ShapeThickness;
  /** 不透明度（0..1、未指定＝1）。 */
  opacity?: number;
}

/** 図形注釈（原本フレームアンカー・エディタ内部の編集の正）。 */
export interface EditorShape {
  id: number;
  originalStart: number;
  originalEnd: number;
  kind: ShapeKind;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  thickness: ShapeThickness;
  /** 不透明度（0..1、未指定＝1）。 */
  opacity?: number;
}

/** プロジェクト検証の結果。 */
export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/** プロジェクトファイルの不備を表すエラー。 */
export class ProjectFileError extends Error {
  constructor(public readonly file: string, message: string) {
    super(`[${file}] ${message}`);
    this.name = 'ProjectFileError';
  }
}
