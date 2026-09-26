/**
 * タイムラインの縦あふれ（下のトラックが画面外）を測る純関数。
 *
 * 1440×900 でもタイムラインは「動画」「じまく」しか見えず、テロップ・画像・サブ動画・
 * BGM・効果音・図形は下端 1139〜1347px で画面の外にいた。
 * 見えていないこと自体に気付けないのが問題なので、「下にまだある」ことを数で伝える。
 */

/**
 * 可視域に**入りきっていない**トラックの本数。
 *
 * @param trackBottoms 各トラックの下端（コンテンツ座標・`offsetTop + offsetHeight`）。
 * @param scrollTop 縦スクロール量。
 * @param clientHeight 可視域の高さ。
 * @returns 下端が可視域の下辺を超えるトラックの本数（0 なら全部見えている）。
 *   clientHeight が 0（レイアウト前・非表示）のときは 0（＝手がかりを出さない）。
 */
export function hiddenTracksBelow(
  trackBottoms: readonly number[],
  scrollTop: number,
  clientHeight: number,
): number {
  if (!Number.isFinite(clientHeight) || clientHeight <= 0) return 0;
  const viewBottom = scrollTop + clientHeight;
  let n = 0;
  for (const bottom of trackBottoms) {
    // 1px の丸め誤差で「1 トラック隠れている」と言い続けないよう遊びを持たせる。
    if (bottom > viewBottom + 1) n++;
  }
  return n;
}

/** 「▼ さらに N トラック」の文言（N が 0 なら null＝出さない）。 */
export function moreTracksLabel(hidden: number): string | null {
  if (hidden <= 0) return null;
  return `▼ さらに ${hidden} トラック`;
}
