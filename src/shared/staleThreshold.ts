/**
 * activity（AI 作業中バッジ）が stale（放置・中断疑い）と判定されるまでの経過時間。
 * サーバ（src/server/projectStatus.ts）とクライアント（src/app/panels/projectStatusView.ts）の
 * 両方から参照する共有定数（重複定義しない）。
 */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
