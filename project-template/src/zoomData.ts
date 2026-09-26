// ==== カメラ演出（パンチイン）データ ====
// 空のままなら演出なし。ショートの標準（golf-short-gold プリセット zoom 準拠）:
//   冒頭カメラフック { startFrame: 0, endFrame: 18, from: 1.15, to: 1.0, rampFrames: 18 }
//   クライマックス・CTA で 1.08〜1.1 のパンチイン（SE と同期・図解カード表示中は置かない）
// フレームはカット適用後の再生タイムライン基準（telopData.ts / seData.ts と同じ）。
export interface ZoomSegment {
  id: number;
  startFrame: number;
  endFrame: number;
  from: number; // 開始スケール
  to: number; // 到達スケール（rampFrames かけて到達し、endFrame まで保持）
  rampFrames: number;
}

export const zoomData: ZoomSegment[] = [];
