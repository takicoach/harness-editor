/**
 * 自己保存ウィンドウ管理: PUT /api/project でサーバ自身がファイルを書き換えた直後、
 * chokidar が検知する change イベントが「外部更新」として通知されないように、
 * projectId ごとに「この時刻まで自己書込中」のタイムスタンプを保持する。
 *
 * 1500ms というウィンドウは debounce (500ms) + writeFileSync I/O + FSEvents 遅延の合算に
 * 十分なマージン。これより短いと自己保存通知が漏れる、長くすると外部編集の検知が遅れる。
 *
 * plugin.ts（従来の /api/watch・/api/project 等）と eventsApi.ts（統合 /api/events の
 * watch チャネル）の両方から参照される共有状態のため、循環 import を避けて独立モジュールに
 * 切り出している。
 */
const SELF_WRITE_WINDOW_MS = 1500;
const selfWriteUntilByProject = new Map<string, number>();

/** projectId を「自己書込中」としてマークする。watchProject から参照される。 */
export function markSelfWrite(projectId: string): void {
  selfWriteUntilByProject.set(projectId, Date.now() + SELF_WRITE_WINDOW_MS);
  console.log(`[sme] markSelfWrite: id=${projectId}, window=${SELF_WRITE_WINDOW_MS}ms`);
}

/** projectId が現時点で自己書込ウィンドウ内かどうか。 */
export function isSelfWriting(projectId: string): boolean {
  const until = selfWriteUntilByProject.get(projectId);
  return until !== undefined && Date.now() < until;
}

/**
 * SSE 切断時に自己保存ウィンドウをクリアする。
 * 残ったままだと次の SSE 接続（別テスト等）での外部書き換えを誤って suppress してしまう。
 */
export function clearSelfWrite(projectId: string): void {
  selfWriteUntilByProject.delete(projectId);
}
