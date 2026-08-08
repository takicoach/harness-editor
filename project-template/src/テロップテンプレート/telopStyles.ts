import type {
  TelopStyleConfig,
  TelopAnimation,
  TelopTextShadow,
  TelopTextStroke,
  TelopBackground,
  TelopPosition,
} from './telopTypes';

// ===== アニメーションテンプレート =====

// アニメーションなし
export const animation_none: TelopAnimation = {
  name: 'アニメーションなし',
  fadeInDuration: 0,
  fadeOutDuration: 0,
  slideInDistance: 0,
  slideDirection: 'up' as const,
  spring: {
    damping: 20,
    stiffness: 100,
    mass: 0.5,
  },
};

// 左からスライドイン
export const animation_slideFromLeft: TelopAnimation = {
  name: '左からスライドイン',
  fadeInDuration: 8,
  fadeOutDuration: 8,
  slideInDistance: 50,
  slideDirection: 'left' as const,
  spring: {
    damping: 20,
    stiffness: 100,
    mass: 0.5,
  },
};

// 不透明度+ブラー_下から
export const animation_fadeBlurFromBottom: TelopAnimation = {
  name: '不透明度+ブラー_下から',
  fadeInDuration: 10,
  fadeOutDuration: 10,
  slideInDistance: 30,
  slideDirection: 'up' as const,
  spring: {
    damping: 15,
    stiffness: 120,
    mass: 0.5,
  },
};

// スライドイン + フェード（上から）
export const animation_slideIn: TelopAnimation = {
  name: 'スライドイン',
  fadeInDuration: 8,
  fadeOutDuration: 8,
  slideInDistance: 30,
  slideDirection: 'up' as const,
  spring: {
    damping: 20,
    stiffness: 100,
    mass: 0.5,
  },
};

// フェードのみ
export const animation_fadeOnly: TelopAnimation = {
  name: 'フェードのみ',
  fadeInDuration: 8,
  fadeOutDuration: 8,
  slideInDistance: 0,
  slideDirection: 'up' as const,
  spring: {
    damping: 20,
    stiffness: 100,
    mass: 0.5,
  },
};

// 左からスライドイン + 不透明度 + ブラー（複合）
export const animation_slideLeftFadeBlur: TelopAnimation = {
  name: '左スライド+フェード+ブラー',
  fadeInDuration: 10,
  fadeOutDuration: 10,
  slideInDistance: 50,
  slideDirection: 'left' as const,
  spring: {
    damping: 15,
    stiffness: 120,
    mass: 0.5,
  },
};

// 右からフェードイン
export const animation_fadeFromRight: TelopAnimation = {
  name: '右からフェードイン',
  fadeInDuration: 10,
  fadeOutDuration: 10,
  slideInDistance: 40,
  slideDirection: 'right' as const,
  spring: {
    damping: 18,
    stiffness: 100,
    mass: 0.5,
  },
};

// 左からフェードイン（スライド小さめ）
export const animation_fadeFromLeft: TelopAnimation = {
  name: '左からフェードイン',
  fadeInDuration: 10,
  fadeOutDuration: 10,
  slideInDistance: 40,
  slideDirection: 'left' as const,
  spring: {
    damping: 18,
    stiffness: 100,
    mass: 0.5,
  },
};

// 一文字ずつ上からスライドイン
export const animation_charByChar: TelopAnimation = {
  name: '一文字ずつ上から',
  fadeInDuration: 0,
  fadeOutDuration: 8,
  slideInDistance: 25,
  slideDirection: 'down' as const,
  charDelay: 2, // 各文字の遅延フレーム数
  spring: {
    damping: 15,
    stiffness: 200,
    mass: 0.4,
  },
};

// ===== スタイルテンプレート集（TAKICOACH オリジナル・3種） =====
//
// 設計方針:
// - フォントは Noto Sans JP の weight 違いのみ。画像・SVG・外部フォント不使用
// - 全種 `style: 'normal'`（直立体）。グラデーション文字・グラデーション背景は不使用
// - 個性は「形状」で出す（縁取り・帯）
// - 形状パーツは `css`（TelopCssSpec）に置き、Telop.tsx の CSS 描画パスが描く
//
// 番号 01〜03 は拡張テロップパックの 01〜03 と一致させてある（同番号＝同じ見た目）。
// スタイルを増やすときは telopStyles.ts に定義を足し、Telop.tsx の TEMPLATE_MAP と
// telopTypes.ts の TelopTemplateId に番号を追加する。
//
// ⚠️ 装飾の px 値は fontSize 80（youtube 16:9）を基準に調整してある。
//    `videoConfig.ts` の TELOP_CONFIG が fontSize を上書きする（short=56 / square=66）ため、
//    縦型・正方形では文字だけが縮み、装飾は同じ大きさのまま残る。
//    縦型で装飾が大きすぎる場合は該当スタイルの px 値を調整する。

