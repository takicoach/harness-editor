import type { RenderProgress } from './renderProgress';

/** SSE イベントのフェーズ。 */
export type RenderJobPhase =
  | 'preparing'
  /** オーバーレイ（テロップ/タイトル/画像）の撮影中（M2c・fastCut.prepare 実行中）。 */
  | 'capturing'
  | 'bundling'
  | 'rendering'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'cancelled';

/**
 * 撮影段の見積り（M2c 設計判断6）。distinct フレーム数 × 実測単価から算出した予測時間。
 * 「基準線超過が見込まれても撮影は続行する」ので、退避判断ではなく**表示情報**として流す。
 */
export interface RenderCaptureEstimate {
  /**
   * 撮影対象の相異なるシグネチャ数（情報用・M2c 設計判断6 の名残）。
   *
   * **進捗の分母ではない**（C-1）: 非連続な区間に同一シグネチャが再登場すると run は
   * 分かれるので `capturedTotal >= distinctFrames`（狭義に大きくなりうる）。分母に使うと
   * 進捗が分母を追い越し、最終報告が永遠に来ない。
   */
  distinctFrames: number;
  /** 実際に Chromium で撮る枚数（全レイヤの run 総数）。進捗の分母・完了判定はこちら。 */
  capturedTotal: number;
  /** 予測撮影時間（ms）＝ 残り枚数 × 実測単価。初回見積りは capturedTotal × 単価。 */
  estimatedMs: number;
  /**
   * 撮影済み枚数（M2d T3・申し送り⑥）。未指定は「撮影開始前の初回見積り」を示す
   * （capturedTotal/estimatedMs のみ判明した状態）。capturedTotal と一致すれば最終報告。
   */
  capturedFrames?: number;
}

/** SSE で流すイベント。 */
export interface RenderJobEvent {
  phase: RenderJobPhase;
  progress?: RenderProgress;
  error?: { code: string; message: string };
  /** 完了はしたが気になる点がある時の注意書き（例: フレーム数が想定と違う）。 */
  warning?: string;
  /** 撮影段の見積り（phase='capturing' の時のみ）。 */
  capture?: RenderCaptureEstimate;
}

/** ジョブの内部状態。 */
export interface RenderJob {
  projectId: string;
  outputFile?: string;
  startedAt: number;
  phase: RenderJobPhase;
  progress?: RenderProgress;
  error?: { code: string; message: string };
  warning?: string;
  /** 撮影段の見積り（判明後に載る・SSE snapshot にそのまま含まれる）。 */
  capture?: RenderCaptureEstimate;
}

