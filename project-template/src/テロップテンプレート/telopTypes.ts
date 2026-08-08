import type { CSSProperties } from 'react';

// テロップテンプレート番号（telopStyles.ts の3スタイルに対応）。
// 拡張テロップパックを導入すると、エディタの installTelopPack がこの宣言を
// `type TelopTemplateId = number;` へ広げる（番号を足したい場合は手で `| 4` 等を追記する）。
export type TelopTemplateId = 1 | 2 | 3;

/** エディタの自由配置座標（正規化: x は中心0で -1..1、y は下0〜上-1）。 */
export interface TelopPoint {
  x: number;
  y: number;
}

/** 2点アニメの端点状態（Harness Editor の core/motion と同スキーマ）。 */
export interface TelopMotionState {
  x?: number;
  y?: number;
  scale?: number;
  opacity?: number;
  rotation?: number;
}

/** 2点アニメ指定（エディタが telopData.ts へ書く）。 */
export interface TelopMotion {
  preset: 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'fadeIn' | 'custom';
  intensity?: number;
  from?: TelopMotionState;
  to?: TelopMotionState;
}

export interface TelopSegment {
  id: number;
  startFrame: number;
  endFrame: number;
  text: string;
  highlight?: string;
  style?: 'normal' | 'emphasis' | 'warning' | 'success';
  template?: TelopTemplateId;
  animation?: 'none' | 'slideIn' | 'fadeOnly' | 'slideFromLeft' | 'fadeBlurFromBottom' | 'slideLeftFadeBlur' | 'fadeFromRight' | 'fadeFromLeft' | 'charByChar';
  /** エディタ拡張（任意）: 自由配置。未指定なら既定の下端中央。 */
  position?: TelopPoint;
  /** エディタ拡張（任意）: 拡縮（1 = 等倍）。 */
  scale?: number;
  /** エディタ拡張（任意）: 2点アニメ。 */
  motion?: TelopMotion;
  /** エディタ拡張（任意）: 行削除テロップの原本区間。 */
  originalStart?: number;
  originalEnd?: number;
  /** エディタ拡張（任意）: true なら手動追加（飾り）テロップ。 */
  manual?: boolean;
}

export interface TelopSpring {
  damping: number;
  stiffness: number;
  mass: number;
}

export type TelopSlideDirection = 'up' | 'down' | 'left' | 'right';

export interface TelopAnimation {
  name: string;
  fadeInDuration: number;
  fadeOutDuration: number;
  slideInDistance: number;
  slideDirection: TelopSlideDirection;
  spring: TelopSpring;
  charDelay?: number; // animation_charByChar のみ
}

export interface TelopFillGradient {
  enabled: boolean;
  start: string;
  end: string;
}

export interface TelopFont {
  size: number;
  weight: number;
  family: string;
  style: 'italic' | 'normal';
  lineHeight: number;
  letterSpacing: number;
  color: string;
  fillGradient?: TelopFillGradient;
  opacity?: number;
}

export interface TelopTextShadow {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: string;
}

export interface TelopGradientPair {
  start: string;
  end: string;
}

export interface TelopTextStroke {
  width: number;
  gradient: TelopGradientPair;
}

export interface TelopBackground {
  enabled: boolean;
  gradient: string;
  padding: string;
  borderRadius: number;
  backdropFilter: string;
  boxShadow: string;
  border: string;
}

export interface TelopPosition {
  bottom: number;
  maxWidth: string;
  containerPadding: string;
}

export interface TelopHighlight {
  color: string;
  glowOpacity: string;
}

// ===== 形状パーツ（css 拡張描画で使用） =====
// 「切り欠き・矢羽根・二色ズレ・タブ・縦罫・下線」等、上の基本フィールドだけでは
// 表現できない意匠を、Telop.tsx の CSS 描画パスに渡すための定義。
// css を持たないスタイルは従来どおり（背景あり=CSSボックス / 背景なし=SVG）で描かれる。

// 装飾パーツ（タブ・縦罫・三角・ドット・カーソル・角タグ等）
export interface TelopOrnament {
  text?: string;      // ラベル文字（'POINT' / '●' 等）。図形だけなら省略
  blink?: boolean;    // 0.5秒ごとの点滅（タイプライターのカーソル）
  style: CSSProperties;
}

// 本文と同じ文字を重ねる層（二重袋文字・グロウレス発光・印刷ズレ）
export interface TelopTextLayer {
  color: string;          // 塗り色（'transparent' 可）
  strokeWidth?: number;   // px
  strokeColor?: string;
  offsetX?: number;       // px（印刷ズレ用）
  offsetY?: number;
}

// 2色分割ブロックの片側
export interface TelopSplitPart {
  box: CSSProperties;
  text?: CSSProperties;
}

// テキストを区切り文字で2分割して別色のブロックに流し込む
export interface TelopSplit {
  by: string;                                   // 例: '→'（区切り文字は後半側に残る）
  parts: [TelopSplitPart, TelopSplitPart];      // 区切り文字が無いテキストは parts[1] の見た目で1ブロック表示
}

export interface TelopCssSpec {
  frame?: CSSProperties;        // ボックスの外側にもう1枚敷く枠（ストライプ縁・銀フチ）
  box?: CSSProperties;          // ボックスへの追加CSS（clip-path・skew・flex 等）
  text?: CSSProperties;         // 本文への追加CSS（多層シャドウ・逆スキュー等）
  layers?: TelopTextLayer[];    // 本文の背面に重ねる層
  before?: TelopOrnament[];     // 本文の前に置く装飾
  after?: TelopOrnament[];      // 本文の後ろに置く装飾
  overlays?: TelopOrnament[];   // ボックスに絶対配置する装飾（角タグ・下線）
  split?: TelopSplit;
  fullBleed?: boolean;          // 画面幅いっぱいの帯（containerPadding / maxWidth を使わない）
}

export interface TelopStyleConfig {
  name: string;
  font: TelopFont;
  textShadow: TelopTextShadow;
  textStroke: TelopTextStroke;
  background: TelopBackground;
  position: TelopPosition;
  highlight: TelopHighlight;
  css?: TelopCssSpec;
}
