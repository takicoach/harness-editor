/**
 * プレビュー再読み込みボタン（C-4）の純ロジック。
 * Windows 利用者から「ウィンドウリサイズで映像停止」「編集を重ねると黒画面」の報告があり、
 * F5 でしか復帰できず編集消失リスクがあった問題への応急処置。
 * Remotion Player だけを key で再マウントし、動画 URL も同時にキャッシュバストする。
 */

/** 再読み込みキーを1つ進める（Player の key に使い、変化で再マウントを起こす）。 */
export function nextReloadKey(current: number): number {
  return current + 1;
}

/**
 * 動画 URL に再読み込み用のキャッシュバストクエリを付与する。
 * key が 0（未使用・初期値）のときは URL を変更しない。空 URL もそのまま返す。
 */
export function withReloadBust(url: string, key: number): string {
  if (!url || key <= 0) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}reload=${encodeURIComponent(String(key))}`;
}
