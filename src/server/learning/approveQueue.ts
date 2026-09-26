/**
 * 学習の承認をサーバー内で1件ずつ順番に実行する処理待ちの列（設計書 D12）。
 * 承認は差分の再計算（非同期）→記録（同期）の順に進むので、列が無いと2件の承認の記録が交互に混ざる。
 * 前の処理が失敗しても次の処理は実行する。
 */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

export function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

/** /api/learning/approve 用の列（サーバー全体で1本）。 */
export const runLearningApprove: SerialQueue = createSerialQueue();
