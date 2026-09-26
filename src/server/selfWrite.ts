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

/**
 * 1 プロジェクト分の自己書込ウィンドウ。writerId は書いた画面の識別子（無ければ従来動作）。
 * contentSignature は「保存し終えた直後のディスクの指紋」（recordSelfWriteContent で記録）。
 */
interface SelfWriteWindow {
  until: number;
  writerId?: string;
  contentSignature?: string;
}

const selfWriteUntilByProject = new Map<string, SelfWriteWindow>();

/**
 * projectId を「自己書込中」としてマークする。watchProject から参照される。
 *
 * writerId（クライアントが起動時に作る画面ごとの識別子・data-safety-5）を渡すと、
 * suppress の対象を「その画面自身」に絞れる。省略時は従来どおり projectId 単位で
 * すべての接続を suppress する（旧クライアント互換）。
 */
export function markSelfWrite(projectId: string, writerId?: string): void {
  // 新しい書込が始まるので、前回の保存で記録した指紋は捨てる（古い記録での誤判定を防ぐ）。
  selfWriteUntilByProject.set(projectId, { until: Date.now() + SELF_WRITE_WINDOW_MS, writerId });
  console.log(
    `[sme] markSelfWrite: id=${projectId}, writer=${writerId ?? '(none)'}, window=${SELF_WRITE_WINDOW_MS}ms`,
  );
}

/**
 * この接続（viewerWriterId）から見て、現在が自己書込ウィンドウかどうか。
 *
 * 書いた側と見る側の両方に writerId があるときだけ照合する。どちらかが欠けていれば
 * 従来どおり projectId 単位で suppress する（旧クライアント・旧 /api/watch 互換）。
 * これにより、別画面の保存は「自分の書込」ではなくなり外部変更として通知される。
 */
export function isSelfWriting(projectId: string, viewerWriterId?: string): boolean {
  const win = selfWriteUntilByProject.get(projectId);
  if (win === undefined || Date.now() >= win.until) return false;
  if (win.writerId === undefined || viewerWriterId === undefined) return true;
  return win.writerId === viewerWriterId;
}

/**
 * projectId の自己書込ウィンドウの残り時間 (ms)。ウィンドウ外・未マークは 0。
 * watchProject が「suppress した外部変更をいつ再評価するか」に使う（data-safety-6）。
 */
export function selfWriteRemainingMs(projectId: string, viewerWriterId?: string): number {
  if (!isSelfWriting(projectId, viewerWriterId)) return 0;
  const win = selfWriteUntilByProject.get(projectId);
  if (win === undefined) return 0;
  return Math.max(0, win.until - Date.now());
}

/**
 * 保存し終えた直後のディスク指紋を記録する（サイクル 2 レビュー Important）。
 *
 * data-safety-6 で suppress を「破棄」から「先送り」に変えたため、ウィンドウが明けた
 * 時点の再評価では **自己書込か外部書込かを見分ける材料が何も無く**、常に通知が通った。
 * その結果、1 タブで保存しただけで自分の画面に「外部で更新されました」が出ていた。
 * 内容（指紋）で見分けられるように、書き終えた時点のディスクの姿を残す。
 *
 * ウィンドウも張り直す。markSelfWrite は**書き込みの前**に呼ばれるので、書込に時間が
 * かかると再評価までにウィンドウが尽きることがある（起点を書き終えた時刻に揃える）。
 */
export function recordSelfWriteContent(projectId: string, signature: string): void {
  const win = selfWriteUntilByProject.get(projectId);
  selfWriteUntilByProject.set(projectId, {
    until: Date.now() + SELF_WRITE_WINDOW_MS,
    writerId: win?.writerId,
    contentSignature: signature,
  });
}

/**
 * 「いまディスクに在る内容は、この画面が最後に保存した内容そのものか」。
 *
 * 一致するなら watch イベントは自分の保存の残響であり、外部変更ではない。
 * 判定は writerId でも絞る（別画面の保存はその画面にとって外部変更のまま＝data-safety-5）。
 * 記録が無い場合は false（＝従来どおり通知する）。サーバが自分で書くルート
 * （PUT・install 系・convert・pack-upgrade）は書込直後に必ず指紋を記録すること。
 */
export function isSelfWriteContent(
  projectId: string,
  viewerWriterId: string | undefined,
  currentSignature: string,
): boolean {
  const win = selfWriteUntilByProject.get(projectId);
  if (win === undefined || win.contentSignature === undefined) return false;
  if (win.writerId !== undefined && viewerWriterId !== undefined && win.writerId !== viewerWriterId) {
    return false;
  }
  return win.contentSignature === currentSignature;
}

/**
 * SSE 切断時に自己保存ウィンドウをクリアする。
 * 残ったままだと次の SSE 接続（別テスト等）での外部書き換えを誤って suppress してしまう。
 */
export function clearSelfWrite(projectId: string): void {
  selfWriteUntilByProject.delete(projectId);
}
