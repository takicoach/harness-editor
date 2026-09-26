// src/shared/captureOverlays.ts
/**
 * 撮影（native capture）が要るかの述語と、撮影経路に入れない理由（M2d T2 修正 I-2・I-3）。
 *
 * サーバ（fastCutPlan.ts）とクライアント（App の ExportDialog needsCapture）で**同じ判定**を
 * 使うための正本。どちらも「射影後（縮退区間を除いた）」の telops / titles / images に対して
 * 適用する——生データで判定すると、丸ごとカット区間に入ったテロップを「撮影が要る」と
 * 誤って数え、UI とサーバの結論が食い違う。
 */

/** 射影後のオーバーレイ配列（telops/titles は startFrame/endFrame、images は playbackStart/End）。 */
export interface CaptureOverlaySets {
  telops: readonly unknown[];
  titles: readonly unknown[];
  images: readonly unknown[];
}

/**
 * 1 要素が実際に描かれるか（尺が正か）。
 *
 * サーバ（fastCutPlan）は射影後に `endFrame > startFrame` で縮退要素を落としてから数えるが、
 * プレビュー（playbackModel）は落とさずに carry する（描画側が endFrame 排他で無を描く）。
 * 同じ結論にするため、述語側で縮退要素を数えない。座標の無い要素は「在る」として数える
 * （情報が無いのに撮影不要と断じない＝安全側）。
 */
function isDrawn(item: unknown): boolean {
  if (typeof item !== 'object' || item === null) return true;
  const rec = item as Record<string, unknown>;
  const start = typeof rec['startFrame'] === 'number' ? rec['startFrame'] : rec['playbackStart'];
  const end = typeof rec['endFrame'] === 'number' ? rec['endFrame'] : rec['playbackEnd'];
  if (typeof start !== 'number' || typeof end !== 'number') return true;
  return end > start;
}

/** テロップ・タイトル・画像のいずれかが（縮退せずに）残っているか＝撮影段が要るか。 */
export function hasCaptureOverlays(sets: CaptureOverlaySets): boolean {
  return sets.telops.some(isDrawn) || sets.titles.some(isDrawn) || sets.images.some(isDrawn);
}

/**
 * 高速書き出し（撮影経路）に入れない理由。**撮影エンジンの解決失敗のみ**を扱う
 * （server の ResolveChromiumFailKind と同一の値集合。fastCutPlan.ts で型検査している）。
 * projectId 無し・titleStyle 不正などの他の非適格は理由なし（undefined）のまま。
 */
export const FAST_CUT_INELIGIBLE_REASONS = [
  'chromium-missing',
  'env-path-missing',
  'unsupported-platform',
] as const;

/** 値集合の正本は上の配列 1 つ（型と実行時チェックがずれないよう型は配列から導く）。 */
export type FastCutIneligibleReason = (typeof FAST_CUT_INELIGIBLE_REASONS)[number];

/** 未知の値（サーバの型崩れ・古いクライアント）は undefined に落とす。 */
export function asFastCutIneligibleReason(value: unknown): FastCutIneligibleReason | undefined {
  return typeof value === 'string'
    && (FAST_CUT_INELIGIBLE_REASONS as readonly string[]).includes(value)
    ? (value as FastCutIneligibleReason)
    : undefined;
}
