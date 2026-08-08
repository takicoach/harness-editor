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

/** サブ動画インサート（Harness Editor が生成）。 */
export interface VideoInsert {
  id: number;
  startFrame: number;
  endFrame: number;
  file: string;
  sourceInFrame: number;
  position?: { x: number; y: number };
  scale?: number;
  /** エディタプレビュー用の解決済み URL（最終 render では未指定→staticFile へ）。 */
  videoUrl?: string;
  /** 登場アニメ（未指定＝なし＝従来挙動）。 */
  enter?: ElementAnim;
  /** 退場アニメ（未指定＝なし＝従来挙動）。 */
  exit?: ElementAnim;
  /** 再生速度（倍率・未指定＝1.0）。0.1〜16。D_source = (endFrame-startFrame)×playbackRate を保つ。 */
  playbackRate?: number;
}
