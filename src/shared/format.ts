/** 秒数を m:ss 形式へ整形する。 */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

/** フレーム → 秒。fps が 0 以下なら 0（ゼロ除算回避）。表示は呼び出し側で toFixed する。 */
export function frameToSec(frame: number, fps: number): number {
  return fps > 0 ? frame / fps : 0;
}

/** 秒 → フレーム。最も近いフレームへ丸める。fps が 0 以下なら 0。 */
export function secToFrame(sec: number, fps: number): number {
  return fps > 0 ? Math.round(sec * fps) : 0;
}

/**
 * 秒入力の文字列を「コミットすべきフレーム」へ変換する。
 * 空文字・非数値・変換後フレームが現在値と同じ（＝無編集や等価表記）なら null を返す。
 * 呼び出し側は null のとき表示を現在値へ戻すだけで履歴を積まない。
 */
export function parseSecField(str: string, currentFrame: number, fps: number): number | null {
  const n = Number(str);
  if (str.trim() === '' || !Number.isFinite(n)) return null;
  const frame = secToFrame(n, fps);
  return frame === currentFrame ? null : frame;
}

/** バイト数を人間可読なファイルサイズへ整形する。 */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return '—';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${Math.max(1, Math.round(kb))} KB`;
}
