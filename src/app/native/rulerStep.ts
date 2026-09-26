/**
 * ラベルが重ならない最小の間隔（px）。ラベルは `tabular-nums` の 11.5px で、最長表記
 * `h:mm:ss`（7 文字）が約 48px。72px なら隣に 24px 以上の余白が残る。
 */
export const RULER_LABEL_PITCH_PX = 72;
const CANDIDATE_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MAX_STEP_SECONDS = 86400;
const MIN_MINOR_GAP_PX = 8;

/**
 * ルーラーの主目盛りと補助線の間隔（フレーム）。1 秒未満は作らない
 * （フレーム単位は再生位置の数値欄が担う）。不正な入力では `null` を返し、呼び出し側は目盛りを描かない。
 *
 * `stepSeconds`（選んだ候補秒そのもの・常に整数）と `minorDivisions`（補助線の分割数・5 か 2）を併せて返す。
 * 呼び出し側はラベルを `stepSeconds` から（フレーム経由で戻さず）、補助線の除外を `minorDivisions` を
 * 使ったインデックス判定で行う（丸めたフレーム値の剰余だと端数 fps でずれる。R3-1／R3-2）。
 */
export function rulerStep(
  pxPerFrame: number,
  fps: number,
): {stepFrames: number; minorFrames: number | null; stepSeconds: number; minorDivisions: 5 | 2} | null {
  if (!Number.isFinite(pxPerFrame) || !Number.isFinite(fps) || pxPerFrame <= 0 || fps <= 0) return null;
  const fits = (seconds: number) => seconds * fps * pxPerFrame >= RULER_LABEL_PITCH_PX;
  let seconds = CANDIDATE_SECONDS.find(fits);
  if (seconds === undefined) {
    seconds = CANDIDATE_SECONDS[CANDIDATE_SECONDS.length - 1]!;
    while (!fits(seconds) && seconds < MAX_STEP_SECONDS) seconds = Math.min(MAX_STEP_SECONDS, seconds * 2);
  }
  // 小数のまま返す。23.976／29.97fps を整数化すると、呼び出し側で目盛り位置を index 倍したときに
  // 誤差が線形に積み上がる（1800 番目の目盛りが 30 分 1.8 秒）。丸めるのは呼び出し側が
  // 各目盛りの最終フレーム位置を出すときだけ（Codex P2）。
  const stepFrames = seconds * fps;
  const minorDivisions: 5 | 2 = seconds % 5 === 0 ? 5 : 2;
  const minorFrames = stepFrames / minorDivisions;
  return {
    stepFrames,
    minorFrames: minorFrames * pxPerFrame >= MIN_MINOR_GAP_PX ? minorFrames : null,
    stepSeconds: seconds,
    minorDivisions,
  };
}

function formatClock(totalSeconds: number, longForm: boolean): string {
  const total = Math.max(0, Math.round(totalSeconds)), seconds = total % 60;
  if (!longForm) return `${Math.floor(total / 60)}:${String(seconds).padStart(2, '0')}`;
  return `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 表示フレームを `m:ss`（`longForm` なら `h:mm:ss`）にする。 */
export function rulerLabel(frames: number, fps: number, longForm: boolean): string {
  return formatClock(Math.floor(frames / fps), longForm);
}

/**
 * 主目盛りのラベルを秒から直接整形する（フレーム経由で戻さない）。`rulerStep` の `stepSeconds` は
 * 常に整数なので、`index * stepSeconds` は端数 fps でも誤差なく整数秒になる（R3-1）。
 */
export function rulerLabelFromSeconds(totalSeconds: number, longForm: boolean): string {
  return formatClock(totalSeconds, longForm);
}
