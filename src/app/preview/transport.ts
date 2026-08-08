/**
 * JKL トランスポート（編集ソフト共通の再生操作）の速度遷移を担う純粋関数。
 *
 * - L = 早送り（押すたび 1x → 2x → 4x → 8x）
 * - J = 巻き戻し（押すたび -1x → -2x → -4x → -8x）
 * - K = 一時停止（速度は 1x へ戻す）
 *
 * 逆向きのキーを押したときは段数を積み増さず 1x から入り直す（4 倍速で流している時に
 * J を押したら「4 倍で逆再生」ではなく「等速で巻き戻し」になるのが編集ソフトの慣習）。
 */

/** 押すたびに上がる速度の段。先頭が 1 回目の押下。 */
export const TRANSPORT_RATES = [1, 2, 4, 8] as const;

/** トランスポートキーの種別。 */
export type TransportKey = 'j' | 'k' | 'l';

/**
 * 現在の再生速度（負＝逆再生・0 は停止扱い）と押されたキーから、次の再生速度を返す。
 * K は常に 1（呼び出し側で pause する）。
 */
export function nextPlaybackRate(current: number, key: TransportKey): number {
  if (key === 'k') return 1;
  const dir = key === 'l' ? 1 : -1;
  const magnitude = Math.abs(current);
  // 逆向き（または停止中）から入るときは常に等速から。
  if (current === 0 || Math.sign(current) !== dir) return dir;
  const idx = TRANSPORT_RATES.indexOf(magnitude as (typeof TRANSPORT_RATES)[number]);
  // 想定外の速度（段に無い値）からは等速へ落として仕切り直す。
  if (idx === -1) return dir;
  const next = TRANSPORT_RATES[Math.min(idx + 1, TRANSPORT_RATES.length - 1)] ?? 1;
  return dir * next;
}

/** 速度バッジの表示文字列。等速は空文字（バッジを出さない）。 */
export function playbackRateLabel(rate: number): string {
  if (rate === 1) return '';
  if (rate < 0) return `◀◀ ${Math.abs(rate)}x`;
  return `▶▶ ${rate}x`;
}
