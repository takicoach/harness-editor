/**
 * アニメーション見本のループ再生（カタログ表示）の土台。
 *
 * 17 枚のカードが同時に動くため、rAF は**カードごとに 1 本**ではなく
 * **モジュールに 1 本**だけ回す。購読者が 0 になったら止め、`document.hidden` の間も止める
 * （見えていない絵のためにメインスレッドを使わない）。
 *
 * フレームの決め方は純関数に閉じる。rAF が何回呼ばれたかではなく「経過ミリ秒」から求めるので、
 * 間引かれても見た目の速さが変わらない。
 */

/** 見本 1 周の尺。字幕の実尺ではなく固定にして、どのカードでも入場・退場が必ず見えるようにする。 */
export const SAMPLE_LOOP_SECONDS = 2.5;
/** 退場が終わってから次の入場までの静止。 */
export const SAMPLE_LOOP_HOLD_SECONDS = 0.5;

/** 見本の尺（フレーム数）。`fps` は案件の fps。 */
export function sampleLoopFrames(fps: number): number {
  return Math.max(2, Math.round(fps * SAMPLE_LOOP_SECONDS));
}

/**
 * 経過ミリ秒から、見本の中の表示フレーム（0 起点）を求める。
 * 0 → frames-1 まで進み、そのあと 0.5 秒ぶん frames-1 で静止してから 0 へ戻る。
 */
export function sampleLoopFrame(elapsedMs: number, fps: number, frames: number): number {
  const hold = Math.max(1, Math.round(fps * SAMPLE_LOOP_HOLD_SECONDS));
  const cycle = frames + hold;
  const position = Math.floor((Math.max(0, elapsedMs) / 1000) * fps) % cycle;
  return Math.min(position, frames - 1);
}

type SampleListener = (now: number) => void;

const listeners = new Set<SampleListener>();
let handle = 0;

const hidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

const pump = (now: number): void => {
  handle = 0;
  // 購読解除が走っても今回の巡回が壊れないよう、複製の上を回る。
  for (const listener of [...listeners]) listener(now);
  schedule();
};

function schedule(): void {
  if (handle !== 0 || listeners.size === 0 || hidden()) return;
  if (typeof requestAnimationFrame !== 'function') return;
  handle = requestAnimationFrame(pump);
}

function stop(): void {
  if (handle === 0) return;
  cancelAnimationFrame(handle);
  handle = 0;
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function')
  document.addEventListener('visibilitychange', () => (hidden() ? stop() : schedule()));

/** 共通ティッカーへ購読する。戻り値を呼ぶと解除し、最後の 1 人なら rAF も止める。 */
export function subscribeSampleLoop(listener: SampleListener): () => void {
  listeners.add(listener);
  schedule();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/** テスト用。ティッカーが実際に回っているかの存在検査に使う。 */
export function sampleLoopSubscriberCount(): number {
  return listeners.size;
}
