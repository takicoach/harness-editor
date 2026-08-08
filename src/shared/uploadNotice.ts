/**
 * 大容量アップロードの事前案内。
 * しきい値はプレビュー軽量化（preview proxy）の推奨判定（500MB）と同値に揃える。
 */
export const LARGE_UPLOAD_NOTICE_BYTES = 500 * 1024 * 1024;

/** サイズがしきい値超なら投入時に見せる案内文を返す（超えなければ null）。 */
export function largeUploadNotice(sizeBytes: number): string | null {
  if (sizeBytes <= LARGE_UPLOAD_NOTICE_BYTES) return null;
  const gb = sizeBytes / (1024 * 1024 * 1024);
  const size = gb >= 1 ? `${(Math.round(gb * 10) / 10)}GB` : `${Math.round(sizeBytes / (1024 * 1024))}MB`;
  return `容量が大きい動画です（${size}）。取り込み後にプレビュー用の軽量化をご案内します（書き出し画質は変わりません）。`;
}
