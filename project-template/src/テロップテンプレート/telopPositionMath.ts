/**
 * テロップの自由配置（position.x）を画面内へ収める安全網（2026-09-06 #2）。
 *
 * `TelopPlayer.tsx` / `Telop.tsx` の両方から使う純関数だけを持つ自己完結モジュール
 * （プロジェクトへコピーされて動くため remotion 等の外部 import を増やさない）。
 * 式は Harness Editor 本体の `src/preview/telopLayout.ts` の
 * `clampTelopX` / `telopMaxWidthFrac` と完全同一（正本はそちら。手でのコピーで
 * 乖離させないこと。乖離検知は `src/server/telopPositionMathParity.test.ts`）。
 *
 * なぜ要るか: `translate(position.x * 50%, …)` は AbsoluteFill（フレーム全面）へ
 * 掛かるため、position.x=±1 は「帯の中心をフレーム端へ動かす」＝帯の半分は
 * 常に画面外になる（2026-09-04〜09-06 の不具合）。実際の帯幅は文字数・フォント・
 * scale 依存で描画直前にしか分からないため、position.x を作る側（ドラッグ・
 * API・旧データ）が正しくクランプ済みかに関わらず、描画直前にもう一度
 * 「ありうる最大の帯幅」でクランプする（多重防御）。
 */

/**
 * position.x を「実際の帯の横幅 (elemW) を与えたときに画面内へ収まる範囲」へ丸める。
 * `telopLayout.clampTelopX` と同式。
 */
export function clampTelopX(x: number, containerW: number, elemW: number): number {
  if (!(containerW > 0) || !(elemW >= 0) || !Number.isFinite(x)) return 0;
  if (elemW >= containerW) return 0;
  const limit = (containerW - elemW) / containerW;
  return Math.max(-limit, Math.min(limit, x));
}

/**
 * テロップ帯の「ありうる最大幅」の標準比率（フォーマット別・幅に対する比率）。
 * `videoConfig.ts` の `TELOP_CONFIG_MAP.maxWidth`（youtube 85% / short 92% /
 * square 90%）と同じ値を、実際のプロジェクトの TELOP_CONFIG を知らなくても
 * エディタ側（telopLayout.telopMaxWidthFrac）と同じ判定になるよう標準固定する。
 */
export function telopMaxWidthFrac(width: number, height: number): number {
  if (width > height) return 0.85; // youtube
  if (height > width) return 0.92; // short
  return 0.9; // square
}