const FAMILY = '"Noto Sans JP", sans-serif';

const NO_SHADOW: TelopTextShadow = {
  offsetX: 0,
  offsetY: 0,
  blur: 0,
  color: 'transparent',
};

const NO_STROKE: TelopTextStroke = {
  width: 0,
  gradient: { start: 'transparent', end: 'transparent' },
};

const NO_BACKGROUND: TelopBackground = {
  enabled: false,
  gradient: 'transparent',
  padding: '0',
  borderRadius: 0,
  backdropFilter: 'none',
  boxShadow: 'none',
  border: 'none',
};

const POSITION: TelopPosition = {
  bottom: 100,
  maxWidth: '85%',
  containerPadding: '0 60px',
};

// ------------------------------------------------------------
// 白黒シンプル系（01〜03）
// ------------------------------------------------------------

// 01: 白文字＋黒縁のみ。背景を選ばない最も安全な定番
export const template1_classicOutline: TelopStyleConfig = {
  name: 'クラシック白抜き',
  font: {
    size: 80,
    weight: 900,
    family: FAMILY,
    style: 'normal',
    lineHeight: 1.35,
    letterSpacing: 1,
    color: '#ffffff',
  },
  textShadow: NO_SHADOW,
  textStroke: { width: 13, gradient: { start: '#000000', end: '#000000' } },
  background: NO_BACKGROUND,
  position: POSITION,
  highlight: { color: '#ffffff', glowOpacity: '0' },
  css: {},
};

// 02: 黒帯＋白文字。明るい実写背景でも安定
export const template2_blackBar: TelopStyleConfig = {
  name: 'ブラックバー',
  font: {
    size: 80,
    weight: 700,
    family: FAMILY,
    style: 'normal',
    lineHeight: 1.35,
    letterSpacing: 0,
    color: '#ffffff',
  },
  textShadow: NO_SHADOW,
  textStroke: NO_STROKE,
  background: {
    ...NO_BACKGROUND,
    enabled: true,
    gradient: '#111318',
    padding: '27px 64px',
    borderRadius: 21,
    boxShadow: '0 21px 53px rgba(0, 0, 0, 0.4)',
  },
  position: POSITION,
  highlight: { color: '#ffd400', glowOpacity: '0' },
  css: {},
};

// 03: 白帯＋黒文字（02の反転）。暗い室内・夜間ショート向け
export const template3_whiteBar: TelopStyleConfig = {
  name: 'ホワイトバー',
  font: {
    size: 80,
    weight: 700,
    family: FAMILY,
    style: 'normal',
    lineHeight: 1.35,
    letterSpacing: 0,
    color: '#161616',
  },
  textShadow: NO_SHADOW,
  textStroke: NO_STROKE,
  background: {
    ...NO_BACKGROUND,
    enabled: true,
    gradient: '#f7f7f5',
    padding: '27px 64px',
    borderRadius: 21,
    boxShadow: '0 21px 53px rgba(0, 0, 0, 0.25)',
  },
  position: POSITION,
  highlight: { color: '#c0392b', glowOpacity: '0' },
  css: {},
};

// ===== 使用するテンプレートを選択 =====
// 使いたいテンプレートに変更してください
export const subtitleConfig = template1_classicOutline;

// CSSスタイルを生成するヘルパー関数
export const getTextShadowCSS = () => {
  const { offsetX, offsetY, blur, color } = subtitleConfig.textShadow;
  return `${offsetX}px ${offsetY}px ${blur}px ${color}`;
};

export const getTextStrokeCSS = () => {
  const { width, gradient } = subtitleConfig.textStroke;
  // グラデーションストロークはSVGで実装するため、ここではwidthのみ返す
  return { width, gradient };
};
