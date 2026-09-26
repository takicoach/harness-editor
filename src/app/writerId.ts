/**
 * この画面（タブ）を識別する writerId（監査 data-safety-5・既知起票 16）。
 *
 * 自己書込ウィンドウがプロジェクト単位だったため、同じ案件を 2 つの画面で開くと
 * 「別の画面の保存」まで自分の書込として抑止され、外部変更バナーが出なかった。
 * 衝突は自分が保存して 409 になるまで発覚せず、それまでの作業が積み上がってしまう。
 *
 * 保存 PUT のヘッダ（X-Harness-Writer）と SSE の ?w= で同じ値を送り、サーバは
 * 「同じ画面の書込」だけを抑止する。
 *
 * 値は**この JS モジュールが生きている間だけのメモリ変数**で持つ（サイクル 2 Minor）。
 * sessionStorage に置いていたときは「タブの複製」で複製元と同じ値が引き継がれ、
 * 2 つの画面が同じ writerId を名乗って、この仕組みが防ぐはずだった
 * 「別画面の保存が自分の書込に見える」状態がそのまま再発していた。
 * 画面を読み込み直せば新しい値になるが、それは正しい（別の画面＝別の書き手）。
 */

/** ランダムな識別子。crypto が無い環境でも動くようにフォールバックする。 */
function newId(): string {
  const c: Crypto | undefined = typeof crypto === 'undefined' ? undefined : crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** この画面の writerId（モジュールスコープ＝画面ごとに 1 つ・永続化しない）。 */
let cached: string | null = null;

/** この画面の writerId を返す（初回呼び出しで生成し、以後は同じ値）。 */
export function getWriterId(): string {
  if (cached === null) cached = newId();
  return cached;
}

/** テスト用: メモリの値を捨てる（本番導線からは呼ばない）。 */
export function resetWriterIdForTest(): void {
  cached = null;
}
