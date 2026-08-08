/** メイン動画レイアウト（payload ローカル・自己完結＝core を import しない）。 */
export interface Layout {
  position: { x: number; y: number };
  scale: number;
  background: string;
  /** 回転（度）。省略時は 0 として扱う（旧導入済みプロジェクトとの後方互換）。 */
  rotation?: number;
  /** 左右反転。省略時は false として扱う（旧導入済みプロジェクトとの後方互換）。 */
  flipH?: boolean;
  /** 上下反転。省略時は false として扱う（旧導入済みプロジェクトとの後方互換）。 */
  flipV?: boolean;
}

/** 2点アニメの端点状態（Harness Editor の core/motion と同スキーマ・payload ローカル）。 */
export interface MotionState {
  x?: number;
  y?: number;
  scale?: number;
  opacity?: number;
  rotation?: number;
}

/** 2点アニメ指定（mainLayoutData.ts の SEGMENT_LAYOUTS[].motion）。 */
export interface Motion {
  preset: 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'fadeIn' | 'custom';
  intensity?: number;
  from?: MotionState;
  to?: MotionState;
}

/** 区間ごとレイアウト上書き（背景は持たない＝全体共通）。payload ローカル。 */
export type SegmentLayout = Omit<Layout, 'background'> & { motion?: Motion };

/** 区間範囲計算用の最小 CutSegment（payload ローカル・src/core を import しない）。 */
export interface CutSegmentLite {
  id: number;
  originalStart: number;
  originalEnd: number;
  playbackStart: number;
  playbackEnd: number;
}
