/**
 * BGM クリップ内フレームの音量を返す（フェードイン/アウト適用）。
 *
 * エディタプレビュー（EditorComposition の BgmLayer）と、プロジェクトへ同梱する
 * BgmSequence.tsx の両方がこの式を使う。同梱部品は独立コピーのためこの式を**契約**として
 * 一致させること（一致しないとプレビューと焼き込みでフェードがズレる）。
 *
 * @param frameInClip  クリップ内フレーム（0 始まり）
 * @param durationFrames クリップ区間長（= endFrame - startFrame）
 * @param baseVolume   基準音量（0〜1）
 * @param fadeInFrames フェードイン長（フレーム・0 で無し）
 * @param fadeOutFrames フェードアウト長（フレーム・0 で無し）
 */
export function bgmFadeVolume(
  frameInClip: number,
  durationFrames: number,
  baseVolume: number,
  fadeInFrames: number,
  fadeOutFrames: number,
): number {
  let v = baseVolume;
  if (fadeInFrames > 0 && frameInClip < fadeInFrames) {
    v *= frameInClip / fadeInFrames;
  }
  // フェードアウトは最終描画フレーム（durationFrames-1）で 0 に達する。
  // Remotion がレンダリングするのは 0..durationFrames-1 のフレームのみ。
  const lastFrame = durationFrames - 1;
  if (fadeOutFrames > 0 && frameInClip > lastFrame - fadeOutFrames) {
    v *= Math.max(0, (lastFrame - frameInClip) / fadeOutFrames);
  }
  return Math.max(0, Math.min(baseVolume, v));
}
